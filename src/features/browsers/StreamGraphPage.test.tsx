// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  RuntimeInfo,
  StreamGraphNode,
  StreamGraphQuery,
  StreamGraphResult,
} from "../../shared/contracts/types";
import { StreamGraphPage } from "./StreamGraphPage";

const backend = vi.hoisted(() => ({
  queryStreamGraph: vi.fn(),
  listUserWorkspaces: vi.fn(),
  cancelOperation: vi.fn(async () => undefined),
}));
const scrollToIndex = vi.hoisted(() => vi.fn());

vi.mock("../../infrastructure/backend", () => ({ backend }));
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 70,
    getVirtualItems: () =>
      Array.from({ length: Math.min(count, 18) }, (_, index) => ({
        index,
        key: index,
        start: index * 70,
        size: 70,
      })),
    measureElement: () => undefined,
    measure: () => undefined,
    scrollToIndex,
  }),
}));

const baseRuntime: RuntimeInfo = {
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

function node(
  stream: string,
  parent = "",
  overrides: Partial<StreamGraphNode> = {},
): StreamGraphNode {
  return {
    stream,
    name: stream.split("/").at(-1),
    owner: "tester",
    parent,
    kind: "development",
    description: `Description for ${stream}`,
    parentView: parent ? "inherit" : "noinherit",
    flowOptions: { toParent: true, fromParent: false },
    ...overrides,
  };
}

function graphResult(
  query: StreamGraphQuery,
  nodes: StreamGraphNode[],
  overrides: Partial<StreamGraphResult> = {},
): StreamGraphResult {
  return {
    requestGeneration: query.requestGeneration,
    scope: {
      activeProfileId: baseRuntime.activeProfileId,
      contextGeneration: baseRuntime.contextGeneration,
      server: baseRuntime.context.server,
      user: baseRuntime.context.user,
      client: baseRuntime.context.client,
    },
    nodes,
    edges: nodes.flatMap((item) =>
      item.parent ? [{ parent: item.parent, child: item.stream }] : [],
    ),
    roots: nodes.filter((item) => !item.parent).map((item) => item.stream),
    orphans: [],
    hasMore: false,
    partial: false,
    truncated: false,
    stats: {
      scannedCount: nodes.length,
      matchedCount: nodes.length,
      returnedCount: nodes.length,
      duplicateCount: 0,
      invalidRelationCount: 0,
      safetyLimit: 5000,
    },
    operationIds: [query.operationId],
    cacheFreshness: "fresh",
    simulated: false,
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
let openPage: ReturnType<typeof vi.fn>;

async function render(runtime = baseRuntime) {
  await act(async () => {
    root.render(
      <StreamGraphPage
        runtime={runtime}
        onRuntime={vi.fn()}
        onLocateStream={openPage}
        zh={false}
      />,
    );
  });
}

async function clickButton(text: string) {
  const button = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent?.includes(text),
  );
  expect(button).toBeTruthy();
  await act(async () => button!.click());
}

beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  backend.queryStreamGraph.mockReset();
  backend.listUserWorkspaces.mockReset().mockResolvedValue([
    {
      name: "workspace",
      owner: "tester",
      host: "",
      root: "C:/workspace",
      stream: "//streams/dev",
      description: "",
      updated: null,
      accessed: null,
    },
  ]);
  backend.cancelOperation.mockClear();
  scrollToIndex.mockClear();
  openPage = vi.fn();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

it("renders the directed forest states and provides keyboard-equivalent details", async () => {
  backend.queryStreamGraph.mockImplementation(async (query: StreamGraphQuery) =>
    graphResult(
      query,
      [
        node("//streams/main", "", { kind: "mainline" }),
        node("//streams/dev", "//streams/main"),
        node("//streams/deleted", "//streams/main", { deleted: true }),
        node("//streams/unknown", "//missing/parent", { kind: undefined }),
        node("//streams/orphan", "//missing/orphan"),
      ],
      {
        orphans: ["//streams/orphan"],
        simulated: true,
        partial: true,
      },
    ),
  );
  await render();

  expect(host.querySelectorAll('[role="treeitem"]')).toHaveLength(5);
  expect(host.textContent).toContain("Browser Mock simulated data");
  expect(host.textContent).toContain("Current");
  expect(host.textContent).toContain("Deleted");
  expect(host.textContent).toContain("Unknown type");
  expect(host.textContent).toContain("Orphan");
  expect(host.textContent).toContain("Parent not loaded");
  await act(async () =>
    host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click(),
  );
  expect(backend.queryStreamGraph).toHaveBeenLastCalledWith(
    expect.objectContaining({ includeDeleted: true }),
  );

  const main = host.querySelector<HTMLButtonElement>(
    '[data-stream-index="0"]',
  )!;
  main.focus();
  await act(async () =>
    main.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
    ),
  );
  expect(document.activeElement?.textContent).toContain("deleted");
  await act(async () =>
    document.activeElement?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    ),
  );
  expect(host.querySelector(".stream-graph-details")?.textContent).toContain(
    "//streams/deleted",
  );
  await clickButton("Locate in Streams");
  expect(openPage).toHaveBeenCalledWith("//streams/deleted");
  const locate = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent?.includes("Locate in Streams"),
  )!;
  locate.focus();
  await act(async () =>
    locate.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    ),
  );
  expect(host.querySelector(".stream-graph-details")).toBeNull();
});

it("passes filters and cursor verbatim, dedupes pages, and stops a non-progressing cursor", async () => {
  backend.queryStreamGraph
    .mockImplementationOnce(async (query: StreamGraphQuery) =>
      graphResult(query, [node("//streams/initial")]),
    )
    .mockImplementationOnce(async (query: StreamGraphQuery) =>
      graphResult(query, [node("//streams/main")], {
        hasMore: true,
        nextCursor: "opaque/cursor==",
      }),
    )
    .mockImplementationOnce(async (query: StreamGraphQuery) =>
      graphResult(
        query,
        [node("//streams/main"), node("//streams/dev", "//streams/main")],
        { hasMore: true, nextCursor: "opaque/cursor==" },
      ),
    );
  await render();
  const depot = host.querySelector<HTMLInputElement>(
    '[aria-label="Depot scope"]',
  )!;
  const text = host.querySelector<HTMLInputElement>(
    '[aria-label="Stream text filter"]',
  )!;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!;
    setter.call(depot, " //streams ");
    depot.dispatchEvent(new Event("input", { bubbles: true }));
    setter.call(text, " dev ");
    text.dispatchEvent(new Event("input", { bubbles: true }));
    host
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  expect(backend.queryStreamGraph).toHaveBeenLastCalledWith(
    expect.objectContaining({ depotPrefix: "//streams", text: "dev" }),
  );
  await clickButton("Load more streams");
  expect(backend.queryStreamGraph).toHaveBeenLastCalledWith(
    expect.objectContaining({ cursor: "opaque/cursor==" }),
  );
  expect(host.querySelectorAll('[role="treeitem"]')).toHaveLength(2);
  expect(host.textContent).toContain("non-progressing cursor");
  expect(host.textContent).not.toContain("Load more streams");
});

it("restarts an expired cursor and isolates cancelled late responses after context change", async () => {
  const stale = deferred<StreamGraphResult>();
  backend.queryStreamGraph
    .mockImplementationOnce((query: StreamGraphQuery) => {
      void query;
      return stale.promise;
    })
    .mockImplementationOnce(async (query: StreamGraphQuery) =>
      graphResult(query, [node("//streams/new")], {
        scope: {
          ...graphResult(query, []).scope,
          contextGeneration: 8,
        },
      }),
    );
  await render();
  const firstQuery = backend.queryStreamGraph.mock
    .calls[0][0] as StreamGraphQuery;
  await render({ ...baseRuntime, contextGeneration: 8 });
  expect(backend.cancelOperation).toHaveBeenCalledWith(firstQuery.operationId);
  expect(host.textContent).toContain("//streams/new");
  await act(async () => stale.reject(new Error("late failure")));
  expect(host.textContent).not.toContain("late failure");

  backend.queryStreamGraph
    .mockReset()
    .mockImplementationOnce(async (query: StreamGraphQuery) =>
      graphResult(query, [node("//streams/main")], {
        hasMore: true,
        nextCursor: "expired-token",
        scope: {
          ...graphResult(query, []).scope,
          activeProfileId: "profile-b",
          contextGeneration: 8,
        },
      }),
    )
    .mockRejectedValueOnce({ code: "cursorExpired", message: "expired" })
    .mockImplementationOnce(async (query: StreamGraphQuery) =>
      graphResult(query, [node("//streams/restarted")], {
        scope: {
          ...graphResult(query, []).scope,
          activeProfileId: "profile-b",
          contextGeneration: 8,
        },
      }),
    );
  await render({
    ...baseRuntime,
    contextGeneration: 8,
    activeProfileId: "profile-b",
  });
  await clickButton("Load more streams");
  expect(backend.queryStreamGraph.mock.calls[1][0]).toEqual(
    expect.objectContaining({ cursor: "expired-token" }),
  );
  expect(backend.queryStreamGraph.mock.calls[2][0].cursor).toBeUndefined();
  expect(host.textContent).not.toContain("restarted from the first page");
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(host.textContent).toContain("//streams/restarted");
});

it("keeps a large graph DOM-bounded through virtualization", async () => {
  backend.queryStreamGraph.mockImplementation(async (query: StreamGraphQuery) =>
    graphResult(
      query,
      Array.from({ length: 1000 }, (_, index) =>
        node(`//streams/node-${String(index).padStart(4, "0")}`),
      ),
      { simulated: true },
    ),
  );
  await render();
  expect(host.querySelectorAll('[role="treeitem"]')).toHaveLength(18);
  expect(host.textContent).toContain("1000 / 1000");
});

it("keeps the graph visible during silent cursor recovery and reports a real refresh failure once", async () => {
  const replacement = deferred<StreamGraphResult>();
  backend.queryStreamGraph
    .mockImplementationOnce(async (query: StreamGraphQuery) =>
      graphResult(query, [node("//streams/cached")], {
        hasMore: true,
        nextCursor: "invalid",
      }),
    )
    .mockRejectedValueOnce({ code: "invalidCursor", message: "invalid cursor" })
    .mockImplementationOnce(() => replacement.promise);
  await render();
  await clickButton("Load more streams");
  expect(backend.queryStreamGraph).toHaveBeenCalledTimes(3);
  expect(backend.queryStreamGraph.mock.calls[2][0].cursor).toBeUndefined();
  expect(host.textContent).toContain("//streams/cached");
  expect(host.textContent).not.toMatch(
    /invalid cursor|restarted from the first page/i,
  );
  expect(host.querySelector('[role="alert"]')).toBeNull();
  await act(async () => replacement.reject(new Error("Server unavailable")));
  expect(host.textContent).toContain("//streams/cached");
  expect(host.textContent).toContain("Server unavailable");
  expect(backend.queryStreamGraph).toHaveBeenCalledTimes(3);
});

it("reopens from the cached graph without P4 and refreshes stale pages behind it", async () => {
  backend.queryStreamGraph.mockImplementation(async (query: StreamGraphQuery) =>
    graphResult(query, [node("//streams/main")]),
  );
  await render();
  expect(backend.queryStreamGraph).toHaveBeenCalledTimes(1);
  await act(async () => root.unmount());
  root = createRoot(host);
  await render();
  expect(backend.queryStreamGraph).toHaveBeenCalledTimes(1);
  expect(host.textContent).toContain("//streams/main");

  // A stale snapshot stays on screen while the replacement is read.
  const { appCache } = await import("../../shared/cache/appCache");
  await act(async () => {
    await appCache.invalidateQueries({
      queryKey: ["snapshot", "streamGraph"],
      refetchType: "none",
    });
  });
  const next = deferred<StreamGraphResult>();
  backend.queryStreamGraph.mockImplementationOnce(() => next.promise);
  await act(async () => root.unmount());
  root = createRoot(host);
  await render();
  expect(backend.queryStreamGraph).toHaveBeenCalledTimes(2);
  expect(host.textContent).toContain("//streams/main");
  const query = backend.queryStreamGraph.mock.calls[1][0] as StreamGraphQuery;
  expect(query.refresh).toBe(true);
  await act(async () =>
    next.resolve(graphResult(query, [node("//streams/refreshed")])),
  );
  expect(host.textContent).toContain("//streams/refreshed");
});
