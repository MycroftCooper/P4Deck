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
  const terminal = [...host.querySelectorAll("button")].find((button) =>
    button.textContent?.includes("Open Terminal"),
  )!;
  expect(terminal.disabled).toBe(true);
  expect(terminal.title).toContain("loading");
  const input = host.querySelector("input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, "P4 Log");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const log = [...host.querySelectorAll("button")].find((button) =>
    button.textContent?.includes("Open P4 Log"),
  )!;
  await act(async () => log.click());
  expect(execute).toHaveBeenCalledWith("tools.openP4Log");
  expect(host.textContent).not.toContain("Open Terminal");
});
