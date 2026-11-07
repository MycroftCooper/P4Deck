// @vitest-environment jsdom
import { act } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { dialogHarness } from "../dialogs/testHarness";
import { CommandBar } from "./CommandBar";
import type { CommandId, CommandTarget } from "./commandPolicy";
import type {
  RuntimeInfo,
  SyncPreviewPlan,
  SyncResult,
} from "../../shared/contracts";
import { commandActions } from "../actions/actionCatalog";
import { defaultUi } from "../../features/settings/preferences";
import { setLocale } from "../../shared/i18n";
const deps = vi.hoisted(() => ({
  previewSync: vi.fn(),
  syncLatest: vi.fn(),
  open: vi.fn(),
  invalidate: vi.fn(),
  resolveSelection: vi.fn(),
  refresh: vi.fn(),
  cancel: vi.fn(),
  log: vi.fn(),
  feedback: vi.fn(),
  focus: vi.fn(),
  busy: vi.fn(),
  ui: { toolbarText: true } as {
    toolbarText: boolean;
    getLatestConfirmThreshold?: number;
  },
}));
vi.mock("../../infrastructure/backend", () => ({
  backend: {
    previewSync: deps.previewSync,
    syncLatest: deps.syncLatest,
    cancelOperation: deps.cancel,
    subscribeOperationEvents: async () => () => {},
  },
}));
vi.mock("../../infrastructure/backend/frontendOperationLog", () => ({
  recordFrontendOperationLog: deps.log,
}));
vi.mock("../context-menu/ContextMenu", () => ({
  useContextMenu: () => () => ({}),
}));
vi.mock("../context-menu/environment", () => ({
  useMenuEnvironment: () => ({
    preferences: { ui: deps.ui },
    openPage: vi.fn(),
  }),
}));
vi.mock("../dialogs/useCommandDialogs", () => ({
  useCommandDialogs: () => ({
    pending: false,
    element: null,
    open: deps.open,
  }),
  refreshFileLockFacts: deps.refresh,
}));
vi.mock("./useLocalPathCapabilities", () => ({
  useLocalPathCapabilities: () => ({ reveal: false, openWith: false }),
}));
vi.mock("../../shared/cache/dataEffects", async (original) => ({
  ...(await original<typeof import("../../shared/cache/dataEffects")>()),
  invalidateData: deps.invalidate,
}));
vi.mock("../../features/files/resolveSelection", () => ({
  resolveSelection: deps.resolveSelection,
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
const node = {
  id: "//fixture/a",
  depotPath: "//fixture/a",
  name: "a",
  kind: "file" as const,
  absolutePath: "",
  relativePath: "a",
  state: "openedEdit" as const,
};
const directoryNode = {
  id: "//fixture/dir",
  depotPath: "//fixture/dir",
  name: "dir",
  kind: "directory" as const,
  absolutePath: "",
  relativePath: "dir",
  state: "controlled" as const,
};
const target: CommandTarget = { type: "file", node };
const directoryTarget: CommandTarget = { type: "file", node: directoryNode };
let handler: ((id: CommandId, target?: CommandTarget) => void) | undefined;

function syncResult(overrides: Partial<SyncResult> = {}): SyncResult {
  return {
    outcome: "succeeded",
    message: "ok",
    affectedPaths: ["//fixture/a"],
    counts: {
      added: 0,
      updated: 1,
      deleted: 0,
      upToDate: 0,
      warnings: 0,
      conflicts: 0,
    },
    refreshWorkspace: true,
    refreshDepot: true,
    ...overrides,
  };
}
function previewPlan(
  overrides: Partial<SyncPreviewPlan> = {},
): SyncPreviewPlan {
  return {
    ready: true,
    target: {
      server: "fixture.invalid",
      user: "u",
      client: "c",
      workspace: "",
      contextGeneration: 1,
      paths: ["//fixture/a"],
      revision: { kind: "head", value: "" },
      force: false,
    },
    counts: {
      added: 0,
      updated: 1,
      deleted: 0,
      upToDate: 0,
      warnings: 0,
      conflicts: 0,
    },
    entries: [],
    totalEntries: 0,
    truncated: false,
    partial: false,
    blockers: [],
    warnings: [],
    contentDigest: "digest",
    expiresAt: Date.now() + 60_000,
    ttlMs: 60_000,
    operationIds: [],
    ...overrides,
  };
}
function planWithCounts(overrides: Partial<SyncPreviewPlan["counts"]>) {
  const base = previewPlan();
  return previewPlan({ counts: { ...base.counts, ...overrides } });
}

beforeEach(() => {
  setLocale("en-US");
  vi.clearAllMocks();
  deps.ui = { toolbarText: true };
  deps.invalidate.mockResolvedValue(undefined);
  deps.resolveSelection.mockImplementation(async (nodes: unknown) => nodes);
  deps.refresh.mockResolvedValue(undefined);
  deps.cancel.mockResolvedValue(undefined);
  deps.previewSync.mockResolvedValue(previewPlan());
  deps.syncLatest.mockResolvedValue(syncResult());
  deps.log.mockResolvedValue({ status: "unavailable" });
});

async function mount(
  options: {
    connectionKey?: string;
    target?: CommandTarget;
    runtime?: RuntimeInfo;
  } = {},
) {
  await root.render(
    <CommandBar
      runtime={options.runtime ?? runtime}
      zh={false}
      connectionKey={options.connectionKey ?? "fixture"}
      target={options.target ?? target}
      targetError=""
      onBusyChange={deps.busy}
      onOpenOperations={deps.feedback}
      registerCommand={(h) => {
        handler = h;
      }}
      onNavigate={vi.fn()}
      onFocus={deps.focus}
      onReview={vi.fn()}
    />,
  );
}

async function run(id: CommandId, actionTarget: CommandTarget = target) {
  await act(async () => {
    handler!(id, actionTarget);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function errorNotice() {
  return document.querySelector(".command-notice-error")?.textContent ?? "";
}
function notice() {
  return document.querySelector(".command-notice-warning")?.textContent ?? "";
}
function toolbarButton(label: string) {
  return [
    ...document.querySelectorAll<HTMLButtonElement>(".command-group button"),
  ].find((button) => button.getAttribute("aria-label") === label)!;
}
function dialogOpened() {
  return deps.open.mock.calls.some(
    ([request]) => request?.kind === "sync" && request.revisionMode === "head",
  );
}

it("Get Latest previews in the background and syncs a single changed file directly", async () => {
  await mount();
  await run("getLatest");
  expect(deps.open).not.toHaveBeenCalled();
  expect(deps.previewSync).toHaveBeenCalledExactlyOnceWith({
    paths: ["//fixture/a"],
    revision: { kind: "head", value: "" },
    force: false,
    operationId: expect.any(String),
  });
  const operationId = deps.previewSync.mock.calls[0][0].operationId as string;
  expect(operationId).toMatch(/^[0-9a-f-]{36}$/);
  expect(deps.syncLatest).toHaveBeenCalledExactlyOnceWith({
    paths: ["//fixture/a"],
    revision: { kind: "head", value: "" },
    operationId,
  });
});

it("Get Latest success invalidates the command effects and refreshes the selection", async () => {
  await mount();
  await run("getLatest");
  expect(deps.invalidate).toHaveBeenCalledWith(
    commandActions.getLatest.effects,
    {
      connectionKey: "fixture",
      affectedPaths: ["//fixture/a"],
    },
  );
  expect(deps.resolveSelection).toHaveBeenCalled();
  expect(deps.focus).toHaveBeenCalledWith(
    expect.objectContaining({ type: "file" }),
  );
  expect(deps.feedback).not.toHaveBeenCalled();
});

it("Get Latest syncs directly when the preview is exactly at the threshold", async () => {
  deps.previewSync.mockResolvedValue(
    planWithCounts({ updated: defaultUi.getLatestConfirmThreshold }),
  );
  await mount();
  await run("getLatest");
  expect(deps.open).not.toHaveBeenCalled();
  expect(deps.syncLatest).toHaveBeenCalledTimes(1);
});

it("Get Latest opens the safe-sync dialog one changed file above the threshold", async () => {
  deps.previewSync.mockResolvedValue(
    planWithCounts({ updated: defaultUi.getLatestConfirmThreshold + 1 }),
  );
  await mount();
  await run("getLatest");
  expect(deps.syncLatest).not.toHaveBeenCalled();
  expect(deps.open).toHaveBeenCalledWith(
    expect.objectContaining({
      kind: "sync",
      revisionMode: "head",
      nodes: expect.any(Array),
    }),
  );
  expect(errorNotice()).toBe("");
});

it("Get Latest syncs a single deletion directly", async () => {
  deps.previewSync.mockResolvedValue(
    previewPlan({
      counts: {
        added: 0,
        updated: 0,
        deleted: 1,
        upToDate: 0,
        warnings: 0,
        conflicts: 0,
      },
    }),
  );
  await mount();
  await run("getLatest");
  expect(deps.syncLatest).toHaveBeenCalledTimes(1);
  expect(deps.open).not.toHaveBeenCalled();
});

it("Get Latest syncs a small recursive folder directly (count-only policy)", async () => {
  await mount({ target: directoryTarget });
  await run("getLatest", directoryTarget);
  expect(deps.previewSync).toHaveBeenCalledWith(
    expect.objectContaining({ paths: ["//fixture/dir/..."] }),
  );
  expect(deps.syncLatest).toHaveBeenCalledTimes(1);
  expect(deps.open).not.toHaveBeenCalled();
});

it("Get Latest syncs below the threshold even when the preview has blockers (count-only policy)", async () => {
  deps.previewSync.mockResolvedValue(
    previewPlan({
      ready: false,
      blockers: [{ code: "openedFile", message: "opened files present" }],
      counts: {
        added: 0,
        updated: 1,
        deleted: 0,
        upToDate: 0,
        warnings: 0,
        conflicts: 0,
      },
    }),
  );
  await mount();
  await run("getLatest");
  expect(deps.syncLatest).toHaveBeenCalledTimes(1);
  expect(deps.open).not.toHaveBeenCalled();
});

it("Get Latest honors a custom confirmation threshold from preferences", async () => {
  deps.ui = { toolbarText: true, getLatestConfirmThreshold: 5 };
  deps.previewSync.mockResolvedValue(planWithCounts({ updated: 6 }));
  await mount();
  await run("getLatest");
  expect(deps.open).toHaveBeenCalledTimes(1);
  expect(deps.syncLatest).not.toHaveBeenCalled();

  deps.open.mockClear();
  deps.previewSync.mockResolvedValue(planWithCounts({ updated: 5 }));
  await mount();
  await run("getLatest");
  expect(deps.open).not.toHaveBeenCalled();
  expect(deps.syncLatest).toHaveBeenCalledTimes(1);
});

it("Get Latest preview failure never syncs, never opens a dialog and shows the real error", async () => {
  deps.previewSync.mockRejectedValue(new Error("preview transport failed"));
  await mount();
  await run("getLatest");
  expect(deps.syncLatest).not.toHaveBeenCalled();
  expect(dialogOpened()).toBe(false);
  expect(errorNotice()).toContain("preview transport failed");
  expect(deps.feedback).toHaveBeenCalledWith(
    expect.stringContaining("preview transport failed"),
  );
  // A failed preflight never reached the workspace, so it must not invalidate.
  expect(deps.invalidate).not.toHaveBeenCalled();
  expect(deps.focus).not.toHaveBeenCalled();
});

it("Get Latest failure keeps the selection, shows the real message and invalidates caches", async () => {
  deps.syncLatest.mockResolvedValue(
    syncResult({
      outcome: "failed",
      message: "sync denied by P4",
      affectedPaths: [],
      refreshWorkspace: false,
      refreshDepot: false,
    }),
  );
  await mount();
  await run("getLatest");
  expect(deps.open).not.toHaveBeenCalled();
  expect(deps.focus).not.toHaveBeenCalledWith({ type: "none" });
  expect(deps.focus).not.toHaveBeenCalled();
  expect(errorNotice()).toContain("sync denied by P4");
  expect(deps.feedback).toHaveBeenCalledWith(
    expect.stringContaining("sync denied by P4"),
  );
  expect(deps.invalidate).toHaveBeenCalledWith(
    commandActions.getLatest.effects,
    {
      connectionKey: "fixture",
      affectedPaths: ["//fixture/a"],
    },
  );
});

it("watchdog clears a hung operation, re-enables the toolbar and logs the uncertain outcome", async () => {
  vi.useFakeTimers({
    toFake: ["setInterval", "clearInterval", "Date"],
  });
  try {
    deps.syncLatest.mockImplementation(
      () => new Promise<SyncResult>(() => undefined),
    );
    await mount();
    await act(async () => {
      handler!("getLatest", target);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(deps.busy).toHaveBeenLastCalledWith(true);
    expect(toolbarButton("Get latest").disabled).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(700_000);
    });
    expect(deps.busy).toHaveBeenLastCalledWith(false);
    expect(deps.log).toHaveBeenCalledTimes(1);
    expect(deps.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "otherOperation",
        phase: "execute",
        outcome: "unknown",
        code: "uncertainOutcome",
        targetCount: 1,
        operationId: expect.any(String),
      }),
    );
    expect(notice()).toContain("did not return in time");
    expect(
      document.querySelector(".command-notice-warning")?.getAttribute("role"),
    ).toBe("alert");
    expect(toolbarButton("Refresh").disabled).toBe(false);
    expect(toolbarButton("Get latest").disabled).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});

it("a connection change clears a stuck operation and restores the toolbar", async () => {
  deps.syncLatest.mockImplementation(
    () => new Promise<SyncResult>(() => undefined),
  );
  await mount();
  await act(async () => {
    handler!("getLatest", target);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(deps.busy).toHaveBeenLastCalledWith(true);
  await mount({ connectionKey: "fixture-next" });
  expect(deps.busy).toHaveBeenLastCalledWith(false);
  expect(toolbarButton("Get latest").disabled).toBe(false);
  expect(notice()).toBe("");
});

it("keeps Refresh usable while another operation is pending but still blocks Get Latest", async () => {
  let settleSync!: (result: SyncResult) => void;
  deps.syncLatest.mockImplementation(
    () =>
      new Promise<SyncResult>((resolve) => {
        settleSync = resolve;
      }),
  );
  await mount();
  await act(async () => {
    handler!("getLatest", target);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(deps.syncLatest).toHaveBeenCalledTimes(1);
  expect(deps.previewSync).toHaveBeenCalledTimes(1);
  expect(deps.busy).toHaveBeenLastCalledWith(true);

  await run("refresh");
  expect(deps.refresh).toHaveBeenCalledExactlyOnceWith("fixture");
  expect(deps.invalidate).toHaveBeenCalledWith(commandActions.refresh.effects, {
    connectionKey: "fixture",
  });
  expect(errorNotice()).toBe("");
  expect(deps.feedback).not.toHaveBeenCalled();

  await run("getLatest");
  expect(deps.syncLatest).toHaveBeenCalledTimes(1);
  expect(deps.previewSync).toHaveBeenCalledTimes(1);
  // Mutation commands stay blocked by commandPolicy while the operation runs.
  expect(errorNotice()).toContain("Wait for or cancel the current operation");

  await act(async () => {
    settleSync(syncResult());
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});

it("cancels the in-flight command when the connection changes", async () => {
  let finishPreview: (value: SyncPreviewPlan) => void = () => undefined;
  const pending = new Promise<SyncPreviewPlan>((resolve) => {
    finishPreview = resolve;
  });
  deps.previewSync.mockReturnValueOnce(pending);
  await mount();
  await run("getLatest");
  expect(deps.previewSync).toHaveBeenCalledTimes(1);
  const operationId = deps.previewSync.mock.calls[0][0].operationId as string;
  // A connection switch retires the toolbar session: the host operation must be
  // cancelled instead of becoming an orphan the UI can no longer reach.
  await mount({ connectionKey: "fixture-2" });
  expect(deps.cancel).toHaveBeenCalledWith(operationId);
  await act(async () => {
    finishPreview(previewPlan());
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  // The retired preview must not dispatch a sync against the old connection.
  expect(deps.syncLatest).not.toHaveBeenCalled();
});
