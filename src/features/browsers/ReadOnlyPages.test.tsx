// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  DiffResult,
  FileHistoryPage,
  FileRevision,
  RuntimeInfo,
  StreamSummary,
} from "../../shared/contracts/types";
import { ReadOnlyPage } from "./ReadOnlyPages";

const backend = vi.hoisted(() => ({
  getFileHistory: vi.fn(),
  getDiff: vi.fn(),
  listStreams: vi.fn<() => Promise<StreamSummary[]>>(async () => []),
  cancelOperation: vi.fn(async () => undefined),
}));
vi.mock("../../infrastructure/backend", () => ({ backend }));
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 52,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        index,
        key: index,
        start: index * 52,
        size: 52,
      })),
  }),
}));

const runtime: RuntimeInfo = {
  mode: "tauri",
  p4Version: "P4/TEST",
  activeProfileId: "profile-a",
  contextGeneration: 7,
  context: {
    server: "fixture:1666",
    user: "tester",
    client: "workspace",
    cwd: "C:/workspace",
  },
  connection: {
    state: "connected",
    message: "ok",
    recovery: "none",
    server: "fixture:1666",
  },
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function revision(
  revisionNumber: number,
  path = "//depot/a.txt",
): FileRevision {
  return {
    depotPath: path,
    revision: revisionNumber,
    changelistId: revisionNumber,
    user: "tester",
    action: "edit",
    fileType: "text",
    time: "",
    description: `REVISION-${revisionNumber}`,
    integrations: [],
  };
}

function page(
  revisions: number[],
  path = "//depot/a.txt",
  overrides: Partial<FileHistoryPage> = {},
): FileHistoryPage {
  return {
    items: revisions.map((value) => revision(value, path)),
    hasMore: false,
    partial: false,
    truncated: false,
    operationIds: [],
    ...overrides,
  };
}

function diff(text: string): DiffResult {
  return {
    path: "//depot/a.txt",
    left: {
      reference: { kind: "revision", revision: 1 },
      label: "#1",
      depotPath: "//depot/a.txt",
      exists: true,
      binary: false,
    },
    right: {
      reference: { kind: "revision", revision: 2 },
      label: "#2",
      depotPath: "//depot/a.txt",
      exists: true,
      binary: false,
    },
    unified: text,
    stats: { additions: 1, deletions: 0, hunks: 1 },
    binary: false,
    unsupported: false,
    identical: false,
    truncated: false,
    partial: false,
    operationIds: [],
  };
}

let host: HTMLDivElement;
let root: Root;

async function render(target: string, nextRuntime = runtime) {
  await act(async () => {
    root.render(
      <ReadOnlyPage
        kind="history"
        runtime={nextRuntime}
        target={target}
        onTargetChange={() => undefined}
        zh={false}
      />,
    );
    await Promise.resolve();
  });
}

function button(text: string) {
  return [...host.querySelectorAll<HTMLButtonElement>("button")].find((item) =>
    item.textContent?.includes(text),
  )!;
}

async function click(element: Element, options: MouseEventInit = {}) {
  await act(async () =>
    element.dispatchEvent(
      new MouseEvent("click", { bubbles: true, ...options }),
    ),
  );
}

beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  backend.getFileHistory.mockReset();
  backend.getDiff.mockReset();
  backend.listStreams.mockReset();
  backend.listStreams.mockResolvedValue([]);
  backend.cancelOperation.mockClear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

it("cancels a history page on path drift and ignores its late rows", async () => {
  const more = deferred<FileHistoryPage>();
  backend.getFileHistory
    .mockResolvedValueOnce(
      page([4, 3], "//depot/a.txt", { hasMore: true, nextCursor: "c1" }),
    )
    .mockImplementationOnce(() => more.promise)
    .mockResolvedValueOnce(page([9], "//depot/b.txt"));
  await render("//depot/a.txt");
  await act(async () => Promise.resolve());
  await click(button("Load more history"));
  const pageOperation = backend.getFileHistory.mock.calls[1][0].operationId;
  await render("//depot/b.txt");
  await act(async () => Promise.resolve());
  expect(backend.cancelOperation).toHaveBeenCalledWith(pageOperation);
  await act(async () => more.resolve(page([2], "//depot/a.txt")));
  expect(host.textContent).toContain("REVISION-9");
  expect(host.textContent).not.toContain("REVISION-2");
});

it("cancels a two-revision diff when selection changes and ignores its late error", async () => {
  backend.getFileHistory.mockResolvedValue(page([5, 4, 3]));
  const first = deferred<DiffResult>();
  const second = deferred<DiffResult>();
  backend.getDiff
    .mockImplementationOnce(() => first.promise)
    .mockImplementationOnce(() => second.promise);
  await render("//depot/a.txt");
  await act(async () => Promise.resolve());
  let rows = host.querySelectorAll<HTMLButtonElement>(".workspace-row");
  await click(rows[0]);
  await click(rows[1], { ctrlKey: true });
  await click(button("Compare two selected revisions"));
  const firstOperation = backend.getDiff.mock.calls[0][0].operationId;
  await click(rows[1]);
  expect(backend.cancelOperation).toHaveBeenCalledWith(firstOperation);
  rows = host.querySelectorAll<HTMLButtonElement>(".workspace-row");
  await click(rows[2], { ctrlKey: true });
  await click(button("Compare two selected revisions"));
  await act(async () => second.resolve(diff("LATEST HISTORY DIFF")));
  await act(async () => first.reject(new Error("OLD HISTORY ERROR")));
  expect(host.textContent).toContain("LATEST HISTORY DIFF");
  expect(host.textContent).not.toContain("OLD HISTORY ERROR");
});

it("rejects a duplicate history cursor without losing trusted rows", async () => {
  backend.getFileHistory
    .mockResolvedValueOnce(
      page([3], "//depot/a.txt", { hasMore: true, nextCursor: "same" }),
    )
    .mockResolvedValueOnce(
      page([3, 2], "//depot/a.txt", { hasMore: true, nextCursor: "same" }),
    );
  await render("//depot/a.txt");
  await act(async () => Promise.resolve());
  await click(button("Load more history"));
  await act(async () => Promise.resolve());
  expect(host.textContent).toContain("REVISION-3");
  expect(host.textContent).toContain("REVISION-2");
  expect(host.textContent).toContain("repeated cursor");
  expect(button("Load more history")).toBeUndefined();
});

it("hides generation-stale history and accepts the replacement request", async () => {
  const first = deferred<FileHistoryPage>();
  const second = deferred<FileHistoryPage>();
  backend.getFileHistory
    .mockImplementationOnce(() => first.promise)
    .mockImplementationOnce(() => second.promise);
  await render("//depot/a.txt");
  await render("//depot/a.txt", {
    ...runtime,
    activeProfileId: "profile-b",
    contextGeneration: 8,
  });
  expect(host.textContent).not.toContain("REVISION-1");
  await act(async () => second.resolve(page([8])));
  await act(async () => first.resolve(page([1])));
  expect(host.textContent).toContain("REVISION-8");
  expect(host.textContent).not.toContain("REVISION-1");
});

it("shows an explicit result when Global Search locates or cannot locate a stream", async () => {
  backend.listStreams.mockResolvedValue([
    {
      stream: "//atlas/main",
      name: "Main",
      owner: "tester",
      parent: "none",
      kind: "mainline",
      description: "Main stream",
    },
  ]);
  await act(async () => {
    root.render(
      <ReadOnlyPage
        kind="streams"
        runtime={runtime}
        navigation={{ stream: "//atlas/main", nonce: 1 }}
        zh={false}
      />,
    );
    await Promise.resolve();
  });
  expect(host.textContent).toContain("Located stream: //atlas/main");

  await act(async () => {
    root.render(
      <ReadOnlyPage
        kind="streams"
        runtime={runtime}
        navigation={{ stream: "//atlas/missing", nonce: 2 }}
        zh={false}
      />,
    );
    await Promise.resolve();
  });
  expect(host.textContent).toContain("current list has no exact match");
});
