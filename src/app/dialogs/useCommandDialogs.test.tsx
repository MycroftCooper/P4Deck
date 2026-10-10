// @vitest-environment jsdom
import { act } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { dialogHarness, dialogButton, chooseSelect } from "./testHarness";
import {
  refreshForceUnlockFacts,
  useCommandDialogs,
} from "./useCommandDialogs";
import type {
  PendingChange,
  PendingChangePage,
  WorkspaceNode,
} from "../../shared/contracts/types";
import { backend } from "../../infrastructure/backend";
import { workspaceCache } from "../../features/files/workspaceQueries";
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

it("reloads cached workspace and depot lock facts after force unlock", async () => {
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

  await refreshForceUnlockFacts("scope");

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
  const confirm = vi.spyOn(backend, "confirmSubmit").mockResolvedValue({
    outcome: "submitted",
    changeId: 10,
    message: "Submitted",
    refresh: {
      pendingChanges: true,
      submittedChanges: true,
      workspaceStatus: true,
      depotPaths: ["//depot/a"],
      reason: "refresh",
    },
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
  expect(confirm).toHaveBeenCalledExactlyOnceWith({
    token: "token",
    target: expect.objectContaining({ changeId: 10 }),
  });
  expect(document.body.textContent).toContain("Submitted");
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
  await act(async () => dialogButton("检查冲突").click());
  await chooseSelect("safe");
  await act(async () => dialogButton("执行逐文件计划").click());
  expect(preflight).toHaveBeenCalledExactlyOnceWith({
    depotPaths: ["//depot/a"],
  });
  expect(confirm).toHaveBeenCalledExactlyOnceWith({
    token: "resolve-token",
    target,
    resolutions: [{ depotPath: "//depot/a", strategy: "safe" }],
  });
});

it("connects file shelving requests through FileClWorkflow to the typed workflow", async () => {
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
  const target = {
    kind: "shelf" as const,
    server: "server:1666",
    user: "tester",
    client: "workspace",
    workspace: "/work",
    contextGeneration: 1,
    sourceChangeId: 10,
    depotPaths: ["//depot/a"],
  };
  const preflight = vi.spyOn(backend, "preflightShelf").mockResolvedValue({
    ready: true,
    change,
    blockers: [],
    warnings: [],
    target,
    scope: {
      openedPaths: ["//depot/a"],
      existingShelvedPaths: [],
      createPaths: ["//depot/a"],
      replacePaths: [],
      deletePaths: [],
      contentDigest: "digest",
    },
    token: "shelf-token",
    expiresAt: Date.now() + 60_000,
    ttlMs: 60_000,
    operationIds: [],
  });
  const confirm = vi.spyOn(backend, "confirmShelf").mockResolvedValue({
    outcome: "succeeded",
    message: "Shelved",
    operationIds: ["shelf-op"],
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
    api.open({
      kind: "fileCl",
      nodes: [depotNode],
      mode: "shelve",
      source: null,
    }),
  );
  await act(async () => dialogButton("运行预检").click());
  await act(async () => dialogButton("确认搁置所选文件").click());
  expect(preflight).toHaveBeenCalledExactlyOnceWith({
    changeId: 10,
    depotPaths: ["//depot/a"],
    mode: "createOrUpdate",
    replace: false,
  });
  expect(confirm).toHaveBeenCalledExactlyOnceWith({
    token: "shelf-token",
    target,
  });
});
