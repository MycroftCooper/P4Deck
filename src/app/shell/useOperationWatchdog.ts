import { useEffect, useRef } from "react";
import {
  IO_DEADLINE_HEADROOM_MS,
  WATCHDOG_TICK_MS,
  WORKSPACE_BOUNDS_MS,
  type WorkspaceBound,
} from "../../shared/operationBounds.generated";

export type OperationKind =
  "sync" | "getLatest" | "getRevision" | "refresh" | "other";

/**
 * The host family each watched operation dispatches. R9: the lengths are no
 * longer written here — they come from `operationBounds.generated`, which is
 * generated from the runner's own table, so the UI and the host cannot drift
 * apart again.
 *
 * `other` is the generic mutating workspace family (`workspaceCommand`, the
 * widest interactive bound), not `workspaceOther`: checkout/add/delete/
 * lock/unlock and revert batches all run as mutating commands, and the UI must
 * never give up on a command the host is still allowed to finish.
 */
const OPERATION_BOUND: Record<OperationKind, WorkspaceBound> = {
  sync: "workspaceSync",
  getLatest: "workspaceSync",
  getRevision: "workspaceSync",
  refresh: "workspacePreview",
  other: "workspaceCommand",
};

/** The host family a watched operation runs under. */
export function operationBound(kind: OperationKind): WorkspaceBound {
  return OPERATION_BOUND[kind];
}

/**
 * How long the UI waits before treating a toolbar operation as an uncertain
 * outcome: the host limit for its family plus the shared IPC/report headroom,
 * so a command that times out on the host still reports its own failure first.
 */
export const OPERATION_LIMITS: Record<OperationKind, number> =
  Object.fromEntries(
    (Object.keys(OPERATION_BOUND) as OperationKind[]).map((kind) => [
      kind,
      WORKSPACE_BOUNDS_MS[OPERATION_BOUND[kind]] + IO_DEADLINE_HEADROOM_MS,
    ]),
  ) as Record<OperationKind, number>;

/** Interval of the watchdog: a tick only re-checks elapsed time. */
export const OPERATION_WATCHDOG_INTERVAL_MS = WATCHDOG_TICK_MS;

export function operationLimit(kind: OperationKind): number {
  return OPERATION_LIMITS[kind];
}

export interface ActiveOperation {
  id: string;
  label: string;
  progress?: number;
  cancellable: boolean;
  /** Uniquely identifies the kind so the watchdog can apply the right limit. */
  kind: OperationKind;
  /** Real selected/affected target count, recorded with timeout diagnostics. */
  targetCount: number;
  startedAt: number;
  limitMs: number;
}

export function startOperation(
  id: string,
  label: string,
  options: {
    kind: OperationKind;
    cancellable: boolean;
    targetCount: number;
  },
): ActiveOperation {
  return {
    id,
    label,
    cancellable: options.cancellable,
    kind: options.kind,
    targetCount: options.targetCount,
    startedAt: Date.now(),
    limitMs: operationLimit(options.kind),
  };
}

/**
 * Clears an operation that outlived its own limit. A hung host call must never
 * leave the toolbar permanently disabled; the timeout is reported as an
 * uncertain result so the user verifies instead of assuming success.
 */
export function useOperationWatchdog(
  operation: ActiveOperation | undefined,
  onTimeout: (operation: ActiveOperation) => void,
  intervalMs = OPERATION_WATCHDOG_INTERVAL_MS,
) {
  const current = useRef({ operation, onTimeout });
  current.current = { operation, onTimeout };
  const active = operation !== undefined;
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => {
      const { operation: live, onTimeout: notify } = current.current;
      if (!live || Date.now() - live.startedAt < live.limitMs) return;
      notify(live);
    }, intervalMs);
    return () => window.clearInterval(timer);
  }, [active, intervalMs]);
}
