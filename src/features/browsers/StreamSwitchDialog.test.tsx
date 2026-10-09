// @vitest-environment jsdom
import { act } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { dialogButton, dialogHarness } from "../../app/dialogs/testHarness";
import { backend } from "../../infrastructure/backend";
import type {
  RuntimeInfo,
  StreamSwitchPreflight,
  StreamSwitchResult,
} from "../../shared/contracts/types";
import { StreamSwitchDialog } from "./StreamSwitchDialog";

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 30,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        index,
        key: index,
        start: index * 30,
        size: 30,
      })),
    scrollToIndex: vi.fn(),
  }),
}));

const harness = dialogHarness();
const runtime: RuntimeInfo = {
  mode: "tauri",
  p4Version: "P4/TEST",
  activeProfileId: "profile-a",
  contextGeneration: 7,
  context: {
    server: "localhost:1666",
    user: "alice",
    client: "workspace",
    cwd: "C:/work",
  },
  connection: {
    state: "connected",
    message: "connected",
    recovery: "none",
    server: "localhost:1666",
  },
};
const stream = {
  stream: "//depot/开发",
  name: "开发",
  owner: "alice",
  parent: "//depot/main",
  kind: "development",
  description: "Unicode stream",
};

function plan(
  overrides: Partial<StreamSwitchPreflight> = {},
): StreamSwitchPreflight {
  const target = {
    server: "localhost:1666",
    user: "alice",
    client: "workspace",
    workspace: "C:/work",
    activeProfileId: "profile-a",
    contextGeneration: 7,
    currentStream: "//depot/main",
    targetStream: stream.stream,
    targetType: "development",
    targetParent: "//depot/main",
    mode: "viewOnly" as const,
    clientSpecDigest: "client",
    streamSpecDigest: "stream",
    riskDigest: "clean",
  };
  return {
    ready: true,
    currentStream: "//depot/main",
    targetStream: stream.stream,
    targetType: "development",
    targetParent: "//depot/main",
    mode: "viewOnly",
    syncRequired: true,
    risks: {
      openedFiles: 0,
      unresolvedFiles: 0,
      reconcileFiles: 0,
      targetFileCount: 12,
      targetFileBytes: 4096,
    },
    blockers: [],
    warnings: [],
    targetSnapshot: target,
    previewDigest: "digest",
    token: "one-time-token",
    expiresAt: Date.now() + 60_000,
    ttlMs: 60_000,
    operationIds: ["preflight"],
    ...overrides,
  };
}

function success(): StreamSwitchResult {
  return {
    outcome: "succeeded",
    message: "Stream verified; files unchanged.",
    streamChanged: true,
    syncPerformed: false,
    syncCompleted: false,
    verifiedStream: stream.stream,
    operationId: "switch-op",
    runtime: { ...runtime, contextGeneration: 8 },
    refresh: {
      workspace: true,
      streams: true,
      pendingChanges: true,
      submittedChanges: true,
      search: true,
      depot: true,
      reason: "refresh",
    },
  };
}

function render(
  connectionKey = "profile-a:7",
  onRuntime = vi.fn(),
  onRefresh = vi.fn(),
) {
  return harness.render(
    <StreamSwitchDialog
      stream={stream}
      runtime={runtime}
      connectionKey={connectionKey}
      source={null}
      zh={false}
      onDismiss={vi.fn()}
      onRuntime={onRuntime}
      onRefresh={onRefresh}
    />,
  );
}

afterEach(() => vi.restoreAllMocks());

it("runs preflight before a one-time confirmation and applies verified runtime", async () => {
  const preflight = vi
    .spyOn(backend, "preflightStreamSwitch")
    .mockResolvedValue(plan());
  const confirm = vi
    .spyOn(backend, "confirmStreamSwitch")
    .mockResolvedValue(success());
  const onRuntime = vi.fn();
  const onRefresh = vi.fn();
  await render("profile-a:7", onRuntime, onRefresh);
  expect(document.body.textContent).toContain("never forces the switch");
  await act(async () => dialogButton("Run preflight").click());
  expect(preflight).toHaveBeenCalledWith(
    expect.objectContaining({ targetStream: "//depot/开发", mode: "viewOnly" }),
  );
  expect(document.body.textContent).toContain("//depot/main");
  await act(async () => dialogButton("Confirm view-only switch").click());
  expect(confirm).toHaveBeenCalledWith(
    expect.objectContaining({
      token: "one-time-token",
      previewDigest: "digest",
      acknowledgeWarnings: false,
    }),
  );
  expect(document.body.textContent).toContain("Preflight recovery sync");
  expect(onRuntime).not.toHaveBeenCalled();
  await act(async () => dialogButton("Close").click());
  expect(onRuntime).toHaveBeenCalledWith(
    expect.objectContaining({ contextGeneration: 8 }),
  );
  expect(onRefresh).toHaveBeenCalledWith(
    expect.objectContaining({ outcome: "succeeded" }),
  );
});

it("shows blockers and requires warning acknowledgement for sync", async () => {
  const blocked = plan({
    ready: false,
    token: undefined,
    blockers: [
      {
        code: "localChanges",
        message: "Local changes block sync.",
        paths: ["C:/work/未跟踪.txt"],
      },
    ],
    warnings: [
      {
        code: "syncChangesWorkspace",
        message: "Sync changes files.",
        paths: [],
      },
    ],
  });
  vi.spyOn(backend, "preflightStreamSwitch").mockResolvedValue(blocked);
  await render();
  const radios = document.querySelectorAll<HTMLInputElement>(
    'input[name="stream-switch-mode"]',
  );
  await act(async () => radios[1].click());
  await act(async () => dialogButton("Run preflight").click());
  expect(document.body.textContent).toContain("Local changes block sync");
  expect(document.body.textContent).toContain("C:/work/未跟踪.txt");
  expect(dialogButton("Confirm switch and sync").disabled).toBe(true);
});

it("cancels a multi-command preflight when the connection owner changes", async () => {
  let finish!: (value: StreamSwitchPreflight) => void;
  vi.spyOn(backend, "preflightStreamSwitch").mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const cancel = vi.spyOn(backend, "cancelOperation").mockResolvedValue();
  await render("profile-a:7");
  await act(async () => dialogButton("Run preflight").click());
  const operationId = vi.mocked(backend.preflightStreamSwitch).mock.calls[0][0]
    .operationId!;
  await render("profile-b:8");
  expect(cancel).toHaveBeenCalledWith(operationId);
  await act(async () => finish(plan()));
  expect(document.body.textContent).not.toContain("Confirm view-only switch");
});

it("offers a conservative recovery preflight after an incomplete sync", async () => {
  const syncPlan = plan({
    mode: "sync",
    warnings: [
      {
        code: "syncChangesWorkspace",
        message: "Sync changes files.",
        paths: [],
      },
    ],
    targetSnapshot: { ...plan().targetSnapshot!, mode: "sync" },
  });
  vi.spyOn(backend, "preflightStreamSwitch").mockResolvedValue(syncPlan);
  vi.spyOn(backend, "confirmStreamSwitch").mockResolvedValue({
    ...success(),
    outcome: "failed",
    failure: "syncFailed",
    message: "Stream changed; sync incomplete; no rollback.",
    syncPerformed: true,
  });
  await render();
  const radios = document.querySelectorAll<HTMLInputElement>(
    'input[name="stream-switch-mode"]',
  );
  await act(async () => radios[1].click());
  await act(async () => dialogButton("Run preflight").click());
  const acknowledgement = document.querySelector<HTMLInputElement>(
    '.workflow-checkbox input[type="checkbox"]',
  )!;
  await act(async () => acknowledgement.click());
  await act(async () => dialogButton("Confirm switch and sync").click());
  expect(document.body.textContent).toContain("no rollback");
  expect(dialogButton("Preflight recovery sync")).toBeTruthy();
});
