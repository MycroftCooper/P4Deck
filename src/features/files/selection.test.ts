import { expect, it } from "vitest";
import type { WorkspaceNode } from "../../shared/contracts";
import { containsNode, nodeKey, selectionKeys, selectRange } from "./selection";
import {
  affectedPathAliases,
  compactTargets,
  selectionRequest,
} from "./selectionCommands";
const make = (
  name: string,
  kind: WorkspaceNode["kind"] = "file",
): WorkspaceNode => ({
  id: name,
  name,
  kind,
  absolutePath: `/root/${name}`,
  relativePath: name,
  depotPath: `//depot/${name}`,
  state: "controlled",
});
const rows = [make("a"), make("b"), make("c"), make("d")];
it("replaces, toggles on both platforms, and deselects the last item", () => {
  expect(selectRange([rows[1]], rows, rows[0], undefined, {})).toEqual([
    rows[0],
  ]);
  const two = selectRange([rows[0]], rows, rows[2], undefined, {
    metaKey: true,
  });
  expect(two).toEqual([rows[0], rows[2]]);
  expect(selectRange(two, rows, rows[0], undefined, { ctrlKey: true })).toEqual(
    [rows[2]],
  );
  expect(
    selectRange([rows[0]], rows, rows[0], undefined, { metaKey: true }),
  ).toEqual([]);
});
it("ranges use filtered data order, including rows not mounted by virtualization", () => {
  expect(
    selectRange([], rows, rows[3], nodeKey(rows[1]), { shiftKey: true }),
  ).toEqual(rows.slice(1));
  expect(
    selectRange([rows[3]], rows, rows[0], nodeKey(rows[2]), {
      shiftKey: true,
      ctrlKey: true,
    }),
  ).toHaveLength(4);
  expect(
    selectRange([], [rows[0], rows[3]], rows[3], nodeKey(rows[0]), {
      shiftKey: true,
    }),
  ).toEqual([rows[0], rows[3]]);
});
it("matches Depot and workspace selections by paths, not view-specific ids", () => {
  expect(
    containsNode(selectionKeys([rows[0]]), {
      ...rows[0],
      id: "another",
      absolutePath: "",
    }),
  ).toBe(true);
  expect(
    containsNode(
      selectionKeys([
        { ...rows[0], depotPath: undefined, absolutePath: "C:\\Work\\a" },
      ]),
      { ...rows[0], absolutePath: "C:/work/a" },
    ),
  ).toBe(true);
});
it("collapses nested selections without matching sibling prefixes", () => {
  const folder = make("src", "directory");
  expect(
    compactTargets([
      folder,
      make("src/a"),
      make("src/nested", "directory"),
      make("src-other/a"),
      folder,
    ]),
  ).toEqual([folder, make("src-other/a")]);
});
it("adds local aliases to confirmed depot paths for scoped cache invalidation", () => {
  expect(affectedPathAliases(["//depot/a"], [rows[0]])).toEqual([
    "//depot/a",
    "/root/a",
  ]);
  expect(affectedPathAliases([], rows)).toEqual([]);
  expect(affectedPathAliases(undefined, rows)).toBeUndefined();
});
it("builds one batch with recursive folder filespecs and never locally deletes an untracked folder", () => {
  const folder = { ...make("src", "directory"), state: "untracked" as const };
  const request = selectionRequest(
    "delete",
    [folder, make("src/a"), rows[0]],
    "operation",
  );
  expect(request.action).toBe("markForDelete");
  expect(request.paths).toEqual(["//depot/src/...", "//depot/a"]);
  expect(request.operationId).toBe("operation");
});
it("scopes revert unchanged to its CL and retains every explicit file", () => {
  const targets = [make("a"), make("b")].map((item) => ({
    ...item,
    state: "openedEdit" as const,
    changelistId: 0,
  }));
  expect(selectionRequest("revertUnchanged", targets)).toMatchObject({
    action: "revertUnchanged",
    changelistId: 0,
    paths: ["//depot/a", "//depot/b"],
  });
  expect(
    selectionRequest(
      "revertUnchanged",
      targets.map((item) => ({ ...item, changelistId: 202 })),
    ).changelistId,
  ).toBe(202);
});
it("marks a whole-changelist revert only when the caller proves the full scope", () => {
  const partial = selectionRequest("revert", rows.slice(0, 2), "operation");
  expect(partial).not.toHaveProperty("revertWholeChangelist");
  expect(partial).not.toHaveProperty("changelistId");

  expect(selectionRequest("revert", rows, "operation", 202)).toMatchObject({
    action: "revert",
    changelistId: 202,
    revertWholeChangelist: true,
    paths: ["//depot/a", "//depot/b", "//depot/c", "//depot/d"],
  });
  expect(selectionRequest("revert", rows, "operation", 0)).toMatchObject({
    action: "revert",
    changelistId: 0,
    revertWholeChangelist: true,
  });
});
it("adds folders with add-only reconciliation and escapes local reserved characters", () => {
  const request = selectionRequest("add", [
    { ...make("my #dir", "directory"), depotPath: undefined },
  ]);
  expect(request.action).toBe("addRecursive");
  expect(request.paths).toEqual(["/root/my %23dir/..."]);
  expect(selectionRequest("getLatest", rows).paths).toHaveLength(4);
});
