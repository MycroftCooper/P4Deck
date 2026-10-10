import { afterEach, expect, it, vi } from "vitest";
import {
  canScanWorkspace,
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
