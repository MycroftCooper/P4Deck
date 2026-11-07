// @vitest-environment jsdom
import { act, createRef, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  DiagnosticAlert,
  LogEntry,
  LogPolicy,
  OperationEvent,
  OperationRecord,
} from "../../../shared/contracts";
import { DiagnosticsView } from "./DiagnosticsView";
import { LogView } from "./LogView";
import {
  OperationJournalView,
  operationRecoveryGuidance,
} from "./OperationJournalView";
import { ToolArea, type ToolHandle } from "../ToolArea";
import { ToolPanel } from "../ToolPanel";
import { messages, setLocale } from "../../../shared/i18n";
import { ContextMenuProvider } from "../../../app/context-menu/ContextMenu";

const backend = vi.hoisted(() => ({
  queryLogPage: vi.fn(),
  getLogPolicy: vi.fn(),
  setLogPolicy: vi.fn(),
  subscribeLogsCleared: vi.fn(),
  queryOperationJournal: vi.fn(),
  statusCacheDiagnostics: vi.fn(),
  exportDiagnostics: vi.fn(),
  subscribeOperationEvents: vi.fn(),
  subscribeDiagnosticAlerts: vi.fn(),
  runP4: vi.fn(),
  cancelOperation: vi.fn(),
  companySubmitConnectionSnapshot: vi.fn(),
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
  // Components translate through the module-level locale.
  setLocale("zh-CN");
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  Object.values(backend).forEach((mock) => mock.mockReset());
  backend.getLogPolicy.mockResolvedValue(policy);
  backend.companySubmitConnectionSnapshot.mockResolvedValue({
    profileId: "fixture",
    generation: "1",
    server: "fixture:1666",
    user: "tester",
    client: "fixture-client",
  });
  backend.setLogPolicy.mockResolvedValue({
    kind: "logPolicySet",
    operationId: "op-policy",
    state: "committed",
    outcome: "succeeded",
    artifact: { exists: true, sizeBytes: 128, sha256: "C".repeat(64) },
    details: policy,
    optimistic: "intentOnly",
    message: "saved",
    legacy: policy,
  });
  backend.queryLogPage.mockResolvedValue({ entries: [] });
  backend.subscribeLogsCleared.mockResolvedValue(() => undefined);
  backend.queryOperationJournal.mockResolvedValue({ records: [] });
  backend.cancelOperation.mockResolvedValue(undefined);
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
    kind: "diagnosticsExport",
    operationId: "op-export",
    state: "committed",
    outcome: "succeeded",
    artifact: {
      path: "C:\\safe\\p4deck-diagnostic.json",
      fileName: "p4deck-diagnostic.json",
      exists: true,
      sizeBytes: 1024,
      sha256: "B".repeat(64),
    },
    details: { format: "json", truncated: false, sizeBytes: 1024 },
    optimistic: "intentOnly",
    message: "exported",
    legacy: null,
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

it("renders a cancelled log as a non-error Cancelled row and filters by the cancelled level", async () => {
  const cancelledEntry: LogEntry = { ...log("cancelled"), level: "cancelled" };
  backend.queryLogPage.mockResolvedValue({ entries: [cancelledEntry] });
  const props: ComponentProps<typeof LogView> = {
    zh: false,
    connectionKey: "connection-a",
    refreshKey: 0,
    onOperationFilter: vi.fn(),
    onOpenJournal: vi.fn(),
  };
  await act(async () => root.render(<LogView {...props} />));
  await flush();
  expect(host.textContent).toContain("Cancelled");
  expect(host.querySelector("tr.cancelled td:nth-child(2)")?.textContent).toBe(
    "Cancelled",
  );
  const row = host.querySelector("tr.cancelled");
  expect(row).toBeTruthy();
  expect(row!.getAttribute("data-level")).toBe("cancelled");
  // The cancelled row is not styled as an error row.
  expect(host.querySelector("tr.error")).toBeNull();
  const levelSelect = host.querySelector<HTMLSelectElement>(
    'select[aria-label="Log level"]',
  )!;
  const option = [...levelSelect.options].find(
    (item) => item.value === "cancelled",
  );
  expect(option?.textContent).toBe("Cancelled");
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLSelectElement.prototype,
      "value",
    )!.set!.call(levelSelect, "cancelled");
    levelSelect.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await flush();
  expect(backend.queryLogPage).toHaveBeenLastCalledWith(
    expect.objectContaining({ levels: ["cancelled"] }),
  );
  // Filter request for cancelled shows only the cancelled entry.
  expect(host.textContent).toContain("safe message cancelled");
});

it("clears visible logs immediately and ignores stale loads after all logs are deleted", async () => {
  let cleared!: () => void;
  backend.subscribeLogsCleared.mockImplementation(
    async (callback: () => void) => {
      cleared = callback;
      return () => undefined;
    },
  );
  const props: ComponentProps<typeof LogView> = {
    zh: false,
    connectionKey: "active",
    refreshKey: 0,
    onOperationFilter: vi.fn(),
    onOpenJournal: vi.fn(),
  };
  backend.queryLogPage.mockResolvedValueOnce({
    entries: [log("before-delete")],
  });
  await act(async () => root.render(<LogView {...props} />));
  expect(host.textContent).toContain("safe message before-delete");
  let stale!: (value: { entries: LogEntry[] }) => void;
  backend.queryLogPage.mockReturnValueOnce(
    new Promise((resolve) => {
      stale = resolve;
    }),
  );
  await act(async () => root.render(<LogView {...props} refreshKey={1} />));
  backend.queryLogPage.mockResolvedValueOnce({ entries: [] });
  await act(async () => cleared());
  await act(async () => stale({ entries: [log("stale-deleted")] }));
  expect(host.textContent).not.toContain("safe message");
  expect(host.textContent).toContain("No matching logs");
});

it("drops a policy readback that a connection change retired", async () => {
  const policyInputs = () => [
    ...host.querySelectorAll<HTMLInputElement>(".policy-grid input"),
  ];
  let resolveFirst!: (value: LogPolicy) => void;
  backend.getLogPolicy.mockReturnValueOnce(
    new Promise((resolve) => {
      resolveFirst = resolve;
    }),
  );
  const props: ComponentProps<typeof LogView> = {
    zh: false,
    connectionKey: "connection-a",
    refreshKey: 0,
    onOperationFilter: vi.fn(),
    onOpenJournal: vi.fn(),
  };
  await act(async () => root.render(<LogView {...props} />));
  expect(policyInputs()).toHaveLength(0);
  // The first connection's readback is still outstanding.
  backend.getLogPolicy.mockResolvedValue({ ...policy, retentionDays: 7 });
  await act(async () =>
    root.render(<LogView {...props} connectionKey="connection-b" />),
  );
  await flush();
  expect(policyInputs()[0]?.value).toBe("7");
  await act(async () => resolveFirst({ ...policy, retentionDays: 29 }));
  await flush();
  // The retired readback must not overwrite the new connection's policy.
  expect(policyInputs()[0]?.value).toBe("7");
});

it("retires an in-flight log read when the view is cleared", async () => {
  let resolveRead!: (value: { entries: LogEntry[] }) => void;
  backend.queryLogPage.mockReturnValueOnce(
    new Promise((resolve) => {
      resolveRead = resolve;
    }),
  );
  await act(async () =>
    root.render(
      <LogView
        zh={false}
        connectionKey="a"
        refreshKey={0}
        onOperationFilter={vi.fn()}
        onOpenJournal={vi.fn()}
      />,
    ),
  );
  await act(async () => button("Clear view").click());
  await act(async () => resolveRead({ entries: [log("late")] }));
  await flush();
  // A read nobody is waiting for any more cannot repopulate the cleared view.
  expect(host.textContent).not.toContain("safe message late");
  expect(host.textContent).toContain("No matching logs");
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
      />,
    ),
  );
  await flush();
  await act(async () =>
    host.querySelector<HTMLDetailsElement>("details")!.setAttribute("open", ""),
  );
  expect(host.textContent).toContain("新日志不会自动展开");
  expect(host.textContent).not.toContain("Warning 时展开工具区");
  expect(host.textContent).not.toContain("Error 时展开工具区");
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
  expect(backend.setLogPolicy).toHaveBeenCalledWith({
    policy: expect.objectContaining({ retentionDays: 20 }),
    operationId: expect.any(String),
  });
  expect(retention.value).toBe("14");
  expect(host.textContent).toContain("保存结果不确定");
});

it("never auto-expands logs and only marks unviewed errors", async () => {
  localStorage.setItem("p4deck.toolOpen", "true");
  const focused = document.createElement("button");
  document.body.append(focused);
  const tools = createRef<ToolHandle>();
  await act(async () =>
    root.render(
      <ContextMenuProvider scope="tools-test" zh>
        <ToolArea
          ref={tools}
          t={messages["zh-CN"]}
          zh
          native
          connectionKey="a"
          context={{ server: "fixture", user: "u", client: "c" }}
          onOpenChange={vi.fn()}
          onOpenSettings={vi.fn()}
        />
      </ContextMenuProvider>,
    ),
  );
  await flush();
  focused.focus();
  expect(diagnosticAlert).toBeTypeOf("function");
  expect(
    host.querySelector('[role="tab"][aria-selected="true"]')?.textContent,
  ).toContain("命令行");
  await act(async () => {
    await tools.current!.afterOperation(["warning from operation"]);
    diagnosticAlert!({ operationId: "op-alert", level: "warning" });
    diagnosticAlert!({ operationId: "op-alert", level: "warning" });
  });
  await flush();
  expect(
    host.querySelector('[role="tab"][aria-selected="true"]')?.textContent,
  ).toContain("命令行");
  expect(host.querySelector(".tool-unread-dot")).toBeNull();
  await act(async () => {
    diagnosticAlert!({ operationId: "op-error", level: "error" });
    diagnosticAlert!({ operationId: "op-error", level: "error" });
  });
  await flush();
  expect(
    host.querySelector('[role="tab"][aria-selected="true"]')?.textContent,
  ).toContain("命令行");
  expect(host.querySelector(".tool-unread-dot")?.getAttribute("title")).toBe(
    "1 个未查看的新错误",
  );
  expect(host.textContent).not.toContain("op-error");
  expect(document.activeElement).toBe(focused);
  await act(async () => backend.subscribeLogsCleared.mock.calls[0][0]());
  expect(host.querySelector(".tool-unread-dot")).toBeNull();
  await act(async () => button("日志").click());
  await flush();
  expect(
    host.querySelector('[role="tab"][aria-selected="true"]')?.textContent,
  ).toContain("日志");
  expect(host.querySelector(".tool-unread-dot")).toBeNull();
  expect(host.textContent).not.toContain("操作筛选");
  await act(async () => {
    diagnosticAlert!({ operationId: "op-visible", level: "error" });
  });
  await flush();
  expect(host.querySelector(".tool-unread-dot")).toBeNull();

  const journalTab = [
    ...host.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
  ].find((item) => item.textContent?.includes("操作"))!;
  await act(async () => journalTab.click());
  await act(async () => {
    diagnosticAlert!({ operationId: "op-journal", level: "error" });
  });
  await flush();
  expect(journalTab.getAttribute("aria-selected")).toBe("true");
  expect(host.textContent).not.toContain("op-journal");
  expect(host.querySelector(".tool-unread-dot")).toBeTruthy();
  await act(async () => button("日志").click());
  expect(host.querySelector(".tool-unread-dot")).toBeNull();

  const toggle = host.querySelector<HTMLButtonElement>(".drawer-toggle")!;
  await act(async () => toggle.click());
  expect(host.querySelector(".tool-drawer")?.classList).toContain("collapsed");
  await act(async () => {
    diagnosticAlert!({ operationId: "op-collapsed", level: "error" });
  });
  await flush();
  expect(host.querySelector(".tool-drawer")?.classList).toContain("collapsed");
  expect(host.querySelector(".tool-unread-dot")).toBeTruthy();
  await act(async () => toggle.click());
  expect(host.querySelector(".tool-drawer")?.classList).toContain("expanded");
  expect(host.querySelector(".tool-unread-dot")).toBeNull();
  focused.remove();
});

it("blocks credential commands before backend execution and offers Settings recovery", async () => {
  localStorage.setItem("p4deck.toolOpen", "true");
  const openSettings = vi.fn();
  await act(async () =>
    root.render(
      <ContextMenuProvider scope="terminal-security-test" zh>
        <ToolArea
          t={messages["zh-CN"]}
          zh
          native
          connectionKey="terminal-security"
          context={{ server: "fixture", user: "u", client: "c" }}
          onOpenChange={vi.fn()}
          onOpenSettings={openSettings}
        />
      </ContextMenuProvider>,
    ),
  );
  await flush();
  const input = host.querySelector<HTMLInputElement>(".terminal-input input")!;
  const sentinel = "P4DECK_SECRET_frontend_91b7";
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, `info P4PASSWD=${sentinel}`);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => button("运行").click());
  expect(backend.runP4).not.toHaveBeenCalled();
  expect(host.textContent).not.toContain(sentinel);
  expect(localStorage.getItem("p4deck.terminalHistory")).toBe("[]");
  expect(host.textContent).toContain("打开连接设置");
  await act(async () => button("打开连接设置").click());
  expect(openSettings).toHaveBeenCalledOnce();
});

it("keeps the credential boundary inside a detached-capable Terminal panel", async () => {
  await act(async () =>
    root.render(
      <ContextMenuProvider scope="detached-terminal-security" zh={false}>
        <ToolPanel
          kind="terminal"
          t={messages["en-US"]}
          zh={false}
          native
          connectionKey="profile:7"
          context={{ server: "fixture", user: "u", client: "c" }}
          onOpenSettings={vi.fn()}
        />
      </ContextMenuProvider>,
    ),
  );
  await flush();
  const input = host.querySelector<HTMLInputElement>(".terminal-input input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, "p4 login2 -P never-persist-this");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => button("Run").click());
  expect(backend.runP4).not.toHaveBeenCalled();
  expect(host.textContent).not.toContain("never-persist-this");
  expect(localStorage.getItem("p4deck.terminalHistory")).toBe("[]");
});

it("routes Terminal lock commands to the file preflight workflow without an auth prompt", async () => {
  localStorage.setItem("p4deck.toolOpen", "true");
  await act(async () =>
    root.render(
      <ContextMenuProvider scope="terminal-lock-workflow" zh={false}>
        <ToolArea
          t={messages["en-US"]}
          zh={false}
          native
          connectionKey="terminal-lock"
          context={{ server: "fixture", user: "u", client: "c" }}
          onOpenChange={vi.fn()}
          onOpenSettings={vi.fn()}
        />
      </ContextMenuProvider>,
    ),
  );
  await flush();
  const input = host.querySelector<HTMLInputElement>(".terminal-input input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, "lock //depot/main/a.txt");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => button("Run").click());
  expect(backend.runP4).not.toHaveBeenCalled();
  expect(host.textContent).toContain(
    "file toolbar or context-menu preflight workflow",
  );
  expect(host.textContent).not.toContain("Settings > Connections");
});

it("keeps normal terminal execution and history after backend validation", async () => {
  localStorage.setItem("p4deck.toolOpen", "true");
  backend.runP4.mockResolvedValue({
    operationId: "normal-info",
    exitCode: 0,
    durationMs: 2,
    events: [
      {
        operationId: "normal-info",
        type: "stdout",
        message: "safe info",
        timestamp: "2026-10-09T01:02:03Z",
      },
    ],
  });
  await act(async () =>
    root.render(
      <ContextMenuProvider scope="terminal-normal-test" zh>
        <ToolArea
          t={messages["zh-CN"]}
          zh
          native
          connectionKey="terminal-normal"
          context={{ server: "fixture", user: "u", client: "c" }}
          onOpenChange={vi.fn()}
          onOpenSettings={vi.fn()}
        />
      </ContextMenuProvider>,
    ),
  );
  await flush();
  const input = host.querySelector<HTMLInputElement>(".terminal-input input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, "info");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => button("运行").click());
  await flush();
  expect(backend.runP4).toHaveBeenCalledWith(
    expect.objectContaining({ command: "info", args: [] }),
  );
  expect(localStorage.getItem("p4deck.terminalHistory")).toBe('["info"]');
  expect(host.textContent).toContain("safe info");
});

it("cancels a running Terminal command and isolates its stale result after connection generation changes", async () => {
  localStorage.setItem("p4deck.toolOpen", "true");
  let resolveOld!: (value: {
    operationId: string;
    exitCode: number;
    durationMs: number;
    events: OperationEvent[];
  }) => void;
  backend.runP4.mockReturnValueOnce(
    new Promise((resolve) => {
      resolveOld = resolve;
    }),
  );
  const render = (connectionKey: string, user: string) => (
    <ContextMenuProvider scope={`terminal-generation-${connectionKey}`} zh>
      <ToolArea
        t={messages["zh-CN"]}
        zh
        native
        connectionKey={connectionKey}
        context={{ server: "fixture", user, client: "c" }}
        onOpenChange={vi.fn()}
        onOpenSettings={vi.fn()}
      />
    </ContextMenuProvider>
  );
  await act(async () => root.render(render("generation-a", "old-user")));
  await flush();
  const input = host.querySelector<HTMLInputElement>(".terminal-input input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, "info");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => button("运行").click());
  const operationId = backend.runP4.mock.calls[0][0].operationId;
  await act(async () => root.render(render("generation-b", "new-user")));
  await flush();
  expect(backend.cancelOperation).toHaveBeenCalledWith(operationId);
  await act(async () =>
    resolveOld({
      operationId,
      exitCode: 0,
      durationMs: 2,
      events: [
        {
          operationId,
          type: "stdout",
          message: "stale generation output",
          timestamp: "2026-10-09T01:02:03Z",
        },
      ],
    }),
  );
  await flush();
  expect(host.textContent).toContain("connection context changed");
  expect(host.textContent).not.toContain("stale generation output");
  expect(localStorage.getItem("p4deck.terminalHistory")).toBe("[]");
});

it("invalidates a detached Terminal promise when a runtime-keyed panel remounts", async () => {
  let resolveOld!: (value: {
    operationId: string;
    exitCode: number;
    durationMs: number;
    events: OperationEvent[];
  }) => void;
  backend.runP4.mockReturnValueOnce(
    new Promise((resolve) => {
      resolveOld = resolve;
    }),
  );
  const panel = (key: string) => (
    <ContextMenuProvider key={key} scope={`detached-${key}`} zh={false}>
      <ToolPanel
        kind="terminal"
        t={messages["en-US"]}
        zh={false}
        native
        connectionKey={key}
        context={{ server: "fixture", user: key, client: "c" }}
        onOpenSettings={vi.fn()}
      />
    </ContextMenuProvider>
  );
  await act(async () => root.render(panel("runtime-a")));
  await flush();
  const input = host.querySelector<HTMLInputElement>(".terminal-input input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, "info");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => button("Run").click());
  const operationId = backend.runP4.mock.calls[0][0].operationId;
  await act(async () => root.render(panel("runtime-b")));
  expect(backend.cancelOperation).toHaveBeenCalledWith(operationId);
  await act(async () =>
    resolveOld({
      operationId,
      exitCode: 0,
      durationMs: 1,
      events: [],
    }),
  );
  await flush();
  expect(localStorage.getItem("p4deck.terminalHistory")).toBe("[]");
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

it("warns that unknown interrupted and cancelled writes require manual verification", async () => {
  const records: OperationRecord[] = [
    {
      operationId: "op-unknown",
      connectionId: "c",
      workspace: "ws",
      source: "gui",
      category: "fileMutation",
      state: "failed",
      failure: "unknown",
      startedAt: "2026-10-09T01:00:00Z",
      finishedAt: "2026-10-09T01:00:05Z",
    },
    {
      operationId: "op-interrupted",
      connectionId: "c",
      workspace: "ws",
      source: "gui",
      category: "submit",
      state: "interrupted",
      failure: "interrupted",
      startedAt: "2026-10-09T01:01:00Z",
    },
    {
      operationId: "op-cancelled",
      connectionId: "c",
      workspace: "ws",
      source: "gui",
      category: "fileMutation",
      state: "cancelled",
      failure: "cancelled",
      startedAt: "2026-10-09T01:02:00Z",
      finishedAt: "2026-10-09T01:02:01Z",
    },
  ];
  backend.queryOperationJournal.mockResolvedValueOnce({ records });
  await act(async () =>
    root.render(
      <OperationJournalView
        zh={false}
        connectionKey="recovery"
        onOpenLogs={vi.fn()}
      />,
    ),
  );
  await flush();
  expect(host.textContent).toContain("3 operation(s) need manual recovery");
  expect(
    host.querySelector('[data-testid="recovery-op-unknown"]')?.textContent,
  ).toContain("verify the server-side result");
  expect(
    host.querySelector('[data-testid="recovery-op-interrupted"]')?.textContent,
  ).toContain("never replays automatically");
  expect(
    host.querySelector('[data-testid="recovery-op-cancelled"]')?.textContent,
  ).toContain("does not undo completed work");
  expect(operationRecoveryGuidance(records[0], true)?.steps).toContain(
    "不会自动重放",
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
  expect(backend.exportDiagnostics).toHaveBeenCalledWith({
    request: {},
    operationId: expect.any(String),
  });
  expect(host.textContent).toContain("C:\\safe\\p4deck-diagnostic.json");
  expect(host.textContent).not.toMatch(/hunter2|ticket-value|AA:BB:CC:DD/);
  backend.exportDiagnostics.mockRejectedValueOnce(new Error("write denied"));
  await act(async () => button("Export").click());
  await flush();
  expect(host.textContent).toContain("Export outcome uncertain");
  expect(host.querySelector('[role="status"]')).toBeTruthy();
  expect(
    host.querySelector("section[aria-labelledby=cache-heading]"),
  ).toBeTruthy();
});
