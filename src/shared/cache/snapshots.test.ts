import { afterEach, describe, expect, it, vi } from "vitest";
import { appCache } from "./appCache";
import {
  CACHE_POLICY,
  serverScope,
  snapshotKey,
  workspaceScope,
} from "./policy";
import {
  hydrateSnapshot,
  isFresh,
  readSnapshot,
  writePagedSnapshot,
  writeSnapshot,
} from "./snapshots";
import * as store from "./persistentStore";

const runtime = {
  mode: "tauri",
  activeProfileId: "p1",
  context: {
    server: "ssl:p4:1666",
    user: "alice",
    client: "alice_ws",
    cwd: "D:/ws",
  },
} as Parameters<typeof serverScope>[0];

const key = snapshotKey("workspaces", serverScope(runtime));

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("snapshot keys", () => {
  it("never embed the connection generation so restarts reuse them", () => {
    expect(key).toEqual(["snapshot", "workspaces", serverScope(runtime)]);
    expect(JSON.stringify(key)).not.toContain("generation");
    expect(workspaceScope(runtime)).toContain("alice_ws");
    expect(serverScope(runtime)).not.toContain("alice_ws");
  });
});

describe("isFresh", () => {
  it("is false without data, true inside staleTime, false after it", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-21T10:00:00Z"));
    expect(isFresh(key)).toBe(false);
    writeSnapshot(key, ["a"]);
    expect(isFresh(key)).toBe(true);
    vi.advanceTimersByTime(CACHE_POLICY.snapshot.staleTime - 1);
    expect(isFresh(key)).toBe(true);
    vi.advanceTimersByTime(2);
    expect(isFresh(key)).toBe(false);
    // A shorter per-view staleTime is honoured.
    writeSnapshot(key, ["b"]);
    vi.advanceTimersByTime(CACHE_POLICY.target.staleTime + 1);
    expect(isFresh(key, CACHE_POLICY.target.staleTime)).toBe(false);
    expect(isFresh(key)).toBe(true);
  });

  it("treats invalidated data as stale even when it is recent", async () => {
    writeSnapshot(key, ["a"]);
    await appCache.invalidateQueries({ queryKey: key, refetchType: "none" });
    expect(readSnapshot(key)?.data).toEqual(["a"]);
    expect(isFresh(key)).toBe(false);
  });
});

describe("writeSnapshot", () => {
  it("keeps an explicit updatedAt and persists only when asked", () => {
    const persist = vi
      .spyOn(store, "writePersisted")
      .mockImplementation(() => {});
    writeSnapshot(key, ["a"], { updatedAt: 1234 });
    expect(readSnapshot(key)).toEqual({ data: ["a"], updatedAt: 1234 });
    expect(persist).not.toHaveBeenCalled();
    writeSnapshot(key, ["b"], { persist: true, updatedAt: 5678 });
    expect(persist).toHaveBeenCalledWith(JSON.stringify(key), 5678, ["b"]);
  });

  it("persists loaded pages without the live cursor and leaves memory resumable", () => {
    const persist = vi
      .spyOn(store, "writePersisted")
      .mockImplementation(() => {});
    const data = {
      rows: ["first", "second"],
      hasMore: true,
      nextCursor: "live-token",
    };
    writePagedSnapshot(key, data);
    expect(readSnapshot(key)?.data).toEqual(data);
    expect(persist).toHaveBeenCalledWith(
      JSON.stringify(key),
      expect.any(Number),
      { rows: ["first", "second"], hasMore: false },
    );
  });
});

describe("hydrateSnapshot", () => {
  it("marks a hydrated display snapshot stale without fetching or changing its timestamp", async () => {
    const updatedAt = Date.now();
    vi.spyOn(store, "readPersisted").mockResolvedValue({
      schema: 1,
      updatedAt,
      data: ["disk"],
    });
    await hydrateSnapshot(
      key,
      (value): value is string[] => Array.isArray(value),
      {
        revalidate: true,
      },
    );
    expect(readSnapshot(key)).toEqual({ data: ["disk"], updatedAt });
    expect(isFresh(key)).toBe(false);
    expect(appCache.isFetching()).toBe(0);

    writeSnapshot(key, ["new server data"]);
    await hydrateSnapshot(
      key,
      (value): value is string[] => Array.isArray(value),
      {
        revalidate: true,
      },
    );
    expect(isFresh(key)).toBe(true);
    expect(readSnapshot(key)?.data).toEqual(["new server data"]);
  });

  it("does not let a slow disk read overwrite data received from the server", async () => {
    let finish!: (value: store.PersistedEntry) => void;
    vi.spyOn(store, "readPersisted").mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const hydration = hydrateSnapshot(
      key,
      (value): value is string[] => Array.isArray(value),
      { revalidate: true },
    );
    writeSnapshot(key, ["server"]);
    finish({ schema: 1, updatedAt: 1, data: ["disk"] });
    await hydration;
    expect(readSnapshot(key)?.data).toEqual(["server"]);
    expect(isFresh(key)).toBe(true);
  });
  it("loads validated disk data once and ignores foreign or corrupt entries", async () => {
    const read = vi
      .spyOn(store, "readPersisted")
      .mockResolvedValue({ schema: 1, updatedAt: 42, data: ["disk"] });
    const isStrings = (value: unknown): value is string[] =>
      Array.isArray(value) && value.every((item) => typeof item === "string");
    await Promise.all([
      hydrateSnapshot(key, isStrings),
      hydrateSnapshot(key, isStrings),
    ]);
    expect(read).toHaveBeenCalledTimes(1);
    expect(readSnapshot(key)).toEqual({ data: ["disk"], updatedAt: 42 });

    // Memory wins over disk once data exists.
    read.mockResolvedValue({ schema: 1, updatedAt: 99, data: ["newer"] });
    await hydrateSnapshot(key, isStrings);
    expect(readSnapshot(key)?.data).toEqual(["disk"]);

    const other = snapshotKey("streams", serverScope(runtime));
    read.mockResolvedValue({ schema: 1, updatedAt: 7, data: { bad: true } });
    await hydrateSnapshot(other, isStrings);
    expect(readSnapshot(other)).toBeUndefined();

    read.mockRejectedValue(new Error("IndexedDB unavailable"));
    await expect(hydrateSnapshot(other, isStrings)).resolves.toBeUndefined();
  });
});
