import type { FileState, WorkspaceNode } from "../../shared/contracts";

export type WorkspaceFileFilter = "all" | "changed" | "incoming";

/** Production file-table filtering. Kept pure so large-list cost is measurable. */
export function filterWorkspaceNodes(
  nodes: readonly WorkspaceNode[],
  filter: WorkspaceFileFilter,
): WorkspaceNode[] {
  if (filter === "all") return nodes.slice();
  return nodes.filter((node) =>
    filter === "changed"
      ? node.state.startsWith("opened") ||
        ["modified", "missing", "untracked", "conflicted"].includes(node.state)
      : ["outOfDate", "notSynced"].includes(node.state),
  );
}

/** Production resource-tree search with one query normalization per pass. */
export function searchWorkspaceNodes(
  nodes: readonly WorkspaceNode[],
  query: string,
): WorkspaceNode[] {
  const normalized = query.toLocaleLowerCase();
  if (!normalized) return nodes.slice();
  return nodes.filter((node) =>
    node.name.toLocaleLowerCase().includes(normalized),
  );
}

export function depotNodeAsWorkspaceNode(node: {
  id: string;
  name: string;
  kind: "file" | "directory";
  depotPath: string;
  headRevision?: number;
  headAction?: string;
  hasChildren?: boolean;
}): WorkspaceNode {
  return {
    ...node,
    absolutePath: "",
    relativePath: node.depotPath,
    state: "missing" as FileState,
  };
}
