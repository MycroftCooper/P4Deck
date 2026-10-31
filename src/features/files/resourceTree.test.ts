import { expect, it } from "vitest";
import type { WorkspaceNode } from "../../shared/contracts";
import {
  expandedResourcePaths,
  flattenResourceTree,
  type ResourceFolder,
} from "./resourceTree";

const node = (
  path: string,
  kind: "file" | "directory" = "directory",
): WorkspaceNode => ({
  id: path,
  name: path.split("/").at(-1)!,
  kind,
  absolutePath: path,
  depotPath: path,
  relativePath: path,
  state: "controlled",
});
const folder = (
  items: WorkspaceNode[],
  overrides: Partial<ResourceFolder> = {},
): ResourceFolder => ({ items, loaded: true, loading: false, ...overrides });

for (const mode of ["workspace", "depot"] as const) {
  it(`${mode}: flattening preserves ancestors, depth and unopened sibling branches`, () => {
    const folders = new Map([
      ["", folder([node("/a"), node("/b")])],
      ["/a", folder([node("/a/src")])],
      ["/a/src", folder([node("/a/src/player.ts", "file")])],
    ]);
    const expanded = new Set(["/a", "/a/src"]);
    expect(
      expandedResourcePaths(
        mode,
        expanded,
        (path) => folders.get(path)?.items || [],
      ),
    ).toEqual(["", "/a", "/a/src"]);
    expect(
      flattenResourceTree(mode, expanded, folders).map((row) => [
        row.key,
        row.depth,
      ]),
    ).toEqual([
      ["/a", 0],
      ["/a/src", 1],
      ["/a/src/player.ts", 2],
      ["/b", 0],
    ]);
    expect(
      flattenResourceTree(mode, expanded, folders, "PLAYER").map(
        (row) => row.key,
      ),
    ).toEqual(["/a", "/a/src", "/a/src/player.ts"]);
    expanded.delete("/a");
    expect(
      expandedResourcePaths(
        mode,
        expanded,
        (path) => folders.get(path)?.items || [],
      ),
    ).toEqual([""]);
    expect(
      flattenResourceTree(mode, expanded, folders).map((row) => row.key),
    ).toEqual(["/a", "/b"]);
  });
}

it("keeps folder errors, empty state and loading next to the owning folder", () => {
  const folders = new Map([
    ["", folder([node("/empty"), node("/error"), node("/loading")])],
    ["/empty", folder([])],
    ["/error", folder([], { loaded: false, error: "Permission denied" })],
    ["/loading", folder([], { loaded: false, loading: true })],
  ]);
  const rows = flattenResourceTree(
    "workspace",
    new Set(["/empty", "/error", "/loading"]),
    folders,
  );
  expect(
    rows
      .filter((row) => row.kind === "notice")
      .map((row) => [
        row.parent,
        row.kind === "notice" && row.state,
        row.depth,
      ]),
  ).toEqual([
    ["/empty", "empty", 1],
    ["/error", "error", 1],
    ["/loading", "loading", 1],
  ]);
});
