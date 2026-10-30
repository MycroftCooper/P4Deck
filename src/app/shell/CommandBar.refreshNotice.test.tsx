// @vitest-environment jsdom
import { act } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { dialogHarness } from "../dialogs/testHarness";
import { CommandBar } from "./CommandBar";
import type { CommandId, CommandTarget } from "./commandPolicy";
import type { RuntimeInfo } from "../../shared/contracts";
const deps = vi.hoisted(() => ({
  refresh: vi.fn(),
  invalidate: vi.fn(),
  action: vi.fn(),
  revert: vi.fn(),
  feedback: vi.fn(),
  busy: vi.fn(),
}));
vi.mock("../../infrastructure/backend", () => ({
  backend: {
    performFileAction: deps.action,
    subscribeOperationEvents: async () => () => {},
  },
}));
vi.mock("../context-menu/ContextMenu", () => ({
  useContextMenu: () => () => ({}),
}));
vi.mock("../context-menu/environment", () => ({
  useMenuEnvironment: () => ({
    preferences: { ui: { toolbarText: true } },
    openPage: vi.fn(),
  }),
}));
vi.mock("../dialogs/useCommandDialogs", () => ({
  useCommandDialogs: () => ({ pending: false, element: null }),
  refreshFileLockFacts: deps.refresh,
}));
vi.mock("./useLocalPathCapabilities", () => ({
  useLocalPathCapabilities: () => ({ reveal: false, openWith: false }),
}));
vi.mock("../../shared/cache/dataEffects", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/cache/dataEffects")>()),
  invalidateData: deps.invalidate,
}));
vi.mock("../../features/files/resolveSelection", () => ({
  resolveSelection: async (nodes: unknown) => nodes,
}));
// Revert was migrated to the durable revert task (S2b); CommandBar no longer
// calls performFileAction for revert/revertUnchanged.
vi.mock("../../features/actions/revertTask", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../features/actions/revertTask")
  >()),
  startRevert: deps.revert,
}));
const root = dialogHarness();
const runtime: RuntimeInfo = {
  mode: "mock",
  p4Version: "synthetic",
  contextGeneration: 1,
  context: { server: "fixture.invalid", user: "u", client: "c" },
  connection: {
    state: "connected",
    message: "mock",
    recovery: "none",
    server: "fixture.invalid",
  },
};
const target: CommandTarget = {
  type: "file",
  node: {
    id: "//fixture/a",
    depotPath: "//fixture/a",
    name: "a",
    kind: "file",
    absolutePath: "",
    relativePath: "a",
    state: "openedEdit",
  },
};
let handler: ((id: CommandId, target?: CommandTarget) => void) | undefined;
beforeEach(() => {
  vi.clearAllMocks();
  deps.refresh.mockResolvedValue(undefined);
  deps.invalidate.mockResolvedValue(undefined);
  deps.action.mockResolvedValue({
    message: "fixture changed",
    affectedPaths: [],
    operation: { operationId: "mock-only", exitCode: 0, events: [] },
  });
});
async function mount(zh = false, targetError = "") {
  await root.render(
    <CommandBar
      runtime={runtime}
      zh={zh}
      connectionKey="fixture"
      target={target}
      targetError={targetError}
      onBusyChange={deps.busy}
      onOpenOperations={deps.feedback}
      registerCommand={(h) => {
        handler = h;
      }}
      onNavigate={vi.fn()}
      onFocus={vi.fn()}
      onReview={vi.fn()}
    />,
  );
}
async function run(id: CommandId) {
  await act(async () => {
    handler!(id, target);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}
it.each([false, true])(
  "refresh success removes the completion check without skipping refresh (zh=%s)",
  async (zh) => {
    await mount(zh);
    await run("refresh");
    expect(deps.refresh).toHaveBeenCalledExactlyOnceWith("fixture");
    expect(deps.invalidate).toHaveBeenCalled();
    expect(document.querySelector(".command-status")).toBeNull();
    expect(document.body.textContent).not.toContain(
      zh ? "刷新完成" : "Refresh completed",
    );
    expect(
      [...document.querySelectorAll("button")].some(
        (button) => button.textContent === (zh ? "刷新" : "Refresh"),
      ),
    ).toBe(true);
  },
);
it("keeps fixed controls and prevents duplicate refresh while pending", async () => {
  let done!: () => void;
  deps.refresh.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        done = resolve;
      }),
  );
  await mount();
  const buttons = [
    ...document.querySelectorAll(".command-toolbar-row button"),
  ].map((b) => b.getAttribute("aria-label"));
  await run("refresh");
  expect(deps.busy).toHaveBeenCalledWith(true);
  await run("refresh");
  expect(deps.refresh).toHaveBeenCalledTimes(1);
  expect(document.querySelector(".command-status-slot")).toBeNull();
  expect(
    [...document.querySelectorAll(".command-toolbar-row button")].map((b) =>
      b.getAttribute("aria-label"),
    ),
  ).toEqual(buttons);
  await act(async () => done());
  expect(document.querySelector(".command-status")).toBeNull();
});
it.each([false, true])("preserves refresh errors (zh=%s)", async (zh) => {
  deps.refresh.mockRejectedValue(new Error("synthetic refresh failed"));
  await mount(zh);
  await run("refresh");
  expect(deps.feedback).toHaveBeenCalledWith(
    expect.stringContaining("synthetic refresh failed"),
  );
  expect(document.querySelector(".command-status-slot")).toBeNull();
});
it("keeps other action success out of the toolbar without skipping the action", async () => {
  await mount();
  await run("revertUnchanged");
  // The migrated durable revert task owns execution/reporting; the toolbar must
  // not skip it nor mirror its progress/success into the fixed toolbar.
  expect(deps.revert).toHaveBeenCalledOnce();
  expect(deps.action).not.toHaveBeenCalled();
  expect(document.querySelector(".command-status-slot")).toBeNull();
  expect(deps.feedback).not.toHaveBeenCalled();
  await run("refresh");
  expect(document.querySelector(".command-status")).toBeNull();
});

it.each([false, true])(
  "routes target errors outside the fixed toolbar (zh=%s)",
  async (zh) => {
    await mount(zh, "Synthetic target unavailable");
    expect(deps.feedback).toHaveBeenCalledExactlyOnceWith(
      "Synthetic target unavailable",
    );
    expect(document.querySelector(".command-status-slot")).toBeNull();
  },
);
it("routes revert failures through the durable revert task, not the toolbar", async () => {
  await mount();
  await run("revertUnchanged");
  // The revert task records its own operationId/failure into the frontend
  // operation log (covered by revertTask.test.ts); the fixed toolbar must stay
  // silent and never surface a task id as toolbar status.
  expect(deps.revert).toHaveBeenCalledOnce();
  expect(deps.feedback).not.toHaveBeenCalled();
  expect(document.querySelector(".command-status-slot")).toBeNull();
});
