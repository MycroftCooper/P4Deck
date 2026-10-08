// @vitest-environment jsdom
import { act } from "react";
import { dialogHarness } from "../../../app/dialogs/testHarness";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  ChangelistFormDialog,
  type ChangelistDraft,
} from "./ChangelistFormDialog";

const root = dialogHarness();
const dismiss = vi.fn();
beforeEach(() => {
  dismiss.mockClear();
});
afterEach(() => {
  vi.restoreAllMocks();
});
async function render(
  description = "",
  onSubmit?: (draft: ChangelistDraft) => Promise<void>,
) {
  await act(async () =>
    root.render(
      <ChangelistFormDialog
        mode="create"
        client="test-workspace"
        zh
        initial={{ description, jobs: [] }}
        onDismiss={dismiss}
        onSubmit={onSubmit}
      />,
    ),
  );
}
async function submit() {
  await act(async () => {
    document
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}
it("labels its modal and prevents empty descriptions", async () => {
  await render();
  await submit();
  const dialog = document.querySelector("dialog")!;
  expect(
    document.getElementById(dialog.getAttribute("aria-labelledby")!)!
      .textContent,
  ).toBe("新建 Changelist");
  expect(document.querySelector('[role="alert"]')!.textContent).toContain(
    "请填写",
  );
  expect(document.querySelector("textarea")!.getAttribute("aria-invalid")).toBe(
    "true",
  );
  expect(dismiss).not.toHaveBeenCalled();
});
it("explicitly reports preview validation without pretending to save", async () => {
  await render("Fix cache");
  await submit();
  expect(document.body.textContent).toContain("尚未创建或保存 CL");
  expect(dismiss).not.toHaveBeenCalled();
});
it("locks duplicate submissions and Escape while a provided adapter is running", async () => {
  let finish!: () => void;
  const adapter = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  await render("Fix cache", adapter);
  await submit();
  await submit();
  expect(adapter).toHaveBeenCalledTimes(1);
  expect(document.querySelector("dialog")!.getAttribute("aria-busy")).toBe(
    "true",
  );
  await act(async () => {
    document
      .querySelector("dialog")!
      .dispatchEvent(new Event("cancel", { cancelable: true }));
  });
  expect(dismiss).not.toHaveBeenCalled();
  await act(async () => finish());
  expect(dismiss).toHaveBeenCalledTimes(1);
});
it("preserves the form and shows an adapter failure for retry", async () => {
  const adapter = vi.fn(async () => {
    throw new Error("offline");
  });
  await render("Do not lose this description", adapter);
  await submit();
  expect(document.querySelector('[role="alert"]')!.textContent).toContain(
    "offline",
  );
  expect(document.querySelector("textarea")!.value).toBe(
    "Do not lose this description",
  );
  expect(document.querySelector("dialog")!.getAttribute("aria-busy")).toBe(
    "false",
  );
  expect(dismiss).not.toHaveBeenCalled();
});
it("restores focus to the originating control after unmount", async () => {
  const source = document.createElement("button");
  document.body.append(source);
  source.focus();
  await render();
  await act(async () => root.render(null));
  expect(document.activeElement).toBe(source);
  source.remove();
});
async function input(index: number, value: string) {
  await act(async () => {
    const field = document.querySelectorAll("textarea")[index];
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )!.set!.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function click(text: string) {
  await act(async () => {
    [...document.querySelectorAll("button")]
      .find((button) => button.textContent === text)!
      .click();
  });
}
it("protects a changed draft on Escape and permits explicit discard", async () => {
  await render();
  await input(0, "Unsaved draft");
  await act(async () => {
    document
      .querySelector("dialog")!
      .dispatchEvent(new Event("cancel", { cancelable: true }));
  });
  expect(dismiss).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain("关闭将丢弃此次输入");
  await click("继续编辑");
  expect(document.querySelector("textarea")!.value).toBe("Unsaved draft");
  await click("取消");
  await click("放弃修改并关闭");
  expect(dismiss).toHaveBeenCalledOnce();
});
it("normalizes the draft and deduplicates Jobs before an adapter receives it", async () => {
  const adapter = vi.fn(async () => {});
  await render("  Description  ", adapter);
  await input(1, " job001 \njob002\njob001\n\n");
  await submit();
  expect(adapter).toHaveBeenCalledWith({
    description: "Description",
    jobs: ["job001", "job002"],
  });
});
it("does not dismiss a later workflow when a disposed request completes", async () => {
  let finish!: () => void;
  await render(
    "Draft",
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  await submit();
  await act(async () => root.render(null));
  await act(async () => finish());
  expect(dismiss).not.toHaveBeenCalled();
});
it("rejects editing Default instead of treating it as a numbered CL", async () => {
  const adapter = vi.fn(async () => {});
  await act(async () =>
    root.render(
      <ChangelistFormDialog
        mode="edit"
        changeId={0}
        initial={{ description: "Default", jobs: [] }}
        client="workspace"
        zh
        onDismiss={dismiss}
        onSubmit={adapter}
      />,
    ),
  );
  await submit();
  expect(document.body.textContent).toContain("只能编辑已编号的 CL");
  expect(adapter).not.toHaveBeenCalled();
});
it("preserves and submits the complete Jobs list while editing", async () => {
  const adapter = vi.fn(async () => {});
  await act(async () =>
    root.render(
      <ChangelistFormDialog
        mode="edit"
        changeId={42}
        initial={{ description: "Existing", jobs: ["JOB-1", "JOB-2"] }}
        client="workspace"
        zh
        onDismiss={dismiss}
        onSubmit={adapter}
      />,
    ),
  );
  expect(document.querySelectorAll("textarea")[1].value).toBe("JOB-1\nJOB-2");
  await submit();
  expect(adapter).toHaveBeenCalledWith({
    description: "Existing",
    jobs: ["JOB-1", "JOB-2"],
  });
});
