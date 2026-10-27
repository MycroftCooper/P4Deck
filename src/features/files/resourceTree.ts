import type { WorkspaceNode } from "../../shared/contracts/types";

export type ResourceTreeMode = "workspace" | "depot";
export interface ResourceFolder {
  items: WorkspaceNode[];
  loaded: boolean;
  loading: boolean;
  error?: string;
  warning?: string;
}
export type ResourceTreeRow = {
  key: string;
  depth: number;
  parent: string;
} & (
  | { kind: "node"; node: WorkspaceNode; position: number; siblings: number }
  | {
      kind: "notice";
      state: "loading" | "error" | "empty" | "warning";
      message?: string;
    }
);

export function resourceNodePath(node: WorkspaceNode, mode: ResourceTreeMode) {
  return mode === "depot"
    ? node.depotPath || node.id
    : node.absolutePath || node.id;
}

/** Only expanded, reachable folders get observers or requests. */
export function expandedResourcePaths(
  mode: ResourceTreeMode,
  expanded: ReadonlySet<string>,
  children: (path: string) => WorkspaceNode[],
) {
  const paths = [""];
  const seen = new Set(paths);
  for (let index = 0; index < paths.length; index++) {
    for (const node of children(paths[index])) {
      const path = resourceNodePath(node, mode);
      if (node.kind === "directory" && expanded.has(path) && !seen.has(path)) {
        seen.add(path);
        paths.push(path);
      }
    }
  }
  return paths;
}

export function flattenResourceTree(
  mode: ResourceTreeMode,
  expanded: ReadonlySet<string>,
  folders: ReadonlyMap<string, ResourceFolder>,
  filter = "",
): ResourceTreeRow[] {
  const rows: ResourceTreeRow[] = [];
  const visited = new Set<string>();
  function visit(parent: string, depth: number) {
    if (visited.has(parent)) return;
    visited.add(parent);
    const folder = folders.get(parent);
    if (!folder) return;
    const notice = (
      state: "loading" | "error" | "empty" | "warning",
      message?: string,
    ) =>
      rows.push({
        kind: "notice",
        key: `${parent}:${state}`,
        parent,
        depth,
        state,
        message,
      });
    if (parent && folder.loading) notice("loading");
    if (parent && folder.error) notice("error", folder.error);
    if (parent && folder.warning) notice("warning", folder.warning);
    if (
      parent &&
      folder.loaded &&
      !folder.loading &&
      !folder.error &&
      !folder.items.length
    )
      notice("empty");
    folder.items.forEach((node, index) => {
      const path = resourceNodePath(node, mode);
      rows.push({
        kind: "node",
        key: path,
        node,
        depth,
        parent,
        position: index + 1,
        siblings: folder.items.length,
      });
      if (node.kind === "directory" && expanded.has(path))
        visit(path, depth + 1);
    });
  }
  visit("", 0);
  if (!filter.trim()) return rows;
  const needle = filter.trim().toLocaleLowerCase();
  const parents = new Map(
    rows
      .filter((row) => row.kind === "node")
      .map((row) => [row.key, row.parent]),
  );
  const keep = new Set<string>();
  for (const row of rows) {
    if (
      row.kind !== "node" ||
      !row.node.name.toLocaleLowerCase().includes(needle)
    )
      continue;
    let path = row.key;
    while (path && !keep.has(path)) {
      keep.add(path);
      path = parents.get(path) || "";
    }
  }
  return rows.filter((row) =>
    row.kind === "node" ? keep.has(row.key) : keep.has(row.parent),
  );
}
