// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { LogSettingsCard } from "./LogSettingsCard";
const backend = vi.hoisted(() => ({
  openLogsFolder: vi.fn(),
  deleteAllLogs: vi.fn(),
}));
vi.mock("../../infrastructure/backend", () => ({ backend }));
let host: HTMLDivElement, root: Root;
const originals = ["showModal", "close"].map((key) =>
  Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, key),
);
beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.resetAllMocks();
  backend.openLogsFolder.mockResolvedValue(undefined);
  backend.deleteAllLogs.mockResolvedValue(undefined);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  for (const key of ["showModal", "close"])
    Object.defineProperty(HTMLDialogElement.prototype, key, {
      configurable: true,
      value() {},
    });
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  ["showModal", "close"].forEach((key, index) => {
    if (originals[index])
      Object.defineProperty(
        HTMLDialogElement.prototype,
        key,
        originals[index]!,
      );
    else
      delete (
        HTMLDialogElement.prototype as unknown as Record<string, unknown>
      )[key];
  });
});
function button(name: string) {
  return [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent === name,
  )!;
}
it("opens the fixed log folder and deletes only after confirmation, then restores focus", async () => {
  await act(async () => root.render(<LogSettingsCard native zh />));
  await act(async () => button("打开日志文件夹").click());
  expect(backend.openLogsFolder).toHaveBeenCalledExactlyOnceWith();
  await act(async () => button("删除全部日志").click());
  expect(backend.deleteAllLogs).not.toHaveBeenCalled();
  await act(async () => button("取消").click());
  expect(backend.deleteAllLogs).not.toHaveBeenCalled();
  await act(async () => button("删除全部日志").click());
  await act(async () => button("确认删除").click());
  expect(backend.deleteAllLogs).toHaveBeenCalledExactlyOnceWith();
  expect(document.querySelector("dialog")).toBeNull();
  expect(host.querySelector('[role="status"]')?.textContent).toContain(
    "后续日志将继续写入",
  );
  expect(document.activeElement).toBe(button("删除全部日志"));
});
it("keeps errors actionable and allows retrying deletion", async () => {
  backend.deleteAllLogs.mockRejectedValueOnce(new Error("Log file is busy"));
  await act(async () => root.render(<LogSettingsCard native zh={false} />));
  await act(async () => button("Delete all logs").click());
  await act(async () => button("Confirm deletion").click());
  expect(document.querySelector('[role="alert"]')?.textContent).toBe(
    "Log file is busy",
  );
  expect(document.querySelector("dialog")).not.toBeNull();
  await act(async () => button("Confirm deletion").click());
  expect(backend.deleteAllLogs).toHaveBeenCalledTimes(2);
  expect(document.querySelector("dialog")).toBeNull();
});
it("disables folder opening in the browser and labels simulated deletion", async () => {
  await act(async () =>
    root.render(<LogSettingsCard native={false} zh={false} />),
  );
  expect(button("Open log folder").disabled).toBe(true);
  await act(async () => button("Delete all logs").click());
  await act(async () => button("Confirm deletion").click());
  expect(host.textContent).toContain("Simulated logs cleared");
  expect(backend.openLogsFolder).not.toHaveBeenCalled();
});
it("reports folder-opening failures without claiming success", async () => {
  backend.openLogsFolder.mockRejectedValueOnce(
    new Error("Explorer unavailable"),
  );
  await act(async () => root.render(<LogSettingsCard native zh={false} />));
  await act(async () => button("Open log folder").click());
  expect(host.querySelector('[role="alert"]')?.textContent).toBe(
    "Explorer unavailable",
  );
});
