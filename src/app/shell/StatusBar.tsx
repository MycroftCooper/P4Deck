import { t } from "../../shared/i18n";
import { isZh } from "../../shared/locale";
import { formatLocalTime } from "../../shared/lib/localTime";
import { useServerStatus } from "./useServerStatus";
import type { ServerStatusHint } from "./serverStatus";
import {
  PassiveServerStatusIcon,
  PassiveStatusPanel,
} from "./PassiveServerStatus";
import { passiveStatusPresentation } from "./passiveStatus";
import type { PassiveStatusView } from "./passiveStatus";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronUp, HardDrive, Pause, RefreshCw } from "lucide-react";
import { backend } from "../../infrastructure/backend";
import {
  cancelIntentMessage,
  cancelIntentState,
} from "../../features/actions/cancelLogBoundary";
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
  serverStatus: suppliedStatus,
  serverScopeHint,
  onCheckServer: suppliedCheck,
  checkingServer: suppliedChecking,
  native,
  zh,
  children,
  onOpenLogs,
  autoRefresh,
  autoRefreshPaused,
  onToggleAutoRefresh,
}: {
  connectionKey: string;
  serverStatus?: PassiveStatusView;
  serverScopeHint?: ServerStatusHint;
  onCheckServer?(): void;
  checkingServer?: boolean;
  native: boolean;
  zh: boolean;
  children: ReactNode;
  onOpenLogs(id?: string): void;
  autoRefresh: AutoRefreshStatus;
  autoRefreshPaused: boolean;
  onToggleAutoRefresh(): void;
}) {
  const observed = useServerStatus(native, connectionKey, serverScopeHint);
  const serverStatus = suppliedStatus ?? observed.view;
  const onCheckServer =
    suppliedCheck ?? (observed.canCheck ? observed.check : undefined);
  const checkingServer = suppliedChecking ?? observed.busy;
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
  const statusTrigger = useRef<HTMLButtonElement>(null);
  const tasksId = useId();
  const statusId = useId();
  const [statusOpen, setStatusOpen] = useState(false);
  const progress = progressSummary(tasks);
  const closeTasks = () => {
    setTasksOpen(false);
    trigger.current?.focus();
  };
  const closeStatus = () => {
    setStatusOpen(false);
    statusTrigger.current?.focus();
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
  useEffect(() => {
    if (!statusOpen) return;
    operations.current
      ?.querySelector<HTMLButtonElement>(".passive-server-panel header button")
      ?.focus();
    const outside = (event: PointerEvent) => {
      if (!operations.current?.contains(event.target as Node))
        setStatusOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [statusOpen]);
  const cancelTask = async (id: string) => {
    if (!active.current.has(id) || pending.current.has(id)) return;
    trigger.current?.focus();
    pending.current.add(id);
    setCancelling(new Set(pending.current));
    setCancelError("");
    try {
      const cancelled = await backend.cancelOperation(id);
      // Cancel is a request only: surface notFound/unknown as uncertainty, never as rollback.
      const state = cancelIntentState(cancelled);
      if (live.current && (state === "notFound" || state === "unknown")) {
        setCancelError(cancelIntentMessage(state, zh));
        setTasksOpen(true);
      }
    } catch {
      if (!live.current) return;
      pending.current.delete(id);
      setCancelling(new Set(pending.current));
      setCancelError(
        t("shell.cancellation.failed.retry.or.inspect"),
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
      const cancelled = await backend.cancelAllOperations();
      const state = cancelIntentState(cancelled);
      if (live.current && (state === "notFound" || state === "unknown")) {
        setCancelError(cancelIntentMessage(state, zh));
        setTasksOpen(true);
      }
    } catch {
      if (!live.current) return;
      ids.forEach((id) => pending.current.delete(id));
      setCancelling(new Set(pending.current));
      setCancelError(
        t("shell.cancelling.all.tasks.failed.retry"),
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
            ? `${disk.data.path}\n${t("shell.available")}: ${size(disk.data.available)} / ${size(disk.data.total)}`
            : native
              ? String(
                  disk.error ??
                    (t("shell.reading.disk.capacity")),
                )
              : t("shell.local.disk.capacity.requires.the")
        }
      >
        <HardDrive size={13} />
        <span>{t("shell.disk")}</span>
        <progress
          aria-label={t("shell.disk.used.capacity")}
          value={metrics?.percent ?? 0}
          max={100}
        />
        <span>
          {metrics && disk.data
            ? `${Math.round(metrics.percent)}% · ${size(metrics.used)} / ${size(disk.data.total)}`
            : t("shell.unavailable")}
        </span>
      </div>
      <div
        className="p4-operations"
        ref={operations}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            if (statusOpen) {
              event.preventDefault();
              event.stopPropagation();
              closeStatus();
            } else if (tasksOpen) {
              event.preventDefault();
              event.stopPropagation();
              closeTasks();
            }
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
            t("shell.p4.progress.concurrent.operations.averaged")
          }
        >
          <span>
            {eventError
              ? t("shell.progress.unavailable")
              : progress.count
                ? `P4 · ${progress.count} ${t("shell.running")}`
                : t("shell.p4.idle")}
          </span>
          <progress
            aria-label={t("shell.p4.operation.progress")}
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
        <button
          ref={statusTrigger}
          className="passive-server-trigger"
          aria-haspopup="dialog"
          aria-expanded={statusOpen}
          aria-controls={statusOpen ? statusId : undefined}
          onClick={() => setStatusOpen((value) => !value)}
          title={passiveStatusPresentation(serverStatus, zh).title}
        >
          <PassiveServerStatusIcon status={serverStatus} zh={zh} />
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
        {statusOpen && (
          <PassiveStatusPanel
            id={statusId}
            status={serverStatus}
            zh={zh}
            native={native}
            onCheckServer={onCheckServer}
            checkingServer={checkingServer}
            onClose={closeStatus}
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
            ? t("shell.auto.refresh.paused.click.to")
            : t("shell.auto.refresh.runs.idempotent.reads"))
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
            ? t("shell.refresh.failed")
            : autoRefreshPaused
              ? t("shell.auto.refresh.paused")
              : autoRefresh.lastUpdated
                ? `${t("shell.updated")} ${formatLocalTime(autoRefresh.lastUpdated, isZh() ? "zh-CN" : "en-US")}`
                : t("shell.auto.refresh")}
        </span>
      </button>
      {children}
    </footer>
  );
}
