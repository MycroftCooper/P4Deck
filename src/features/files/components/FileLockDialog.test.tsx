// @vitest-environment jsdom
import { act } from "react";
import { expect, it, vi } from "vitest";
import { dialogButton, dialogHarness } from "../../../app/dialogs/testHarness";
import type {
  FileLockPreflight,
  FileLockTargetSnapshot,
  WorkspaceNode,
} from "../../../shared/contracts";
import { FileLockDialog } from "./FileLockDialog";

const harness = dialogHarness();
const nodes: WorkspaceNode[] = ["a", "b"].map((name) => ({
  id: name,
  name: `${name}.bin`,
  kind: "file",
  state: "openedEdit",
  absolutePath: `C:\\workspace\\${name}.bin`,
  relativePath: `${name}.bin`,
  depotPath: `//depot/main/${name}.bin`,
  changelistId: name === "a" ? 0 : 17,
}));

const target: FileLockTargetSnapshot = {
  server: "localhost:1666",
  user: "alice",
  client: "workspace",
  workspace: "C:\\workspace",
  activeProfileId: "profile",
  contextGeneration: 4,
  operation: "lock",
  files: nodes.map((node) => ({
    inputPath: node.depotPath!,
    depotPath: node.depotPath!,
    clientPath: node.depotPath!.replace("//depot/main", "//workspace"),
    localPath: node.absolutePath,
    openedAction: "edit",
    changelistId: node.changelistId!,
    fileType: node.id === "a" ? "binary+l" : "binary",
    exclusive: node.id === "a",
    ownership: "unlocked",
    otherOpen: [],
    permission: "allowed",
    applicable: true,
  })),
};

function ready(): FileLockPreflight {
  return {
    ready: true,
    operation: "lock",
    files: target.files,
    counts: {
      requested: 2,
      applicable: 2,
      alreadySatisfied: 0,
      blocked: 0,
      exclusive: 1,
    },
    blockers: [],
    warnings: [],
    targetSnapshot: target,
    stateDigest: "state-digest",
    token: "one-use-token",
    expiresAt: Date.now() + 60_000,
    ttlMs: 60_000,
    operationIds: ["preview:fstat"],
  };
}

it("reviews the full locked file set and binds token, snapshot and digest", async () => {
  const check = vi.fn().mockResolvedValue(ready());
  const execute = vi.fn().mockResolvedValue({
    outcome: "partial",
    message: "1 satisfied, 1 failed; no rollback",
    files: [
      {
        depotPath: "//depot/main/a.bin",
        outcome: "succeeded",
        message: "verified",
        ownership: "ours",
      },
      {
        depotPath: "//depot/main/b.bin",
        outcome: "failed",
        message: "other owner",
        ownership: "other",
        lockOwner: "bob@other",
      },
    ],
    operationId: "lock-op",
    refresh: {
      workspaceStatus: true,
      pendingChanges: true,
      search: true,
      review: true,
      depotPaths: target.files.map((file) => file.depotPath),
      localPaths: target.files.map((file) => file.localPath!),
      reason: "refresh before retry",
    },
  });
  const refresh = vi.fn();
  await harness.render(
    <FileLockDialog
      nodes={nodes}
      operation="lock"
      source={null}
      connectionKey="connection-a"
      zh
      onDismiss={vi.fn()}
      onRefresh={refresh}
      check={check}
      execute={execute}
    />,
  );
  await act(async () => dialogButton("开始预检").click());
  expect(document.body.textContent).toContain("binary+l · +l");
  expect(document.body.textContent).toContain("//depot/main/b.bin");
  await act(async () => dialogButton("确认锁定").click());
  expect(check).toHaveBeenCalledWith({
    operation: "lock",
    paths: ["//depot/main/a.bin", "//depot/main/b.bin"],
    operationId: expect.any(String),
  });
  expect(execute).toHaveBeenCalledWith({
    token: "one-use-token",
    target,
    stateDigest: "state-digest",
    operationId: expect.any(String),
  });
  expect(document.body.textContent).toContain("partial");
  expect(document.body.textContent).toContain("bob@other");
  expect(document.body.textContent).toContain("人工重试");
  expect(refresh).toHaveBeenCalledOnce();
});

it("keeps confirmed blockers visible and never enables execution", async () => {
  const blocked = ready();
  blocked.ready = false;
  blocked.token = undefined;
  blocked.targetSnapshot = undefined;
  blocked.counts = { ...blocked.counts, applicable: 0, blocked: 2 };
  blocked.blockers = [
    {
      code: "lockedByOther",
      certainty: "confirmed",
      message: "bob@other owns this lock",
      paths: ["//depot/main/a.bin"],
    },
  ];
  await harness.render(
    <FileLockDialog
      nodes={nodes}
      operation="lock"
      source={null}
      connectionKey="connection-a"
      zh
      onDismiss={vi.fn()}
      check={vi.fn().mockResolvedValue(blocked)}
    />,
  );
  await act(async () => dialogButton("开始预检").click());
  expect(document.body.textContent).toContain("bob@other owns this lock");
  expect(dialogButton("确认锁定").disabled).toBe(true);
});

it("discards a late preflight response after the connection changes", async () => {
  let resolve!: (value: FileLockPreflight) => void;
  const check = vi.fn(
    () => new Promise<FileLockPreflight>((done) => (resolve = done)),
  );
  const render = (connectionKey: string) => (
    <FileLockDialog
      nodes={nodes}
      operation="lock"
      source={null}
      connectionKey={connectionKey}
      zh
      onDismiss={vi.fn()}
      check={check}
    />
  );
  await harness.render(render("connection-a"));
  await act(async () => dialogButton("开始预检").click());
  await harness.render(render("connection-b"));
  await act(async () => resolve(ready()));
  expect(document.body.textContent).not.toContain("binary+l · +l");
  expect(dialogButton("开始预检")).toBeTruthy();
});
