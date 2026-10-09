// @vitest-environment jsdom
import { act } from "react";
import { expect, it, vi } from "vitest";
import { dialogButton, dialogHarness } from "../../../app/dialogs/testHarness";
import type {
  RenameMovePreflight,
  RenameMoveTargetSnapshot,
  WorkspaceNode,
} from "../../../shared/contracts/types";
import { RenameDialog } from "./RenameDialog";

const harness = dialogHarness();
const node: WorkspaceNode = {
  id: "a",
  name: "a.txt",
  kind: "file",
  state: "openedEdit",
  absolutePath: "C:\\workspace\\a.txt",
  relativePath: "a.txt",
  depotPath: "//depot/main/a.txt",
  changelistId: 0,
};
const target: RenameMoveTargetSnapshot = {
  server: "server:1666",
  user: "alice",
  client: "workspace",
  workspace: "C:\\workspace",
  activeProfileId: "profile",
  contextGeneration: 3,
  source: {
    depotPath: "//depot/main/a.txt",
    clientPath: "//workspace/a.txt",
    localPath: "C:\\workspace\\a.txt",
  },
  target: {
    depotPath: "//depot/main/b.txt",
    clientPath: "//workspace/b.txt",
    localPath: "C:\\workspace\\b.txt",
  },
  sourceState: {
    action: "edit",
    changeId: 0,
    fileType: "text",
    haveRevision: 1,
    headRevision: 1,
  },
  targetChangeId: 0,
};

function ready(): RenameMovePreflight {
  return {
    ready: true,
    source: target.source,
    target: target.target,
    sourceState: target.sourceState,
    targetChangeId: 0,
    targetChangeValid: true,
    targetExists: false,
    caseOnlyRisk: false,
    blockers: [],
    warnings: [],
    targetSnapshot: target,
    previewDigest: "digest",
    token: "one-use-token",
    expiresAt: Date.now() + 60_000,
    ttlMs: 60_000,
    operationIds: ["preview-op"],
  };
}

async function changeTarget(value: string) {
  await act(async () => {
    const input =
      document.querySelectorAll<HTMLInputElement>("dialog input")[1];
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

it("runs Preview → Review → Confirming → Result and binds the reviewed token", async () => {
  const check = vi.fn().mockResolvedValue(ready());
  const execute = vi.fn().mockResolvedValue({
    outcome: "succeeded",
    message: "Moved",
    operationId: "move-op",
    refresh: {
      workspaceStatus: true,
      pendingChanges: true,
      depotPaths: [target.source.depotPath, target.target.depotPath],
      localPaths: [target.source.localPath, target.target.localPath],
      reason: "refresh",
    },
  });
  const refresh = vi.fn();
  await harness.render(
    <RenameDialog
      node={node}
      source={null}
      zh
      onDismiss={vi.fn()}
      onRefresh={refresh}
      check={check}
      execute={execute}
    />,
  );
  await changeTarget("C:\\workspace\\b.txt");
  await act(async () => dialogButton("预检并审阅").click());
  expect(document.body.textContent).toContain("//depot/main/b.txt");
  expect(document.body.textContent).toContain("预检通过");
  await act(async () => dialogButton("确认重命名 / 移动").click());
  expect(check).toHaveBeenCalledWith(
    expect.objectContaining({
      sourcePath: "C:\\workspace\\a.txt",
      targetPath: "C:\\workspace\\b.txt",
      targetChangeId: 0,
    }),
  );
  expect(execute).toHaveBeenCalledWith(
    expect.objectContaining({
      token: "one-use-token",
      target,
      previewDigest: "digest",
    }),
  );
  expect(document.body.textContent).toContain("Moved");
  expect(refresh).toHaveBeenCalledOnce();
});

it("invalidates a reviewed token whenever destination input changes", async () => {
  const check = vi.fn().mockResolvedValue(ready());
  await harness.render(
    <RenameDialog
      node={node}
      source={null}
      zh
      onDismiss={vi.fn()}
      check={check}
    />,
  );
  await changeTarget("C:\\workspace\\b.txt");
  await act(async () => dialogButton("预检并审阅").click());
  expect(dialogButton("确认重命名 / 移动")).toBeTruthy();
  await changeTarget("C:\\workspace\\c.txt");
  expect(dialogButton("确认重命名 / 移动")).toBeUndefined();
  expect(dialogButton("预检并审阅")).toBeTruthy();
});

it("renders case-only and target-exists blockers without exposing confirm", async () => {
  const blocked = ready();
  blocked.ready = false;
  blocked.token = undefined;
  blocked.targetSnapshot = undefined;
  blocked.caseOnlyRisk = true;
  blocked.targetExists = true;
  blocked.blockers = [
    {
      code: "caseOnlyRename",
      message: "Case-only rename is blocked on Windows.",
    },
    { code: "targetExists", message: "Destination exists." },
  ];
  await harness.render(
    <RenameDialog
      node={node}
      source={null}
      zh
      onDismiss={vi.fn()}
      check={vi.fn().mockResolvedValue(blocked)}
    />,
  );
  await changeTarget("C:\\workspace\\A.txt");
  await act(async () => dialogButton("预检并审阅").click());
  expect(document.body.textContent).toContain("Case-only rename is blocked");
  expect(document.body.textContent).toContain("Destination exists");
  expect(dialogButton("确认重命名 / 移动").disabled).toBe(true);
});

it("shows structured command failure and performs the requested refresh", async () => {
  const refresh = vi.fn();
  await harness.render(
    <RenameDialog
      node={node}
      source={null}
      zh
      onDismiss={vi.fn()}
      onRefresh={refresh}
      check={vi.fn().mockResolvedValue(ready())}
      execute={vi.fn().mockResolvedValue({
        outcome: "failed",
        failure: "commandFailure",
        message: "Server rejected move",
        operationId: "failed-op",
        refresh: {
          workspaceStatus: true,
          pendingChanges: true,
          depotPaths: [target.source.depotPath, target.target.depotPath],
          localPaths: [target.source.localPath, target.target.localPath],
          reason: "Refresh both paths before retrying.",
        },
      })}
    />,
  );
  await changeTarget("C:\\workspace\\b.txt");
  await act(async () => dialogButton("预检并审阅").click());
  await act(async () => dialogButton("确认重命名 / 移动").click());
  expect(document.body.textContent).toContain("commandFailure");
  expect(document.body.textContent).toContain("Refresh both paths");
  expect(refresh).toHaveBeenCalledOnce();
});
