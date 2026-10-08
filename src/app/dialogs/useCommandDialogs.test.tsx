// @vitest-environment jsdom
import { act } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { dialogHarness, dialogButton } from "./testHarness";
import { useCommandDialogs } from "./useCommandDialogs";
import type { WorkspaceNode } from "../../shared/contracts/types";
import { backend } from "../../infrastructure/backend";
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
function Harness({ scope = "a" }: { scope?: string }) {
  api = useCommandDialogs(scope, "workspace", true);
  return api.element;
}
afterEach(() => vi.restoreAllMocks());
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
  vi.spyOn(backend, "queryPendingChanges").mockResolvedValue([change]);
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
