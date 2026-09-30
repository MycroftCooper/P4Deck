import { useState } from "react";
import { useContextMenu } from "../context-menu/ContextMenu";
import { action, copy } from "../context-menu/bindings";
import { backend } from "../../infrastructure/backend";

export function TaskList({
  tasks,
  onClose,
  onLogs,
  zh,
}: {
  tasks: [string, number | undefined][];
  onClose(): void;
  onLogs(id: string): void;
  zh: boolean;
}) {
  const menu = useContextMenu();
  const [selected, setSelected] = useState<string>();
  return (
    <section
      className="task-list"
      aria-label={zh ? "执行中的任务" : "Running tasks"}
    >
      <header>
        {zh ? "执行中的任务" : "Running tasks"}
        <button onClick={onClose} aria-label="关闭任务列表 / Close task list">
          ×
        </button>
      </header>
      {!tasks.length && <p>{zh ? "没有执行中的任务" : "No running tasks"}</p>}
      {tasks.map(([id, progress]) => (
        <button
          key={id}
          className="task-row"
          onClick={() => setSelected(id)}
          {...menu(
            "U05",
            () => ({
              查看任务详情: action(() => setSelected(id)),
              查看相关日志: action(() => onLogs(id)),
              "复制任务 ID": copy(id),
              取消此任务: action(() => backend.cancelOperation(id)),
            }),
            { title: id },
          )}
        >
          <span>{id}</span>
          <progress max={100} value={progress} />
        </button>
      ))}
      {selected && (
        <p>
          {selected} ·{" "}
          {tasks.some(([id]) => id === selected)
            ? zh
              ? "执行中；取消不会回滚已完成的修改"
              : "Running; cancellation does not undo completed changes"
            : zh
              ? "已结束"
              : "Finished"}
        </p>
      )}
    </section>
  );
}
