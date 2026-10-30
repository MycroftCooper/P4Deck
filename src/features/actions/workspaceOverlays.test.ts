import { expect, it } from "vitest";
import {
  beginGenericFileProjection,
  withdrawGenericFileProjection,
  resetGenericFileProjectionsForTests,
} from "./genericFileProjection";
import {
  beginLocalIoProjection,
  resetLocalIoProjectionsForTests,
  withdrawLocalIoProjection,
} from "./localIoLifecycle";
import {
  beginFileLockProjection,
  resetFileLockProjectionsForTests,
  settleFileLockProjection,
} from "./fileLockProjection";
import { composeWorkspaceOverlays } from "./workspaceOverlays";
import type {
  FileActionRequest,
  FileLockResult,
  WorkspaceNode,
} from "../../shared/contracts";

const scope = "connection-b1";
const row = (): WorkspaceNode =>
  ({
    id: "C:/ws/a",
    name: "a",
    kind: "file",
    absolutePath: "C:/ws/a",
    depotPath: "//d/a",
    relativePath: "a",
    state: "untracked",
    status: { lockOwnership: "unlocked" },
  }) as unknown as WorkspaceNode;
const checkoutRequest = (paths: string[]): FileActionRequest =>
  ({ action: "add", paths, states: ["untracked"] }) as FileActionRequest;

function resetAll() {
  resetGenericFileProjectionsForTests();
  resetLocalIoProjectionsForTests();
  resetFileLockProjectionsForTests();
}

it("one row shows generic + localIo + fileLock projections together (orthogonal merge)", () => {
  resetAll();
  beginGenericFileProjection(
    scope,
    "op-generic",
    checkoutRequest(["C:/ws/a"]),
    "tk-a",
  );
  // rename projects the row path AND keeps the generic projected state on the same row.
  beginLocalIoProjection({
    operationId: "op-local",
    kind: "renameMove",
    scope,
    fromPath: "C:/ws/a",
    toPath: "C:/ws/b",
  });
  // lock iterates after the rename, so it matches the projected target path.
  beginFileLockProjection("op-lock", "lock", ["C:/ws/b"], scope);
  const rows = composeWorkspaceOverlays([row()], scope, "tk-a");
  expect(rows).toHaveLength(1);
  expect(rows[0].state).toBe("openedAdd"); // generic overlay
  expect(rows[0].absolutePath).toBe("C:/ws/b"); // localIo rename overlay
  expect(rows[0].name).toBe("b");
  expect(rows[0].status?.lockOwnership).toBe("ours"); // fileLock overlay
});
it("withdrawing/unknown one overlay leaves the other two visible", () => {
  resetAll();
  beginGenericFileProjection(
    scope,
    "op-generic",
    checkoutRequest(["C:/ws/a"]),
    "tk-a",
  );
  beginLocalIoProjection({
    operationId: "op-local",
    kind: "renameMove",
    scope,
    fromPath: "C:/ws/a",
    toPath: "C:/ws/b",
  });
  beginFileLockProjection("op-lock", "lock", ["C:/ws/b"], scope);
  // unknown generic result: generic only withdraws; path+lock stay visible.
  withdrawGenericFileProjection("op-generic", "tk-a");
  let rows = composeWorkspaceOverlays([row()], scope, "tk-a");
  expect(rows[0].state).toBe("untracked");
  expect(rows[0].absolutePath).toBe("C:/ws/b");
  expect(rows[0].status?.lockOwnership).toBe("ours");
  // pre-dispatch lock rejection (no execution) only withdraws the fileLock overlay.
  settleFileLockProjection(
    "op-lock",
    {
      outcome: "rejected",
      files: [],
      message: "",
      refresh: {
        workspaceStatus: false,
        pendingChanges: false,
        search: false,
        review: false,
        depotPaths: [],
        localPaths: [],
        reason: "",
      },
    } as unknown as FileLockResult,
    false,
  );
  // re-create the generic projection, then withdraw localIo: generic + lock remain.
  beginGenericFileProjection(
    scope,
    "op-generic2",
    checkoutRequest(["C:/ws/a"]),
    "tk-a",
  );
  withdrawLocalIoProjection("op-local");
  rows = composeWorkspaceOverlays([row()], scope, "tk-a");
  expect(rows[0].state).toBe("openedAdd");
  expect(rows[0].absolutePath).toBe("C:/ws/a");
  expect(rows[0].status?.lockOwnership).toBe("unlocked");
});
it("scope drift discards: projections registered for another scope never apply", () => {
  resetAll();
  beginGenericFileProjection(
    "other-scope",
    "op-generic",
    checkoutRequest(["C:/ws/a"]),
    "tk-a",
  );
  beginLocalIoProjection({
    operationId: "op-local",
    kind: "renameMove",
    scope: "other-scope",
    fromPath: "C:/ws/a",
    toPath: "C:/ws/b",
  });
  beginFileLockProjection("op-lock", "lock", ["C:/ws/a"], "other-scope");
  const rows = composeWorkspaceOverlays([row()], scope, "tk-a");
  expect(rows[0].state).toBe("untracked");
  expect(rows[0].absolutePath).toBe("C:/ws/a");
  expect(rows[0].status?.lockOwnership).toBe("unlocked");
});
it("targetKey drift only drops the generic overlay; localIo/lock are scope-only", () => {
  resetAll();
  beginGenericFileProjection(
    scope,
    "op-generic",
    checkoutRequest(["C:/ws/a"]),
    "tk-a",
  );
  beginLocalIoProjection({
    operationId: "op-local",
    kind: "renameMove",
    scope,
    fromPath: "C:/ws/a",
    toPath: "C:/ws/b",
  });
  beginFileLockProjection("op-lock", "lock", ["C:/ws/b"], scope);
  const rows = composeWorkspaceOverlays([row()], scope, "tk-b");
  expect(rows[0].state).toBe("untracked"); // generic dropped on targetKey drift
  expect(rows[0].absolutePath).toBe("C:/ws/b"); // localIo still applies
  expect(rows[0].status?.lockOwnership).toBe("ours"); // fileLock still applies
});
