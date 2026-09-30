import { afterEach, expect, it, vi } from "vitest";
import { workspaceCache, workspaceQuery } from "./workspaceQueries";
import { backend } from "../../infrastructure/backend";
afterEach(() => {
  workspaceCache.clear();
  vi.restoreAllMocks();
});
it("deduplicates sidebar/list reads and isolates connections", async () => {
  const load = vi.spyOn(backend, "listWorkspaceChildren").mockResolvedValue([]);
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
