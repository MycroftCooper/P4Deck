import { useSyncExternalStore } from "react";
import type { PendingChange } from "../../shared/contracts";

/** Optimistic unshelve: rows appear in the target CL immediately, corrected by the host result. */
type Projection = {
  operationId: string;
  connectionKey: string;
  targetChangeId: number;
  paths: string[];
};

let projections: Projection[] = [];
const listeners = new Set<() => void>();
const emit = () => {
  for (const listener of listeners) listener();
};

export function beginUnshelveProjection(
  operationId: string,
  connectionKey: string,
  targetChangeId: number,
  paths: readonly string[],
): boolean {
  if (!paths.length || !Number.isSafeInteger(targetChangeId)) return false;
  if (projections.some((item) => item.operationId === operationId))
    return false;
  projections = [
    ...projections,
    {
      operationId,
      connectionKey,
      targetChangeId,
      paths: [...new Set(paths)],
    },
  ];
  emit();
  return true;
}

export function withdrawUnshelveProjection(operationId: string) {
  if (!projections.some((item) => item.operationId === operationId)) return;
  projections = projections.filter((item) => item.operationId !== operationId);
  emit();
}

export const useUnshelveProjections = () =>
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => projections,
    () => [],
  );

export function projectUnshelvedChanges(
  changes: PendingChange[],
  connectionKey: string,
): PendingChange[] {
  const relevant = projections.filter(
    (item) => item.connectionKey === connectionKey,
  );
  if (!relevant.length) return changes;
  return changes.map((change) => {
    const paths = relevant
      .filter((item) => item.targetChangeId === change.id)
      .flatMap((item) => item.paths);
    if (!paths.length) return change;
    const existing = new Set(change.files.map((file) => file.depotPath));
    const added = [...new Set(paths)]
      .filter((path) => !existing.has(path))
      .map((depotPath) => ({
        depotPath,
        action: "edit",
        state: "openedEdit" as const,
      }));
    if (!added.length) return change;
    return { ...change, files: [...change.files, ...added] };
  });
}
