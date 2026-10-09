// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { dialogHarness } from "../../../app/dialogs/testHarness";
import { backend } from "../../../infrastructure/backend";
import type {
  MoveFilesPreflight,
  MoveFilesResult,
  PendingChange,
} from "../../../shared/contracts/types";
import { MoveFilesDialog, type MoveFilesRequest } from "./MoveFilesDialog";

const root = dialogHarness();
const dismiss = vi.fn();
const changes: PendingChange[] = [0, 10, 20].map((id) => ({
  id,
  description: `Change ${id}`,
  user: "tester",
  client: "workspace",
  status: "pending",
  jobs: [],
  files: [],
  shelvedFiles: [],
}));
const target = {
  kind: "move" as const,
  server: "fixture:1666",
  user: "tester",
  client: "workspace",
  workspace: "/workspace",
  contextGeneration: 1,
  targetChangeId: 0,
  depotPaths: ["//depot/a"],
};
const ready = (
  overrides: Partial<MoveFilesPreflight> = {},
): MoveFilesPreflight => ({
  ready: true,
  target,
  files: [
    {
      depotPath: "//depot/a",
      sourceChangeId: 10,
      action: "edit",
      movable: true,
    },
  ],
  blockers: [],
  warnings: [],
  contentDigest: "digest",
  token: "token",
  expiresAt: Date.now() + 60_000,
  ttlMs: 60_000,
  operationIds: ["preflight"],
  ...overrides,
});
const success = (
  overrides: Partial<MoveFilesResult> = {},
): MoveFilesResult => ({
  outcome: "succeeded",
  message: "Moved 1 file(s).",
  operationIds: ["move:1"],
  files: [
    {
      depotPath: "//depot/a",
      state: "succeeded",
      message: "Moved",
      operationId: "move:1",
    },
  ],
  affectedChanges: [0, 10],
  refreshedChanges: [],
  refresh: {
    pendingChanges: true,
    workspaceStatus: true,
    depotPaths: ["//depot/a"],
    reason: "refresh",
  },
  ...overrides,
});

beforeEach(() => dismiss.mockClear());

async function render(
  request: MoveFilesRequest = {
    from: 10,
    paths: ["//depot/a", "//depot/a"],
    source: null,
  },
  overrides: Partial<ComponentProps<typeof MoveFilesDialog>> = {},
) {
  await act(async () =>
    root.render(
      <MoveFilesDialog
        request={request}
        changes={changes}
        client="workspace"
        connectionKey="connection-a"
        zh
        onDismiss={dismiss}
        check={vi.fn().mockResolvedValue(ready())}
        execute={vi.fn().mockResolvedValue(success())}
        {...overrides}
      />,
    ),
  );
}

function button(text: string) {
  return [...document.querySelectorAll("button")].find(
    (item) => item.textContent === text,
  )!;
}

it("preflights the frozen, deduplicated numbered-to-Default snapshot", async () => {
  const check = vi.fn().mockResolvedValue(ready());
  await render(undefined, { check });
  const select = document.querySelector("select")!;
  await act(async () => {
    select.value = "0";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await act(async () => button("预检（不执行）").click());
  expect(check).toHaveBeenCalledOnce();
  expect(check.mock.calls[0][0]).toMatchObject({
    targetChangeId: 0,
    depotPaths: ["//depot/a"],
  });
  expect(document.body.textContent).toContain("预检通过：1 个文件");
  expect(dismiss).not.toHaveBeenCalled();
});

it("confirms only the returned token/target and closes on verified success", async () => {
  const execute = vi.fn().mockResolvedValue(success());
  await render(
    { from: 10, target: 0, paths: ["//depot/a"], source: null },
    { execute },
  );
  await act(async () => button("预检（不执行）").click());
  await act(async () => button("确认移动").click());
  expect(execute).toHaveBeenCalledOnce();
  expect(execute.mock.calls[0][0]).toMatchObject({ token: "token", target });
  expect(dismiss).toHaveBeenCalledOnce();
});

it("keeps partial failures visible and never presents them as full success", async () => {
  const execute = vi.fn().mockResolvedValue(
    success({
      outcome: "partial",
      message: "Moved 1 file(s); 1 file(s) were not confirmed moved.",
      files: [
        success().files[0],
        {
          depotPath: "//depot/b",
          state: "failed",
          message: "Target rejected this file",
        },
      ],
    }),
  );
  await render(
    { from: 10, target: 0, paths: ["//depot/a"], source: null },
    { execute },
  );
  await act(async () => button("预检（不执行）").click());
  await act(async () => button("确认移动").click());
  expect(document.body.textContent).toContain("not confirmed moved");
  expect(document.body.textContent).toContain("Target rejected this file");
  expect(dismiss).not.toHaveBeenCalled();
});

it("invalidates an old preview when target or connection changes", async () => {
  await render({ from: 0, target: 10, paths: ["//depot/a"], source: null });
  await act(async () => button("预检（不执行）").click());
  expect(document.body.textContent).toContain("确认移动");
  await act(async () => {
    const select = document.querySelector("select")!;
    select.value = "20";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(document.body.textContent).not.toContain("确认移动");
  await render(
    { from: 0, target: 10, paths: ["//depot/a"], source: null },
    { connectionKey: "connection-b" },
  );
  expect(document.body.textContent).toContain("连接或 Workspace 已改变");
});

it("blocks empty and repeated same-target drops before preflight", async () => {
  await render({ from: 10, target: 10, paths: ["//depot/a"], source: null });
  expect(button("预检（不执行）").disabled).toBe(true);
  expect(document.body.textContent).toContain("已跳过本来就在目标 CL");
});

it("cancels the active grouped operation instead of dismissing a busy dialog", async () => {
  const check = vi.fn().mockReturnValue(new Promise(() => undefined));
  const cancel = vi
    .spyOn(backend, "cancelOperation")
    .mockResolvedValue(undefined);
  await render(
    { from: 10, target: 0, paths: ["//depot/a"], source: null },
    { check },
  );
  await act(async () => button("预检（不执行）").click());
  const operationId = check.mock.calls[0][0].operationId;
  await act(async () => button("取消操作").click());
  expect(cancel).toHaveBeenCalledWith(operationId);
  expect(dismiss).not.toHaveBeenCalled();
  cancel.mockRestore();
});
