import { useEffect, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { HardDrive } from "lucide-react";
import { backend } from "../../infrastructure/backend";
import { workspaceCache } from "../../features/files/workspaceQueries";
import { subscribeSafely } from "../../shared/lib/subscription";
import {
  diskMetrics,
  progressSummary,
  updateProgress,
  type ActiveOperations,
} from "./statusProgress";

import { TaskList } from "./TaskList";
import { useContextMenu } from "../context-menu/ContextMenu";
import { action } from "../context-menu/bindings";
const size = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
export function StatusBar({
  connectionKey,
  native,
  zh,
  children,
  onOpenLogs,
}: {
  connectionKey: string;
  native: boolean;
  zh: boolean;
  children: ReactNode;
  onOpenLogs(id?: string): void;
}) {
  const menu = useContextMenu();
  const [tasksOpen, setTasksOpen] = useState(false);
  const [tasks, setTasks] = useState<[string, number | undefined][]>([]);
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
  const [progress, setProgress] = useState({
    count: 0,
    percent: undefined as number | undefined,
  });
  const [eventError, setEventError] = useState(false);
  useEffect(() => {
    const active: ActiveOperations = new Map();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = subscribeSafely(
      () =>
        backend.subscribeOperationEvents((event) => {
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
          updateProgress(active, event);
          if (timer === undefined)
            timer = setTimeout(() => {
              timer = undefined;
              setProgress(progressSummary(active));
              setTasks([...active]);
            }, 100);
        }),
      () => setEventError(true),
    );
    return () => {
      stop();
      clearTimeout(timer);
    };
  }, []);
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
        className="p4-status"
        tabIndex={0}
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
      </div>
      {tasksOpen && <TaskList tasks={tasks} onClose={() => setTasksOpen(false)} onLogs={onOpenLogs} zh={zh} />}
      {children}
    </footer>
  );
}
