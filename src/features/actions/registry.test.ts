import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { actionRegistry, lookupAction, type CanonicalAction } from "./registry";
import {
  commandActions,
  fileActionRegistry,
  resolveCommand,
  resolveFileMenu,
  resolveSelectionAction,
} from "./resolveAction";
import { fileMenuCommands } from "../../app/context-menu/fileMenuCommands";
import { menuCatalog } from "../../app/context-menu/catalog";
import type { WorkspaceNode } from "../../shared/contracts";
const source = (path: string) =>
  ts.createSourceFile(
    path,
    readFileSync(path, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    path.endsWith("tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
function strings(path: string, name: string): string[] {
  const file = source(path);
  const alias = file.statements.find(
    (s) => ts.isTypeAliasDeclaration(s) && s.name.text === name,
  );
  if (!alias || !ts.isTypeAliasDeclaration(alias)) throw Error(name);
  return ts.isUnionTypeNode(alias.type)
    ? alias.type.types.flatMap((t) =>
        ts.isLiteralTypeNode(t) && ts.isStringLiteral(t.literal)
          ? [t.literal.text]
          : ts.isTypeReferenceNode(t)
            ? strings(path, t.typeName.getText(file))
            : [],
      )
    : [];
}
const node: WorkspaceNode = {
  id: "a",
  name: "a",
  kind: "file",
  absolutePath: "C:/fixture/a",
  relativePath: "a",
  depotPath: "//fixture/a",
  state: "controlled",
};
it("covers actual CommandId and FileAction discriminants bidirectionally", () => {
  expect(Object.keys(commandActions).sort()).toEqual(
    strings("src/app/shell/commandPolicy.ts", "CommandId").sort(),
  );
  expect(Object.keys(fileActionRegistry).sort()).toEqual(
    strings("src/shared/contracts.ts", "FileAction").sort(),
  );
});
it("uses actual selection builder for recursive add and mark-delete, preserving path snapshots", () => {
  const add = resolveSelectionAction(
    "add",
    [{ ...node, kind: "directory" }],
    "op",
  );
  expect(add.request.action).toBe("addRecursive");
  expect(add.action).toMatchObject({ kind: "add-recursive" });
  expect(add.request.operationId).toBe("op");
  for (const kind of ["file", "directory"] as const) {
    const result = resolveSelectionAction("delete", [{ ...node, kind }]);
    expect(result.request.action).toBe("markForDelete");
    expect(result.action).toMatchObject({ kind: "delete" });
  }
  expect(fileActionRegistry.delete).toMatchObject({ kind: "delete-generic" });
  expect(fileActionRegistry.deleteLocal).toMatchObject({ kind: "deleteLocal" });
});
it("maps executable real menu aliases but not unbound catalog placeholders", () => {
  const labels = new Set<string>(
    Object.values(menuCatalog).flatMap((menu) =>
      menu.items.map((item) => item.label),
    ),
  );
  for (const [label, id] of Object.entries(fileMenuCommands)) {
    expect(labels.has(label), label).toBe(true);
    expect(resolveFileMenu(label, true)).toEqual(resolveCommand(id));
    expect(resolveFileMenu(label, false)).toBeUndefined();
  }
  expect(resolveFileMenu("不存在的写操作", true)).toBeUndefined();
  expect(resolveFileMenu("复制 › Depot 路径", true)).toEqual({
    boundary: "platform",
  });
  expect(fileActionRegistry.copy).toMatchObject({ kind: "copy" });
});
it("keeps custom/native submit and selected-file preparation separate", () => {
  expect(
    resolveCommand("submit", { customSubmitConfigured: true }),
  ).toMatchObject({ kind: "submit-custom" });
  expect(
    resolveCommand("submit", { customSubmitConfigured: false }),
  ).toMatchObject({ kind: "submit-native" });
  expect(actionRegistry["selected-files-submit-prepare"].adapters).toContain(
    "selectedSubmitClaim",
  );
});
it("maps MOVE only to selected route; host generic route is explicitly legacy", () => {
  expect(resolveCommand("moveFiles")).toEqual({
    kind: "move-files",
    route: "selectedMove",
  });
  expect(fileActionRegistry.moveToChangelist).toMatchObject({
    route: "legacyOnly",
  });
  for (const path of [
    "src/features/changelists/components/PendingPage.tsx",
    "src/features/changelists/components/FileClWorkflow.tsx",
  ]) {
    let count = 0;
    function visit(n: ts.Node) {
      if (
        ts.isJsxSelfClosingElement(n) &&
        n.tagName.getText() === "MoveFilesDialog"
      ) {
        count++;
        expect(
          n.attributes.properties.some(
            (p) => ts.isJsxAttribute(p) && p.name.getText() === "onStart",
          ),
        ).toBe(true);
      }
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression))
        expect(
          ["preflightMoveFiles", "confirmMoveFiles"].includes(
            n.expression.name.text,
          ),
        ).toBe(false);
      ts.forEachChild(n, visit);
    }
    visit(source(path));
    expect(count).toBeGreaterThan(0);
  }
});
it("registry adapters refer to real Backend members and all entries own a concrete migration boundary", () => {
  const file = source("src/infrastructure/backend/contract.ts");
  const declaration = file.statements.find(
    (s) => ts.isInterfaceDeclaration(s) && s.name.text === "Backend",
  ) as ts.InterfaceDeclaration;
  const methods = new Set(
    declaration.members.map((m) => m.name?.getText(file)),
  );
  for (const row of Object.values(actionRegistry)) {
    expect(row.resource.length).toBeGreaterThan(0);
    expect(row.confirmation.length).toBeGreaterThan(0);
    expect(["1", "2a", "2b", "3a", "3b", "3c", "boundary"]).toContain(
      row.stage,
    );
    for (const adapter of row.adapters)
      expect(methods.has(adapter), adapter).toBe(true);
  }
  for (const mapping of [
    ...Object.values(commandActions),
    ...Object.values(fileActionRegistry),
  ])
    if ("kind" in mapping) expect(lookupAction(mapping.kind)).toBeDefined();
});
it("does not disguise host-only variants or unfinished removal adapters as migrated", () => {
  for (const kind of [
    "checkoutAndOpen",
    "reconcile",
    "changeFiletype",
    "integrate",
    "copy",
    "branch",
    "clean",
    "tagWithLabel",
  ] as CanonicalAction[]) {
    expect(lookupAction(kind)).toMatchObject({
      state: "hostOnly",
      stage: "3a",
      result: "genericUnknown",
    });
  }
  expect(actionRegistry.deleteLocal.state).toBe("migrated");
  expect(actionRegistry["shelf-delete"].state).toBe("migrated");
  expect(actionRegistry.revert.state).toBe("legacyAdapter");
  expect(actionRegistry["connection-profile-local"].stage).toBe("3c");
});
