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

it("moves a frozen deduplicated drop immediately without mounting a dialog", async () => {
  const check = vi.fn().mockResolvedValue(ready());
  const execute = vi.fn().mockResolvedValue(success());
  await render(
    { from: 10, target: 0, paths: ["//depot/a", "//depot/a"], source: null },
    { check, execute },
  );
  expect(document.querySelector("dialog")).toBeNull();
  expect(check).toHaveBeenCalledOnce();
  expect(check.mock.calls[0][0]).toMatchObject({
    targetChangeId: 0,
    depotPaths: ["//depot/a"],
  });
  expect(execute).toHaveBeenCalledOnce();
  expect(execute.mock.calls[0][0]).toMatchObject({ token: "token", target });
  expect(dismiss).toHaveBeenCalledOnce();
});

it("returns success before a background refresh finishes", async () => {
  const onResult = vi.fn(
    () => new Promise<void>(() => {}),
  );
  await render(
    { from: 10, target: 0, paths: ["//depot/a"], source: null },
    { onResult },
  );
  expect(onResult).toHaveBeenCalledOnce();
  expect(dismiss).toHaveBeenCalledOnce();
  expect(document.querySelector('[role="alert"]')).toBeNull();
});

it("menu entry only asks for a destination, then moves on one click", async () => {
  const execute = vi.fn().mockResolvedValue(success());
  await render(undefined, { execute });
  expect(document.querySelector("dialog")).not.toBeNull();
  expect(document.body.textContent).not.toContain("预检");
  expect(document.body.textContent).not.toContain("确认移动");
  await act(async () => button("DefaultChange 0").click());
  expect(execute).toHaveBeenCalledOnce();
  expect(dismiss).toHaveBeenCalledOnce();
});

it("reports partial failures without presenting them as full success or opening a dialog", async () => {
  const execute = vi.fn().mockResolvedValue(
    success({
      outcome: "partial",
      message: "Some files were not confirmed moved.",
      files: [
        {
          depotPath: "//depot/a",
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
  expect(document.querySelector("dialog")).toBeNull();
  expect(document.querySelector('[role="alert"]')!.textContent).toContain(
    "Target rejected this file",
  );
  expect(dismiss).not.toHaveBeenCalled();
});

it("stops before writing when automatic checks reject the selected files", async () => {
  const execute = vi.fn();
  const check = vi.fn().mockResolvedValue(
    ready({
      ready: false,
      token: undefined,
      blockers: [
        {
          code: "lockedFile",
          certainty: "confirmed",
          message: "File is locked",
          paths: ["//depot/a"],
        },
      ],
    }),
  );
  await render(
    { from: 10, target: 0, paths: ["//depot/a"], source: null },
    { check, execute },
  );
  expect(execute).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain("File is locked");
});

it("does not execute a delayed check after the connection changes", async () => {
  let finish!: (value: MoveFilesPreflight) => void;
  const check = vi.fn(
    () =>
      new Promise<MoveFilesPreflight>((resolve) => {
        finish = resolve;
      }),
  );
  const execute = vi.fn();
  const cancel = vi.spyOn(backend, "cancelOperation").mockResolvedValue();
  const request = { from: 10, target: 0, paths: ["//depot/a"], source: null };
  await render(request, { check, execute });
  await render(request, { check, execute, connectionKey: "connection-b" });
  await act(async () => finish(ready()));
  expect(execute).not.toHaveBeenCalled();
  expect(cancel).toHaveBeenCalled();
  expect(document.body.textContent).toContain("连接或工作区已改变");
  cancel.mockRestore();
});

it("treats a repeated same-target drop as a no-op without checking or writing", async () => {
  const check = vi.fn();
  const execute = vi.fn();
  await render(
    { from: 10, target: 10, paths: ["//depot/a"], source: null },
    { check, execute },
  );
  expect(check).not.toHaveBeenCalled();
  expect(execute).not.toHaveBeenCalled();
  expect(document.querySelector("dialog")).toBeNull();
  expect(dismiss).toHaveBeenCalledOnce();
});

it("blocks duplicate destination clicks while moving", async () => {
  const check = vi.fn().mockReturnValue(new Promise(() => {}));
  await render(undefined, { check });
  await act(async () => {
    button("DefaultChange 0").click();
    button("DefaultChange 0").click();
  });
  expect(check).toHaveBeenCalledOnce();
  expect(button("DefaultChange 0").disabled).toBe(true);
});
