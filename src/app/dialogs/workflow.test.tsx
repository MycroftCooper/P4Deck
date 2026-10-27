// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { OperationConfirmDialog } from "./OperationConfirmDialog";
import { useDialogRequest } from "./useDialogRequest";
import { RenameDialog } from "../../features/files/components/RenameDialog";
import type { WorkspaceNode } from "../../shared/contracts/types";

let root: Root, host: HTMLDivElement;
const close = vi.fn();
const node: WorkspaceNode = {
  id: "a",
  name: "a",
  kind: "file",
  state: "controlled",
  absolutePath: "/workspace/a",
  relativePath: "a",
  depotPath: "//depot/a",
};
const originals = ["showModal", "close"].map((name) =>
  Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, name),
);
beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  for (const name of ["showModal", "close"])
    Object.defineProperty(HTMLDialogElement.prototype, name, {
      configurable: true,
      value(this: HTMLDialogElement) {
        this.toggleAttribute("open", name === "showModal");
      },
    });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  close.mockClear();
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  ["showModal", "close"].forEach((name, index) => {
    if (originals[index])
      Object.defineProperty(
        HTMLDialogElement.prototype,
        name,
        originals[index]!,
      );
    else Reflect.deleteProperty(HTMLDialogElement.prototype, name);
  });
});
function button(text: string) {
  return [...document.querySelectorAll("button")].find(
    (button) => button.textContent === text,
  )!;
}
it("requires scope acknowledgement for delete and cancels explicitly", async () => {
  await act(async () =>
    root.render(
      <OperationConfirmDialog
        request={{ operation: "delete", nodes: [node], source: null }}
        zh
        onClose={close}
      />,
    ),
  );
  expect(button("确认执行").disabled).toBe(true);
  expect(document.body.textContent).toContain("标记为删除");
  expect(document.body.textContent).toContain("不能撤销已完成部分");
  await act(async () => button("取消").click());
  expect(close).toHaveBeenCalledExactlyOnceWith(null);
  await act(async () =>
    document.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click(),
  );
  expect(button("确认执行").disabled).toBe(false);
});
it("wraps Tab and Shift+Tab within visible enabled modal controls", async () => {
  const geometry = vi
    .spyOn(HTMLElement.prototype, "getClientRects")
    .mockReturnValue({ length: 1 } as DOMRectList);
  try {
    await act(async () =>
      root.render(
        <OperationConfirmDialog
          request={{ operation: "revert", nodes: [node], source: null }}
          zh
          onClose={close}
        />,
      ),
    );
    expect(document.querySelector('input[type="checkbox"]')).toBeNull();
    expect(button("确认执行").disabled).toBe(false);
    const last = button("确认执行"),
      first = document.querySelector<HTMLButtonElement>(
        '[aria-label="关闭对话框"]',
      )!;
    await act(async () => {
      last.focus();
      last.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Tab",
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    expect(document.activeElement).toBe(first);
    await act(async () =>
      first.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Tab",
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    expect(document.activeElement).toBe(last);
  } finally {
    geometry.mockRestore();
  }
});
it("retains a frozen recursive scope when outside selection changes", async () => {
  const folder = {
    ...node,
    id: "folder",
    absolutePath: "/workspace",
    depotPath: "//depot",
    kind: "directory" as const,
  };
  const render = (nodes: WorkspaceNode[]) =>
    act(async () =>
      root.render(
        <OperationConfirmDialog
          request={{ operation: "delete", nodes, source: null }}
          zh
          onClose={close}
        />,
      ),
    );
  await render([folder, node]);
  await render([node]);
  expect(document.body.textContent).toContain("1 个目标 · 1 个目录");
  expect(document.body.textContent).toContain("子项已合并");
});
it("keeps rename in preview until a changed input is preflighted and protects drafts", async () => {
  await act(async () =>
    root.render(
      <RenameDialog node={node} source={null} zh onDismiss={close} />,
    ),
  );
  expect(button("预检并审阅").disabled).toBe(true);
  await act(async () => {
    const input = document.querySelectorAll("input")[1];
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, "/workspace/new");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(button("预检并审阅").disabled).toBe(false);
  expect(document.body.textContent).toContain("阶段 · preview");
  await act(async () => button("取消").click());
  expect(close).not.toHaveBeenCalled();
  await act(async () => button("放弃并关闭").click());
  expect(close).toHaveBeenCalledOnce();
});
it("settles pending requests on scope change and unmount, rejecting duplicate requests", async () => {
  let gateway!: ReturnType<typeof useDialogRequest<string, string>>;
  function Harness({ scope }: { scope: string }) {
    gateway = useDialogRequest<string, string>(scope);
    return <span>{gateway.request}</span>;
  }
  await act(async () => root.render(<Harness scope="a" />));
  let first!: Promise<string | null>;
  await act(async () => {
    first = gateway.ask("first");
  });
  expect(await gateway.ask("second")).toBeNull();
  expect(host.textContent).toBe("first");
  await act(async () => root.render(<Harness scope="b" />));
  expect(await first).toBeNull();
  expect(host.textContent).toBe("");
  let next!: Promise<string | null>;
  await act(async () => {
    next = gateway.ask("next");
  });
  await act(async () => root.render(null));
  expect(await next).toBeNull();
});
