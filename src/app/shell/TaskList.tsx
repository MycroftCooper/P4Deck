import { useState } from "react";
import { Square } from "lucide-react";
import { useContextMenu } from "../context-menu/ContextMenu";
import { action, copy } from "../context-menu/bindings";
import type { ActiveTask } from "./statusProgress";

export function TaskList({
  tasks,
  onClose,
  onLogs,
  onCancel,
  onCancelAll,
  cancellingAll,
  cancelling,
  error,
  id,
  zh,
}: {
  tasks: ActiveTask[];
  id: string;
  onClose(): void;
  onLogs(id: string): void;
  onCancel(id: string): Promise<void>;
  onCancelAll(): Promise<void>;
  cancellingAll: boolean;
  cancelling: ReadonlySet<string>;
  error: string;
  zh: boolean;
}) {
  const menu = useContextMenu();
  const [selected, setSelected] = useState<string>();
  return (
    <section
      id={id}
      className="task-list"
      role="dialog"
      aria-label={zh ? "P4 任务" : "P4 tasks"}
    >
      <header role="presentation">
        {zh ? "P4 任务" : "P4 tasks"}
        <button onClick={onClose} aria-label="关闭任务列表 / Close task list">
          ×
        </button>
      </header>
      {!tasks.length && (
        <p className="task-idle" role="status">
          {zh ? "P4 空闲" : "P4 idle"}
        </p>
      )}
      {tasks.map((task) => (
        <div
          key={task.id}
          className="task-row"
          {...menu(
            "U05",
            () => ({
              查看任务详情: action(() => setSelected(task.id)),
              查看相关日志: action(() => onLogs(task.id)),
              "复制任务 ID": copy(task.id),
              取消此任务: action(
                () => onCancel(task.id),
                cancelling.has(task.id)
                  ? zh
                    ? "正在取消"
                    : "Cancelling"
                  : undefined,
              ),
            }),
            { title: task.label },
          )}
        >
          <button
            className="task-details"
            onClick={() => setSelected(task.id)}
            title={task.label}
          >
            <strong>{task.label}</strong>
            <small>
              {task.phase === "queued"
                ? zh
                  ? "排队中"
                  : "Queued"
                : zh
                  ? "执行中"
                  : "Running"}
              {task.progress !== undefined
                ? ` · ${Math.round(task.progress)}%`
                : ""}
            </small>
            <progress
              aria-label={`${task.label} ${zh ? "进度" : "progress"}`}
              max={100}
              value={task.progress}
            />
          </button>
          <button
            className="task-cancel"
            aria-label={`${zh ? "取消任务" : "Cancel task"}: ${task.label} (${task.id})`}
            title={
              cancelling.has(task.id)
                ? zh
                  ? "取消中…"
                  : "Cancelling…"
                : zh
                  ? "取消任务"
                  : "Cancel task"
            }
            disabled={cancelling.has(task.id)}
            onClick={() => void onCancel(task.id)}
          >
            <Square
              className="cancel-stop-icon"
              size={12}
              fill="currentColor"
              strokeWidth={0}
              aria-hidden="true"
            />
          </button>
        </div>
      ))}
      {error && tasks.length > 0 && (
        <p className="task-cancel-error" role="alert">
          {error}
        </p>
      )}
      {selected && tasks.length > 0 && (
        <p>
          {selected} ·{" "}
          {tasks.some((task) => task.id === selected)
            ? zh
              ? "执行中；取消不会回滚已完成的修改"
              : "Running; cancellation does not undo completed changes"
            : zh
              ? "已结束"
              : "Finished"}
        </p>
      )}
      {tasks.length > 0 && (
        <footer role="presentation">
          <button
            className="p4-cancel-all"
            aria-label={zh ? "取消全部 P4 任务" : "Cancel all P4 tasks"}
            disabled={
              cancellingAll || tasks.every((task) => cancelling.has(task.id))
            }
            onClick={() => void onCancelAll()}
          >
            <Square
              className="cancel-stop-icon"
              size={12}
              fill="currentColor"
              strokeWidth={0}
              aria-hidden="true"
            />
            <span>{zh ? "取消全部" : "Cancel all"}</span>
          </button>
        </footer>
      )}
    </section>
  );
}
