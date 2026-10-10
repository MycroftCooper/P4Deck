import { afterEach, expect, it, vi } from "vitest";
import { backend } from "../../infrastructure/backend";
import type { WorkspaceNode } from "../../shared/contracts/types";
import { resolveSelection } from "./resolveSelection";
import { workspaceCache } from "./workspaceQueries";
afterEach(() => {
  workspaceCache.clear();
  vi.restoreAllMocks();
});
it("resolves thousands of depot selections with one mapping and one shared directory query", async () => {
  const nodes: WorkspaceNode[] = Array.from({ length: 2000 }, (_, i) => ({
    id: String(i),
    name: `${i}.txt`,
    kind: "file",
    depotPath: `//depot/main/${i}.txt`,
    absolutePath: "",
    relativePath: `${i}.txt`,
    state: "missing",
  }));
  const mapping = vi.spyOn(backend, "resolvePath").mockResolvedValue({
    found: true,
    inputKind: "depot",
    absolutePath: "/root",
  });
  const listing = vi.spyOn(backend, "listWorkspaceChildren").mockResolvedValue({
    items: nodes.map((n) => ({
      ...n,
      absolutePath: `/root/${n.name}`,
      state: "controlled",
    })),
    completeness: "complete",
    errors: [],
    operationIds: [],
    truncated: false,
    safetyLimit: 10_000,
    cacheFreshness: "fresh",
  });
  const result = await resolveSelection(nodes, "connection", "/root");
  expect(result).toHaveLength(2000);
  expect(result.every((n) => n.state === "controlled")).toBe(true);
  expect(mapping).toHaveBeenCalledTimes(1);
  expect(listing).toHaveBeenCalledTimes(1);
});
it("does not pretend an unmapped depot path has a local copy", async () => {
  vi.spyOn(backend, "resolvePath").mockResolvedValue({
    found: false,
    inputKind: "depot",
  });
  const node: WorkspaceNode = {
    id: "a",
    name: "a",
    kind: "file",
    depotPath: "//depot/a",
    relativePath: "a",
    absolutePath: "",
    state: "missing",
  };
  expect(await resolveSelection([node], "c", "/root")).toEqual([node]);
});

it("requests authoritative workspace facts when refreshing a selection", async () => {
  const node: WorkspaceNode = {
    id: "a",
    name: "a.txt",
    kind: "file",
    depotPath: "//depot/a.txt",
    absolutePath: "/root/a.txt",
    relativePath: "a.txt",
    state: "controlled",
  };
  const listing = vi.spyOn(backend, "listWorkspaceChildren").mockResolvedValue({
    items: [{ ...node }],
    completeness: "complete",
    errors: [],
    operationIds: [],
    truncated: false,
    safetyLimit: 10_000,
    cacheFreshness: "fresh",
  });
  await resolveSelection([node], "c", "/root", true);
  expect(listing).toHaveBeenCalledWith(undefined, true, expect.any(String));
});
