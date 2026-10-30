import type { WorkspaceNode } from "../../shared/contracts";
import { pathKey } from "./address";
export const nodeKey = (node: WorkspaceNode) =>
  node.depotPath
    ? `depot:${node.depotPath}`
    : `local:${pathKey(node.absolutePath)}`;
export function selectionKeys(nodes: WorkspaceNode[]) {
  return new Set(
    nodes.flatMap((n) =>
      [
        n.depotPath ? `depot:${n.depotPath}` : "",
        n.absolutePath ? `local:${pathKey(n.absolutePath)}` : "",
      ].filter(Boolean),
    ),
  );
}
export function containsNode(keys: Set<string>, node: WorkspaceNode) {
  return !!(
    (node.depotPath && keys.has(`depot:${node.depotPath}`)) ||
    (node.absolutePath && keys.has(`local:${pathKey(node.absolutePath)}`))
  );
}
export interface SelectionGesture {
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
}
export function selectRange(
  current: WorkspaceNode[],
  visible: WorkspaceNode[],
  node: WorkspaceNode,
  anchor: string | undefined,
  event: SelectionGesture,
): WorkspaceNode[] {
  const toggle = event.ctrlKey || event.metaKey;
  const index = visible.findIndex((n) => nodeKey(n) === nodeKey(node));
  const start = visible.findIndex((n) => nodeKey(n) === anchor);
  if (event.shiftKey && start >= 0 && index >= 0) {
    const range = visible.slice(
      Math.min(start, index),
      Math.max(start, index) + 1,
    );
    return toggle
      ? [
          ...new Map(
            [...current, ...range].map((n) => [nodeKey(n), n]),
          ).values(),
        ]
      : range;
  }
  if (toggle)
    return containsNode(selectionKeys(current), node)
      ? current.filter((n) => !containsNode(selectionKeys([node]), n))
      : [...current, node];
  return [node];
}
