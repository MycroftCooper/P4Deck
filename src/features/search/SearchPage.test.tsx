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

/** Types into the query box only; searching never happens on input alone. */
async function type(value: string) {
  const input = host.querySelector<HTMLInputElement>("#global-search-input")!;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** Waits past any plausible debounce window with the real timers running. */
async function settle(wait = 360) {
  await act(async () => new Promise((resolve) => setTimeout(resolve, wait)));
}

async function pressEnter() {
  const input = host.querySelector<HTMLInputElement>("#global-search-input")!;
  // A real Enter keypress is what the browser turns into a form submit.
  await act(async () =>
    input.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        code: "Enter",
        bubbles: true,
      }),
    ),
  );
  await act(async () =>
    input
      .closest("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
}

/** Types, submits with Enter, and lets the response settle. */
async function enter(value: string, wait = 0) {
  await type(value);
  await pressEnter();
  if (wait) await settle(wait);
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
  backend.cancelOperation.mockReset().mockResolvedValue(undefined);
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

it("groups the six navigable kinds and opens every row, while a typed query stays idle", async () => {
  await render();
  await type("needle");
  // Typing alone must never reach the backend, however long the pause.
  await settle();
  expect(backend.globalSearch).not.toHaveBeenCalled();
  expect(host.textContent).toContain("Enter a query to search");
  expect(host.textContent).toContain("Six result categories are available");

  await pressEnter();
  expect(backend.globalSearch).toHaveBeenCalledTimes(1);
  expect(backend.globalSearch).toHaveBeenCalledWith(
    expect.objectContaining({
      text: "needle",
      kinds: [...GLOBAL_SEARCH_KINDS],
      pageSize: 50,
    }),
  );
  expect(host.querySelectorAll(".search-group")).toHaveLength(6);
  expect(host.textContent).toContain("6 loaded · 6 matched · 42 scanned");
  expect(host.textContent).toContain("Matched: Title");
  expect(host.textContent).toContain("Path: //atlas/needle");
  expect(host.textContent).toContain("Numbered CL: 404");
  expect(host.textContent).toContain("Shelf deep search is bounded");
  // No Job chip, row or footer special case survives on the page.
  expect(host.querySelector(".search-kind-picker")?.textContent).not.toMatch(
    /job/i,
  );
  expect(host.textContent).not.toContain("no destination page");

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
});

it("runs nothing while typing, one query per submit, and clears back to idle when the draft changes", async () => {
  const first = deferred<GlobalSearchResult>();
  const second = deferred<GlobalSearchResult>();
  backend.globalSearch
    .mockImplementationOnce(() => first.promise)
    .mockImplementationOnce(() => second.promise);
  await render();

  await type("first");
  // Waiting past the old 300ms debounce must produce zero requests.
  await settle(400);
  expect(backend.globalSearch).not.toHaveBeenCalled();

  await pressEnter();
  expect(backend.globalSearch).toHaveBeenCalledTimes(1);
  const firstQuery = backend.globalSearch.mock.calls[0][0] as GlobalSearchQuery;

  await type("second");
  // Editing invalidates the accepted query: it is never cancelled on the host
  // (it already ran) and its late answer is dropped instead of rendered.
  expect(backend.cancelOperation).not.toHaveBeenCalled();
  expect(host.querySelectorAll(".search-result-row")).toHaveLength(0);
  expect(host.textContent).toContain("Enter a query to search");
  await settle(400);
  expect(backend.globalSearch).toHaveBeenCalledTimes(1);
  await act(async () =>
    first.resolve(result(firstQuery, [searchItem("submittedChange", "stale")])),
  );
  expect(host.textContent).not.toContain("stale");
  expect(host.querySelectorAll(".search-result-row")).toHaveLength(0);

  await pressEnter();
  expect(backend.globalSearch).toHaveBeenCalledTimes(2);
  const secondQuery = backend.globalSearch.mock
    .calls[1][0] as GlobalSearchQuery;
  await act(async () =>
    second.resolve(result(secondQuery, [searchItem("shelf", "fresh")])),
  );
  expect(host.textContent).toContain("shelf needle fresh");
  expect(host.textContent).not.toContain("stale");
});

it("renders Unicode UTF-16 highlights and injection-shaped content as text", async () => {
  backend.globalSearch.mockImplementationOnce(
    async (query: GlobalSearchQuery) =>
      result(query, [
        searchItem("depotFile", "unicode", {
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

it("submits by button, cancels the accepted query on a category change, and ignores in-flight work", async () => {
  const first = deferred<GlobalSearchResult>();
  const second = deferred<GlobalSearchResult>();
  backend.globalSearch
    .mockImplementationOnce(() => first.promise)
    .mockImplementationOnce(() => second.promise);
  await render();
  await type("first");
  await click(button("Search"));
  expect(backend.globalSearch).toHaveBeenCalledTimes(1);
  const firstQuery = backend.globalSearch.mock.calls[0][0] as GlobalSearchQuery;

  const submitted = [
    ...host.querySelectorAll<HTMLLabelElement>(".search-kind-picker label"),
  ].find((label) => label.textContent === "Submitted")!;
  await click(submitted.querySelector("input")!);
  // Re-filtering invalidates the accepted query the same way.
  expect(backend.cancelOperation).not.toHaveBeenCalled();
  expect(host.textContent).toContain("Enter a query to search");
  await settle(400);
  expect(backend.globalSearch).toHaveBeenCalledTimes(1);

  await click(button("Search"));
  expect(backend.globalSearch).toHaveBeenCalledTimes(2);
  const secondQuery = backend.globalSearch.mock
    .calls[1][0] as GlobalSearchQuery;
  expect(secondQuery.kinds).not.toContain("submittedChange");
  expect(secondQuery.cursor).toBeUndefined();
  await act(async () =>
    second.resolve(result(secondQuery, [searchItem("shelf", "latest")])),
  );
  expect(host.textContent).toContain("shelf needle latest");
  await act(async () =>
    first.resolve(result(firstQuery, [searchItem("shelf", "stale")])),
  );
  expect(host.textContent).not.toContain("stale");
});

it("appends cursor pages with identity dedupe and preserves results across page retry", async () => {
  backend.globalSearch
    .mockImplementationOnce(async (query: GlobalSearchQuery) =>
      result(query, [searchItem("shelf", "one", { title: "page one" })], {
        hasMore: true,
        nextCursor: "cursor-2",
      }),
    )
    .mockRejectedValueOnce(new Error("page unavailable"))
    .mockImplementationOnce(async (query: GlobalSearchQuery) =>
      result(query, [
        searchItem("shelf", "one", { title: "duplicate" }),
        searchItem("shelf", "two", { title: "page two" }),
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

it("exposes mock, responsive, keyboard, and aria states without hidden controls", async () => {
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
    // Mock mode is disclosed in the body note, not in the page title bar.
    expect(
      host.querySelector(".search-ui-badge, .search-production-badge"),
    ).toBeNull();
    expect(host.querySelector(".search-ui-note")).toBeTruthy();
    expect(
      host.querySelector('[role="status"][aria-live="polite"]'),
    ).toBeTruthy();
    // The category picker keeps an accessible name without a visible legend.
    const picker = host.querySelector(".search-kind-picker")!;
    expect(picker.getAttribute("aria-label")).toBe("Categories");
    expect(picker.querySelector("legend")).toBeNull();
    // The query box is labelled for assistive tech, not by visible text.
    expect(
      host.querySelector('label[for="global-search-input"]')?.textContent,
    ).toBe("Search query");

    const rows = [
      ...host.querySelectorAll<HTMLButtonElement>(".search-result-row"),
    ];
    expect(rows.every((row) => !row.disabled)).toBe(true);
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
    // Re-filtering never queries on its own.
    await settle(400);
    expect(backend.globalSearch).toHaveBeenCalledTimes(1);
  } finally {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: previousWidth,
    });
  }
});
