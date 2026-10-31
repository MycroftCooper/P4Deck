// @vitest-environment jsdom
import { act } from "react";
import { dialogHarness } from "../../../app/dialogs/testHarness";
import { beforeEach, expect, it, vi } from "vitest";
import { RevisionDialog } from "./RevisionDialog";
import type { WorkspaceNode } from "../../../shared/contracts";
const root = dialogHarness();
const close = vi.fn();
const node: WorkspaceNode = {
  id: "a",
  name: "a",
  absolutePath: "/workspace/a",
  relativePath: "a",
  depotPath: "//depot/a",
  kind: "file",
  state: "controlled",
};
beforeEach(() => {
  close.mockClear();
});
async function render(nodes = [node]) {
  await act(async () =>
    root.render(
      <RevisionDialog request={{ nodes, source: null }} zh onClose={close} />,
    ),
  );
}
function confirm() {
  return [...document.querySelectorAll("button")].find(
    (button) => button.textContent === "确认获取",
  )!;
}
it("cancels without returning an executable revision", async () => {
  await render();
  await act(async () =>
    document
      .querySelector("dialog")!
      .dispatchEvent(new Event("cancel", { cancelable: true })),
  );
  expect(close).toHaveBeenCalledExactlyOnceWith(null);
});
it("requires a valid selector after switching mode", async () => {
  await render();
  await act(async () => {
    const select = document.querySelector("select")!;
    select.value = "change";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(confirm().disabled).toBe(true);
  await act(async () => {
    const input = document.querySelector("input")!;
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, "123");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(confirm().disabled).toBe(false);
  await act(async () => confirm().click());
  expect(close).toHaveBeenCalledExactlyOnceWith("@123");
});
it("freezes recursive scope and explains descendant consolidation", async () => {
  const folder: WorkspaceNode = {
    ...node,
    id: "folder",
    kind: "directory",
    absolutePath: "/workspace",
    depotPath: "//depot",
  };
  await render([folder, node]);
  await render([node]);
  expect(document.body.textContent).toContain("1 个目标");
  expect(document.body.textContent).toContain("递归覆盖");
  expect(document.body.textContent).toContain("已合并重复项");
});
