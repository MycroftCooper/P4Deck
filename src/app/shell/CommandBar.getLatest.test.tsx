// @vitest-environment jsdom
import { act } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { dialogHarness } from "../dialogs/testHarness";
import { CommandBar } from "./CommandBar";
import type { CommandId, CommandTarget } from "./commandPolicy";
import type { RuntimeInfo, SyncResult } from "../../shared/contracts";
import { commandActions } from "../actions/actionCatalog";
const deps = vi.hoisted(() => ({
  syncLatest: vi.fn(),
  open: vi.fn(),
  invalidate: vi.fn(),
  resolveSelection: vi.fn(),
  feedback: vi.fn(),
  focus: vi.fn(),
  busy: vi.fn(),
}));
vi.mock("../../infrastructure/backend", () => ({
  backend: {
    syncLatest: deps.syncLatest,
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
  useCommandDialogs: () => ({
    pending: false,
    element: null,
    open: deps.open,
  }),
  refreshFileLockFacts: vi.fn(),
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
const target: CommandTarget = { type: "file", node };
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

beforeEach(() => {
  vi.clearAllMocks();
  deps.invalidate.mockResolvedValue(undefined);
  deps.resolveSelection.mockImplementation(async (nodes: unknown) => nodes);
  deps.syncLatest.mockResolvedValue(syncResult());
});

async function mount() {
  await root.render(
    <CommandBar
      runtime={runtime}
      zh={false}
      connectionKey="fixture"
      target={target}
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

async function run(id: CommandId) {
  await act(async () => {
    handler!(id, target);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

it("Get Latest calls sync_latest directly without opening the sync dialog", async () => {
  await mount();
  await run("getLatest");
  expect(deps.open).not.toHaveBeenCalled();
  expect(deps.syncLatest).toHaveBeenCalledExactlyOnceWith({
    paths: ["//fixture/a"],
    revision: { kind: "head", value: "" },
    operationId: expect.any(String),
  });
  expect(deps.syncLatest.mock.calls[0][0].operationId).toMatch(
    /^[0-9a-f-]{36}$/,
  );
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

it("Get Latest failure surfaces the host message and still invalidates caches", async () => {
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
  expect(deps.focus).toHaveBeenCalledWith({ type: "none" });
});

it("Get Revision still opens the safe-sync dialog", async () => {
  await mount();
  await run("getRevision");
  expect(deps.open).toHaveBeenCalledWith(
    expect.objectContaining({ kind: "sync", revisionMode: "choose" }),
  );
  expect(deps.syncLatest).not.toHaveBeenCalled();
});
