// @vitest-environment jsdom
import { act } from "react";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { dialogHarness } from "../dialogs/testHarness";
import { WindowControls } from "./WindowControls";
const d = vi.hoisted(() => ({
  events: new Map<string, (e: { payload: unknown }) => void>(),
  invoke: vi.fn(),
  close: vi.fn(),
  min: vi.fn(),
  max: vi.fn(),
  isMax: vi.fn(),
  label: "main",
}));
vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => true,
  invoke: d.invoke,
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (name: string, handler: (e: { payload: unknown }) => void) => {
    d.events.set(name, handler);
    return () => d.events.delete(name);
  },
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    label: d.label,
    minimize: d.min,
    toggleMaximize: d.max,
    isMaximized: d.isMax,
    isMinimized: async () => false,
    isFocused: async () => true,
    onFocusChanged: async () => () => {},
    onResized: async () => () => {},
  }),
}));
vi.mock("../closeGuard", () => ({ requestGuardedClose: d.close }));
const root = dialogHarness();
beforeEach(() => {
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  d.events.clear();
  d.label = "main";
  [d.invoke, d.close, d.min, d.max, d.isMax].forEach((m) => m.mockReset());
  d.invoke.mockResolvedValue({ accepted: true });
  d.close.mockResolvedValue({ accepted: false });
  d.min.mockResolvedValue(undefined);
  d.max.mockResolvedValue(undefined);
  d.isMax.mockResolvedValue(false);
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([
    {},
  ] as unknown as DOMRectList);
});
afterEach(() => {
  vi.mocked(HTMLElement.prototype.getClientRects).mockRestore();
  vi.unstubAllGlobals();
});
it("renders immediately without mode/probe IPC; min/max work and close stays guarded", async () => {
  await root.render(<WindowControls zh={false} />);
  expect(document.querySelectorAll(".window-controls button")).toHaveLength(3);
  expect(
    [
      ...document.querySelectorAll<HTMLButtonElement>(
        ".window-controls button",
      ),
    ].every((b) => b.tabIndex === 0 && !b.disabled),
  ).toBe(true);
  expect(d.events.size).toBe(0);
  expect(d.invoke).not.toHaveBeenCalled();
  await act(async () =>
    document
      .querySelector<HTMLButtonElement>('[aria-label="Minimize"]')!
      .click(),
  );
  expect(d.min).toHaveBeenCalledOnce();
  d.isMax.mockResolvedValue(true);
  await act(async () =>
    document
      .querySelector<HTMLButtonElement>('[aria-label="Maximize"]')!
      .click(),
  );
  expect(d.max).toHaveBeenCalledOnce();
  expect(
    document.querySelector('[aria-label="Restore window"]'),
  ).not.toBeNull();
  await act(async () =>
    document
      .querySelector<HTMLButtonElement>('[aria-label="Close window"]')!
      .click(),
  );
  expect(d.close).toHaveBeenCalledExactlyOnceWith("window");
  expect(document.querySelectorAll(".window-controls button")).toHaveLength(3);
});
it("leaves detached windows on their own native controls", async () => {
  d.label = "tool-popout";
  await root.render(<WindowControls zh />);
  expect(document.querySelector(".window-controls")).toBeNull();
  expect(d.invoke).not.toHaveBeenCalled();
});
it("zero layout does not hide or handshake; failures stay visible", async () => {
  vi.mocked(HTMLElement.prototype.getClientRects).mockReturnValue(
    [] as unknown as DOMRectList,
  );
  d.min.mockRejectedValue(new Error("failed"));
  await root.render(<WindowControls zh />);
  await act(async () =>
    document.querySelector<HTMLButtonElement>('[aria-label="最小化"]')!.click(),
  );
  expect(document.querySelector('[role="alert"]')?.textContent).toBe(
    "窗控操作失败",
  );
  expect(document.querySelectorAll(".window-controls button")).toHaveLength(3);
  expect(d.invoke).not.toHaveBeenCalled();
});
