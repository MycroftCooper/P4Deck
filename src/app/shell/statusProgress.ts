import type { DiskUsage, OperationEvent } from "../../shared/contracts/types";
export function diskMetrics(disk: DiskUsage) {
  if (
    !Number.isFinite(disk.total) ||
    disk.total <= 0 ||
    !Number.isFinite(disk.available)
  )
    return undefined;
  const available = Math.max(0, Math.min(disk.total, disk.available));
  return {
    used: disk.total - available,
    percent: (1 - available / disk.total) * 100,
    low: available / disk.total < 0.05,
  };
}
export type ActiveOperations = Map<string, number | undefined>;
/** Only retain active operation counters, never stdout or event history. */
export function updateProgress(
  active: ActiveOperations,
  event: OperationEvent,
) {
  if (event.type === "completed" || event.type === "cancelled")
    active.delete(event.operationId);
  else if (event.type === "queued" || event.type === "started")
    active.set(event.operationId, undefined);
  else if (
    event.type === "progress" &&
    active.has(event.operationId) &&
    Number.isFinite(event.progress)
  ) {
    active.set(
      event.operationId,
      Math.max(
        active.get(event.operationId) ?? 0,
        Math.min(100, Math.max(0, event.progress!)),
      ),
    );
  }
}
export function progressSummary(active: ActiveOperations) {
  const values = [...active.values()];
  return {
    count: values.length,
    percent:
      values.length && values.every((v) => v !== undefined)
        ? values.reduce<number>((sum, v) => sum + v!, 0) / values.length
        : undefined,
  };
}
