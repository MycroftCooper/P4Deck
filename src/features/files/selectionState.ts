import type { WorkspaceNode } from "../../shared/contracts/types";
import { containsNode, selectionKeys } from "./selection";

export interface FileSelection {
  nodes: WorkspaceNode[];
  primary?: WorkspaceNode;
}

/** Hydration may enrich the current set, but must never select another target. */
export function reconcileSelection(
  current: FileSelection,
  nodes: WorkspaceNode[],
  primary: WorkspaceNode,
): FileSelection {
  const keys = selectionKeys(current.nodes);
  if (
    nodes.length !== current.nodes.length ||
    !nodes.every((node) => containsNode(keys, node))
  )
    return current;
  if (
    current.primary === primary &&
    nodes.every((node, index) => node === current.nodes[index])
  )
    return current;
  return { nodes, primary };
}
