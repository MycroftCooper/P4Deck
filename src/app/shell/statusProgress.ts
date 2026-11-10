import type { DiskUsage, OperationEvent } from "../../shared/contracts";
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
  /** Completed units, only when the backend reports countable work. */
  current?: number;
  /** Total units; absent for commands whose total is unknown (e.g. sync). */
  total?: number;
  /** Stdout lines seen for this operation — the processed-files approximation. */
  lines: number;
  /** Queue/start time in epoch ms; the task panel derives the elapsed label. */
  startedAt: number;
}
export type ActiveOperations = Map<string, ActiveTask>;
/** Clamp one percentage into 0–100; keeps NaN/infinity out of the bar. */
function clampPercent(value: number) {
  return Math.min(100, Math.max(0, value));
}
/**
 * The percentage to render for one task. An explicit percent wins; when the
 * backend only reports countable work (current/total, e.g. sync or submit)
 * derive it, because a bar that ignores those counts stays indeterminate even
 * though the operation is measurable. `undefined` means there is no usable
 * total yet, so callers render an indeterminate bar instead of a fake 0%.
 */
export function taskPercent(
  task: Pick<ActiveTask, "progress" | "current" | "total">,
): number | undefined {
  if (Number.isFinite(task.progress)) return clampPercent(task.progress!);
  const total = task.total;
  if (
    Number.isFinite(task.current) &&
    Number.isFinite(total) &&
    (total ?? 0) > 0
  ) {
    return clampPercent(((task.current ?? 0) / total!) * 100);
  }
  return undefined;
}
/** Epoch ms of the event, falling back to now for a missing/invalid timestamp. */
function eventTime(event: OperationEvent) {
  const parsed = Date.parse(event.timestamp);
  return Number.isFinite(parsed) ? parsed : Date.now();
}
/** Retain only active command metadata and counters, never stdout or event history. */
export function updateProgress(
  active: ActiveOperations,
  event: OperationEvent,
) {
  if (event.type === "completed" || event.type === "cancelled") {
    active.delete(event.operationId);
    return;
  }
  if (event.type === "queued" || event.type === "started") {
    const previous = active.get(event.operationId);
    active.set(event.operationId, {
      id: event.operationId,
      label: event.message || previous?.label || "P4",
      phase: event.type === "queued" ? "queued" : "running",
      progress: previous?.progress,
      current: previous?.current,
      total: previous?.total,
      lines: previous?.lines ?? 0,
      startedAt: eventTime(event),
    });
    return;
  }
  const task = active.get(event.operationId);
  if (!task) return;
  if (event.type === "stdout") {
    // One sync output line maps to one file closely enough to show a live count.
    active.set(event.operationId, { ...task, lines: task.lines + 1 });
    return;
  }
  if (event.type !== "progress") return;
  const { progress: percent, progressCurrent, progressTotal } = event;
  const hasPercent = Number.isFinite(percent);
  const hasCurrent = Number.isFinite(progressCurrent);
  const hasTotal = Number.isFinite(progressTotal);
  if (!hasPercent && !hasCurrent && !hasTotal) return;
  const next = { ...task };
  // Percent stays monotonic: a reordered event must not make the bar jump back.
  if (hasPercent)
    next.progress = Math.max(task.progress ?? 0, clampPercent(percent!));
  if (hasCurrent) next.current = Math.max(0, progressCurrent!);
  if (hasTotal) next.total = Math.max(0, progressTotal!);
  active.set(event.operationId, next);
}
export function progressSummary(tasks: Iterable<ActiveTask>) {
  const values = [...tasks].map(taskPercent);
  return {
    count: values.length,
    percent:
      values.length && values.every((v) => v !== undefined)
        ? values.reduce<number>((sum, v) => sum + v!, 0) / values.length
        : undefined,
  };
}
