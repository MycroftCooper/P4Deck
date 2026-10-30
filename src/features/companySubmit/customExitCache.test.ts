// @vitest-environment jsdom
import { it, expect, vi, beforeEach } from "vitest";
const api = vi.hoisted(() => ({
  queryPendingChanges: vi.fn(),
  cancelOperation: vi.fn(async () => {}),
}));
vi.mock("../../infrastructure/backend", () => ({ backend: api }));
import { appCache } from "../../shared/cache/appCache";
import {
  pendingSnapshotKey,
  refreshPendingAfterToolExit,
} from "../changelists/pendingCache";
import type { RuntimeInfo } from "../../shared/contracts";
const runtime = {
  mode: "tauri",
  p4Version: "fixture",
  activeProfileId: "p",
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
} as RuntimeInfo;
const page = {
  items: [],
  hasMore: false,
  partial: false,
  stats: { truncatedBySafetyLimit: false },
};
beforeEach(() => {
  appCache.clear();
  vi.clearAllMocks();
});
it("refreshes the closed Pending cache without an observer or navigation", async () => {
  api.queryPendingChanges.mockResolvedValue(page);
  await refreshPendingAfterToolExit(runtime, () => true);
  expect(api.queryPendingChanges).toHaveBeenCalledOnce();
  expect(appCache.getQueryData(pendingSnapshotKey(runtime))).toEqual({
    changes: [],
    partial: false,
    stats: page.stats,
  });
});
it("connection switch before fetch causes no read", async () => {
  await refreshPendingAfterToolExit(runtime, () => false);
  expect(api.queryPendingChanges).not.toHaveBeenCalled();
});
it("late response after connection switch cannot update snapshot", async () => {
  let finish!: (value: typeof page) => void;
  let current = true;
  api.queryPendingChanges.mockReturnValue(
    new Promise((r) => {
      finish = r;
    }),
  );
  const done = refreshPendingAfterToolExit(runtime, () => current);
  await vi.waitFor(() =>
    expect(api.queryPendingChanges).toHaveBeenCalledOnce(),
  );
  current = false;
  finish(page);
  await expect(done).rejects.toThrow("connection changed");
  expect(appCache.getQueryData(pendingSnapshotKey(runtime))).toBeUndefined();
});
it("refresh error is not retried", async () => {
  api.queryPendingChanges.mockRejectedValue(Error("synthetic"));
  await expect(
    refreshPendingAfterToolExit(runtime, () => true),
  ).rejects.toThrow("synthetic");
  expect(api.queryPendingChanges).toHaveBeenCalledOnce();
});

it("keeps incomplete data but reports partial refresh rather than complete", async () => {
  api.queryPendingChanges.mockResolvedValue({ ...page, partial: true });
  await expect(
    refreshPendingAfterToolExit(runtime, () => true),
  ).rejects.toThrow("incomplete");
  expect(appCache.getQueryData(pendingSnapshotKey(runtime))).toMatchObject({
    partial: true,
  });
  expect(api.queryPendingChanges).toHaveBeenCalledOnce();
});
