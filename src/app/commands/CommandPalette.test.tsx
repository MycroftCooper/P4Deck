// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CommandPalette } from "./CommandPalette";

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

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

it("lists catalog commands, exposes disabled reasons, filters, and executes", async () => {
  const execute = vi.fn();
  await act(async () =>
    root.render(
      <CommandPalette
        open
        zh={false}
        environment={{ detached: false, runtimeReady: false }}
        onClose={vi.fn()}
        onExecute={execute}
      />,
    ),
  );
  const terminal = [...host.querySelectorAll('[role="option"]')].find(
    (option) => option.textContent?.includes("Open Terminal"),
  )!;
  expect(terminal.getAttribute("aria-disabled")).toBe("true");
  expect(host.querySelector('[role="combobox"]')).toBeTruthy();
  expect(host.querySelector('[role="listbox"]')).toBeTruthy();
  const input = host.querySelector("input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, "P4 Log");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const log = [...host.querySelectorAll<HTMLElement>('[role="option"]')].find(
    (option) => option.textContent?.includes("Open P4 Log"),
  )!;
  await act(async () => log.click());
  expect(execute).toHaveBeenCalledWith("tools.openP4Log");
  expect(host.textContent).not.toContain("Open Terminal");
});

it("supports listbox navigation, traps Tab, Escape, and restores focus", async () => {
  const close = vi.fn();
  const execute = vi.fn();
  const source = document.createElement("button");
  source.textContent = "Open palette";
  document.body.append(source);
  source.focus();
  await act(async () =>
    root.render(
      <CommandPalette
        open
        zh={false}
        environment={{ detached: false, runtimeReady: true }}
        onClose={close}
        onExecute={execute}
      />,
    ),
  );
  await act(async () => Promise.resolve());
  const input = host.querySelector<HTMLInputElement>('[role="combobox"]')!;
  expect(document.activeElement).toBe(input);
  const first = input.getAttribute("aria-activedescendant");
  await act(async () =>
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "End", bubbles: true }),
    ),
  );
  expect(input.getAttribute("aria-activedescendant")).not.toBe(first);
  await act(async () =>
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Home", bubbles: true }),
    ),
  );
  expect(input.getAttribute("aria-activedescendant")).toBe(first);
  await act(async () =>
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Tab", bubbles: true }),
    ),
  );
  expect(document.activeElement).toBe(input);
  await act(async () =>
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    ),
  );
  expect(close).toHaveBeenCalledOnce();
  await act(async () =>
    root.render(
      <CommandPalette
        open={false}
        zh={false}
        environment={{ detached: false, runtimeReady: true }}
        onClose={close}
        onExecute={execute}
      />,
    ),
  );
  await act(async () => Promise.resolve());
  expect(document.activeElement).toBe(source);
  source.remove();
});
