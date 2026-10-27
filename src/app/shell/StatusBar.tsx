import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronUp, HardDrive, Pause, RefreshCw } from "lucide-react";
import { backend } from "../../infrastructure/backend";
import { workspaceCache } from "../../features/files/workspaceQueries";
import { subscribeSafely } from "../../shared/lib/subscription";
import {
  diskMetrics,
  progressSummary,
  updateProgress,
  type ActiveOperations,
  type ActiveTask,
} from "./statusProgress";

import { TaskList } from "./TaskList";
import { useContextMenu } from "../context-menu/ContextMenu";
import { action } from "../context-menu/bindings";
import type { AutoRefreshStatus } from "../refresh/autoRefresh";
const size = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
export function StatusBar({
  connectionKey,
  native,
  zh,
  children,
  onOpenLogs,
  autoRefresh,
  autoRefreshPaused,
  onToggleAutoRefresh,
}: {
  connectionKey: string;
  native: boolean;
  zh: boolean;
  children: ReactNode;
  onOpenLogs(id?: string): void;
  autoRefresh: AutoRefreshStatus;
  autoRefreshPaused: boolean;
  onToggleAutoRefresh(): void;
}) {
  const menu = useContextMenu();
  const [tasksOpen, setTasksOpen] = useState(false);
  const [tasks, setTasks] = useState<ActiveTask[]>([]);
  const active = useRef<ActiveOperations>(new Map());
  const pending = useRef(new Set<string>());
  const [cancelling, setCancelling] = useState<ReadonlySet<string>>(new Set());
  const [cancellingAll, setCancellingAll] = useState(false);
  const allPending = useRef(false);
  const [cancelError, setCancelError] = useState("");
  const live = useRef(true);
  const operations = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const tasksId = useId();
  const progress = progressSummary(tasks);
  const closeTasks = () => {
    setTasksOpen(false);
    trigger.current?.focus();
  };
  const disk = useQuery(
    {
      queryKey: ["workspace-disk", connectionKey],
      queryFn: () => backend.workspaceDiskUsage(),
      enabled: native,
      staleTime: 60_000,
      refetchInterval: 60_000,
      refetchIntervalInBackground: false,
    },
    workspaceCache,
  );
  const metrics = disk.data ? diskMetrics(disk.data) : undefined;
  const [eventError, setEventError] = useState(false);
  useEffect(() => {
    live.current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = subscribeSafely(
      () =>
        backend.subscribeOperationEvents((event) => {
          if (!live.current) return;
          if (
            ![
              "queued",
              "started",
              "progress",
              "completed",
              "cancelled",
            ].includes(event.type)
          )
            return;
          updateProgress(active.current, event);
          if (timer === undefined)
            timer = setTimeout(() => {
              timer = undefined;
              setTasks([...active.current.values()]);
              for (const id of pending.current) {
                if (!active.current.has(id)) pending.current.delete(id);
              }
              setCancelling(new Set(pending.current));
            }, 100);
        }),
      () => setEventError(true),
    );
    return () => {
      live.current = false;
      stop();
      clearTimeout(timer);
    };
  }, []);
  useEffect(() => {
    if (!tasksOpen) return;
    operations.current
      ?.querySelector<HTMLButtonElement>(".task-list header button")
      ?.focus();
    const outside = (event: PointerEvent) => {
      if (!operations.current?.contains(event.target as Node))
        setTasksOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [tasksOpen]);
  const cancelTask = async (id: string) => {
    if (!active.current.has(id) || pending.current.has(id)) return;
    trigger.current?.focus();
    pending.current.add(id);
    setCancelling(new Set(pending.current));
    setCancelError("");
    try {
      await backend.cancelOperation(id);
    } catch {
      if (!live.current) return;
      pending.current.delete(id);
      setCancelling(new Set(pending.current));
      setCancelError(
        zh
          ? "取消请求失败，请重试或查看日志。"
          : "Cancellation failed. Retry or inspect the logs.",
      );
      setTasksOpen(true);
    }
  };
  const cancelAllTasks = async () => {
    if (!active.current.size || allPending.current) return;
    trigger.current?.focus();
    const ids = [...active.current.keys()];
    ids.forEach((id) => pending.current.add(id));
    setCancelling(new Set(pending.current));
    allPending.current = true;
    setCancellingAll(true);
    setCancelError("");
    try {
      await backend.cancelAllOperations();
    } catch {
      if (!live.current) return;
      ids.forEach((id) => pending.current.delete(id));
      setCancelling(new Set(pending.current));
      setCancelError(
        zh
          ? "取消全部任务的请求失败，请重试或逐项取消。"
          : "Cancelling all tasks failed. Retry or cancel tasks individually.",
      );
      setTasksOpen(true);
    } finally {
      allPending.current = false;
      if (live.current) setCancellingAll(false);
    }
  };
  return (
    <footer className="statusbar status-meters">
      <div
        className={`disk-status ${metrics?.low ? "low-space" : ""}`}
        title={
          disk.data
            ? `${disk.data.path}\n${zh ? "可用" : "Available"}: ${size(disk.data.available)} / ${size(disk.data.total)}`
            : native
              ? String(
                  disk.error ??
                    (zh ? "正在读取磁盘容量" : "Reading disk capacity"),
                )
              : zh
                ? "浏览器无法读取本地磁盘容量，请使用桌面版"
                : "Local disk capacity requires the desktop app"
        }
      >
        <HardDrive size={13} />
        <span>{zh ? "磁盘" : "Disk"}</span>
        <progress
          aria-label={zh ? "磁盘已用容量" : "Disk used capacity"}
          value={metrics?.percent ?? 0}
          max={100}
        />
        <span>
          {metrics && disk.data
            ? `${Math.round(metrics.percent)}% · ${size(metrics.used)} / ${size(disk.data.total)}`
            : zh
              ? "容量不可用"
              : "Unavailable"}
        </span>
      </div>
      <div
        className="p4-operations"
        ref={operations}
        onKeyDown={(event) => {
          if (event.key === "Escape" && tasksOpen) {
            event.preventDefault();
            event.stopPropagation();
            closeTasks();
          }
        }}
      >
        <button
          ref={trigger}
          className="p4-status"
          aria-haspopup="dialog"
          aria-expanded={tasksOpen}
          aria-controls={tasksOpen ? tasksId : undefined}
          onClick={() => setTasksOpen((value) => !value)}
          {...menu("U06", () => ({ 打开日志栏: action(() => onOpenLogs()) }))}
          title={
            zh
              ? "P4 操作进度；并发任务取平均值，无可量化进度时显示运行状态"
              : "P4 progress; concurrent operations averaged, unknown progress is indeterminate"
          }
        >
          <span>
            {eventError
              ? zh
                ? "进度不可用"
                : "Progress unavailable"
              : progress.count
                ? `P4 · ${progress.count} ${zh ? "项执行中" : "running"}`
                : zh
                  ? "P4 空闲"
                  : "P4 idle"}
          </span>
          <progress
            aria-label={zh ? "P4 操作进度" : "P4 operation progress"}
            max={100}
            value={progress.count ? progress.percent : 0}
          />
          <span>
            {progress.count && progress.percent !== undefined
              ? `${Math.round(progress.percent)}%`
              : ""}
          </span>
          <ChevronUp size={12} />
        </button>
        {tasksOpen && (
          <TaskList
            id={tasksId}
            tasks={tasks}
            onClose={closeTasks}
            onLogs={onOpenLogs}
            onCancel={cancelTask}
            onCancelAll={cancelAllTasks}
            cancellingAll={cancellingAll}
            cancelling={cancelling}
            error={cancelError}
            zh={zh}
          />
        )}
      </div>
      <button
        className="auto-refresh-status"
        onClick={onToggleAutoRefresh}
        aria-pressed={autoRefreshPaused}
        title={
          autoRefresh.error ||
          (autoRefreshPaused
            ? zh
              ? "自动刷新已暂停；点击恢复"
              : "Auto refresh paused; click to resume"
            : zh
              ? "自动刷新只运行幂等只读请求；点击暂停"
              : "Auto refresh runs idempotent reads only; click to pause")
        }
      >
        {autoRefreshPaused ? (
          <Pause size={13} />
        ) : (
          <RefreshCw
            size={13}
            className={autoRefresh.phase === "refreshing" ? "spin" : undefined}
          />
        )}
        <span>
          {autoRefresh.phase === "failed"
            ? zh
              ? "刷新失败"
              : "Refresh failed"
            : autoRefreshPaused
              ? zh
                ? "自动刷新已暂停"
                : "Auto refresh paused"
              : autoRefresh.lastUpdated
                ? `${zh ? "更新于" : "Updated"} ${new Date(autoRefresh.lastUpdated).toLocaleTimeString()}`
                : zh
                  ? "自动刷新"
                  : "Auto refresh"}
        </span>
      </button>
      {children}
    </footer>
  );
}
