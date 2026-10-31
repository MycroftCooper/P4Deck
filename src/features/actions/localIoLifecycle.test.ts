import { expect, it } from "vitest";
import {
  beginLocalIoProjection,
  clearLocalIoProjection,
  isLocalIoResult,
  lifecycleOf,
  localIoProjectionsSnapshot,
  projectLocalIoNodes,
  resetLocalIoProjectionsForTests,
  settleLocalIoProjection,
  unwrapLocalIoLegacy,
  type LocalIoActionResultLike,
} from "./localIoLifecycle";
import type { WorkspaceNode } from "../../shared/contracts";

const node = (
  path: string,
  state = "controlled",
  changelistId = 0,
): WorkspaceNode =>
  ({
    id: path,
    name: path.split(/[\\/]/).filter(Boolean).at(-1) ?? path,
    relativePath: "",
    absolutePath: state === "openedEdit" ? path : path,
    depotPath: path,
    kind: "file",
    state,
    changelistId,
  }) as WorkspaceNode;
const result = (
  kind: LocalIoActionResultLike["kind"],
  state: LocalIoActionResultLike["state"],
  outcome: string,
  files: LocalIoActionResultLike["files"] = [],
): LocalIoActionResultLike => ({
  kind,
  operationId: "op",
  state,
  outcome,
  files,
  message: "",
});

it("rename projects the row source -> target immediately (path and name)", () => {
  resetLocalIoProjectionsForTests();
  const scope = "s1";
  expect(
    beginLocalIoProjection({
      operationId: "r1",
      kind: "renameMove",
      scope,
      fromPath: "C:/ws/a",
      toPath: "C:/ws/b",
    }),
  ).toBe(true);
  const rows = projectLocalIoNodes([node("C:/ws/a")], scope);
  expect(rows[0].absolutePath).toBe("C:/ws/b");
  expect(rows[0].name).toBe("b");
  // Base rows outside the source path and other scopes are untouched.
  expect(
    projectLocalIoNodes([node("C:/ws/other")], scope)[0].absolutePath,
  ).toBe("C:/ws/other");
  expect(projectLocalIoNodes([node("C:/ws/a")], "other")[0].absolutePath).toBe(
    "C:/ws/a",
  );
  settleLocalIoProjection(
    "r1",
    result("renameMove", "committed", "succeeded"),
    true,
  );
  expect(localIoProjectionsSnapshot()).toHaveLength(0);
});
it("sync projects the target state; unknown rows are never guessed", () => {
  resetLocalIoProjectionsForTests();
  beginLocalIoProjection({
    operationId: "s-1",
    kind: "syncRevision",
    paths: ["//d/a"],
    targetState: "controlled",
  });
  const rows = projectLocalIoNodes([node("//d/a", "outOfDate")]);
  expect(rows[0].state).toBe("controlled");
  // change/date/label kinds are unprovable per wire: caller simply does not project them.
  beginLocalIoProjection({
    operationId: "s-2",
    kind: "syncRevision",
    paths: ["//d/b"],
  });
  expect(projectLocalIoNodes([node("//d/b", "outOfDate")])[0].state).toBe(
    "outOfDate",
  );
  clearLocalIoProjection("s-1");
  clearLocalIoProjection("s-2");
});
it("undo projects openedEdit in the target changelist", () => {
  resetLocalIoProjectionsForTests();
  beginLocalIoProjection({
    operationId: "u1",
    kind: "undoChange",
    paths: ["//d/a"],
    targetState: "openedEdit",
    changelistId: 12,
  });
  const rows = projectLocalIoNodes([node("//d/a", "notSynced", 3)]);
  expect(rows[0].state).toBe("openedEdit");
  expect(rows[0].changelistId).toBe(12);
});
it("unknown/rejected withdraw immediately; committed keeps until refresh succeeds; failed refresh keeps provisional", () => {
  resetLocalIoProjectionsForTests();
  beginLocalIoProjection({
    operationId: "x",
    kind: "syncRevision",
    paths: ["//d/a"],
    targetState: "controlled",
  });
  settleLocalIoProjection(
    "x",
    result("syncRevision", "unknown", "unknown"),
    true,
  );
  expect(localIoProjectionsSnapshot()).toHaveLength(0);
  beginLocalIoProjection({
    operationId: "y",
    kind: "syncRevision",
    paths: ["//d/a"],
    targetState: "controlled",
  });
  settleLocalIoProjection(
    "y",
    result("syncRevision", "committed", "succeeded"),
    false,
  );
  expect(localIoProjectionsSnapshot()[0].phase).toBe("confirmed");
  settleLocalIoProjection(
    "y",
    result("syncRevision", "committed", "succeeded"),
    true,
  );
  expect(localIoProjectionsSnapshot()).toHaveLength(0);
  beginLocalIoProjection({
    operationId: "z",
    kind: "syncRevision",
    paths: ["//d/a"],
    targetState: "controlled",
  });
  settleLocalIoProjection(
    "z",
    result("syncRevision", "rejected", "rejected"),
    true,
  );
  expect(localIoProjectionsSnapshot()).toHaveLength(0);
});
it("partial keeps only succeeded rows and never promotes affectedPaths-only facts", () => {
  resetLocalIoProjectionsForTests();
  beginLocalIoProjection({
    operationId: "p",
    kind: "syncRevision",
    paths: ["//d/a", "//d/b"],
  });
  settleLocalIoProjection(
    "p",
    result("syncRevision", "committed", "partial", [
      { depotPath: "//d/a", state: "succeeded", message: "" },
      { depotPath: "//d/b", state: "unknown", message: "unprovable" },
    ]),
    true,
  );
  expect(localIoProjectionsSnapshot()[0].paths).toEqual(["//d/a"]);
});
it("legacy compat: old payload keeps working, new payload exposes lifecycle and legacy fields", () => {
  const legacy = {
    outcome: "succeeded",
    operationId: "old",
    files: [],
  } as unknown as { outcome: string };
  expect(isLocalIoResult(legacy)).toBe(false);
  expect(unwrapLocalIoLegacy(legacy)).toBe(legacy);
  expect(lifecycleOf(legacy)).toBeUndefined();
  const wrapped = {
    ...result("undoChange", "committed", "succeeded"),
    legacy: { exitCode: 0, events: [] },
  } as unknown as LocalIoActionResultLike;
  expect(lifecycleOf(wrapped)?.state).toBe("committed");
  expect(
    (unwrapLocalIoLegacy(wrapped) as unknown as { exitCode: number }).exitCode,
  ).toBe(0);
});
