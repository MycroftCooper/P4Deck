// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OperationEvent } from "../../shared/contracts";
import { ContextMenuProvider } from "../context-menu/ContextMenu";
import { StatusBar } from "./StatusBar";

const backend = vi.hoisted(() => ({
  subscribeOperationEvents: vi.fn(),
  workspaceDiskUsage: vi.fn(),
  cancelOperation: vi.fn(),
  cancelAllOperations: vi.fn(),
}));
vi.mock("../../infrastructure/backend", () => ({ backend }));
let host: HTMLDivElement;
let root: Root;
let publish: (event: OperationEvent) => void;
const stop = vi.fn();
const logs = vi.fn();
const trigger = () => host.querySelector<HTMLButtonElement>(".p4-status")!;
const cancelAll = () => host.querySelector<HTMLButtonElement>(".p4-cancel-all");
const rowCancel = (id: string) =>
  [...host.querySelectorAll<HTMLButtonElement>(".task-cancel")].find((button) =>
    button.getAttribute("aria-label")?.endsWith(`(${id})`),
  )!;
async function send(
  operationId: string,
  type: OperationEvent["type"],
  message?: string,
  progress?: number,
) {
  await act(async () => {
    publish({ operationId, type, message, progress, timestamp: "" });
    await vi.advanceTimersByTimeAsync(100);
  });
}
async function render() {
  await act(async () =>
    root.render(
      <ContextMenuProvider scope="test" zh>
        <StatusBar
          connectionKey="fixture"
          native={false}
          zh
          onOpenLogs={logs}
          autoRefresh={{ phase: "idle" }}
          autoRefreshPaused={false}
          onToggleAutoRefresh={() => {}}
        >
          {null}
        </StatusBar>
      </ContextMenuProvider>,
    ),
  );
}
beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  vi.clearAllMocks();
  backend.cancelOperation.mockReset().mockResolvedValue(undefined);
  backend.cancelAllOperations.mockReset().mockResolvedValue(undefined);
  backend.subscribeOperationEvents.mockImplementation(async (listener) => {
    publish = listener;
    return stop;
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
});

it("opens while idle and shows P4 idle again when the last task finishes", async () => {
  await render();
  expect(trigger().disabled).toBe(false);
  expect(cancelAll()).toBeNull();
  await act(async () => trigger().click());
  expect(host.querySelector(".task-list")?.textContent).toContain("P4 空闲");
  expect(host.querySelectorAll(".task-row")).toHaveLength(0);
  await send("a", "queued", "p4 fstat //depot/...");
  await send("b", "started", "p4 sync -n //depot/...");
  expect(host.querySelector(".task-list")?.textContent).toContain(
    "p4 fstat //depot/...",
  );
  expect(host.querySelector(".task-list")?.textContent).toContain("排队中");
  expect(cancelAll()).toBeTruthy();
  await send("a", "started");
  await send("a", "progress", undefined, 42);
  expect(host.querySelector(".task-list")?.textContent).toContain("42%");
  await send("a", "completed");
  expect(host.querySelectorAll(".task-row")).toHaveLength(1);
  await send("b", "completed");
  expect(trigger().disabled).toBe(false);
  expect(cancelAll()).toBeNull();
  expect(host.querySelector(".task-list")?.textContent).toContain("P4 空闲");
});

it("cancels exactly the selected task and waits for a terminal event before removing it", async () => {
  await render();
  await send("a", "started", "p4 fstat");
  await send("b", "started", "p4 opened");
  await act(async () => trigger().click());
  await act(async () => rowCancel("b").click());
  expect(backend.cancelOperation).toHaveBeenCalledExactlyOnceWith("b");
  expect(rowCancel("b").querySelector('svg[fill="currentColor"]')).toBeTruthy();
  expect(rowCancel("b").disabled).toBe(true);
  expect(host.querySelectorAll(".task-row")).toHaveLength(2);
  await send("b", "cancelled");
  expect(host.querySelectorAll(".task-row")).toHaveLength(1);
  expect(rowCancel("a").disabled).toBe(false);
});

it("offers cancel-all only inside the popup and keeps progress until the runner confirms completion", async () => {
  await render();
  await send("a", "started", "p4 fstat");
  await send("b", "queued", "p4 opened");
  expect(cancelAll()).toBeNull();
  await act(async () => trigger().click());
  expect(host.querySelector(".task-list")?.contains(cancelAll())).toBe(true);
  await act(async () => cancelAll()!.click());
  expect(backend.cancelAllOperations).toHaveBeenCalledOnce();
  expect(backend.cancelOperation).not.toHaveBeenCalled();
  expect(trigger().textContent).toContain("2");
  expect(cancelAll()!.disabled).toBe(true);
  await send("a", "cancelled");
  await send("b", "cancelled");
  expect(cancelAll()).toBeNull();
});

it("shows cancellation failures and allows retry without losing tasks", async () => {
  backend.cancelOperation.mockRejectedValueOnce(new Error("offline"));
  backend.cancelAllOperations.mockRejectedValueOnce(new Error("offline"));
  await render();
  await send("a", "started", "p4 fstat");
  await act(async () => trigger().click());
  await act(async () => rowCancel("a").click());
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(
    "取消请求失败",
  );
  expect(rowCancel("a").disabled).toBe(false);
  await act(async () => cancelAll()!.click());
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(
    "取消全部任务的请求失败",
  );
  expect(cancelAll()!.disabled).toBe(false);
  expect(host.querySelectorAll(".task-row")).toHaveLength(1);
});

it("closes on Escape and outside click and stops observing after unmount", async () => {
  await render();
  await send("a", "started", "p4 info");
  await act(async () => trigger().click());
  await act(async () =>
    host
      .querySelector(".task-list")!
      .dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      ),
  );
  expect(host.querySelector(".task-list")).toBeNull();
  expect(document.activeElement).toBe(trigger());
  await act(async () => trigger().click());
  await act(async () =>
    document.body.dispatchEvent(new Event("pointerdown", { bubbles: true })),
  );
  expect(host.querySelector(".task-list")).toBeNull();
  expect(stop).not.toHaveBeenCalled();
});

it("opens the passive status panel from a separate icon button placed after the P4 idle button, keeps three rows and never nests it in P4 tasks", async () => {
  await render();
  const icon = () =>
    host.querySelector<HTMLButtonElement>(".passive-server-trigger")!;
  const p4 = () => host.querySelector<HTMLButtonElement>(".p4-status")!;
  expect(icon()).toBeTruthy();
  // the status icon comes after the P4 idle/progress button, not before it
  expect(
    p4().compareDocumentPosition(icon()) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(host.querySelectorAll(".passive-server-status")).toHaveLength(1);
  expect(
    host
      .querySelector(".passive-server-status")
      ?.getAttribute("data-status-icon"),
  ).toBe("unknown");
  expect(icon().getAttribute("aria-expanded")).toBe("false");
  expect(icon().getAttribute("aria-controls")).toBeNull();
  expect(host.querySelector(".passive-server-panel")).toBeNull();
  // the P4 tasks button no longer embeds the passive icon
  expect(trigger().querySelector(".passive-server-status")).toBeNull();
  await act(async () => icon().click());
  expect(icon().getAttribute("aria-expanded")).toBe("true");
  expect(icon().getAttribute("aria-controls")).toBeTruthy();
  const panel = host.querySelector<HTMLElement>(".passive-server-panel")!;
  expect(panel).toBeTruthy();
  expect(panel.querySelectorAll(".passive-server-details > div")).toHaveLength(
    3,
  );
  expect(host.querySelector(".task-list")).toBeNull();
  // P4 tasks opens independently and contains no passive status content
  await act(async () => trigger().click());
  expect(host.querySelector(".task-list")).toBeTruthy();
  expect(host.querySelector(".task-list .passive-server-details")).toBeNull();
  expect(host.querySelector(".task-list")!.contains(panel)).toBe(false);
  // toggling the icon closes only the status panel
  await act(async () => icon().click());
  expect(host.querySelector(".passive-server-panel")).toBeNull();
  expect(host.querySelector(".task-list")).toBeTruthy();
  expect(backend.workspaceDiskUsage).not.toHaveBeenCalled();
  expect(backend.cancelOperation).not.toHaveBeenCalled();
  expect(logs).not.toHaveBeenCalled();
});

it("closes the passive status panel on Escape and outside click with focus return", async () => {
  await render();
  const icon = () =>
    host.querySelector<HTMLButtonElement>(".passive-server-trigger")!;
  await act(async () => icon().click());
  await act(async () =>
    host
      .querySelector(".passive-server-panel")!
      .dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      ),
  );
  expect(host.querySelector(".passive-server-panel")).toBeNull();
  expect(document.activeElement).toBe(icon());
  await act(async () => icon().click());
  expect(host.querySelector(".passive-server-panel")).toBeTruthy();
  await act(async () =>
    document.body.dispatchEvent(new Event("pointerdown", { bubbles: true })),
  );
  expect(host.querySelector(".passive-server-panel")).toBeNull();
});
