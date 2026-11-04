// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  GlobalSearchItem,
  GlobalSearchKind,
  GlobalSearchQuery,
  GlobalSearchResult,
  GlobalSearchTarget,
} from "../../shared/contracts";
import { GLOBAL_SEARCH_KINDS } from "./searchModel";
import { SearchPage } from "./SearchPage";
import { setLocale } from "../../shared/i18n";

const backend = vi.hoisted(() => ({
  globalSearch: vi.fn(),
  cancelOperation: vi.fn(async () => undefined),
}));
vi.mock("../../infrastructure/backend", () => ({ backend }));

const TARGETS: Record<GlobalSearchKind, GlobalSearchTarget> = {
  submittedChange: { type: "submittedChange", changeId: 101 },
  pendingChange: { type: "pendingChange", changeId: 202 },
  workspaceFile: {
    type: "workspaceFile",
    absolutePath: "C:\\workspace\\needle.ts",
  },
  depotFile: { type: "depotFile", depotPath: "//depot/needle.ts" },
  job: { type: "job", jobId: "JOB-303" },
  stream: { type: "stream", streamPath: "//atlas/needle" },
  shelf: { type: "shelf", changeId: 404 },
};

function searchItem(
  kind: GlobalSearchKind,
  suffix: string = kind,
  overrides: Partial<GlobalSearchItem> = {},
): GlobalSearchItem {
  return {
    identity: `${kind}:${suffix}`,
    kind,
    title: `${kind} needle ${suffix}`,
    summary: `summary ${suffix}`,
    target: TARGETS[kind],
    matchedFields: ["title"],
    highlights: [
      { field: "title", start: kind.length + 1, end: kind.length + 7 },
    ],
    rank: 1,
    ...overrides,
  };
}

function result(
  query: GlobalSearchQuery,
  items: GlobalSearchItem[],
  overrides: Partial<GlobalSearchResult> = {},
): GlobalSearchResult {
  return {
    requestGeneration: query.requestGeneration,
    normalizedQuery: query.text.trim(),
    groups: query.kinds
      .map((kind) => ({
        kind,
        items: items.filter((item) => item.kind === kind),
      }))
      .filter((group) => group.items.length),
    facets: query.kinds.map((kind) => ({
      kind,
      matchedCount: items.filter((item) => item.kind === kind).length,
      scannedCount: 7,
      partial: false,
    })),
    hasMore: false,
    partial: false,
    simulated: false,
    stats: {
      scannedCount: 35,
      matchedCount: items.length,
      returnedCount: items.length,
      categoryFailureCount: 0,
      safetyLimit: 1000,
    },
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

let host: HTMLDivElement;
let root: Root;
let navigate: ReturnType<typeof vi.fn>;

async function render(mode: "mock" | "tauri" = "tauri", zh = false) {
  await act(async () =>
    root.render(
      <SearchPage zh={zh} runtimeMode={mode} onNavigate={navigate} />,
    ),
  );
}

async function enter(value: string, wait = 330) {
  const input = host.querySelector<HTMLInputElement>("#global-search-input")!;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  if (wait)
    await act(async () => new Promise((resolve) => setTimeout(resolve, wait)));
}

async function click(element: HTMLElement) {
  await act(async () => element.click());
}

function button(text: string) {
  return [...host.querySelectorAll<HTMLButtonElement>("button")].find((item) =>
    item.textContent?.includes(text),
  )!;
}

beforeEach(() => {
  // Components translate through the module-level locale.
  setLocale("en-US");
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  backend.globalSearch.mockReset();
  backend.cancelOperation.mockClear();
  navigate = vi.fn(async () => undefined);
  backend.globalSearch.mockImplementation(async (query: GlobalSearchQuery) =>
    result(
      query,
      query.kinds.map((kind) => searchItem(kind)),
    ),
  );
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

it("groups all seven production kinds, shows stream and shelf facts, and honors navigation targets", async () => {
  await render();
  await enter("needle");
  expect(backend.globalSearch).toHaveBeenCalledWith(
    expect.objectContaining({
      text: "needle",
      kinds: [...GLOBAL_SEARCH_KINDS],
      pageSize: 50,
    }),
  );
  expect(host.querySelectorAll(".search-group")).toHaveLength(7);
  expect(host.textContent).toContain("7 loaded · 7 matched · 49 scanned");
  expect(host.textContent).toContain("Matched: Title");
  expect(host.textContent).toContain("Path: //atlas/needle");
  expect(host.textContent).toContain("Numbered CL: 404");
  expect(host.textContent).toContain("Shelf deep search is bounded");

  await click(button("submittedChange needle"));
  await click(button("pendingChange needle"));
  await click(button("workspaceFile needle"));
  await click(button("depotFile needle"));
  await click(button("stream needle"));
  await click(button("shelf needle"));
  expect(navigate.mock.calls.map(([target]) => target)).toEqual([
    TARGETS.submittedChange,
    TARGETS.pendingChange,
    TARGETS.workspaceFile,
    TARGETS.depotFile,
    TARGETS.stream,
    TARGETS.shelf,
  ]);
  const job = button("job needle");
  expect(job.disabled).toBe(true);
  expect(job.textContent).toContain("no destination page");
});

it("renders Unicode UTF-16 highlights and injection-shaped content as text", async () => {
  backend.globalSearch.mockImplementationOnce(
    async (query: GlobalSearchQuery) =>
      result(query, [
        searchItem("job", "unicode", {
          title: "A😀<img src=x>尾",
          summary: "safe <script>alert(1)</script>",
          matchedFields: ["title", "summary"],
          highlights: [
            { field: "title", start: 1, end: 3 },
            { field: "summary", start: 5, end: 13 },
          ],
        }),
      ]),
  );
  await render();
  await enter("😀 [asset]");
  expect(host.querySelector("mark")?.textContent).toBe("😀");
  expect(host.textContent).toContain("<img src=x>");
  expect(host.textContent).toContain("<script>alert(1)</script>");
  expect(host.querySelector("img")).toBeNull();
  expect(host.querySelector("script")).toBeNull();
});

it("debounces, cancels the old operation, and ignores stale rapid-input responses", async () => {
  const first = deferred<GlobalSearchResult>();
  const second = deferred<GlobalSearchResult>();
  backend.globalSearch
    .mockImplementationOnce(() => first.promise)
    .mockImplementationOnce(() => second.promise);
  await render();
  await enter("first");
  const firstQuery = backend.globalSearch.mock.calls[0][0] as GlobalSearchQuery;
  await enter("second", 0);
  expect(backend.cancelOperation).toHaveBeenCalledWith(firstQuery.operationId);
  await act(async () => new Promise((resolve) => setTimeout(resolve, 330)));
  const secondQuery = backend.globalSearch.mock
    .calls[1][0] as GlobalSearchQuery;
  await act(async () =>
    second.resolve(
      result(secondQuery, [searchItem("job", "latest", { title: "latest" })]),
    ),
  );
  expect(host.textContent).toContain("latest");
  await act(async () =>
    first.resolve(
      result(firstQuery, [searchItem("job", "stale", { title: "stale" })]),
    ),
  );
  expect(host.textContent).not.toContain("stale");
  expect(backend.globalSearch).toHaveBeenCalledTimes(2);
});

it("appends cursor pages with identity dedupe and preserves results across page retry", async () => {
  backend.globalSearch
    .mockImplementationOnce(async (query: GlobalSearchQuery) =>
      result(query, [searchItem("job", "one", { title: "page one" })], {
        hasMore: true,
        nextCursor: "cursor-2",
      }),
    )
    .mockRejectedValueOnce(new Error("page unavailable"))
    .mockImplementationOnce(async (query: GlobalSearchQuery) =>
      result(query, [
        searchItem("job", "one", { title: "duplicate" }),
        searchItem("job", "two", { title: "page two" }),
      ]),
    );
  await render();
  await enter("page");
  await click(button("Load more"));
  expect(host.textContent).toContain("page unavailable");
  expect(host.textContent).toContain("page one");
  await click(button("Retry page"));
  expect(host.textContent).toContain("page two");
  expect(host.querySelectorAll(".search-result-row")).toHaveLength(2);
  expect(backend.globalSearch.mock.calls[1][0]).toMatchObject({
    cursor: "cursor-2",
  });
  expect(backend.globalSearch.mock.calls[2][0]).toMatchObject({
    cursor: "cursor-2",
  });
});

it("shows partial category failures, scan truncation, category retry, empty, and overall errors", async () => {
  backend.globalSearch.mockImplementationOnce(
    async (query: GlobalSearchQuery) => {
      const value = result(query, [searchItem("submittedChange")], {
        partial: true,
        stats: {
          scannedCount: 1007,
          matchedCount: 1,
          returnedCount: 1,
          categoryFailureCount: 1,
          safetyLimit: 1000,
        },
      });
      value.facets = value.facets.map((facet) =>
        facet.kind === "pendingChange"
          ? {
              ...facet,
              partial: true,
              error: { code: "timeout", message: "pending timed out" },
            }
          : facet.kind === "depotFile"
            ? { ...facet, partial: true, scannedCount: 1000 }
            : facet.kind === "shelf"
              ? {
                  ...facet,
                  partial: true,
                  partialReason: "shelf detail candidate limit reached",
                }
              : facet,
      );
      return value;
    },
  );
  backend.globalSearch.mockImplementationOnce(
    async (query: GlobalSearchQuery) =>
      result(query, [searchItem("pendingChange", "recovered")]),
  );
  await render();
  await enter("partial");
  expect(host.textContent).toContain("1 categories failed");
  expect(host.textContent).toContain("pending timed out");
  expect(host.textContent).toContain("scan limit reached");
  expect(host.textContent).toContain(
    "Partial reason: shelf detail candidate limit reached",
  );
  await click(button("Retry category"));
  expect(backend.globalSearch.mock.calls[1][0]).toMatchObject({
    kinds: ["pendingChange"],
    cursor: undefined,
  });
  expect(host.textContent).toContain("recovered");

  backend.globalSearch.mockImplementationOnce(
    async (query: GlobalSearchQuery) => result(query, []),
  );
  await enter("empty");
  expect(host.textContent).toContain("No results");

  backend.globalSearch.mockRejectedValueOnce(new Error("server offline"));
  await enter("failure");
  expect(host.textContent).toContain("Search failed");
  expect(host.textContent).toContain("server offline");
});

it("keeps one shelf identity across pages and offers a fresh search after cursor failure", async () => {
  backend.globalSearch
    .mockImplementationOnce(async (query: GlobalSearchQuery) =>
      result(query, [searchItem("shelf", "404")], {
        hasMore: true,
        nextCursor: "shelf-cursor",
      }),
    )
    .mockRejectedValueOnce(
      new Error("Global search cursor expired or was replayed"),
    )
    .mockImplementationOnce(async (query: GlobalSearchQuery) =>
      result(query, [
        searchItem("shelf", "404"),
        searchItem("shelf", "405", {
          target: { type: "shelf", changeId: 405 },
        }),
      ]),
    );
  await render();
  await enter("shelf");
  await click(button("Load more"));
  expect(host.textContent).toContain("cursor expired or was replayed");
  expect(button("Restart search")).toBeTruthy();
  await click(button("Restart search"));
  expect(host.querySelectorAll(".search-result-row")).toHaveLength(2);
  expect(backend.globalSearch.mock.calls.at(-1)?.[0]).toMatchObject({
    cursor: undefined,
    kinds: [...GLOBAL_SEARCH_KINDS],
  });
});

it("resets results and cursors on category change and exposes mock, responsive, keyboard, and aria states", async () => {
  const previousWidth = window.innerWidth;
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: 390,
  });
  try {
    backend.globalSearch.mockImplementationOnce(
      async (query: GlobalSearchQuery) =>
        result(query, [
          ...query.kinds.map((kind) => searchItem(kind)),
          searchItem("submittedChange", "second"),
        ]),
    );
    await render("mock");
    await enter("needle");
    expect(host.textContent).toContain("Simulated · No P4 access");
    expect(
      host.querySelector('[role="status"][aria-live="polite"]'),
    ).toBeTruthy();
    expect(host.querySelector(".search-kind-picker")).toBeTruthy();

    const rows = [
      ...host.querySelectorAll<HTMLButtonElement>(
        ".search-result-row:not(:disabled)",
      ),
    ];
    rows[0].focus();
    await act(async () =>
      rows[0].dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
      ),
    );
    expect(document.activeElement).toBe(rows[1]);

    const submitted = [
      ...host.querySelectorAll<HTMLLabelElement>(".search-kind-picker label"),
    ].find((label) => label.textContent === "Submitted")!;
    await click(submitted.querySelector("input")!);
    expect(host.querySelectorAll(".search-result-row")).toHaveLength(0);
    await act(async () => new Promise((resolve) => setTimeout(resolve, 330)));
    const query = backend.globalSearch.mock.calls.at(
      -1,
    )![0] as GlobalSearchQuery;
    expect(query.kinds).not.toContain("submittedChange");
    expect(query.cursor).toBeUndefined();
  } finally {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: previousWidth,
    });
  }
});
