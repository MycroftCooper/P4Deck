import {
  createContext,
  useContext,
  useMemo,
  useRef,
  type KeyboardEvent,
} from "react";
import type { WorkspaceNode } from "../../shared/contracts/types";
import {
  containsNode,
  nodeKey,
  selectionKeys,
  selectRange,
  type SelectionGesture,
} from "./selection";
export const SelectionContext = createContext<{
  nodes: WorkspaceNode[];
  select(nodes: WorkspaceNode[], primary?: WorkspaceNode): void;
}>({ nodes: [], select() {} });
/** All list surfaces use the same selection, but each keeps its own visible-order anchor. */
export function useObjectSelection(visible: WorkspaceNode[]) {
  const { nodes, select } = useContext(SelectionContext);
  const anchor = useRef<string | undefined>(undefined);
  const keys = useMemo(() => selectionKeys(nodes), [nodes]);
  const isSelected = (node: WorkspaceNode) => containsNode(keys, node);
  const choose = (node: WorkspaceNode, event: SelectionGesture = {}) => {
    const next = selectRange(nodes, visible, node, anchor.current, event);
    if (!event.shiftKey) anchor.current = nodeKey(node);
    select(next, containsNode(selectionKeys(next), node) ? node : next.at(-1));
  };
  const context = (node: WorkspaceNode) => {
    if (!isSelected(node)) choose(node);
    else select(nodes, node);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
      event.preventDefault();
      event.stopPropagation();
      select(visible, visible.at(-1));
      anchor.current = visible[0] ? nodeKey(visible[0]) : undefined;
    } else if (event.key === "Escape") {
      event.preventDefault();
      select([]);
    }
  };
  return { nodes, isSelected, choose, context, onKeyDown };
}
