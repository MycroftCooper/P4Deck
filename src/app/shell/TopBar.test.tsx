// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TopBar } from "./TopBar";
import type { RuntimeInfo } from "../../shared/contracts/types";

const windowApi = vi.hoisted(() => ({
  native: false,
  label: "main",
  isMaximized: vi.fn(),
  onResized: vi.fn(),
  minimize: vi.fn(),
  toggleMaximize: vi.fn(),
  close: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => windowApi.native }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => windowApi,
}));
vi.mock("../../features/workspaces/WorkspaceSwitcher", () => ({
  WorkspaceSwitcher: () => <button className="connection">Workspace</button>,
}));

let host: HTMLDivElement;
let root: Root;
const unsubscribe = vi.fn();
const runtime = {} as RuntimeInfo;
const render = async () => {
  await act(async () => {
    root.render(
      <TopBar runtime={runtime} zh onRuntime={vi.fn()} onSettings={vi.fn()} />,
    );
  });
};
const button = (name: string) =>
  host.querySelector<HTMLButtonElement>(`[aria-label="${name}"]`)!;

beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  windowApi.native = true;
  windowApi.label = "main";
  windowApi.isMaximized.mockResolvedValue(false);
  windowApi.onResized.mockResolvedValue(unsubscribe);
  windowApi.minimize.mockResolvedValue(undefined);
  windowApi.toggleMaximize.mockResolvedValue(undefined);
  windowApi.close.mockResolvedValue(undefined);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("wires native window controls and keeps interactive controls outside drag regions", async () => {
  await render();
  expect(
    host.querySelector(".topbar")?.hasAttribute("data-tauri-drag-region"),
  ).toBe(true);
  expect(
    host.querySelector(".brand strong")?.hasAttribute("data-tauri-drag-region"),
  ).toBe(true);
  expect(
    host.querySelector(".connection")?.hasAttribute("data-tauri-drag-region"),
  ).toBe(false);
  await act(async () => {
    button("最小化").click();
    button("最大化").click();
    button("关闭窗口").click();
  });
  expect(windowApi.minimize).toHaveBeenCalledOnce();
  expect(windowApi.toggleMaximize).toHaveBeenCalledOnce();
  expect(windowApi.close).toHaveBeenCalledOnce();
  expect(
    host.querySelector(".window-controls [data-tauri-drag-region]"),
  ).toBeNull();
});

it("tracks native maximize changes and cleans up a listener registered after unmount", async () => {
  vi.useFakeTimers();
  let resolveListener!: (stop: () => void) => void;
  windowApi.onResized.mockReturnValueOnce(
    new Promise<() => void>((resolve) => {
      resolveListener = resolve;
    }),
  );
  await render();
  windowApi.isMaximized.mockResolvedValue(true);
  await act(async () => {
    windowApi.onResized.mock.calls[0][0]();
    await vi.advanceTimersByTimeAsync(100);
  });
  expect(button("还原窗口")).toBeTruthy();
  await act(async () => button("还原窗口").click());
  expect(windowApi.toggleMaximize).toHaveBeenCalledOnce();
  await act(async () => root.render(null));
  await act(async () => resolveListener(unsubscribe));
  expect(unsubscribe).toHaveBeenCalledOnce();
});

it("uses Windows caption regions without the JavaScript drag IPC handler", async () => {
  vi.stubGlobal("navigator", {
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
  });
  await render();
  expect(host.querySelector(".topbar.system-drag")).toBeTruthy();
  expect(host.querySelector("[data-tauri-drag-region]")).toBeNull();
  expect(button("最大化")).toBeTruthy();
});

it("coalesces a resize burst and cancels a pending check on unmount", async () => {
  vi.useFakeTimers();
  await render();
  expect(windowApi.isMaximized).toHaveBeenCalledOnce();
  const resized = windowApi.onResized.mock.calls[0][0];
  await act(async () => {
    for (let i = 0; i < 60; i++) {
      resized();
      await vi.advanceTimersByTimeAsync(16);
    }
  });
  expect(windowApi.isMaximized).toHaveBeenCalledOnce();
  await act(async () => vi.advanceTimersByTimeAsync(100));
  expect(windowApi.isMaximized).toHaveBeenCalledTimes(2);
  await act(async () => {
    resized();
    root.render(null);
  });
  await act(async () => vi.advanceTimersByTimeAsync(100));
  expect(windowApi.isMaximized).toHaveBeenCalledTimes(2);
});

it("keeps the browser and decorated panel windows free of duplicate window controls", async () => {
  windowApi.native = false;
  await render();
  expect(host.querySelector(".window-controls")).toBeNull();
  expect(host.querySelector("[data-tauri-drag-region]")).toBeNull();
  windowApi.native = true;
  windowApi.label = "panel-pending";
  await render();
  expect(host.querySelector(".window-controls")).toBeNull();
  expect(windowApi.onResized).not.toHaveBeenCalled();
});
