// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, expect, it, vi } from "vitest";
const tauri = vi.hoisted(() => ({ isTauri: vi.fn(() => true) }));
vi.mock("@tauri-apps/api/core", () => tauri);
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ label: "main" }),
}));
const events = vi.hoisted(() => ({
  handlers: [] as Array<(event: { payload: unknown }) => void>,
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(
    async (_name: string, handler: (event: { payload: unknown }) => void) => {
      events.handlers.push(handler);
      return () => undefined;
    },
  ),
}));
const backend = vi.hoisted(() => ({
  queryPendingChanges: vi.fn(),
  companySubmitConnectionSnapshot: vi.fn(),
}));
vi.mock("../../infrastructure/backend", () => ({ backend }));
const pending = vi.hoisted(() => ({
  refreshPendingAfterToolExit: vi.fn(),
}));
vi.mock("../changelists/pendingCache", () => pending);
vi.mock("../../shared/cache/persistentStore", () => ({
  invalidatePersisted: vi.fn(async () => undefined),
}));
vi.mock("../../shared/cache/appCache", () => ({
  appCache: { invalidateQueries: vi.fn(async () => undefined) },
}));
import { useCustomExitRefresh } from "./useCustomExitRefresh";
import {
  claimCustomSubmitChange,
  isCustomSubmitChangeActive,
  resetCustomSubmitSessions,
} from "./customSubmitSessions";

const connection = {
  profileId: "fixture",
  generation: "9007199254740993",
  server: "fixture.invalid",
  user: "u",
  client: "c",
};
const runtime = {
  mode: "tauri",
  p4Version: "fixture",
  activeProfileId: "fixture",
  contextGeneration: 1,
  context: {
    server: "fixture.invalid",
    user: "u",
    client: "c",
    cwd: "C:/fixture",
  },
  connection: {
    state: "connected",
    message: "",
    recovery: "none",
    server: "fixture.invalid",
  },
} as never;

const host = document.createElement("div");
document.body.append(host);
const root = createRoot(host);

beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  resetCustomSubmitSessions();
  events.handlers.length = 0;
  backend.companySubmitConnectionSnapshot.mockReset();
  backend.queryPendingChanges.mockReset();
  pending.refreshPendingAfterToolExit.mockReset();
  backend.companySubmitConnectionSnapshot.mockResolvedValue(connection);
});

async function mount() {
  const report = vi.fn();
  function Probe() {
    useCustomExitRefresh(runtime, "scope-a", report);
    return null;
  }
  await act(async () => {
    root.render(<Probe />);
    await Promise.resolve();
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  expect(events.handlers).toHaveLength(1);
  return { report, emit: events.handlers[0] };
}

async function emitExit(
  emit: (event: { payload: unknown }) => void,
  payload: unknown,
) {
  await act(async () => {
    emit({ payload });
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

it("App-level exit path releases occupancy even when the refresh fails", async () => {
  claimCustomSubmitChange("scope-a", "42", "request-1");
  claimCustomSubmitChange("scope-a", "43", "request-2");
  pending.refreshPendingAfterToolExit.mockRejectedValue(
    Error("refresh failed"),
  );
  const { report, emit } = await mount();
  await emitExit(emit, {
    requestId: "request-1",
    changeId: "42",
    connection,
    exitCode: 0,
  });
  expect(isCustomSubmitChangeActive("scope-a", "42")).toBe(false);
  expect(isCustomSubmitChangeActive("scope-a", "43")).toBe(true);
  expect(report).toHaveBeenCalledOnce();
  // A duplicate exit for the same request cannot free a newer session.
  claimCustomSubmitChange("scope-a", "42", "request-9");
  await emitExit(emit, {
    requestId: "request-1",
    changeId: "42",
    connection,
    exitCode: 0,
  });
  expect(isCustomSubmitChangeActive("scope-a", "42")).toBe(true);
});

it("keeps occupancy when the exit event is malformed", async () => {
  claimCustomSubmitChange("scope-a", "42", "request-1");
  const { emit } = await mount();
  await emitExit(emit, { requestId: "request-1" });
  expect(isCustomSubmitChangeActive("scope-a", "42")).toBe(true);
});
