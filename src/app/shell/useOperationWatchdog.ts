import { useEffect, useRef } from "react";

export type OperationKind =
  "sync" | "getLatest" | "getRevision" | "refresh" | "other";

/**
 * Upper bounds for a toolbar operation. Backend sync commands are capped at
 * 600 s, so the UI leaves headroom for IPC and result reporting; anything that
 * outlives its limit is treated as an uncertain outcome instead of holding the
 * toolbar busy forever.
 */
export const OPERATION_LIMITS: Record<OperationKind, number> = {
  sync: 660_000,
  getLatest: 660_000,
  getRevision: 660_000,
  refresh: 60_000,
  other: 180_000,
};

export const OPERATION_WATCHDOG_INTERVAL_MS = 5_000;

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
