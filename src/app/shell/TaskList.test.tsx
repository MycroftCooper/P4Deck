// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { TaskList } from "./TaskList";
import { ContextMenuProvider } from "../context-menu/ContextMenu";
import { backend } from "../../infrastructure/backend";
vi.mock("../../infrastructure/backend", () => ({
  backend: { cancelOperation: vi.fn(async () => undefined) },
}));

it("routes log and cancel actions to the explicit task, not an aggregate or the latest task", async () => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host),
    logs = vi.fn();
  const open = async (id: string) =>
    act(async () => {
      [...host.querySelectorAll<HTMLButtonElement>(".task-row")]
        .find((row) => row.querySelector("strong")?.textContent === id)!
        .dispatchEvent(
          new MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
        );
    });
  const click = async (label: string) =>
    act(async () => {
      [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
        .find((item) => item.textContent === label)!
        .click();
    });
  try {
    await act(async () =>
      root.render(
        <ContextMenuProvider scope="test" zh>
          <TaskList
            id="tasks"
            tasks={[
              { id: "first", label: "first", phase: "running", progress: 20 },
              { id: "second", label: "second", phase: "queued" },
            ]}
            cancelling={new Set()}
            error=""
            onCancel={(id: string) =>
              backend.cancelOperation(id).then(() => undefined)
            }
            onCancelAll={async () => {}}
            cancellingAll={false}
            zh
            onClose={() => {}}
            onLogs={logs}
          />
        </ContextMenuProvider>,
      ),
    );
    await open("first");
    await click("查看相关日志");
    expect(logs).toHaveBeenCalledWith("first");
    await open("second");
    await click("取消此任务");
    expect(backend.cancelOperation).toHaveBeenCalledExactlyOnceWith("second");
    expect(document.querySelector('[role="menu"]')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
