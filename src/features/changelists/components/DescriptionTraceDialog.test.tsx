// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  ChangelistSummary,
  ClQuery,
  ClQueryResult,
  RuntimeInfo,
} from "../../../shared/contracts";
import { appCache } from "../../../shared/cache/appCache";
const api = vi.hoisted(() => ({
  queryChangelists: vi.fn(),
  cancelOperation: vi.fn(),
  detail: vi.fn(),
  open: vi.fn(),
}));
vi.mock("../../../infrastructure/backend", () => ({ backend: api }));
vi.mock("../../browsers/graphReads", async (original) => ({
  ...(await original<object>()),
  readGraphChange: api.detail,
}));
vi.mock("./ChangeDetailsDialog", () => ({ useChangeDetails: () => api.open }));
vi.mock("../../../app/dialogs/Dialog", () => ({
  Dialog: ({
    children,
    footer,
  }: {
    children: ReactNode;
    footer: ReactNode;
  }) => (
    <div>
      {children}
      {footer}
    </div>
  ),
}));
import { DescriptionTraceDialog } from "./DescriptionTraceDialog";
const runtime = {
  mode: "mock",
  context: {
    server: "mock",
    user: "u",
    client: "current-filter-must-not-leak",
  },
  contextGeneration: 1,
} as RuntimeInfo;
const body = "[FIX] synthetic body --> Task [mock:issue:7]";
const detail = {
  changeId: 100,
  description: body,
  time: "2026-01-01T00:00:00Z",
  inspectionStatus: "complete",
  files: [],
};
const row = (
  id: number,
  client = `target-workspace-${id}`,
): ChangelistSummary => ({
  id,
  client,
  description: `${body}\n提交人: synthetic\n合并来源: //synthetic/main\nCL号: 100`,
  user: "ci-bot",
  time: "2026-01-02T00:00:00Z",
  status: "submitted",
  fileCount: 0,
  jobs: [],
  hasShelf: false,
  mergeClassification: "unknown",
});
function page(
  query: ClQuery,
  items: ChangelistSummary[],
  extra: Partial<ClQueryResult> = {},
): ClQueryResult {
  return {
    requestGeneration: query.requestGeneration,
    items,
    hasMore: false,
    stats: {
      scannedCount: items.length,
      matchedCount: items.length,
      hiddenReliableMergeCount: 0,
      truncatedBySafetyLimit: false,
    },
    ...extra,
  };
}
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  appCache.clear();
  vi.resetAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.detail.mockResolvedValue(detail);
  api.cancelOperation.mockResolvedValue(undefined);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  appCache.clear();
  vi.unstubAllGlobals();
});
async function render(
  value = runtime,
  seedCandidates: ChangelistSummary[] = [],
) {
  await act(async () =>
    root.render(
      <DescriptionTraceDialog
        changeId={100}
        sourceChange={detail}
        seedCandidates={seedCandidates}
        runtime={value}
        zh={false}
        onClose={() => {}}
      />,
    ),
  );
}
async function click(label: string) {
  await act(async () => {
    const button = [...host.querySelectorAll("button")].find(
      (item) => item.textContent === label,
    );
    expect(button).toBeTruthy();
    button!.click();
  });
}
it("uses independent bounded filters and each matching CL's own workspace; preserves multiple matches and previews", async () => {
  api.queryChangelists.mockImplementation(async (query: ClQuery) =>
    page(query, [
      row(100),
      row(101),
      row(102),
      { ...row(103), description: body },
      { ...row(104), description: `[AutoGen]\n${body}` },
    ]),
  );
  await render();
  expect(api.queryChangelists).not.toHaveBeenCalled();
  await click("Find destinations");
  expect(api.detail).not.toHaveBeenCalled();
  const query = api.queryChangelists.mock.calls[0][0];
  expect(query).toMatchObject({
    users: [],
    clients: [],
    jobs: [],
    streams: [],
    keyword: "",
    from: "2026-01-01T00:00:00.000Z",
    mergeClassifications: [],
    hideReliableMerges: false,
    pageSize: 100,
  });
  expect(query.stream).toBeUndefined();
  expect(query.depotPath).toBeUndefined();
  expect(query.hasJob).toBeUndefined();
  expect(host.textContent).toContain("Candidates: 2");
  expect(host.textContent).toContain("target-workspace-101");
  expect(host.textContent).toContain("target-workspace-102");
  await click("101");
  expect(api.open.mock.calls[0][0]).toEqual({
    kind: "submitted",
    changeId: 101,
  });
});
it("keeps a fixed time range/generation across pages, deduplicates by CL and retains results on failure", async () => {
  api.queryChangelists
    .mockImplementationOnce(async (query: ClQuery) =>
      page(query, [row(101)], { hasMore: true, nextCursor: "page-2" }),
    )
    .mockRejectedValueOnce(new Error("simulated failure"))
    .mockImplementationOnce(async (query: ClQuery) =>
      page(query, [row(101), row(102, "")]),
    );
  await render();
  await click("Find destinations");
  expect(host.textContent).toContain("target-workspace-101");
  expect(host.textContent).toContain("simulated failure");
  await click("Continue search (up to 10 pages)");
  expect(host.textContent).toContain("Candidates: 2");
  expect(host.textContent).toContain("Unknown");
  const calls = api.queryChangelists.mock.calls.map((call) => call[0]);
  expect(calls[2]).toMatchObject({
    from: calls[0].from,
    to: calls[0].to,
    requestGeneration: calls[0].requestGeneration,
    cursor: "page-2",
  });
});
it("uses cached candidates on reopen and a new generation on refresh", async () => {
  api.queryChangelists.mockImplementation(async (query: ClQuery) =>
    page(query, [row(101)]),
  );
  await render();
  await click("Find destinations");
  await act(async () => root.render(null));
  await render();
  expect(api.queryChangelists).toHaveBeenCalledTimes(1);
  expect(host.textContent).toContain("Candidates: 1");
  await click("Refresh investigation");
  expect(api.queryChangelists.mock.calls[1][0].requestGeneration).not.toBe(
    api.queryChangelists.mock.calls[0][0].requestGeneration,
  );
});
it("automatically stops at ten pages and only continues another bounded run on explicit request", async () => {
  api.queryChangelists.mockImplementation(async (query: ClQuery) =>
    page(query, [], {
      hasMore: true,
      nextCursor: `page-${api.queryChangelists.mock.calls.length + 1}`,
    }),
  );
  await render();
  await click("Find destinations");
  expect(api.queryChangelists).toHaveBeenCalledTimes(10);
  expect(host.textContent).toContain("Query limit reached · Incomplete");
  expect(
    [...host.querySelectorAll("button")].find(
      (button) => button.textContent === "Continue search (up to 10 pages)",
    )!.disabled,
  ).toBe(false);
  await click("Continue search (up to 10 pages)");
  expect(api.queryChangelists).toHaveBeenCalledTimes(20);
});
it("shows loaded same-context candidates immediately and automatically discovers second-page matches serially", async () => {
  const longClient = "synthetic-workspace-".repeat(12);
  let inFlight = 0,
    peak = 0;
  api.queryChangelists.mockImplementation(async (query: ClQuery) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await Promise.resolve();
    inFlight--;
    return query.cursor
      ? page(query, [row(102)])
      : page(query, [], { hasMore: true, nextCursor: "page-2" });
  });
  await render(runtime, [row(101, longClient)]);
  expect(host.textContent).toContain(longClient);
  expect(api.queryChangelists).not.toHaveBeenCalled();
  const client = [...host.querySelectorAll<HTMLElement>('[role="cell"]')].find(
    (cell) => cell.textContent === longClient,
  )!;
  expect(client.style.overflow).not.toBe("hidden");
  await click("Find destinations");
  expect(api.queryChangelists).toHaveBeenCalledTimes(2);
  expect(peak).toBe(1);
  expect(host.textContent).toContain("Candidates: 2");
  expect(host.textContent).toContain("target-workspace-102");
  await render({ ...runtime, contextGeneration: 2 });
  expect(host.textContent).not.toContain(longClient);
});
it("cancels and hides old-connection late results", async () => {
  let resolve!: (value: ClQueryResult) => void;
  api.queryChangelists.mockImplementation(
    () =>
      new Promise<ClQueryResult>((done) => {
        resolve = done;
      }),
  );
  await render();
  await click("Find destinations");
  const query = api.queryChangelists.mock.calls[0][0];
  await render({ ...runtime, contextGeneration: 2 });
  await act(async () => resolve(page(query, [row(101)])));
  expect(api.cancelOperation).toHaveBeenCalledTimes(1);
  expect(host.textContent).not.toContain("target-workspace-101");
});
it("marks backend truncation and excludes rows before the source submission", async () => {
  api.queryChangelists.mockImplementation(async (query: ClQuery) =>
    page(query, [row(101), { ...row(102), time: "2025-12-31T23:59:59Z" }], {
      stats: {
        scannedCount: 2,
        matchedCount: 2,
        hiddenReliableMergeCount: 0,
        truncatedBySafetyLimit: true,
      },
    }),
  );
  await render();
  await click("Find destinations");
  expect(host.textContent).toContain("Candidates: 1");
  expect(host.textContent).toContain("Query limit reached · Incomplete");
  expect(host.textContent).not.toContain("target-workspace-102");
});

it("recomputes reference reachability when a later page connects an earlier child, independent of body and author", async () => {
  api.queryChangelists.mockImplementation(async (query: ClQuery) =>
    query.cursor
      ? page(query, [
          {
            ...row(101),
            user: "different-author",
            description:
              "different parent body\n合并来源: //synthetic/main\nCL号: 100",
          },
        ])
      : page(
          query,
          [
            {
              ...row(102),
              description:
                "different child body\n合并来源: //synthetic/release\nCL号: 101",
            },
          ],
          { hasMore: true, nextCursor: "parent-page" },
        ),
  );
  await render();
  await click("Find destinations");
  expect(host.textContent).toContain("Candidates: 2");
  expect(host.textContent).toContain("target-workspace-102");
  expect(host.textContent).toContain("target-workspace-101");
  expect(
    [...host.querySelectorAll('[role="columnheader"]')].map(
      (el) => el.textContent,
    ),
  ).toEqual(["CL", "Workspace / Client", "Time", "Description"]);
  expect(host.textContent).not.toContain("Workspace is each submission");
  expect(host.textContent).not.toContain("Not fully scanned; only retrieved");
  const grip = host.querySelector('[role="separator"]')!;
  const before = grip.getAttribute("aria-valuenow");
  await act(async () =>
    grip.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
    ),
  );
  expect(Number(grip.getAttribute("aria-valuenow"))).toBe(Number(before) + 10);
});

it("contains unmeasured long descriptions and remeasures expanded content after column resizing", async () => {
  const callbacks: (() => void)[] = [];
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private callback: ResizeObserverCallback) {}
      observe(target: Element) {
        callbacks.push(() =>
          this.callback(
            [
              {
                target,
                contentRect: target.getBoundingClientRect(),
                borderBoxSize: [
                  {
                    inlineSize: 800,
                    blockSize: target.getBoundingClientRect().height,
                  },
                ],
                contentBoxSize: [],
                devicePixelContentBoxSize: [],
              },
            ],
            this as unknown as ResizeObserver,
          ),
        );
      }
      unobserve() {}
      disconnect() {}
    },
  );
  const bounds = vi
    .spyOn(HTMLElement.prototype, "getBoundingClientRect")
    .mockImplementation(function (this: HTMLElement) {
      const height = this.classList.contains("description-trace-row-content")
        ? this.querySelector(".expanded")
          ? 600
          : 112
        : 320;
      return {
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: 800,
        bottom: height,
        width: 800,
        height,
        toJSON() {},
      } as DOMRect;
    });
  try {
    api.queryChangelists.mockImplementation(async (query: ClQuery) =>
      page(query, [
        {
          ...row(101),
          description: `${"synthetic long line\n".repeat(40)}合并来源: //synthetic/main\nCL号: 100`,
        },
        row(102),
      ]),
    );
    await render();
    await click("Find destinations");
    const records = () => [
      ...host.querySelectorAll<HTMLElement>('[role="row"][data-index]'),
    ];
    expect(records()[0].style.overflow).toBe("hidden");
    expect(host.querySelector(".description-trace-text.expanded")).toBeNull();
    await click("Expand description");
    await act(async () => callbacks.forEach((callback) => callback()));
    expect(
      host.querySelector(".description-trace-text.expanded"),
    ).not.toBeNull();
    const grip = host.querySelectorAll('[role="separator"]')[3];
    await act(async () =>
      grip.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }),
      ),
    );
    await act(async () => callbacks.forEach((callback) => callback()));
    expect(
      records().every((record) => record.style.overflow === "hidden"),
    ).toBe(true);
    expect(parseFloat(records()[1].style.top)).toBeGreaterThanOrEqual(
      parseFloat(records()[0].style.height),
    );
  } finally {
    bounds.mockRestore();
  }
});
