// @vitest-environment jsdom
import { act } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { dialogHarness, dialogButton } from "./testHarness";
import { refreshFileLockFacts, useCommandDialogs } from "./useCommandDialogs";
import type {
  PendingChange,
  PendingChangePage,
  WorkspaceNode,
} from "../../shared/contracts";
import { backend } from "../../infrastructure/backend";
import { lookupSubmitAction } from "../../features/actions/workflowReceipt";
import { workspaceCache } from "../../features/files/workspaceQueries";
vi.mock("../../features/actions/workflowReceipt", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../features/actions/workflowReceipt")
  >()),
  lookupSubmitAction: vi.fn(),
}));
const harness = dialogHarness();
const node: WorkspaceNode = {
  id: "a",
  name: "a",
  kind: "file",
  state: "controlled",
  absolutePath: "/a",
  relativePath: "a",
};
let api!: ReturnType<typeof useCommandDialogs>;
const pendingPage = (changes: PendingChange[]): PendingChangePage => ({
  requestGeneration: 0,
  defaultChange: changes.find((change) => change.id === 0),
  items: changes.filter((change) => change.id > 0),
  hasMore: false,
  partial: false,
  stats: {
    scannedCount: changes.length,
    matchedCount: changes.length,
    truncatedBySafetyLimit: false,
  },
});
function Harness({ scope = "a" }: { scope?: string }) {
  api = useCommandDialogs(scope, "workspace", true);
  return api.element;
}
afterEach(() => {
  workspaceCache.clear();
  vi.restoreAllMocks();
});

it("reloads cached workspace and depot facts after ordinary lock changes", async () => {
  workspaceCache.setQueryData(["workspace-files", "scope", "/root"], {
    items: [],
  });
  const workspace = vi
    .spyOn(backend, "listWorkspaceChildren")
    .mockResolvedValue({
      items: [],
      completeness: "complete",
      errors: [],
      operationIds: [],
      truncated: false,
      safetyLimit: 10_000,
      cacheFreshness: "fresh",
    });
  const depot = vi.spyOn(backend, "listDepotChildren").mockResolvedValue([]);
  await workspaceCache.fetchQuery({
    queryKey: ["depot-files", "scope", "//depot"],
    queryFn: () => backend.listDepotChildren("//depot"),
  });
  depot.mockClear();

  await refreshFileLockFacts("scope");

  expect(workspace).toHaveBeenCalledWith("/root", true, expect.any(String));
  expect(depot).toHaveBeenCalledWith("//depot");
});
it("serializes command modals and ignores a second preview while one is open", async () => {
  await harness.render(<Harness />);
  await act(async () => {
    api.open({ kind: "rename", node, source: null });
    api.open({ kind: "resolve", nodes: [node], source: null });
  });
  expect(document.querySelectorAll("dialog")).toHaveLength(1);
  expect(document.body.textContent).toContain("重命名 / 移动");
  await act(async () => dialogButton("取消").click());
  expect(document.querySelector("dialog")).toBeNull();
});
it("cancels awaited revisions on connection change without leaking a later modal", async () => {
  await harness.render(<Harness />);
  let result!: Promise<string | null>;
  await act(async () => {
    result = api.getRevision({ nodes: [node], source: null });
  });
  await harness.render(<Harness scope="b" />);
  expect(await result).toBeNull();
  expect(document.querySelector("dialog")).toBeNull();
});
it("cancels a checkout destination selection when the workspace changes", async () => {
  await harness.render(<Harness />);
  let result!: ReturnType<typeof api.checkout>;
  await act(async () => {
    result = api.checkout({
      changes: [],
      count: 1,
      recursive: false,
      source: null,
    });
  });
  expect(document.body.textContent).toContain("选择签出目标 CL");
  await harness.render(<Harness scope="new-workspace" />);
  expect(await result).toBeNull();
  expect(document.querySelector("dialog")).toBeNull();
});
it("connects the shared submit dialog to preflight and confirmation adapters", async () => {
  const change = {
    id: 10,
    description: "Submit me",
    user: "tester",
    client: "workspace",
    status: "pending" as const,
    jobs: [],
    files: [{ depotPath: "//depot/a", action: "edit" }],
    shelvedFiles: [],
  };
  vi.spyOn(backend, "queryPendingChanges").mockResolvedValue(
    pendingPage([change]),
  );
  const preflight = vi.spyOn(backend, "preflightSubmit").mockResolvedValue({
    ready: true,
    change,
    blockers: [],
    warnings: [],
    target: {
      server: "server:1666",
      user: "tester",
      client: "workspace",
      workspace: "/work",
      changeId: 10,
      contextGeneration: 1,
    },
    fileSummary: {
      fileCount: 1,
      depotPaths: ["//depot/a"],
      actionCounts: { edit: 1 },
      contentDigest: "digest",
    },
    token: "token",
    expiresAt: Date.now() + 60_000,
    ttlMs: 60_000,
    operationIds: [],
    refreshRecommended: false,
  });
  const confirm = vi
    .spyOn(backend, "confirmSubmit")
    .mockImplementation(async (confirmation) => ({
      execution: {
        kind: "submit",
        operationId: confirmation.operationId!,
        state: "commandCompleted",
        outcome: "submitted",
        files: [],
      },
      outcome: "submitted",
      changeId: 10,
      submittedChangeId: 42,
      message: "Submitted as CL 42",
      refresh: {
        pendingChanges: true,
        submittedChanges: true,
        workspaceStatus: true,
        depotPaths: ["//depot/a"],
        reason: "refresh",
      },
    }));
  vi.spyOn(backend, "companySubmitConnectionSnapshot").mockResolvedValue({
    profileId: "fixture",
    generation: "1",
    server: "server:1666",
    user: "tester",
    client: "workspace",
  });
  await harness.render(<Harness />);
  await act(async () =>
    api.open({ kind: "submit", id: 10, count: 1, source: null }),
  );
  await act(async () => dialogButton("重新预检").click());
  await act(async () =>
    document.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click(),
  );
  await act(async () => dialogButton("确认提交整个 CL").click());
  expect(preflight).toHaveBeenCalledExactlyOnceWith({ changeId: 10 });
  const confirmation = confirm.mock.calls[0][0] as {
    token: string;
    target: { changeId: number };
    operationId: string;
  };
  expect(confirmation).toMatchObject({
    token: "token",
    target: expect.objectContaining({ changeId: 10 }),
  });
  expect(confirmation.operationId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  );
  expect(document.body.textContent).toContain("提交结果（权威）");
  expect(document.body.textContent).toContain("CL 42");
  expect(document.body.textContent).toContain("Submitted as CL 42");
});

const submitConnection = {
  profileId: "fixture",
  generation: "1",
  server: "server:1666",
  user: "tester",
  client: "workspace",
};
function submitFixture() {
  const change = {
    id: 10,
    description: "Submit me",
    user: "tester",
    client: "workspace",
    status: "pending" as const,
    jobs: [],
    files: [{ depotPath: "//depot/a", action: "edit" }],
    shelvedFiles: [],
  };
  vi.spyOn(backend, "queryPendingChanges").mockResolvedValue(
    pendingPage([change]),
  );
  vi.spyOn(backend, "preflightSubmit").mockResolvedValue({
    ready: true,
    change,
    blockers: [],
    warnings: [],
    target: {
      server: "server:1666",
      user: "tester",
      client: "workspace",
      workspace: "/work",
      changeId: 10,
      contextGeneration: 1,
    },
    fileSummary: {
      fileCount: 1,
      depotPaths: ["//depot/a"],
      actionCounts: { edit: 1 },
      contentDigest: "digest",
    },
    token: "token",
    expiresAt: Date.now() + 60_000,
    ttlMs: 60_000,
    operationIds: [],
    refreshRecommended: false,
  });
  vi.spyOn(backend, "companySubmitConnectionSnapshot").mockResolvedValue(
    submitConnection,
  );
}
async function openSubmitDialog() {
  await harness.render(<Harness />);
  await act(async () =>
    api.open({ kind: "submit", id: 10, count: 1, source: null }),
  );
  await act(async () => dialogButton("重新预检").click());
  await act(async () =>
    document.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click(),
  );
  await act(async () => dialogButton("确认提交整个 CL").click());
}

it("recovers an unconfirmed submit by the SAME operation id and shows authority", async () => {
  submitFixture();
  const confirm = vi
    .spyOn(backend, "confirmSubmit")
    .mockRejectedValue(new Error("transport lost"));
  const lookup = vi
    .mocked(lookupSubmitAction)
    .mockImplementation(async (request) => ({
      kind: "found" as const,
      receipt: {
        operationId: request.operationId,
        kind: "submit" as const,
        connection: request.connection,
        payloadDigest: "a".repeat(64),
        revision: "2",
        state: "settled" as const,
        result: {
          outcome: "submitted" as const,
          changeId: 10,
          submittedChangeId: 42,
          message: "Submitted as CL 42",
          refresh: {
            pendingChanges: true,
            submittedChanges: true,
            workspaceStatus: true,
            depotPaths: ["//depot/a"],
            reason: "refresh",
          },
        },
      },
    }));
  await openSubmitDialog();
  const confirmation = confirm.mock.calls[0][0] as { operationId: string };
  expect(confirm).toHaveBeenCalledOnce();
  expect(lookup).toHaveBeenCalledExactlyOnceWith({
    operationId: confirmation.operationId,
    connection: submitConnection,
  });
  expect(document.body.textContent).toContain("提交结果（权威）");
  expect(document.body.textContent).toContain("CL 42");
  expect(document.body.textContent).not.toContain("结果不确定");
});

it("keeps a lost submit uncertain when the receipt has no settled result", async () => {
  submitFixture();
  const confirm = vi
    .spyOn(backend, "confirmSubmit")
    .mockRejectedValue(new Error("transport lost"));
  const lookup = vi
    .mocked(lookupSubmitAction)
    .mockResolvedValue({ kind: "notFound" });
  await openSubmitDialog();
  const confirmation = confirm.mock.calls[0][0] as { operationId: string };
  expect(confirm).toHaveBeenCalledOnce();
  expect(lookup).toHaveBeenCalledExactlyOnceWith({
    operationId: confirmation.operationId,
    connection: submitConnection,
  });
  expect(document.body.textContent).toContain("结果不确定");
  expect(document.body.textContent).not.toContain("提交结果（权威）");
  expect(document.body.textContent).toContain(confirmation.operationId);
});

it("connects toolbar and context-menu resolve requests to the typed workflow", async () => {
  const depotNode = {
    ...node,
    depotPath: "//depot/a",
    state: "conflicted" as const,
  };
  const target = {
    kind: "resolve" as const,
    server: "server:1666",
    user: "tester",
    client: "workspace",
    workspace: "/work",
    contextGeneration: 1,
    depotPaths: ["//depot/a"],
  };
  const preflight = vi.spyOn(backend, "preflightResolve").mockResolvedValue({
    ready: true,
    conflicts: [
      {
        depotPath: "//depot/a",
        conflictType: "content",
        status: "unresolved",
        availableStrategies: ["safe"],
        sources: [],
        preview: [],
      },
    ],
    blockers: [],
    warnings: [],
    target,
    contentDigest: "digest",
    token: "resolve-token",
    expiresAt: Date.now() + 60_000,
    ttlMs: 60_000,
    operationIds: [],
  });
  vi.spyOn(backend, "resolveStats").mockResolvedValue({
    base: {},
    source: {},
    target: {},
    conflicts: 0,
  });
  const confirm = vi.spyOn(backend, "confirmResolve").mockResolvedValue({
    outcome: "succeeded",
    message: "Resolved",
    operationIds: ["resolve-op"],
    files: [
      {
        depotPath: "//depot/a",
        state: "succeeded",
        message: "verified",
      },
    ],
    refresh: {
      pendingChanges: true,
      workspaceStatus: true,
      depotPaths: ["//depot/a"],
      reason: "refresh",
    },
  });
  await harness.render(<Harness />);
  await act(async () =>
    api.open({ kind: "resolve", nodes: [depotNode], source: null }),
  );
  // P4V-style dialog: the conflict list is inspected once automatically on mount.
  // Accept executes immediately and success re-inspects the full scope, so the
  // preflight runs twice while the confirmation runs exactly once.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(preflight).toHaveBeenCalledExactlyOnceWith({
    depotPaths: ["//depot/a"],
  });
  const acceptSafe = [
    ...document.querySelectorAll<HTMLButtonElement>("dialog button"),
  ].find((button) => button.textContent?.includes("接受自动合并"))!;
  await act(async () => acceptSafe.click());
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(preflight).toHaveBeenCalledTimes(2);
  expect(confirm).toHaveBeenCalledExactlyOnceWith({
    operationId: expect.any(String),
    token: "resolve-token",
    target,
    resolutions: [{ depotPath: "//depot/a", strategy: "safe" }],
  });
});

it("file shelving no longer opens a preflight or confirm dialog", async () => {
  const depotNode = {
    ...node,
    depotPath: "//depot/a",
    state: "openedEdit" as const,
  };
  const change = {
    id: 10,
    description: "Shelf me",
    user: "tester",
    client: "workspace",
    status: "pending" as const,
    jobs: [],
    files: [
      { depotPath: "//depot/a", action: "edit", state: "openedEdit" as const },
    ],
    shelvedFiles: [],
  };
  vi.spyOn(backend, "queryPendingChanges").mockResolvedValue(
    pendingPage([change]),
  );
  const preflight = vi.spyOn(backend, "preflightShelf");
  await harness.render(<Harness />);
  await act(async () =>
    api.open({
      kind: "fileCl",
      nodes: [depotNode],
      mode: "shelve",
      source: null,
    }),
  );
  await act(async () => {
    await Promise.resolve();
  });
  // No FE preflight call and no shelf/confirm dialog; the host command owns its internal check.
  expect(preflight).not.toHaveBeenCalled();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});
