import { afterEach, expect, it, vi } from "vitest";
import {
  canScanWorkspace,
  canListWorkspace,
  localWorkspaceQuery,
  mergeWorkspaceListings,
  refreshWorkspaceDirectory,
  workspaceCache,
  workspaceQuery,
} from "./workspaceQueries";
import { backend } from "../../infrastructure/backend";
const emptyListing = {
  items: [],
  completeness: "complete" as const,
  errors: [],
  operationIds: [],
  truncated: false,
  safetyLimit: 10_000,
  cacheFreshness: "fresh" as const,
};
afterEach(() => {
  workspaceCache.clear();
  vi.restoreAllMocks();
});
it("does not scan a local workspace until connection and Root are verified", () => {
  const runtime = {
    connection: {
      state: "notTested" as const,
      message: "not tested",
      recovery: "retry" as const,
      server: "p4:1666",
    },
    context: {
      server: "p4:1666",
      user: "alice",
      client: "main",
    },
  };
  expect(canScanWorkspace(runtime)).toBe(false);
  expect(
    canScanWorkspace({
      ...runtime,
      connection: { ...runtime.connection, state: "connected" },
    }),
  ).toBe(false);
  expect(
    canScanWorkspace({
      connection: { ...runtime.connection, state: "connected" },
      context: { ...runtime.context, cwd: "C:/work/main" },
    }),
  ).toBe(true);
});

it("lists local names without waiting for P4 status and keeps the two caches separate", async () => {
  expect(
    canListWorkspace({
      context: {
        server: "offline",
        user: "alice",
        client: "main",
        cwd: "C:/work",
      },
    }),
  ).toBe(true);
  const read = vi
    .spyOn(backend, "listWorkspaceChildren")
    .mockResolvedValue(emptyListing);
  await Promise.all([
    workspaceCache.fetchQuery(localWorkspaceQuery("A")),
    workspaceCache.fetchQuery(localWorkspaceQuery("A")),
  ]);
  expect(read).toHaveBeenCalledTimes(1);
  expect(read.mock.calls[0][0]).toBeUndefined();
  expect(read.mock.calls[0][1]).toBe(false);
  expect(read.mock.calls[0][2]).toMatch(/^workspace-directory-/);
  expect(read.mock.calls[0][3]).toBe(true);
  expect(
    workspaceCache.getQueryData(workspaceQuery("A").queryKey),
  ).toBeUndefined();
  await workspaceCache.fetchQuery(workspaceQuery("A"));
  expect(read).toHaveBeenCalledTimes(2);
});

it("deduplicates sidebar/list reads and isolates connections", async () => {
  const load = vi
    .spyOn(backend, "listWorkspaceChildren")
    .mockResolvedValue(emptyListing);
  await Promise.all([
    workspaceCache.fetchQuery(workspaceQuery("A")),
    workspaceCache.fetchQuery(workspaceQuery("A")),
  ]);
  expect(load).toHaveBeenCalledTimes(1);
  await workspaceCache.fetchQuery(workspaceQuery("A"));
  expect(load).toHaveBeenCalledTimes(1);
  await workspaceCache.fetchQuery(workspaceQuery("B"));
  expect(load).toHaveBeenCalledTimes(2);
  await workspaceCache.invalidateQueries({
    queryKey: workspaceQuery("A").queryKey,
  });
  await workspaceCache.fetchQuery(workspaceQuery("A"));
  expect(load).toHaveBeenCalledTimes(3);
});

it("passes explicit refresh and cancels the grouped runner operation on abort", async () => {
  const cancel = vi.spyOn(backend, "cancelOperation").mockResolvedValue();
  let release!: () => void;
  const load = vi.spyOn(backend, "listWorkspaceChildren").mockImplementation(
    () =>
      new Promise((resolve) => {
        release = () => resolve(emptyListing);
      }),
  );
  const query = workspaceQuery("A", "/workspace", true);
  const pending = workspaceCache.fetchQuery(query).catch(() => undefined);
  await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(1));
  await workspaceCache.cancelQueries({ queryKey: query.queryKey });
  release();
  await pending;
  expect(load.mock.calls[0][1]).toBe(true);
  expect(load.mock.calls[0][2]).toMatch(/^workspace-status-/);
  expect(cancel).toHaveBeenCalledWith(load.mock.calls[0][2]);
});

it("uses the local directory set while overlaying current P4 status", () => {
  const localItem = (
    name: string,
    absolutePath: string,
    state: "loading" | "untracked",
  ) => ({
    id: `local:${name}`,
    name,
    kind: "file" as const,
    absolutePath,
    relativePath: name,
    state,
    status: {
      state,
      completeness: "complete" as const,
      evidence: [],
      errors: [],
    },
  });
  const local = {
    ...emptyListing,
    cacheFreshness: "local" as const,
    items: [
      localItem("existing.txt", "C:/work/existing.txt", "loading"),
      localItem("new.txt", "C:/work/new.txt", "untracked"),
    ],
  } as any;
  const status = {
    ...emptyListing,
    items: [
      {
        ...localItem("existing.txt", "C:/work/existing.txt", "loading"),
        state: "openedEdit" as const,
        revision: 4,
        changelistId: 99,
      },
      {
        ...localItem(
          "deleted-locally.txt",
          "C:/work/deleted-locally.txt",
          "loading",
        ),
        state: "controlled" as const,
      },
    ],
  } as any;

  const merged = mergeWorkspaceListings(local, status)!;

  expect(merged.items.map((item) => item.name)).toEqual([
    "existing.txt",
    "new.txt",
  ]);
  expect(merged.items[0]).toMatchObject({
    state: "openedEdit",
    revision: 4,
    changelistId: 99,
  });
  expect(merged.items[1].state).toBe("untracked");
});

it("starts local and status refreshes together and keeps local data on status failure", async () => {
  const calls: string[] = [];
  let resolveLocal!: (value: typeof emptyListing) => void;
  let rejectStatus!: (cause: Error) => void;
  vi.spyOn(backend, "listWorkspaceChildren").mockImplementation(
    (_path, _refresh, _operationId, localOnly) =>
      new Promise((resolve, reject) => {
        if (localOnly) {
          calls.push("local");
          resolveLocal = resolve;
        } else {
          calls.push("status");
          rejectStatus = reject;
        }
      }),
  );

  const refresh = refreshWorkspaceDirectory("A", "C:/work", true);
  await vi.waitFor(() => expect(calls).toEqual(["local", "status"]));
  resolveLocal(emptyListing);
  rejectStatus(new Error("P4 unavailable"));
  const result = await refresh;

  expect(result.local).toBe(emptyListing);
  expect(result.status).toBeUndefined();
  expect(
    workspaceCache.getQueryState(localWorkspaceQuery("A", "C:/work").queryKey)
      ?.data,
  ).toBe(emptyListing);
});
