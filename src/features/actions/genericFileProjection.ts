import { useSyncExternalStore } from "react";
import type {
  FileActionRequest,
  PendingChange,
  WorkspaceNode,
} from "../../shared/contracts";

/**
 * Provisional ("optimistic") projection for generic S3a file actions.
 *
 * The S3a wire returns only action-level facts (`execution.outcome` + requested `affectedPaths`),
 * never per-file evidence. This overlay therefore projects the action's *expected opened state*
 * immediately (user intent: refresh locally before the backend answers) and is always corrected by
 * the existing bounded active refetch: `commandCompleted` keeps the projection until that refetch
 * succeeds (then it is cleared), `unknown` withdraws it immediately and lets the authoritative
 * refetch restore the real rows. `affectedPaths` is never used as per-file success.
 */
export type GenericProjectedState = "openedEdit" | "openedAdd" | "openedDelete";
export type GenericProjectedAction = "checkout" | "add" | "delete";
export interface GenericProjectionItem {
  readonly path: string;
  readonly state: GenericProjectedState;
}
export interface GenericFileProjection {
  readonly operationId: string;
  readonly scope: string;
  readonly action: GenericProjectedAction;
  readonly targetKey?: string;
  readonly changelistId?: number;
  readonly phase: "pending" | "confirmed";
  readonly items: readonly GenericProjectionItem[];
}
const PRECONDITIONS: Record<
  GenericProjectedAction,
  { from: readonly string[]; state: GenericProjectedState }
> = {
  checkout: {
    from: ["controlled", "outOfDate", "modified"],
    state: "openedEdit",
  },
  add: { from: ["untracked"], state: "openedAdd" },
  delete: {
    from: ["controlled", "outOfDate", "openedEdit"],
    state: "openedDelete",
  },
};
const REQUEST_ACTIONS: Partial<Record<string, GenericProjectedAction>> = {
  checkout: "checkout",
  add: "add",
  markForDelete: "delete",
  delete: "delete",
};
let projections: readonly GenericFileProjection[] = [];
const listeners = new Set<() => void>();
const publish = (next: readonly GenericFileProjection[]) => {
  projections = next;
  for (const fn of listeners) fn();
};
export const genericFileProjectionsSnapshot = () => projections;
export const subscribeGenericFileProjections = (fn: () => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};
export const useGenericFileProjections = () =>
  useSyncExternalStore(
    subscribeGenericFileProjections,
    genericFileProjectionsSnapshot,
  );
export function resetGenericFileProjectionsForTests() {
  publish([]);
}
const isExpansionScope = (path: string) => /(^|[\\/])\.\.\.$/.test(path);
/** scope+operationId+targetKey guard: when a caller supplies a targetKey only that exact target applies. */
const targetMatches = (projection: GenericFileProjection, targetKey?: string) =>
  targetKey === undefined || projection.targetKey === targetKey;
/** A new command on a different target retires projections that no longer describe the visible target. */
export function discardGenericFileProjectionsForTarget(
  scope: string,
  targetKey: string,
) {
  publish(
    projections.filter((p) => p.scope !== scope || targetMatches(p, targetKey)),
  );
}
/** Publish the projection in the SAME tick as the ledger intent (dispatch has not happened yet). */
export function beginGenericFileProjection(
  scope: string,
  operationId: string,
  request: FileActionRequest,
  targetKey?: string,
): boolean {
  const action = REQUEST_ACTIONS[request.action];
  if (!action) return false;
  // addRecursive / directory expansions: the expanded file list is unknown -> intent-only.
  if (request.action === "addRecursive") return false;
  if (!request.paths.length) return false;
  if (request.paths.some(isExpansionScope)) return false;
  if (projections.some((p) => p.operationId === operationId)) return false;
  // Latest intent owns a path: retire overlapping items from older projections so they can never
  // resurface out of order when an older operation settles later.
  const requested = new Set(request.paths);
  const previous = projections
    .map((projection) =>
      projection.scope === scope
        ? {
            ...projection,
            items: projection.items.filter((item) => !requested.has(item.path)),
          }
        : projection,
    )
    .filter((projection) => projection.items.length > 0);
  publish([
    ...previous,
    {
      operationId,
      scope,
      action,
      targetKey,
      changelistId: request.changelistId,
      phase: "pending",
      items: request.paths.map((path) => ({
        path,
        state: PRECONDITIONS[action].state,
      })),
    },
  ]);
  return true;
}
function update(
  operationId: string,
  mutate: (projection: GenericFileProjection) => GenericFileProjection,
) {
  publish(
    projections.map((p) => (p.operationId === operationId ? mutate(p) : p)),
  );
}
/** commandCompleted / settled-receipt reuse: keep the projection until the bounded refetch lands. */
export function confirmGenericFileProjection(
  operationId: string,
  targetKey?: string,
) {
  const projection = projections.find((p) => p.operationId === operationId);
  if (!projection || !targetMatches(projection, targetKey)) return;
  update(operationId, (p) => ({ ...p, phase: "confirmed" }));
}
/** unknown / not-dispatched: withdraw immediately so the authoritative refetch starts from the base. */
export function withdrawGenericFileProjection(
  operationId: string,
  targetKey?: string,
) {
  publish(
    projections.filter(
      (p) => !(p.operationId === operationId && targetMatches(p, targetKey)),
    ),
  );
}
/** Refetch succeeded: the authoritative rows replace the projection. */
export const clearGenericFileProjection = withdrawGenericFileProjection;
const matchPath = (
  node: Pick<WorkspaceNode, "absolutePath" | "depotPath">,
  path: string,
) => node.absolutePath === path || node.depotPath === path;
/** Pure row overlay. A row is only projected when its CURRENT state satisfies the action precondition. */
export function projectWorkspaceNodes<
  T extends Pick<WorkspaceNode, "absolutePath" | "depotPath" | "state">,
>(nodes: readonly T[], scope: string, targetKey?: string): T[] {
  const relevant = projections.filter(
    (p) => p.scope === scope && targetMatches(p, targetKey),
  );
  if (!relevant.length) return nodes as T[];
  const latest = new Map<
    string,
    { state: GenericProjectedState; from: readonly string[] }
  >();
  for (const projection of relevant)
    for (const item of projection.items)
      latest.set(item.path, {
        state: item.state,
        from: PRECONDITIONS[projection.action].from,
      });
  let changed = false;
  const rows = nodes.map((node) => {
    for (const [path, target] of latest) {
      if (!matchPath(node, path)) continue;
      if (!node.state || !target.from.includes(node.state)) return node;
      if (node.state === target.state) return node;
      changed = true;
      return { ...node, state: target.state };
    }
    return node;
  });
  return changed ? rows : (nodes as T[]);
}
/**
 * Pure Pending-row overlay, applied after the MOVE projection and before the removal projection.
 * Only rows whose CL group already exists in the snapshot are touched; Rows are never invented in
 * an unknown CL, and the input snapshot is not migrated.
 */
export function projectGenericPendingChanges(
  changes: readonly PendingChange[],
  scope: string,
  targetKey?: string,
): PendingChange[] {
  const relevant = projections.filter(
    (p) => p.scope === scope && targetMatches(p, targetKey),
  );
  if (!relevant.length) return changes as PendingChange[];
  let next: PendingChange[] = changes.map((cl) => ({
    ...cl,
    files: [...cl.files],
  }));
  for (const projection of relevant) {
    for (const item of projection.items) {
      if (projection.action === "delete") {
        let found = false;
        next = next.map((cl) => {
          if (!cl.files.some((f) => f.depotPath === item.path)) return cl;
          found = true;
          return {
            ...cl,
            files: cl.files.map((f) =>
              f.depotPath === item.path
                ? { ...f, action: "delete" as const }
                : f,
            ),
          };
        });
        if (!found) {
          const target = projection.changelistId ?? 0;
          next = next.map((cl) =>
            cl.id === target
              ? {
                  ...cl,
                  files: [
                    ...cl.files,
                    { depotPath: item.path, action: "delete" as const },
                  ],
                }
              : cl,
          );
        }
      } else {
        const action =
          projection.action === "checkout"
            ? ("edit" as const)
            : ("add" as const);
        if (next.some((cl) => cl.files.some((f) => f.depotPath === item.path)))
          continue;
        const target = projection.changelistId ?? 0;
        next = next.map((cl) =>
          cl.id === target
            ? {
                ...cl,
                files: [...cl.files, { depotPath: item.path, action }],
              }
            : cl,
        );
      }
    }
  }
  return next;
}
