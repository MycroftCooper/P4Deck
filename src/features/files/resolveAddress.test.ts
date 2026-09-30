import { afterEach, expect, it, vi } from "vitest";
import { backend } from "../../infrastructure/backend";
import { resolveAddress } from "./resolveAddress";
import { workspaceCache } from "./workspaceQueries";
afterEach(() => {
  workspaceCache.clear();
  vi.restoreAllMocks();
});
it("locates a nested file, deduplicating both mapping and directory reads", async () => {
  const mapping = vi.spyOn(backend, "resolvePath").mockResolvedValue({
    found: true,
    inputKind: "depot",
    absolutePath: "/root/src/a.ts",
  });
  const listing = vi.spyOn(backend, "listWorkspaceChildren").mockResolvedValue([
    {
      id: "a",
      kind: "file",
      name: "a.ts",
      absolutePath: "/root/src/a.ts",
      relativePath: "src/a.ts",
      state: "controlled",
    },
  ]);
  const [first, second] = await Promise.all([
    resolveAddress("//depot/src/a.ts", "c", "/root"),
    resolveAddress("//depot/src/a.ts", "c", "/root"),
  ]);
  expect(first).toEqual(second);
  expect(listing).toHaveBeenCalledWith("/root/src");
  expect(mapping).toHaveBeenCalledTimes(1);
  expect(listing).toHaveBeenCalledTimes(1);
});
it("reuses the root listing key and never invents a missing local file", async () => {
  vi.spyOn(backend, "resolvePath").mockResolvedValue({
    found: true,
    inputKind: "absolute",
    absolutePath: "/root/no.txt",
  });
  const listing = vi
    .spyOn(backend, "listWorkspaceChildren")
    .mockResolvedValue([]);
  await expect(resolveAddress("/root/no.txt", "c", "/root")).rejects.toThrow();
  expect(listing).toHaveBeenCalledWith(undefined);
});
it("supports a depot file whose local parent has not been synced", async () => {
  vi.spyOn(backend, "resolvePath").mockResolvedValue({
    found: true,
    inputKind: "depot",
    absolutePath: "/root/new/a.ts",
  });
  vi.spyOn(backend, "listWorkspaceChildren").mockRejectedValue(
    new Error("not found"),
  );
  vi.spyOn(backend, "listDepotChildren").mockResolvedValue([
    { id: "d", kind: "file", name: "a.ts", depotPath: "//depot/new/a.ts" },
  ]);
  const node = await resolveAddress("//depot/new/a.ts", "c", "/root");
  expect(node.absolutePath).toBe("");
  expect(node.state).toBe("missing");
});
it("opening the workspace root avoids querying outside the root", async () => {
  const mapping = vi.spyOn(backend, "resolvePath");
  const node = await resolveAddress("/root", "c", "/root");
  expect(node.kind).toBe("directory");
  expect(mapping).not.toHaveBeenCalled();
});
