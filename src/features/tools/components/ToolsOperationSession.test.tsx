// @vitest-environment jsdom
/**
 * RUI-03 operation-session coverage for the diagnostics + journal tools.
 *
 * These complement (never replace) ToolsDiagnostics.test.tsx: the original
 * cases stay untouched as the behavioural-equivalence evidence, and these add
 * the three classes the migration contract requires:
 *   1. cancel idempotence      -- repeated retirement never stacks cancels
 *   2. generation drift        -- a connection change retires the old read
 *   3. late-response isolation -- a late loading/error never writes back
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CacheDiagnostics,
  OperationRecord,
} from "../../../shared/contracts";
import { DiagnosticsView } from "./DiagnosticsView";
import { OperationJournalView } from "./OperationJournalView";
import { setLocale } from "../../../shared/i18n";

const backend = vi.hoisted(() => ({
  statusCacheDiagnostics: vi.fn(),
  queryOperationJournal: vi.fn(),
  cancelOperation: vi.fn(),
  companySubmitConnectionSnapshot: vi.fn(),
  exportDiagnostics: vi.fn(),
}));
vi.mock("../../../infrastructure/backend", () => ({
  backend,
  tokenize: (value: string) => value.trim().split(/\s+/),
}));

const cache: CacheDiagnostics = {
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
};

function record(operationId: string): OperationRecord {
  return {
    operationId,
    connectionId: "c",
    workspace: "ws",
    source: "gui",
    category: "submit",
    state: "failed",
    failure: "permissionDenied",
    startedAt: "2026-10-09T01:00:00Z",
    finishedAt: "2026-10-09T01:00:01Z",
  };
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  setLocale("en-US");
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  Object.values(backend).forEach((mock) => mock.mockReset());
  backend.cancelOperation.mockResolvedValue(undefined);
  backend.statusCacheDiagnostics.mockResolvedValue(cache);
  backend.queryOperationJournal.mockResolvedValue({ records: [] });
  backend.companySubmitConnectionSnapshot.mockResolvedValue({
    profileId: "fixture",
    generation: "1",
    server: "fixture:1666",
    user: "tester",
    client: "fixture-client",
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe("DiagnosticsView operation session", () => {
  it("1. cancellation is idempotent: local reads are never cancelled on the host", async () => {
    let settle!: (value: CacheDiagnostics) => void;
    backend.statusCacheDiagnostics.mockReturnValueOnce(
      new Promise((resolve) => {
        settle = resolve;
      }),
    );
    await act(async () =>
      root.render(<DiagnosticsView zh={false} connectionKey="a" native />),
    );
    // Two context changes while the first read is still in flight. With the
    // session this is one lease superseded once; with a bare generation ref the
    // page had no cancel path at all, and an implementation that forgot
    // `cancelBackend: false` would issue host cancels here.
    await act(async () =>
      root.render(<DiagnosticsView zh={false} connectionKey="b" native />),
    );
    await act(async () =>
      root.render(<DiagnosticsView zh={false} connectionKey="c" native />),
    );
    await act(async () => settle(cache));
    await flush();
    expect(backend.cancelOperation).not.toHaveBeenCalled();
    // The superseded read retired; the live one answered.
    expect(host.textContent).toContain("8 / 2");
  });

  it("1b. a retry after a failure supersedes the failed read instead of stacking", async () => {
    backend.statusCacheDiagnostics.mockRejectedValueOnce(new Error("boom"));
    await act(async () =>
      root.render(<DiagnosticsView zh={false} connectionKey="a" native />),
    );
    await flush();
    expect(host.textContent).toContain("boom");
    // Retry is enabled (the failure retired the busy flag), so the second read
    // starts a fresh lease on the same channel.
    backend.statusCacheDiagnostics.mockResolvedValueOnce({
      ...cache,
      hits: 42,
    });
    const retry = [...host.querySelectorAll("button")].find((item) =>
      item.textContent?.includes("Retry"),
    )!;
    await act(async () => retry.click());
    await flush();
    expect(backend.statusCacheDiagnostics).toHaveBeenCalledTimes(2);
    expect(host.textContent).toContain("42 / 2");
    expect(host.textContent).not.toContain("boom");
  });

  it("2. generation drift: a connection change retires the previous cache read", async () => {
    let first!: (value: CacheDiagnostics) => void;
    backend.statusCacheDiagnostics.mockReturnValueOnce(
      new Promise((resolve) => {
        first = resolve;
      }),
    );
    await act(async () =>
      root.render(<DiagnosticsView zh={false} connectionKey="a" native />),
    );
    backend.statusCacheDiagnostics.mockResolvedValue({
      ...cache,
      hits: 111,
      misses: 0,
    });
    await act(async () =>
      root.render(<DiagnosticsView zh={false} connectionKey="b" native />),
    );
    await flush();
    expect(host.textContent).toContain("111 / 0");
    // The first connection's measurement arrives late and must not repaint.
    await act(async () => first({ ...cache, hits: 8, misses: 2 }));
    await flush();
    expect(host.textContent).toContain("111 / 0");
    expect(host.textContent).not.toContain("8 / 2");
  });

  it("3. late-response isolation: a stale failure never renders an error", async () => {
    let rejectFirst!: (cause: Error) => void;
    backend.statusCacheDiagnostics.mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        rejectFirst = reject;
      }),
    );
    await act(async () =>
      root.render(<DiagnosticsView zh={false} connectionKey="a" native />),
    );
    backend.statusCacheDiagnostics.mockResolvedValue(cache);
    await act(async () =>
      root.render(<DiagnosticsView zh={false} connectionKey="b" native />),
    );
    await flush();
    await act(async () => rejectFirst(new Error("stale connection failure")));
    await flush();
    expect(host.textContent).not.toContain("stale connection failure");
    expect(host.querySelector(".inline-error")).toBeNull();
    // The busy indicator must also be retired by the live lease, not the late one.
    expect(host.textContent).not.toContain("正在刷新");
  });
});

describe("OperationJournalView operation session", () => {
  it("1. cancellation is idempotent: repeated context changes do not stack cancels", async () => {
    let first!: (value: { records: OperationRecord[] }) => void;
    backend.queryOperationJournal.mockReturnValueOnce(
      new Promise((resolve) => {
        first = resolve;
      }),
    );
    await act(async () =>
      root.render(
        <OperationJournalView
          zh={false}
          connectionKey="a"
          onOpenLogs={vi.fn()}
        />,
      ),
    );
    await act(async () =>
      root.render(
        <OperationJournalView
          zh={false}
          connectionKey="b"
          onOpenLogs={vi.fn()}
        />,
      ),
    );
    await act(async () =>
      root.render(
        <OperationJournalView
          zh={false}
          connectionKey="c"
          onOpenLogs={vi.fn()}
        />,
      ),
    );
    await act(async () => first({ records: [record("op-a")] }));
    await flush();
    // A read-only journal query is cancelled locally, never on the host.
    expect(backend.cancelOperation).not.toHaveBeenCalled();
    expect(host.textContent).not.toContain("op-a");
  });

  it("2. generation drift: only the newest connection's records are shown", async () => {
    let first!: (value: { records: OperationRecord[] }) => void;
    backend.queryOperationJournal.mockReturnValueOnce(
      new Promise((resolve) => {
        first = resolve;
      }),
    );
    await act(async () =>
      root.render(
        <OperationJournalView
          zh={false}
          connectionKey="a"
          onOpenLogs={vi.fn()}
        />,
      ),
    );
    backend.queryOperationJournal.mockResolvedValue({
      records: [record("op-new")],
    });
    await act(async () =>
      root.render(
        <OperationJournalView
          zh={false}
          connectionKey="b"
          onOpenLogs={vi.fn()}
        />,
      ),
    );
    await flush();
    expect(host.textContent).toContain("op-new");
    await act(async () => first({ records: [record("op-old")] }));
    await flush();
    expect(host.textContent).toContain("op-new");
    expect(host.textContent).not.toContain("op-old");
  });

  it("3. late-response isolation: a stale failure cannot raise the inline error", async () => {
    let rejectFirst!: (cause: Error) => void;
    backend.queryOperationJournal.mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        rejectFirst = reject;
      }),
    );
    await act(async () =>
      root.render(
        <OperationJournalView
          zh={false}
          connectionKey="a"
          onOpenLogs={vi.fn()}
        />,
      ),
    );
    backend.queryOperationJournal.mockResolvedValue({
      records: [record("op-live")],
    });
    await act(async () =>
      root.render(
        <OperationJournalView
          zh={false}
          connectionKey="b"
          onOpenLogs={vi.fn()}
        />,
      ),
    );
    await flush();
    await act(async () => rejectFirst(new Error("stale journal failure")));
    await flush();
    expect(host.textContent).not.toContain("stale journal failure");
    expect(host.querySelector(".inline-error")).toBeNull();
    expect(host.textContent).toContain("op-live");
  });

  it("retires an in-flight read when the query filters change again", async () => {
    let first!: (value: { records: OperationRecord[] }) => void;
    backend.queryOperationJournal.mockReturnValueOnce(
      new Promise((resolve) => {
        first = resolve;
      }),
    );
    await act(async () =>
      root.render(
        <OperationJournalView
          zh={false}
          connectionKey="a"
          onOpenLogs={vi.fn()}
        />,
      ),
    );
    backend.queryOperationJournal.mockResolvedValue({
      records: [record("op-filtered")],
    });
    const search = host.querySelector<HTMLInputElement>("input")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!.call(search, "op-filtered");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const apply = [...host.querySelectorAll("button")].find((item) =>
      item.textContent?.includes("Apply"),
    )!;
    await act(async () => apply.click());
    await flush();
    await act(async () => first({ records: [record("op-superseded")] }));
    await flush();
    expect(host.textContent).toContain("op-filtered");
    expect(host.textContent).not.toContain("op-superseded");
  });
});
