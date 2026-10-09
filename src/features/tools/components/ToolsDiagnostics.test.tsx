// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  DiagnosticAlert,
  LogEntry,
  LogPolicy,
  OperationEvent,
} from "../../../shared/contracts/types";
import { DiagnosticsView } from "./DiagnosticsView";
import { LogView } from "./LogView";
import { OperationJournalView } from "./OperationJournalView";
import { ToolArea } from "../ToolArea";
import { messages } from "../../../shared/i18n";
import { ContextMenuProvider } from "../../../app/context-menu/ContextMenu";

const backend = vi.hoisted(() => ({
  queryLogPage: vi.fn(),
  getLogPolicy: vi.fn(),
  setLogPolicy: vi.fn(),
  queryOperationJournal: vi.fn(),
  statusCacheDiagnostics: vi.fn(),
  exportDiagnostics: vi.fn(),
  subscribeOperationEvents: vi.fn(),
  subscribeDiagnosticAlerts: vi.fn(),
  runP4: vi.fn(),
  cancelOperation: vi.fn(),
}));
vi.mock("../../../infrastructure/backend", () => ({
  backend,
  tokenize: (value: string) => value.trim().split(/\s+/),
}));

let host: HTMLDivElement;
let root: Root;
let diagnosticAlert: ((alert: DiagnosticAlert) => void) | undefined;

const policy: LogPolicy = {
  autoExpandWarning: true,
  autoExpandError: true,
  retentionDays: 14,
  maxMib: 25,
};

function log(id: string, operationId = `op-${id}`): LogEntry {
  return {
    id,
    timestamp: "2026-10-09T01:02:03Z",
    level: "warning",
    operationId,
    source: "gui",
    server: "fixture:1666",
    workspace: "fixture-client",
    command: "p4 sync",
    message: `safe message ${id}`,
    durationMs: 12,
    repeatCount: 1,
  };
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function button(text: string) {
  return [...host.querySelectorAll<HTMLButtonElement>("button")].find((item) =>
    item.textContent?.includes(text),
  )!;
}

beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  Object.values(backend).forEach((mock) => mock.mockReset());
  backend.getLogPolicy.mockResolvedValue(policy);
  backend.setLogPolicy.mockResolvedValue(policy);
  backend.queryLogPage.mockResolvedValue({ entries: [] });
  backend.queryOperationJournal.mockResolvedValue({ records: [] });
  backend.statusCacheDiagnostics.mockResolvedValue({
    hits: 8,
    misses: 2,
    coalesced: 1,
    evicted: 3,
    invalidated: 4,
    staleFallbacks: 5,
    superseded: 6,
    loadCount: 7,
    totalLoadMs: 80,
    entries: 9,
    estimatedBytes: 2048,
    invalidationReasons: { ManualRefresh: 1 },
  });
  backend.exportDiagnostics.mockResolvedValue({
    path: "C:\\safe\\p4deck-diagnostic.json",
    sizeBytes: 1024,
    truncated: false,
    format: "json",
  });
  backend.subscribeOperationEvents.mockImplementation(
    async (_callback: (event: OperationEvent) => void) => () => undefined,
  );
  backend.subscribeDiagnosticAlerts.mockImplementation(
    async (callback: (alert: DiagnosticAlert) => void) => {
      diagnosticAlert = callback;
      return () => undefined;
    },
  );
  Object.assign(navigator, {
    clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

it("applies real log filters, cursor retry, stale isolation, and accessible narrow structure", async () => {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: 390,
  });
  backend.queryLogPage
    .mockResolvedValueOnce({ entries: [log("1")], nextCursor: "cursor-1" })
    .mockRejectedValueOnce(new Error("append failed"))
    .mockResolvedValueOnce({ entries: [log("2")], nextCursor: undefined });
  const onJournal = vi.fn();
  const props: ComponentProps<typeof LogView> = {
    zh: false,
    connectionKey: "connection-a",
    refreshKey: 0,
    operationFilter: "op-filter",
    onOperationFilter: vi.fn(),
    onOpenJournal: onJournal,
    onPolicy: vi.fn(),
  };
  await act(async () => root.render(<LogView {...props} />));
  await flush();
  expect(backend.queryLogPage).toHaveBeenCalledWith(
    expect.objectContaining({ operationId: "op-filter", limit: 100 }),
  );
  expect(host.textContent).toContain("safe message 1");
  expect(host.querySelector(".diagnostic-scroll table")).toBeTruthy();
  expect(
    host.querySelector('[role="status"][aria-live="polite"]'),
  ).toBeTruthy();
  expect(host.querySelector('input[aria-label="Search logs"]')).toBeTruthy();
  await act(async () => button("View operation").click());
  expect(onJournal).toHaveBeenCalledWith("op-filter");
  await act(async () => button("Load more").click());
  await flush();
  expect(host.textContent).toContain("append failed");
  await act(async () => button("Retry load more").click());
  await flush();
  expect(backend.queryLogPage).toHaveBeenLastCalledWith(
    expect.objectContaining({ cursor: "cursor-1" }),
  );
  expect(host.textContent).toContain("safe message 2");

  let resolveOld!: (value: { entries: LogEntry[] }) => void;
  backend.queryLogPage.mockReturnValueOnce(
    new Promise((resolve) => {
      resolveOld = resolve;
    }),
  );
  await act(async () => root.render(<LogView {...props} refreshKey={1} />));
  backend.queryLogPage.mockResolvedValueOnce({ entries: [log("new")] });
  await act(async () =>
    root.render(
      <LogView {...props} connectionKey="connection-b" refreshKey={2} />,
    ),
  );
  await flush();
  await act(async () => resolveOld({ entries: [log("stale")] }));
  expect(host.textContent).toContain("safe message new");
  expect(host.textContent).not.toContain("safe message stale");
  const selects = host.querySelectorAll<HTMLSelectElement>("select");
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLSelectElement.prototype,
      "value",
    )!.set!.call(selects[0], "error");
    selects[0].dispatchEvent(new Event("change", { bubbles: true }));
    Object.getOwnPropertyDescriptor(
      HTMLSelectElement.prototype,
      "value",
    )!.set!.call(selects[1], "terminal");
    selects[1].dispatchEvent(new Event("change", { bubbles: true }));
  });
  await flush();
  expect(backend.queryLogPage).toHaveBeenLastCalledWith(
    expect.objectContaining({ levels: ["error"], sources: ["terminal"] }),
  );
});

it("validates policy and rolls the form back after a failed save", async () => {
  backend.setLogPolicy.mockRejectedValueOnce(new Error("disk full"));
  await act(async () =>
    root.render(
      <LogView
        zh
        connectionKey="a"
        refreshKey={0}
        onOperationFilter={vi.fn()}
        onOpenJournal={vi.fn()}
        onPolicy={vi.fn()}
      />,
    ),
  );
  await flush();
  await act(async () =>
    host.querySelector<HTMLDetailsElement>("details")!.setAttribute("open", ""),
  );
  const retention = host.querySelector<HTMLInputElement>(
    'input[type="number"]',
  )!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(retention, "20");
    retention.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => button("保存策略").click());
  await flush();
  expect(backend.setLogPolicy).toHaveBeenCalledWith(
    expect.objectContaining({ retentionDays: 20 }),
  );
  expect(retention.value).toBe("14");
  expect(host.textContent).toContain("已恢复原策略");
});

it("auto-expands once per diagnostic alert without moving focus", async () => {
  const focused = document.createElement("button");
  document.body.append(focused);
  focused.focus();
  await act(async () =>
    root.render(
      <ContextMenuProvider scope="tools-test" zh>
        <ToolArea
          t={messages["zh-CN"]}
          zh
          native
          connectionKey="a"
          context={{ server: "fixture", user: "u", client: "c" }}
          onOpenChange={vi.fn()}
        />
      </ContextMenuProvider>,
    ),
  );
  await flush();
  expect(diagnosticAlert).toBeTypeOf("function");
  await act(async () => {
    diagnosticAlert!({ operationId: "op-alert", level: "warning" });
    diagnosticAlert!({ operationId: "op-alert", level: "warning" });
  });
  await flush();
  expect(
    host.querySelector('[role="tab"][aria-selected="true"]')?.textContent,
  ).toContain("日志");
  expect(host.textContent).toContain("op-alert");
  expect(document.activeElement).toBe(focused);
  await act(async () => button("查看操作").click());
  await flush();
  expect(
    host.querySelector('[role="tab"][aria-selected="true"]')?.textContent,
  ).toContain("操作");
  expect(backend.queryOperationJournal).toHaveBeenCalledWith(
    expect.objectContaining({ keyword: "op-alert" }),
  );
  focused.remove();
});

it("filters and paginates the journal and jumps back to related logs", async () => {
  backend.queryOperationJournal.mockResolvedValueOnce({
    records: [
      {
        operationId: "op-42",
        connectionId: "c",
        workspace: "ws",
        source: "gui",
        category: "submit",
        state: "failed",
        failure: "permissionDenied",
        startedAt: "2026-10-09T01:00:00Z",
        finishedAt: "2026-10-09T01:00:01Z",
        logReference: "op-42",
      },
    ],
    nextCursor: "journal-next",
  });
  const onLogs = vi.fn();
  await act(async () =>
    root.render(
      <OperationJournalView
        zh={false}
        connectionKey="a"
        focusOperationId="op-42"
        onOpenLogs={onLogs}
      />,
    ),
  );
  await flush();
  expect(backend.queryOperationJournal).toHaveBeenCalledWith(
    expect.objectContaining({ keyword: "op-42", limit: 50 }),
  );
  expect(host.textContent).toContain("permissionDenied");
  expect(host.textContent).toContain("1000 ms");
  await act(async () => button("View logs").click());
  expect(onLogs).toHaveBeenCalledWith("op-42");
  await act(async () => button("Load more").click());
  expect(backend.queryOperationJournal).toHaveBeenLastCalledWith(
    expect.objectContaining({ cursor: "journal-next" }),
  );
  const selects = host.querySelectorAll<HTMLSelectElement>("select");
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLSelectElement.prototype,
      "value",
    )!.set!.call(selects[0], "failed");
    selects[0].dispatchEvent(new Event("change", { bubbles: true }));
    Object.getOwnPropertyDescriptor(
      HTMLSelectElement.prototype,
      "value",
    )!.set!.call(selects[1], "submit");
    selects[1].dispatchEvent(new Event("change", { bubbles: true }));
  });
  await flush();
  expect(backend.queryOperationJournal).toHaveBeenLastCalledWith(
    expect.objectContaining({ state: "failed", category: "submit" }),
  );
});

it("refreshes real cache counters and reports safe export success and failure", async () => {
  await act(async () =>
    root.render(<DiagnosticsView zh={false} connectionKey="a" native />),
  );
  await flush();
  expect(host.textContent).toContain("80.0%");
  expect(host.textContent).toContain("Offline stale fallbacks");
  expect(host.textContent).toContain("2.0 KiB");
  await act(async () => button("Export").click());
  await flush();
  expect(backend.exportDiagnostics).toHaveBeenCalledWith({});
  expect(host.textContent).toContain("C:\\safe\\p4deck-diagnostic.json");
  expect(host.textContent).not.toMatch(/hunter2|ticket-value|AA:BB:CC:DD/);
  backend.exportDiagnostics.mockRejectedValueOnce(new Error("write denied"));
  await act(async () => button("Export").click());
  await flush();
  expect(host.textContent).toContain("Export failed: Error: write denied");
  expect(host.querySelector('[role="status"]')).toBeTruthy();
  expect(
    host.querySelector("section[aria-labelledby=cache-heading]"),
  ).toBeTruthy();
});
