// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SettingsNav } from "./SettingsNav";

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
});
const items = [
  { id: "connection", label: "已保存连接" },
  { id: "backup", label: "本地配置备份" },
  { id: "appearance", label: "外观与交互" },
];
async function render(activeId = "connection", onSelect = vi.fn()) {
  await act(async () =>
    root.render(
      <SettingsNav
        items={items}
        activeId={activeId}
        onSelect={onSelect}
        label="设置模块"
      />,
    ),
  );
  return onSelect;
}
it("renders navigation items in module order with aria-current on the active one", async () => {
  await render("backup");
  const nav = host.querySelector("nav")!;
  expect(nav.getAttribute("aria-label")).toBe("设置模块");
  const buttons = [...nav.querySelectorAll<HTMLButtonElement>("button")];
  expect(buttons.map((item) => item.textContent)).toEqual(
    items.map((i) => i.label),
  );
  expect(buttons[0].getAttribute("aria-current")).toBeNull();
  expect(buttons[1].getAttribute("aria-current")).toBe("location");
});
it("selects a module on click", async () => {
  const onSelect = await render();
  await act(async () =>
    host
      .querySelector<HTMLButtonElement>('[data-settings-nav="appearance"]')!
      .click(),
  );
  expect(onSelect).toHaveBeenCalledWith("appearance");
});
it("supports keyboard roving (arrows, Home, End)", async () => {
  const onSelect = await render();
  const buttons = [...host.querySelectorAll<HTMLButtonElement>("button")];
  buttons[0].focus();
  await act(async () =>
    buttons[0].dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
    ),
  );
  expect(onSelect).toHaveBeenLastCalledWith("backup");
  expect(document.activeElement).toBe(buttons[1]);
  await act(async () =>
    buttons[1].dispatchEvent(
      new KeyboardEvent("keydown", { key: "End", bubbles: true }),
    ),
  );
  expect(onSelect).toHaveBeenLastCalledWith("appearance");
  expect(document.activeElement).toBe(buttons[2]);
  await act(async () =>
    buttons[2].dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
    ),
  );
  expect(onSelect).toHaveBeenLastCalledWith("connection");
  expect(document.activeElement).toBe(buttons[0]);
});
