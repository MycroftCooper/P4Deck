// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { appCache } from "./appCache";
import {
  ALL_DATA_DOMAINS,
  invalidateData,
  markSnapshotsStale,
} from "./dataEffects";
import { SNAPSHOT_DOMAINS, snapshotKey } from "./policy";
import { isFresh, writeSnapshot } from "./snapshots";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("invalidateData", () => {
  it("marks only the affected snapshot domains and connection queries stale", async () => {
    for (const domain of SNAPSHOT_DOMAINS)
      writeSnapshot(snapshotKey(domain, "scope"), { domain });
    appCache.setQueryData(["workspace-files", "conn", ""], { files: [] });
    appCache.setQueryData(["depot-files", "conn", ""], { files: [] });
    appCache.setQueryData(["workspace-files", "other", ""], { files: [] });

    await invalidateData(["submitted", "workspaceStatus"], {
      connectionKey: "conn",
    });

    expect(isFresh(snapshotKey("submitted", "scope"))).toBe(false);
    expect(isFresh(snapshotKey("streams", "scope"))).toBe(true);
    expect(isFresh(snapshotKey("workspaces", "scope"))).toBe(true);
    const state = (key: unknown[]) =>
      appCache.getQueryState(key)?.isInvalidated;
    expect(state(["workspace-files", "conn", ""])).toBe(true);
    expect(state(["depot-files", "conn", ""])).toBe(false);
    // Other connections keep their data untouched.
    expect(state(["workspace-files", "other", ""])).toBe(false);
  });

  it("routes Pending and Submitted through their owner events", async () => {
    const events: string[] = [];
    const listen = (name: string) =>
      window.addEventListener(name, () => events.push(name));
    listen("p4deck:pending-refresh");
    listen("p4deck:submitted-refresh");
    await invalidateData(["pending"]);
    expect(events).toEqual(["p4deck:pending-refresh"]);
    await invalidateData(ALL_DATA_DOMAINS, { connectionKey: "conn" });
    expect(events).toEqual([
      "p4deck:pending-refresh",
      "p4deck:pending-refresh",
      "p4deck:submitted-refresh",
    ]);
  });

  it("invalidates resource snapshots through runtime generation keys", async () => {
    appCache.setQueryData(["workspace-files", "profile:context", ""], {
      files: [],
    });
    appCache.setQueryData(["depot-files", "profile:context", "//depot"], []);

    await invalidateData(["workspaceStatus", "depot"], {
      connectionKey: "12:9:profile:context",
    });

    expect(
      appCache.getQueryState(["workspace-files", "profile:context", ""])
        ?.isInvalidated,
    ).toBe(true);
    expect(
      appCache.getQueryState(["depot-files", "profile:context", "//depot"])
        ?.isInvalidated,
    ).toBe(true);
  });

  it("invalidates only directory snapshots related to confirmed paths", async () => {
    const key = (prefix: string, path: string) => [prefix, "conn", path];
    const paths = [
      key("workspace-files", ""),
      key("workspace-files", "C:/work"),
      key("workspace-files", "C:/work/art"),
      key("workspace-files", "C:/work/art/characters"),
      key("workspace-files", "C:/work/audio"),
      key("workspace-directory", ""),
      key("workspace-directory", "C:/work"),
      key("workspace-directory", "C:/work/art"),
      key("workspace-directory", "C:/work/audio"),
      key("depot-files", "//depot"),
      key("depot-files", "//depot/art"),
      key("depot-files", "//depot/audio"),
    ];
    for (const path of paths) appCache.setQueryData(path, []);

    await invalidateData(["workspaceStatus", "depot"], {
      connectionKey: "conn",
      affectedPaths: [
        "C:\\work\\art\\characters\\hero.uasset",
        "//depot/art/hero.uasset",
      ],
    });

    const invalidated = (path: unknown[]) =>
      appCache.getQueryState(path)?.isInvalidated ?? false;
    expect(invalidated(paths[0])).toBe(true);
    expect(invalidated(paths[1])).toBe(true);
    expect(invalidated(paths[2])).toBe(true);
    expect(invalidated(paths[3])).toBe(true);
    expect(invalidated(paths[4])).toBe(false);
    expect(invalidated(paths[5])).toBe(true);
    expect(invalidated(paths[6])).toBe(true);
    expect(invalidated(paths[7])).toBe(true);
    expect(invalidated(paths[8])).toBe(false);
    expect(invalidated(paths[9])).toBe(true);
    expect(invalidated(paths[10])).toBe(true);
    expect(invalidated(paths[11])).toBe(false);
  });

  it("falls back to broad directory invalidation without confirmed paths", async () => {
    const paths = [
      ["workspace-files", "conn", "C:/work/a"],
      ["workspace-directory", "conn", "C:/work/b"],
      ["depot-files", "conn", "//depot/c"],
    ];
    for (const path of paths) appCache.setQueryData(path, []);

    await invalidateData(["workspaceStatus", "depot"], {
      connectionKey: "conn",
      affectedPaths: [],
    });

    for (const path of paths)
      expect(appCache.getQueryState(path)?.isInvalidated).toBe(true);
  });
});

describe("markSnapshotsStale", () => {
  it("invalidates every snapshot without fetching anything", async () => {
    const fetches: string[] = [];
    for (const domain of SNAPSHOT_DOMAINS) {
      const key = snapshotKey(domain, "scope");
      writeSnapshot(key, { domain });
      // Register a query function so a refetch would be observable.
      appCache.setQueryDefaults(key, {
        queryFn: async () => {
          fetches.push(domain);
          return { domain };
        },
      });
    }
    await markSnapshotsStale();
    for (const domain of SNAPSHOT_DOMAINS)
      expect(isFresh(snapshotKey(domain, "scope"))).toBe(false);
    expect(fetches).toEqual([]);
    expect(appCache.isFetching()).toBe(0);
  });
});
