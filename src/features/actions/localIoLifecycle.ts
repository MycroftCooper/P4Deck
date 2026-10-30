import { useSyncExternalStore } from "react";
import type {
  OperationResult,
  RenameMoveResult,
  SyncResult,
  WorkspaceNode,
} from "../../shared/contracts";

/**
 * S4a (rename-move-path / sync-revision / undo-change) local lifecycle + provisional projection.
 *
 * The wire makes `files[]` the ONLY per-item authority; `legacy` carries the old payload. This
 * module projects the expected row change immediately (user intent: local refresh before the
 * backend answers) and corrects it from `state/outcome/files`:
 *  - committed  -> keep the projection and let the existing bounded active refetch replace it;
 *  - unknown    -> withdraw at once + one bounded refetch (caller), no retry, no success claim;
 *  - partial    -> keep only files[] rows reported `succeeded`, withdraw the rest, then refetch;
 *  - rejected/cancelled/legacy -> nothing was written, withdraw immediately.
 */
export type LocalIoKind = "renameMove" | "syncRevision" | "undoChange";
export type LocalIoState = "committed" | "unknown" | "rejected" | "legacy";
export type LocalIoFileState =
  "succeeded" | "retained" | "failed" | "cancelled" | "unknown";
export interface LocalIoFileResult {
  depotPath: string;
  state: LocalIoFileState;
  message: string;
  operationId?: string;
}
export interface LocalIoActionResultLike {
  kind: LocalIoKind;
  operationId?: string;
  state: LocalIoState;
  outcome: string;
  files: LocalIoFileResult[];
  message: string;
  legacy?: RenameMoveResult | SyncResult | OperationResult;
}
export function isLocalIoResult(
  value: unknown,
): value is LocalIoActionResultLike {
  return (
    typeof value === "object" &&
    value !== null &&
    "state" in value &&
    "files" in value &&
    Array.isArray((value as { files?: unknown }).files)
  );
}
/** Old payloads (mock or pre-S4a backend) keep working: dialogs read the legacy shape from here. */
export function unwrapLocalIoLegacy<T>(value: unknown): T | undefined {
  if (isLocalIoResult(value)) return value.legacy as T | undefined;
  return value as T | undefined;
}
export const lifecycleOf = (
  value: unknown,
): LocalIoActionResultLike | undefined =>
  isLocalIoResult(value) ? value : undefined;
export interface LocalIoProjection {
  readonly operationId: string;
  readonly kind: LocalIoKind;
  readonly scope?: string;
  readonly phase: "pending" | "confirmed";
  readonly fromPath?: string;
  readonly toPath?: string;
  readonly paths: readonly string[];
  readonly targetState?: WorkspaceNode["state"];
  readonly changelistId?: number;
}
export interface LocalIoProjectionInput {
  operationId: string;
  kind: LocalIoKind;
  scope?: string;
  fromPath?: string;
  toPath?: string;
  paths?: readonly string[];
  targetState?: WorkspaceNode["state"];
  changelistId?: number;
}
let projections: readonly LocalIoProjection[] = [];
const listeners = new Set<() => void>();
const publish = (next: readonly LocalIoProjection[]) => {
  projections = next;
  for (const fn of listeners) fn();
};
export const localIoProjectionsSnapshot = () => projections;
export const subscribeLocalIoProjections = (fn: () => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};
export const useLocalIoProjections = () =>
  useSyncExternalStore(subscribeLocalIoProjections, localIoProjectionsSnapshot);
export function resetLocalIoProjectionsForTests() {
  publish([]);
}
/** Published in the SAME tick as the confirm dispatch; no backend fact is assumed yet. */
export function beginLocalIoProjection(input: LocalIoProjectionInput): boolean {
  if (projections.some((p) => p.operationId === input.operationId))
    return false;
  if (input.kind === "renameMove" && (!input.fromPath || !input.toPath))
    return false;
  const paths =
    input.paths ??
    (input.fromPath ? [input.fromPath] : input.toPath ? [input.toPath] : []);
  if (!paths.length && input.kind !== "renameMove") return false;
  publish([
    ...projections,
    {
      operationId: input.operationId,
      kind: input.kind,
      scope: input.scope,
      phase: "pending",
      fromPath: input.fromPath,
      toPath: input.toPath,
      paths,
      targetState: input.targetState,
      changelistId: input.changelistId,
    },
  ]);
  return true;
}
const baseName = (path: string) =>
  path.split(/[\\/]/).filter(Boolean).at(-1) ?? "";
/** Pure row overlay; `scope` is optional because dialogs are connection-agnostic (callers pass it). */
export function projectLocalIoNodes<T extends WorkspaceNode>(
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
      if (projection.kind === "renameMove") {
        const from = projection.fromPath;
        const to = projection.toPath;
        if (!from || !to) continue;
        const isSource = node.absolutePath === from || node.depotPath === from;
        if (!isSource) continue;
        changed = true;
        const next = { ...node } as WorkspaceNode;
        if (node.absolutePath === from)
          (next as { absolutePath?: string }).absolutePath = to;
        if (node.depotPath === from)
          (next as { depotPath?: string }).depotPath = to;
        (next as { name: string }).name = baseName(to);
        return next;
      }
      const match = projection.paths.some(
        (path) => node.absolutePath === path || node.depotPath === path,
      );
      if (!match) continue;
      if (projection.targetState && node.state === projection.targetState)
        continue;
      changed = true;
      const next = {
        ...node,
        ...(projection.targetState ? { state: projection.targetState } : {}),
        ...(projection.changelistId !== undefined
          ? { changelistId: projection.changelistId }
          : {}),
      } as WorkspaceNode;
      return next;
    }
    return node;
  });
  return changed ? (rows as T[]) : (nodes as T[]);
}
function update(
  operationId: string,
  mutate: (projection: LocalIoProjection) => LocalIoProjection,
) {
  publish(
    projections.map((p) => (p.operationId === operationId ? mutate(p) : p)),
  );
}
/**
 * Correction from the authoritative result. `refreshSucceeded` is reported by the caller after its
 * bounded active refetch: committed/partial projections are dropped only then; a failed refresh
 * keeps the provisional overlay (no retry, no success claim).
 */
export function settleLocalIoProjection(
  operationId: string,
  result: LocalIoActionResultLike | undefined,
  refreshSucceeded: boolean,
): void {
  const projection = projections.find((p) => p.operationId === operationId);
  if (!projection) return;
  if (!result || result.state === "unknown" || result.state === "rejected") {
    publish(projections.filter((p) => p.operationId !== operationId));
    return;
  }
  if (result.state === "legacy") {
    publish(projections.filter((p) => p.operationId !== operationId));
    return;
  }
  if (result.outcome === "partial") {
    const succeeded = new Set(
      result.files
        .filter((f) => f.state === "succeeded")
        .map((f) => f.depotPath),
    );
    const kept = projections
      .filter((p) => p.operationId !== operationId)
      .concat(
        projection.paths.length
          ? [
              {
                ...projection,
                phase: "confirmed" as const,
                paths: projection.paths.filter((path) => succeeded.has(path)),
                fromPath: projection.fromPath,
                toPath: projection.toPath,
              },
            ]
          : [],
      );
    publish(kept);
    return;
  }
  if (refreshSucceeded) {
    publish(projections.filter((p) => p.operationId !== operationId));
    return;
  }
  update(operationId, (p) => ({ ...p, phase: "confirmed" }));
}
export function withdrawLocalIoProjection(operationId: string) {
  publish(projections.filter((p) => p.operationId !== operationId));
}
export const clearLocalIoProjection = withdrawLocalIoProjection;
