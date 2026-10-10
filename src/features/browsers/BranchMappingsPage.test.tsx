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
} from "../../shared/contracts/types";
import { BranchMappingsPage } from "./BranchMappingsPage";

const backend = vi.hoisted(() => ({
  queryBranchMappings: vi.fn(),
  getBranchMappingDetail: vi.fn(),
  previewBranchMappingImpact: vi.fn(),
  preflightBranchMappingMutation: vi.fn(),
  confirmBranchMappingMutation: vi.fn(),
  cancelOperation: vi.fn(async () => undefined),
}));

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
  expect(host.textContent).toContain("restarted from the first page");

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
