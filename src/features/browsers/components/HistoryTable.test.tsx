// @vitest-environment jsdom
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HistoryTable, historyTime } from "./HistoryTable";
import type { FileRevision } from "../../../shared/contracts";
import { setLocale } from "../../../shared/i18n";

// Presentation only: no backend imports, app mount, network or P4.
const measured = vi.hoisted(() => ({ measure: vi.fn(), element: vi.fn() }));
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    measure: measured.measure,
    measureElement: measured.element,
    getTotalSize: () => count * 52,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        index,
        start: index * 52,
      })),
  }),
}));
let host: HTMLDivElement, root: Root;
let available = 200;
const observers = new Set<() => void>();
const select = vi.fn();
const item = (revision: number, description: string): FileRevision => ({
  depotPath: "//mock/file",
  revision,
  changelistId: 100 + revision,
  user: "author",
  time: "2026-10-20T12:34:00Z",
  description,
  action: "edit",
  fileType: "text",
  integrations: [],
});
beforeEach(() => {
  setLocale("en-US");
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  available = 200;
  observers.clear();
  select.mockClear();
  measured.measure.mockClear();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private callback: () => void) {
        observers.add(callback);
      }
      observe() {}
      disconnect() {
        observers.delete(this.callback);
      }
    },
  );
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(
    () => available,
  );
  vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(
    function (this: HTMLElement) {
      return (this.textContent?.length ?? 0) * 10;
    },
  );
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function render(rows: FileRevision[]) {
  await act(async () =>
    root.render(
      <HistoryTable
        rows={rows}
        scroll={createRef()}
        zh={false}
        isSelected={() => false}
        onSelect={select}
        rowMenu={() => ({
          "data-menu-object": "V01",
          onContextMenu() {},
          onKeyDown() {},
        })}
      />,
    ),
  );
}
async function click(element: Element) {
  await act(async () =>
    element.dispatchEvent(new MouseEvent("click", { bubbles: true })),
  );
}
it("shows exactly revision/CL, time, author and description; missing time is a placeholder", async () => {
  await render([item(2, "short"), { ...item(1, ""), time: "" }]);
  expect(
    [...host.querySelectorAll('[role="columnheader"]')].map(
      (cell) => cell.textContent,
    ),
  ).toEqual(["Revision / CL", "Time", "User", "Description"]);
  expect(
    [...host.querySelectorAll(".history-row:first-child")][0].textContent,
  ).toContain("#2 · CL 102");
  expect(
    [...host.querySelectorAll("time")].map((cell) => cell.textContent),
  ).toEqual([historyTime("2026-10-20T12:34:00Z", "en-US"), "—"]);
  expect(
    host.querySelectorAll(".history-description-toggle-slot button"),
  ).toHaveLength(0);
  expect(host.textContent).not.toContain("Details");
  expect(historyTime("invalid")).toBe("—");
});
it("expands separate records below their rows without selecting and preserves full newlines", async () => {
  await render([item(2, "first\nsecond"), item(1, "x".repeat(500))]);
  const buttons = host.querySelectorAll<HTMLButtonElement>(
    ".history-description-toggle-slot button",
  );
  expect(buttons[0].title).toBe("Expand description");
  await click(buttons[0]);
  await click(buttons[1]);
  expect(select).not.toHaveBeenCalled();
  expect(host.querySelectorAll(".history-description-row")).toHaveLength(2);
  expect(
    host.querySelector(".history-row")!.nextElementSibling?.textContent,
  ).toBe("first\nsecond");
  expect(
    host.querySelector('.history-description-row [aria-colspan="4"]'),
  ).not.toBeNull();
  expect(buttons[0].getAttribute("aria-expanded")).toBe("true");
  expect(
    document.getElementById(buttons[0].getAttribute("aria-controls")!),
  ).not.toBeNull();
  await click(buttons[0]);
  expect(host.querySelectorAll(".history-description-row")).toHaveLength(1);
  expect(measured.measure).toHaveBeenCalled();
});
it("remeasures truncation on width changes and retains the collapse control while open", async () => {
  await render([item(1, "x".repeat(50))]);
  await click(host.querySelector(".history-description-toggle-slot button")!);
  available = 1000;
  await act(async () => observers.forEach((measure) => measure()));
  expect(host.querySelector('button[aria-expanded="true"]')).not.toBeNull();
  await click(host.querySelector(".history-description-toggle-slot button")!);
  expect(
    host.querySelector(".history-description-toggle-slot button"),
  ).toBeNull();
  available = 100;
  await act(async () => observers.forEach((measure) => measure()));
  expect(host.querySelector('button[aria-expanded="false"]')).not.toBeNull();
});
it("resizes with pointer capture, clamps minimum widths and leaves selection untouched", async () => {
  await render([item(1, "short")]);
  const handle = host.querySelector<HTMLElement>('[role="separator"]')!;
  Object.defineProperties(handle, {
    setPointerCapture: { value: vi.fn() },
    releasePointerCapture: { value: vi.fn() },
  });
  async function pointer(type: string, clientX: number) {
    const event = new MouseEvent(type, { bubbles: true, button: 0, clientX });
    Object.defineProperty(event, "pointerId", { value: 1 });
    await act(async () => handle.dispatchEvent(event));
  }
  await pointer("pointerdown", 100);
  await pointer("pointermove", 160);
  await pointer("pointerup", 160);
  expect(handle.getAttribute("aria-valuenow")).toBe("230");
  expect(
    (host.querySelector(".workspace-head") as HTMLElement).style
      .gridTemplateColumns,
  ).toBe(
    (host.querySelector(".history-row") as HTMLElement).style
      .gridTemplateColumns,
  );
  await pointer("pointerdown", 160);
  await pointer("pointermove", -1000);
  await pointer("pointerup", -1000);
  expect(handle.getAttribute("aria-valuenow")).toBe("140");
  await act(async () =>
    handle.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
    ),
  );
  expect(handle.getAttribute("aria-valuenow")).toBe("150");
  expect(select).not.toHaveBeenCalled();
});
it("keeps keyboard row selection separate from description controls", async () => {
  await render([item(1, "a\nb")]);
  await act(async () =>
    host
      .querySelector(".history-row")!
      .dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      ),
  );
  expect(select).toHaveBeenCalledOnce();
  select.mockClear();
  await act(async () =>
    host
      .querySelector(".history-description-toggle-slot button")!
      .dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      ),
  );
  expect(select).not.toHaveBeenCalled();
});

it("always includes the year across New Year and both UI languages, keeping local time and minute precision", () => {
  for (const [year, month, day] of [
    [2024, 11, 31],
    [2025, 0, 1],
    [new Date().getFullYear(), 5, 15],
  ]) {
    const raw = new Date(year, month, day, 12, 34, 56).toISOString();
    for (const locale of ["zh-CN", "en-US"]) {
      const formatted = historyTime(raw, locale);
      expect(formatted).toContain(String(year));
      expect(formatted).toContain("12:34");
      expect(formatted).not.toContain(":56");
    }
  }
  const raw = new Date(2024, 11, 31, 12, 34).toISOString();
  expect(historyTime(raw, "zh-CN")).toContain("2024年12月31日");
  expect(historyTime(raw, "en-US")).toContain("Dec 31, 2024");
  for (const locale of ["zh-CN", "en-US"]) {
    expect(historyTime("", locale)).toBe("—");
    expect(historyTime("invalid", locale)).toBe("—");
  }
});
it("gives the complete date room and exposes it as a tooltip when resized", async () => {
  await render([item(1, "short")]);
  const time = host.querySelector("time")!;
  expect(time.title).toBe(time.textContent);
  const resize = host.querySelectorAll('[role="separator"]')[1];
  expect(resize.getAttribute("aria-valuenow")).toBe("210");
  expect(resize.getAttribute("aria-valuemin")).toBe("190");
});
