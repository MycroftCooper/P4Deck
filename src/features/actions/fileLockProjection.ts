import { useSyncExternalStore } from "react";
import type { FileLockResult, WorkspaceNode } from "../../shared/contracts";

/**
 * S4b (file-lock-unlock) provisional projection.
 *
 * Lock/unlock target state is deterministic, so the row can be refreshed locally before the backend
 * answers. `files[]` is the ONLY per-file authority: unknown withdraws at once, partial keeps only
 * succeeded/alreadySatisfied rows, commandCompleted keeps the overlay until the bounded active
 * refetch lands. Pre-dispatch rejections carry no `execution` -> nothing is projected/kept.
 */
export interface FileLockProjection {
  readonly operationId: string;
  readonly action: "lock" | "unlock";
  readonly scope?: string;
  readonly paths: readonly string[];
  readonly phase: "pending" | "confirmed";
}
let projections: readonly FileLockProjection[] = [];
const listeners = new Set<() => void>();
const publish = (next: readonly FileLockProjection[]) => {
  projections = next;
  for (const fn of listeners) fn();
};
export const fileLockProjectionsSnapshot = () => projections;
export const subscribeFileLockProjections = (fn: () => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};
export const useFileLockProjections = () =>
  useSyncExternalStore(
    subscribeFileLockProjections,
    fileLockProjectionsSnapshot,
  );
export function resetFileLockProjectionsForTests() {
  publish([]);
}
export function beginFileLockProjection(
  operationId: string,
  action: "lock" | "unlock",
  paths: readonly string[],
  scope?: string,
): boolean {
  if (!paths.length) return false;
  if (projections.some((p) => p.operationId === operationId)) return false;
  publish([
    ...projections,
    { operationId, action, scope, paths, phase: "pending" },
  ]);
  return true;
}
export function withdrawFileLockProjection(operationId: string) {
  publish(projections.filter((p) => p.operationId !== operationId));
}
function update(
  operationId: string,
  mutate: (projection: FileLockProjection) => FileLockProjection,
) {
  publish(
    projections.map((p) => (p.operationId === operationId ? mutate(p) : p)),
  );
}
const rowMatches = (
  node: Pick<WorkspaceNode, "absolutePath" | "depotPath">,
  path: string,
) => node.absolutePath === path || node.depotPath === path;
/** Pure row overlay: only rows whose current ownership allows the target state are projected. */
export function projectFileLockNodes<T extends WorkspaceNode>(
  nodes: readonly T[],
  scope?: string,
): T[] {
  const relevant = projections.filter(
    (p) => p.scope === undefined || scope === undefined || p.scope === scope,
  );
  if (!relevant.length) return nodes as T[];
  let changed = false;
  const rows = nodes.map((node) => {
    for (const projection of relevant) {
      if (!projection.paths.some((path) => rowMatches(node, path))) continue;
      const ownership = node.status?.lockOwnership;
      const target = projection.action === "lock" ? "ours" : "unlocked";
      if (ownership === target) continue;
      if (projection.action === "lock" && ownership === "other") continue;
      changed = true;
      const status = {
        ...(node.status ?? {}),
        lockOwnership: target,
        ...(projection.action === "lock"
          ? { lockOwner: node.status?.lockOwner }
          : { lockOwner: undefined }),
      } as WorkspaceNode["status"];
      return { ...node, status } as T;
    }
    return node;
  });
  return changed ? (rows as T[]) : (nodes as T[]);
}
/**
 * Correction from the authoritative result. `execution` is absent on pre-dispatch rejection;
 * `files[]` decides partial/unknown per file. The caller calls again with `refreshSucceeded=true`
 * after its bounded active refetch (successful rows are then dropped so the fresh rows win).
 */
export function settleFileLockProjection(
  operationId: string,
  result: FileLockResult,
  refreshSucceeded: boolean,
): void {
  const projection = projections.find((p) => p.operationId === operationId);
  if (!projection) return;
  const execution = result.execution;
  const unknownFile = result.files.some((f) => f.outcome === "unknown");
  if (!execution || execution.outcome === "unknown" || unknownFile) {
    withdrawFileLockProjection(operationId);
    return;
  }
  const cancelledOnly = result.files.every((f) => f.outcome === "cancelled");
  if (result.outcome === "cancelled" || cancelledOnly) {
    withdrawFileLockProjection(operationId);
    return;
  }
  if (result.outcome === "partial") {
    const known = new Set(
      result.files
        .filter(
          (f) => f.outcome === "succeeded" || f.outcome === "alreadySatisfied",
        )
        .map((f) => f.depotPath),
    );
    if (!known.size) {
      withdrawFileLockProjection(operationId);
      return;
    }
    update(operationId, (p) => ({
      ...p,
      phase: "confirmed",
      paths: p.paths.filter((path) => known.has(path)),
    }));
    if (refreshSucceeded) withdrawFileLockProjection(operationId);
    return;
  }
  if (refreshSucceeded) {
    withdrawFileLockProjection(operationId);
    return;
  }
  update(operationId, (p) => ({ ...p, phase: "confirmed" }));
}
