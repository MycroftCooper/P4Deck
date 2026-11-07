// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  BranchImpactPreviewQuery,
  BranchMappingDetail,
  BranchMappingDetailQuery,
  BranchMappingPage,
  BranchMappingQuery,
  RuntimeInfo,
} from "../../../shared/contracts";
import {
  BranchMappingsPage,
  measureBranchMappingRow,
} from "./BranchMappingsPage";
import { setLocale } from "../../../shared/i18n";

const backend = vi.hoisted(() => ({
  queryBranchMappings: vi.fn(),
  getBranchMappingDetail: vi.fn(),
  previewBranchMappingImpact: vi.fn(),
  preflightBranchMappingMutation: vi.fn(),
  confirmBranchMappingMutation: vi.fn(),
  cancelOperation: vi.fn(async () => undefined),
}));

vi.mock("../../../infrastructure/backend", () => ({ backend }));
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
    scrollToIndex: vi.fn(),
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

const summary = (name: string) => ({
  name,
  owner: "tester",
  update: "2026/10/10 09:00:00",
  access: "2026/10/10 10:00:00",
  description: `Mapping ${name}`,
  options: "unlocked",
});

function page(
  query: BranchMappingQuery,
  names: string[],
  overrides: Partial<BranchMappingPage> = {},
): BranchMappingPage {
  return {
    requestGeneration: query.requestGeneration,
    scope: {
      activeProfileId: runtime.activeProfileId,
      contextGeneration: runtime.contextGeneration,
      server: runtime.context.server,
      user: runtime.context.user,
      client: runtime.context.client,
    },
    items: names.map(summary),
    hasMore: false,
    partial: false,
    truncated: false,
    stats: {
      scannedCount: names.length,
      matchedCount: names.length,
      returnedCount: names.length,
      invalidRecordCount: 0,
      safetyLimit: 5000,
    },
    operationIds: [query.operationId],
    simulated: false,
    ...overrides,
  };
}

const detail: BranchMappingDetail = {
  name: "atlas-release",
  owner: "tester",
  update: "raw-update",
  access: "raw-access",
  description: "A very long\nrelease description",
  locked: false,
  view: [
    {
      modifier: "map",
      source: "//atlas/main/...",
      target: "//atlas/release/...",
    },
    {
      modifier: "exclude",
      source: "//atlas/main/private/...",
      target: "//atlas/release/private/...",
    },
    { modifier: "unknown", unknown: "future syntax" },
  ],
  unknownFields: [{ name: "FutureField", value: "raw value" }],
  editable: false,
  operationIds: [],
  simulated: false,
};

let host: HTMLDivElement;
let root: Root;

async function render(nextRuntime = runtime) {
  await act(async () =>
    root.render(<BranchMappingsPage runtime={nextRuntime} zh={false} />),
  );
}

async function click(text: string) {
  const button = [
    ...document.querySelectorAll<HTMLButtonElement>("button"),
  ].find((candidate) => candidate.textContent?.includes(text));
  expect(button).toBeTruthy();
  await act(async () => button!.click());
}

beforeEach(() => {
  // Components translate through the module-level locale.
  setLocale("en-US");
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  Object.values(backend).forEach((mock) => mock.mockReset());
  backend.cancelOperation.mockResolvedValue(undefined);
  backend.queryBranchMappings.mockImplementation(
    async (query: BranchMappingQuery) => page(query, ["atlas-release"]),
  );
  backend.getBranchMappingDetail.mockImplementation(
    async (query: BranchMappingDetailQuery) => ({
      requestGeneration: query.requestGeneration,
      scope: page(
        {
          operationId: "scope",
          requestGeneration: query.requestGeneration,
          pageSize: 1,
        },
        [],
      ).scope,
      detail,
    }),
  );
  backend.previewBranchMappingImpact.mockImplementation(
    async (query: BranchImpactPreviewQuery) => ({
      requestGeneration: query.requestGeneration,
      name: query.name,
      direction: query.direction,
      items: [],
      blockers: [
        {
          code: "workspaceUnmapped" as const,
          message: "The source path is not mapped by this client.",
        },
      ],
      partial: true,
      truncated: true,
      scannedCount: 200,
      safetyLimit: 200,
      operationIds: [query.operationId],
      simulated: false,
    }),
  );
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

it("shows raw detail/View semantics and a structured read-only impact blocker", async () => {
  await render();
  const option = host.querySelector<HTMLButtonElement>('[role="option"]')!;
  option.focus();
  await act(async () =>
    option.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    ),
  );
  expect(host.querySelector(".branch-mapping-detail")?.textContent).toContain(
    "raw-update",
  );
  expect(host.textContent).toContain("FutureField");
  expect(host.textContent).toContain("future syntax");
  expect(host.textContent).toContain("editing is disabled");
  expect(
    host.querySelector<HTMLButtonElement>(".branch-detail-actions button")
      ?.disabled,
  ).toBe(true);

  await click("Run read-only preview");
  expect(backend.previewBranchMappingImpact).toHaveBeenCalledWith(
    expect.objectContaining({
      name: "atlas-release",
      direction: "forward",
      limit: 200,
    }),
  );
  expect(host.textContent).toContain("workspaceUnmapped");
  expect(host.textContent).toContain("integrate -n only");
  expect(host.textContent).toContain("Preview is partial or truncated");

  await click("reverse");
  await click("Run read-only preview");
  expect(backend.previewBranchMappingImpact).toHaveBeenLastCalledWith(
    expect.objectContaining({ direction: "reverse" }),
  );
});

it("passes opaque cursors verbatim, dedupes pages, and stops a non-progressing cursor", async () => {
  backend.queryBranchMappings
    .mockImplementationOnce(async (query: BranchMappingQuery) =>
      page(query, ["alpha", "beta"], {
        hasMore: true,
        nextCursor: "opaque/cursor==",
      }),
    )
    .mockImplementationOnce(async (query: BranchMappingQuery) =>
      page(query, ["beta", "gamma"], {
        hasMore: true,
        nextCursor: "opaque/cursor==",
      }),
    );
  await render();
  await click("Load more");
  expect(backend.queryBranchMappings).toHaveBeenLastCalledWith(
    expect.objectContaining({ cursor: "opaque/cursor==" }),
  );
  expect(host.querySelectorAll('[role="option"]')).toHaveLength(3);
  expect(host.textContent).toContain("non-progressing cursor");
  expect(
    [...host.querySelectorAll("button")].some((button) =>
      button.textContent?.includes("Load more"),
    ),
  ).toBe(false);
});

it("restarts an expired cursor and isolates late detail responses across connection changes", async () => {
  let resolveDetail!: (value: unknown) => void;
  backend.getBranchMappingDetail.mockImplementationOnce(
    () => new Promise((resolve) => (resolveDetail = resolve)),
  );
  backend.queryBranchMappings
    .mockImplementationOnce(async (query: BranchMappingQuery) =>
      page(query, ["atlas-release"], { hasMore: true, nextCursor: "expired" }),
    )
    .mockRejectedValueOnce({ code: "cursorExpired", message: "expired" })
    .mockImplementation(async (query: BranchMappingQuery) =>
      page(query, ["fresh"]),
    );
  await render();
  await act(async () =>
    host.querySelector<HTMLButtonElement>('[role="option"]')!.click(),
  );
  await click("Load more");
  expect(host.textContent).not.toContain("restarted from the first page");
  expect(host.textContent).toContain("fresh");
  expect(host.querySelector('[role="alert"]')).toBeNull();

  await render({
    ...runtime,
    contextGeneration: 8,
    context: { ...runtime.context, client: "other-workspace" },
  });
  await act(async () =>
    resolveDetail({
      requestGeneration: 2,
      scope: page({ operationId: "old", requestGeneration: 2, pageSize: 1 }, [])
        .scope,
      detail,
    }),
  );
  expect(host.textContent).not.toContain("raw-update");
  expect(backend.cancelOperation).toHaveBeenCalled();
});

it("caps a large list to the virtual window DOM budget", async () => {
  backend.queryBranchMappings.mockImplementation(
    async (query: BranchMappingQuery) =>
      page(
        query,
        Array.from({ length: 1000 }, (_, index) => `mapping-${index}`),
      ),
  );
  await render();
  expect(host.querySelectorAll('[role="option"]')).toHaveLength(18);
});

it("keeps the list visible during silent cursor recovery and reports a real refresh failure once", async () => {
  let fail!: (reason: unknown) => void;
  backend.queryBranchMappings
    .mockImplementationOnce(async (query: BranchMappingQuery) =>
      page(query, ["cached-mapping"], { hasMore: true, nextCursor: "invalid" }),
    )
    .mockRejectedValueOnce({ code: "invalidCursor", message: "invalid cursor" })
    .mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          fail = reject;
        }),
    );
  await render();
  await click("Load more");
  expect(backend.queryBranchMappings).toHaveBeenCalledTimes(3);
  expect(backend.queryBranchMappings.mock.calls[2][0].cursor).toBeUndefined();
  expect(host.textContent).toContain("cached-mapping");
  expect(host.textContent).not.toMatch(
    /invalid cursor|restarted from the first page/i,
  );
  expect(host.querySelector('[role="alert"]')).toBeNull();
  await act(async () => fail(new Error("Server unavailable")));
  expect(host.textContent).toContain("cached-mapping");
  expect(host.textContent).toContain("Server unavailable");
  expect(backend.queryBranchMappings).toHaveBeenCalledTimes(3);
});

it("retains positive row heights across hidden tabs and accepts new content heights", () => {
  const node = document.createElement("div");
  let height = 0;
  Object.defineProperty(node, "offsetHeight", { get: () => height });
  expect(measureBranchMappingRow(node)).toBe(70);
  height = 96;
  expect(measureBranchMappingRow(node)).toBe(96);
  height = 0;
  expect(measureBranchMappingRow(node)).toBe(96);
  height = 132;
  expect(measureBranchMappingRow(node)).toBe(132);
  height = 0;
  expect(measureBranchMappingRow(node)).toBe(132);
  height = 72;
  expect(measureBranchMappingRow(node)).toBe(72);
});
it("keeps 81 heterogeneous mapping rows windowed without locking content to cached virtual heights", async () => {
  backend.queryBranchMappings.mockImplementation(
    async (query: BranchMappingQuery) => ({
      ...page(
        query,
        Array.from({ length: 81 }, (_, i) => `synthetic-${i}`),
      ),
      items: Array.from({ length: 81 }, (_, i) => ({
        ...summary(`synthetic-${i}`),
        description: "long synthetic description\n".repeat(1 + (i % 9)),
      })),
    }),
  );
  await render();
  const rows = [
    ...host.querySelectorAll<HTMLElement>(".branch-mapping-window-row"),
  ];
  expect(rows).toHaveLength(18);
  for (const row of rows) {
    expect(row.style.height).toBe("");
    expect(row.style.minHeight).toBe("70px");
  }
});

it("applies both themed filters only on explicit submit", async () => {
  await render();
  const count = backend.queryBranchMappings.mock.calls.length;
  for (const [label, value] of [
    ["Branch Mapping name filter", " release "],
    ["Branch Mapping owner filter", " owner-fixture "],
  ]) {
    const input = host.querySelector<HTMLInputElement>(
      `input[aria-label="${label}"]`,
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  expect(backend.queryBranchMappings).toHaveBeenCalledTimes(count);
  await click("Apply filters");
  expect(backend.queryBranchMappings).toHaveBeenCalledTimes(count + 1);
  expect(backend.queryBranchMappings).toHaveBeenLastCalledWith(
    expect.objectContaining({ nameFilter: "release", owner: "owner-fixture" }),
  );
});
it("retires the detail and preview chains together with the list, with no leaked cancel", async () => {
  // Load the list, select a mapping, then hold the preview in flight: the
  // preview pane only exists after the detail has been read, so the detail is
  // awaited first and the preview is what a context change interrupts.
  await render();
  let resolvePreview!: (value: unknown) => void;
  await act(async () =>
    host.querySelector<HTMLButtonElement>('[role="option"]')!.click(),
  );
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  backend.previewBranchMappingImpact.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolvePreview = resolve;
      }),
  );
  await click("Run read-only preview");
  const listQuery = (
    backend.queryBranchMappings.mock.calls[0] as unknown[]
  )[0] as BranchMappingQuery;
  const previewQuery = (
    backend.previewBranchMappingImpact.mock.calls[0] as unknown[]
  )[0] as BranchImpactPreviewQuery;

  // A connection change retires every chain: the list, the detail and the
  // preview are separate accounts, so a double ledger would leak here.
  backend.cancelOperation.mockClear();
  await render({
    ...runtime,
    contextGeneration: 9,
    context: { ...runtime.context, client: "other-workspace" },
  });
  const cancelled = backend.cancelOperation.mock.calls.map(
    (call) => (call as unknown[])[0],
  );
  // The detail finished before the change, so only the live list chain and the
  // in-flight preview have host operations to retire.
  expect(cancelled).toContain(previewQuery.operationId);
  expect(cancelled).not.toContain(listQuery.operationId);
  // Exactly once each: no account cancels another's operation twice.
  expect(new Set(cancelled).size).toBe(cancelled.length);

  // A late answer from the retired preview must not paint the new scope: a
  // stale impact line would appear as a fresh, "non-partial" preview.
  await act(async () => {
    resolvePreview({
      requestGeneration: previewQuery.requestGeneration,
      name: "atlas-release",
      direction: "forward",
      items: [
        {
          path: "//atlas/release/stale/...",
          action: "map",
          source: "//atlas/main/stale/...",
          target: "//atlas/release/stale/...",
          rationale: "stale-preview-row",
        },
      ],
      blockers: [],
      stats: {},
    });
    await Promise.resolve();
  });
  expect(host.textContent).not.toContain("stale-preview-row");
});
