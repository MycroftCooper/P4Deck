// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FilePreviewPage } from "./FilePreviewPage";
import type { RuntimeInfo } from "../../../shared/contracts";

const backend = vi.hoisted(() => ({ getFilePreview: vi.fn() }));
vi.mock("../../../infrastructure/backend", () => ({ backend }));
vi.mock("../../../app/context-menu/useContentMenu", () => ({
  useContentMenu: () => () => ({}),
}));
vi.mock("../../../app/docking/chrome", async () => ({
  PageRefreshSlotContext: (await import("react")).createContext(null),
}));
let host: HTMLDivElement, root: Root;
const runtime = { mode: "mock", p4Version: "mock", context: {} } as RuntimeInfo;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  // jsdom has no layout: supply a visible viewport, retain the real virtualizer.
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(240);
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(600);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  HTMLElement.prototype.scrollTo = vi.fn();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function render(content: string) {
  backend.getFilePreview.mockResolvedValue({
    kind: "text",
    content,
    encoding: "UTF-8",
    size: content.length,
  });
  await act(async () =>
    root.render(
      <FilePreviewPage
        target="synthetic.json"
        locked={false}
        onTargetChange={() => {}}
        runtime={runtime}
        zh={false}
      />,
    ),
  );
  expect(host.textContent).toContain("Reading");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(160);
  });
}
it.each([
  ['{"enabled":true}', 1],
  [
    '{\n  "name": "fixture",\n  "enabled": true,\n  "items": [\n    1,\n    2\n  ],\n  "label": "中文 🚀"\n}',
    9,
  ],
  ['{\r\n  "label": "中文 🚀"\r\n}', 3],
  ["{ invalid JSON :", 1],
])(
  "renders raw JSON text after asynchronous loading: %s",
  async (content, count) => {
    await render(content);
    expect(host.querySelectorAll(".preview-line")).toHaveLength(count);
    expect(host.querySelector("code")?.textContent).toBe(
      content.split(/\r?\n/)[0],
    );
    expect(host.textContent).toContain(`${count} lines`);
  },
);
it("keeps long single-line JSON bounded and explicitly marks truncation", async () => {
  await render(JSON.stringify({ value: "a".repeat(10000) }));
  expect(host.querySelector("code")?.textContent).toHaveLength(4024);
  expect(host.textContent).toContain("long line truncated");
});
it("distinguishes an empty file from an invisible text viewport", async () => {
  await render("");
  expect(host.textContent).toContain("File is empty");
});
it("shows a read failure instead of a blank body", async () => {
  backend.getFilePreview.mockRejectedValue(new Error("synthetic read failure"));
  await act(async () =>
    root.render(
      <FilePreviewPage
        target="error.json"
        locked={false}
        onTargetChange={() => {}}
        runtime={runtime}
        zh={false}
      />,
    ),
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(20000);
  });
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(
    "synthetic read failure",
  );
});
