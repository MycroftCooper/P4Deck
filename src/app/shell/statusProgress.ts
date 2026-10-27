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
export interface ActiveTask {
  id: string;
  label: string;
  phase: "queued" | "running";
  progress?: number;
}
export type ActiveOperations = Map<string, ActiveTask>;
/** Retain only active command metadata and counters, never stdout or event history. */
export function updateProgress(
  active: ActiveOperations,
  event: OperationEvent,
) {
  if (event.type === "completed" || event.type === "cancelled")
    active.delete(event.operationId);
  else if (event.type === "queued" || event.type === "started") {
    const previous = active.get(event.operationId);
    active.set(event.operationId, {
      id: event.operationId,
      label: event.message || previous?.label || "P4",
      phase: event.type === "queued" ? "queued" : "running",
      progress: previous?.progress,
    });
  } else if (
    event.type === "progress" &&
    active.has(event.operationId) &&
    Number.isFinite(event.progress)
  ) {
    const task = active.get(event.operationId)!;
    active.set(event.operationId, {
      ...task,
      progress: Math.max(
        task.progress ?? 0,
        Math.min(100, Math.max(0, event.progress!)),
      ),
    });
  }
}
export function progressSummary(tasks: Iterable<ActiveTask>) {
  const values = [...tasks].map((task) => task.progress);
  return {
    count: values.length,
    percent:
      values.length && values.every((v) => v !== undefined)
        ? values.reduce<number>((sum, v) => sum + v!, 0) / values.length
        : undefined,
  };
}
