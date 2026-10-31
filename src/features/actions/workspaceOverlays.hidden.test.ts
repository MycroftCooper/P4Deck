import { expect, it } from "vitest";
import {
  beginGenericFileProjection,
  resetGenericFileProjectionsForTests,
} from "./genericFileProjection";
import {
  beginLocalIoProjection,
  resetLocalIoProjectionsForTests,
} from "./localIoLifecycle";
import {
  beginFileLockProjection,
  resetFileLockProjectionsForTests,
} from "./fileLockProjection";
import {
  startLocalDelete,
  localDeleteHiddenPathsForTests,
  resetLocalDeleteForTests,
  type LocalDeletePort,
} from "./localDeleteTask";
import {
  composeWorkspaceOverlays,
  visibleWorkspaceNodes,
} from "./workspaceOverlays";
import type {
  FileActionResult,
  FileActionRequest,
  RuntimeInfo,
  WorkspaceNode,
} from "../../shared/contracts";

const scope = "connection-b1-fix3";
const runtime = {
  context: { server: "server:1666", user: "tester", client: "workspace" },
} as unknown as RuntimeInfo;
const connection = {
  profileId: "p",
  generation: "1",
  server: "server:1666",
  user: "tester",
  client: "workspace",
};
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
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function resetAll() {
  resetGenericFileProjectionsForTests();
  resetLocalIoProjectionsForTests();
  resetFileLockProjectionsForTests();
  resetLocalDeleteForTests();
}
function threeRowOverlays(targetKey = "tk-a") {
  beginGenericFileProjection(
    scope,
    "op-generic",
    {
      action: "add",
      paths: ["C:/ws/a"],
      states: ["untracked"],
    } as FileActionRequest,
    targetKey,
  );
  beginLocalIoProjection({
    operationId: "op-local",
    kind: "renameMove",
    scope,
    fromPath: "C:/ws/a",
    toPath: "C:/ws/b",
  });
  beginFileLockProjection("op-lock", "lock", ["C:/ws/b"], scope);
}

it("fourth overlay: local-delete pending row is invisible while the three row overlays still compose", () => {
  resetAll();
  threeRowOverlays();
  const port: LocalDeletePort = {
    connection: async () => connection,
    execute: () => new Promise<FileActionResult>(() => undefined),
    cancel: async () => undefined,
  };
  expect(startLocalDelete(scope, runtime, ["C:/ws/b"], () => true, port)).toBe(
    true,
  );
  const hidden = localDeleteHiddenPathsForTests(scope);
  expect(hidden.has("C:/ws/b")).toBe(true);
  const composed = composeWorkspaceOverlays([row()], scope, "tk-a");
  // All three row overlays are still applied on the same row before the visibility filter.
  expect(composed[0].state).toBe("openedAdd");
  expect(composed[0].absolutePath).toBe("C:/ws/b");
  expect(composed[0].status?.lockOwnership).toBe("ours");
  expect(visibleWorkspaceNodes(composed, "all", hidden)).toHaveLength(0);
});
it("local-delete unknown restores visibility and never masks the other overlays", async () => {
  resetAll();
  threeRowOverlays();
  const port: LocalDeletePort = {
    connection: async () => connection,
    execute: async (request) =>
      ({
        message: "",
        affectedPaths: [],
        execution: {
          operationId: request.operationId,
          outcome: "unknown",
          perFileEvidence: "notCollected",
          files: [
            { depotPath: "C:/ws/b", state: "unknown", message: "uncertain" },
          ],
        },
      }) as unknown as FileActionResult,
    cancel: async () => undefined,
  };
  expect(startLocalDelete(scope, runtime, ["C:/ws/b"], () => true, port)).toBe(
    true,
  );
  await flush();
  const hidden = localDeleteHiddenPathsForTests(scope);
  expect(hidden.size).toBe(0);
  const visible = visibleWorkspaceNodes(
    composeWorkspaceOverlays([row()], scope, "tk-a"),
    "all",
    hidden,
  );
  expect(visible).toHaveLength(1);
  expect(visible[0].state).toBe("openedAdd");
  expect(visible[0].status?.lockOwnership).toBe("ours");
});
it("scope drift: another connection's local-delete claim does not hide this scope's row", async () => {
  resetAll();
  threeRowOverlays();
  const port: LocalDeletePort = {
    connection: async () => connection,
    execute: () => new Promise<FileActionResult>(() => undefined),
    cancel: async () => undefined,
  };
  expect(
    startLocalDelete("other-scope", runtime, ["C:/ws/a"], () => true, port),
  ).toBe(true);
  await flush();
  expect(localDeleteHiddenPathsForTests(scope).size).toBe(0);
  expect(
    visibleWorkspaceNodes(
      composeWorkspaceOverlays([row()], scope, "tk-a"),
      "all",
      localDeleteHiddenPathsForTests(scope),
    ),
  ).toHaveLength(1);
});
