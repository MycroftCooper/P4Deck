import { useMemo } from "react";
import type { WorkspaceNode } from "../../shared/contracts";
import {
  filterWorkspaceNodes,
  type WorkspaceFileFilter,
} from "../files/fileListModel";
import {
  projectWorkspaceNodes,
  useGenericFileProjections,
} from "./genericFileProjection";
import { projectLocalIoNodes, useLocalIoProjections } from "./localIoLifecycle";
import {
  projectFileLockNodes,
  useFileLockProjections,
} from "./fileLockProjection";

/**
 * B1 composition order (frozen by QA): generic (S3a-Opt) -> localIo (S4a) -> fileLock (S4b).
 * Each overlay owns a different row facet (state / path+state / lock ownership); chaining in this
 * order lets a single row show all three without overwriting the others. All overlays use the same
 * connection scope; the generic overlay also honours the command targetKey when supplied.
 */
export function composeWorkspaceOverlays<T extends WorkspaceNode>(
  nodes: readonly T[],
  scope: string,
  targetKey?: string,
): T[] {
  const generic = projectWorkspaceNodes(nodes, scope, targetKey);
  const localIo = projectLocalIoNodes(generic as WorkspaceNode[], scope);
  const locked = projectFileLockNodes(localIo as WorkspaceNode[], scope);
  return locked as T[];
}

/** Subscribes to all three projection stores and memoizes the composed transform. */
export function useWorkspaceOverlays(scope: string, targetKey?: string) {
  const generic = useGenericFileProjections();
  const localIo = useLocalIoProjections();
  const fileLock = useFileLockProjections();
  return useMemo(
    () => (nodes: readonly WorkspaceNode[]) =>
      composeWorkspaceOverlays(nodes, scope, targetKey),
    [generic, localIo, fileLock, scope, targetKey],
  );
}

/**
 * Fourth overlay (S3-local-FE): local-delete pending rows are hidden after the filter step.
 * localDeleteTask.hiddenFor only contains pending rows; succeeded rows leave the workspace snapshot
 * and unknown rows stay visible, so these rows keep their local claim until truth arrives.
 * Keys are matched against both absolutePath and depotPath (same口径 as S3-local-FE).
 */
export function visibleWorkspaceNodes<T extends WorkspaceNode>(
  nodes: readonly T[],
  filter: WorkspaceFileFilter,
  hidden: ReadonlySet<string>,
): T[] {
  return filterWorkspaceNodes(nodes, filter).filter(
    (node) =>
      !(node.absolutePath && hidden.has(node.absolutePath)) &&
      !(node.depotPath && hidden.has(node.depotPath)),
  ) as T[];
}
