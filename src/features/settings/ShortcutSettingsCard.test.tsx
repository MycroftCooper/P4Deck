// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { commandForShortcut } from "../../app/commands/catalog";
import {
  getShortcutOverrides,
  resetShortcutOverrides,
  setShortcutOverride,
} from "../../app/commands/keymap";
import { ShortcutSettingsCard } from "./ShortcutSettingsCard";

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  resetShortcutOverrides();
});

async function mount(zh = true) {
  await act(async () =>
    root.render(<ShortcutSettingsCard zh={zh} platform="windows" />),
  );
}

function button(label: string): HTMLButtonElement {
  return document.querySelector<HTMLButtonElement>(
    `button[aria-label="${label}"]`,
  )!;
}

async function press(
  target: EventTarget,
  key: string,
  init: KeyboardEventInit,
) {
  await act(async () => {
    target.dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, ...init }),
    );
  });
}

it("lists catalog commands by group with defaults and availability", async () => {
  await mount();
  expect(document.body.textContent).toContain("快捷键");
  expect(document.body.textContent).toContain("导航");
  expect(document.body.textContent).toContain("刷新当前数据");
  expect(document.body.textContent).toContain("Ctrl+R");
  expect(document.body.textContent).toContain("刷新当前数据");
  // P4V alias is displayed next to the primary key.
  const refreshRow = [...document.querySelectorAll("li")].find((row) =>
    row.textContent?.includes("刷新当前数据"),
  )!;
  expect(refreshRow.textContent).toContain("F5");
  // Mutations are listed but cannot be bound.
  const submitRow = [...document.querySelectorAll("li")].find((row) =>
    row.textContent?.includes("提交所选 CL"),
  )!;
  expect(submitRow.textContent).toContain("写操作");
  expect(submitRow.querySelector("button")).toBeNull();
  // Conditions surface as text.
  expect(document.body.textContent).toContain("需先选择文件或目录");
});

it("records a new combination and immediately changes dispatch", async () => {
  await mount();
  const record = button("录制 打开待提交");
  await act(async () => record.click());
  await press(record, "9", { ctrlKey: true, shiftKey: true });
  expect(getShortcutOverrides()["view.pending"]).toBe("Mod+Shift+9");
  expect(
    commandForShortcut(
      {
        key: "9",
        ctrlKey: true,
        shiftKey: true,
        metaKey: false,
        altKey: false,
      },
      "windows",
    ),
  ).toBe("view.pending");
  const row = [...document.querySelectorAll("li")].find((item) =>
    item.textContent?.includes("打开待提交"),
  )!;
  expect(row.textContent).toContain("Ctrl+Shift+9");
  expect(document.body.textContent).toContain("已绑定 Ctrl+Shift+9");
});

it("cancels recording with Escape without changing bindings", async () => {
  await mount();
  await act(async () => button("录制 打开待提交").click());
  await press(document.body, "Escape", {});
  expect(getShortcutOverrides()).toEqual({});
  expect(document.body.textContent).toContain("已取消录制");
});

it("clears a binding with Backspace and stops dispatch", async () => {
  await mount();
  await act(async () => button("录制 刷新当前数据").click());
  await press(document.body, "Backspace", {});
  expect(getShortcutOverrides()["view.refresh"]).toBeNull();
  expect(document.body.textContent).toContain("未绑定");
  expect(
    commandForShortcut(
      {
        key: "r",
        ctrlKey: true,
        metaKey: false,
        altKey: false,
        shiftKey: false,
      },
      "windows",
    ),
  ).toBeUndefined();
});

it("blocks a combination already bound to another command", async () => {
  await mount();
  await act(async () => button("录制 打开待提交").click());
  await press(document.body, "r", { ctrlKey: true });
  expect(getShortcutOverrides()["view.pending"]).toBeUndefined();
  expect(document.body.textContent).toContain("冲突");
  expect(document.body.textContent).toContain("刷新当前数据");
});

it("rejects keys that cannot be bound", async () => {
  await mount();
  await act(async () => button("录制 打开待提交").click());
  await press(document.body, "a", {});
  expect(getShortcutOverrides()["view.pending"]).toBeUndefined();
  expect(document.body.textContent).toContain("不可绑定");
});

it("restores the P4V default keymap", async () => {
  setShortcutOverride("view.pending", "Mod+Shift+9");
  await mount();
  expect(document.body.textContent).toContain("已自定义 1 项");
  const reset = [...document.querySelectorAll("button")].find((item) =>
    item.textContent?.includes("恢复默认快捷键"),
  )!;
  await act(async () => reset.click());
  expect(getShortcutOverrides()).toEqual({});
  expect(document.body.textContent).not.toContain("已自定义 1 项");
});

it("warns about browser/system reserved combinations but keeps them", async () => {
  await mount();
  await act(async () => button("录制 打开待提交").click());
  await press(document.body, "p", { ctrlKey: true });
  expect(getShortcutOverrides()["view.pending"]).toBe("Mod+P");
  expect(document.body.textContent).toContain("占用");
  expect(document.body.textContent).toContain("打印");
});

it("does not hijack keys typed in an editable field", async () => {
  await mount();
  await act(async () => button("录制 打开待提交").click());
  const input = document.createElement("input");
  document.body.append(input);
  await press(input, "9", { ctrlKey: true, shiftKey: true });
  expect(getShortcutOverrides()["view.pending"]).toBeUndefined();
  expect(document.body.textContent).toContain("输入框内不录制");
  input.remove();
});

it("stops captured keys from reaching the global command dispatcher", async () => {
  await mount();
  const bubbled = vi.fn();
  document.body.addEventListener("keydown", bubbled);
  await act(async () => button("录制 打开待提交").click());
  await press(document.body, "9", { ctrlKey: true, shiftKey: true });
  expect(bubbled).not.toHaveBeenCalled();
  document.body.removeEventListener("keydown", bubbled);
});
