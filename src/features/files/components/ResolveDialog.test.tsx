// @vitest-environment jsdom
import { StrictMode, act } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { dialogHarness } from "../../../app/dialogs/testHarness";
import { backend } from "../../../infrastructure/backend";
import { ResolveDialog } from "./ResolveDialog";
import type {
  ResolveConflictDetail,
  ResolvePreflight,
  WorkflowResult,
  WorkspaceNode,
} from "../../../shared/contracts";

vi.mock("../../changelists/workflowRefresh", () => ({
  publishWorkflowResult: vi.fn(async () => undefined),
}));
vi.mock("./ManualMergeEditor", () => ({
  ManualMergeEditor: ({ depotPath }: { depotPath: string }) => (
    <div data-testid="manual-editor">{depotPath}</div>
  ),
}));

const harness = dialogHarness();
const nodes: WorkspaceNode[] = ["a", "b", "c"].map((name) => ({
  id: name,
  name,
  kind: "file",
  state: "conflicted",
  absolutePath: `/workspace/${name}`,
  relativePath: name,
  depotPath: `//depot/${name}`,
}));
const conflict = (
  name: string,
  overrides: Partial<ResolveConflictDetail> = {},
): ResolveConflictDetail => ({
  depotPath: `//depot/${name}`,
  clientPath: `/workspace/${name}`,
  conflictType: "content",
  status: "unresolved",
  availableStrategies: ["safe", "acceptTheirs", "acceptYours", "mergePreview"],
  sources: [
    {
      role: "base",
      depotPath: `//depot/${name}`,
      revision: 1,
      description: "base",
    },
    { role: "yours", description: "workspace" },
    {
      role: "theirs",
      depotPath: `//depot/${name}`,
      revision: 2,
      description: "incoming",
    },
    { role: "merge", description: "" },
  ],
  preview: ["content conflict"],
  ...overrides,
});
const preflight = (
  conflicts: ResolveConflictDetail[],
  overrides: Partial<ResolvePreflight> = {},
): ResolvePreflight => ({
  ready: true,
  conflicts,
  blockers: [],
  warnings: [],
  target: {
    kind: "resolve",
    server: "server:1666",
    user: "tester",
    client: "workspace",
    workspace: "/workspace",
    contextGeneration: 1,
    depotPaths: nodes.map((node) => node.depotPath!),
  },
  contentDigest: "digest",
  token: "resolve-token",
  expiresAt: Date.now() + 60_000,
  ttlMs: 60_000,
  operationIds: [],
  ...overrides,
});
const legacyResult = (
  outcome: WorkflowResult["outcome"],
  files: Array<{
    depotPath: string;
    state: WorkflowResult["files"][number]["state"];
  }>,
): WorkflowResult => ({
  outcome,
  message: `${outcome} result`,
  operationIds: ["resolve-1"],
  logReference: "resolve-log",
  files: files.map((file) => ({
    ...file,
    message:
      file.state === "succeeded" ? "verified resolved" : "remains unresolved",
  })),
  refresh: {
    pendingChanges: true,
    workspaceStatus: true,
    depotPaths: files.map((file) => file.depotPath),
    reason: "refresh conflicts",
  },
});

const action = (label: string) => {
  const button = [
    ...document.querySelectorAll<HTMLButtonElement>(
      ".resolve-action-row button",
    ),
  ].find((candidate) => candidate.textContent?.trim().startsWith(label));
  if (!button) throw new Error(`action button not found: ${label}`);
  return button;
};
const fileRow = (label: string) => {
  const name = label.split(/[\\/]/).pop() ?? label;
  const row = [
    ...document.querySelectorAll<HTMLButtonElement>(".resolve-list-copy"),
  ].find(
    (candidate) =>
      candidate.textContent?.includes(label) ||
      candidate.textContent?.includes(name),
  );
  if (!row) throw new Error(`file row not found: ${label}`);
  return row;
};
const currentRow = () =>
  document.querySelector<HTMLElement>(".resolve-list-item.is-current");
async function flush() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

afterEach(() => {
  vi.useRealTimers();
});

it("keep-source resolves the current file, re-inspects and advances", async () => {
  const check = vi
    .fn()
    .mockResolvedValueOnce(preflight([conflict("a"), conflict("b")]))
    .mockResolvedValueOnce(preflight([conflict("b")]));
  const execute = vi
    .fn()
    .mockResolvedValueOnce(
      legacyResult("succeeded", [
        { depotPath: "//depot/a", state: "succeeded" },
      ]),
    );
  await harness.render(
    <ResolveDialog
      nodes={nodes}
      source={null}
      connectionKey="connection-a"
      zh
      onDismiss={vi.fn()}
      check={check}
      execute={execute}
    />,
  );
  await flush();
  expect(check).toHaveBeenCalledOnce();
  expect(currentRow()?.textContent?.startsWith("a")).toBe(true);
  expect(document.body.textContent).toContain("待处理 2 · 已解决 0");
  await act(async () => action("保留来源").click());
  await flush();
  expect(execute).toHaveBeenCalledExactlyOnceWith({
    token: "resolve-token",
    target: expect.objectContaining({ kind: "resolve" }),
    operationId: expect.any(String),
    resolutions: [{ depotPath: "//depot/a", strategy: "acceptTheirs" }],
  });
  // Success re-inspects the whole scope and selects the next unresolved file.
  expect(check).toHaveBeenCalledTimes(2);
  expect(currentRow()?.textContent?.startsWith("b")).toBe(true);
  expect(document.body.textContent).toContain("待处理 1 · 已解决 1");
});

it("clean file shows no-conflict empty state without requesting attention", async () => {
  const notices: CustomEvent[] = [];
  const listener = (event: Event) => notices.push(event as CustomEvent);
  window.addEventListener("p4deck:desktop-notice", listener);
  try {
    await harness.render(
      <ResolveDialog
        nodes={nodes}
        source={null}
        connectionKey="connection-a"
        zh
        onDismiss={vi.fn()}
        check={async () =>
          preflight([], {
            warnings: [
              {
                code: "notResolvable",
                certainty: "confirmed",
                message:
                  "The file has no unresolved integration record; nothing to resolve.",
                paths: ["//depot/a"],
              },
            ],
          })
        }
      />,
    );
    await flush();
    const text = document.body.textContent ?? "";
    expect(text).toContain("没有冲突");
    expect(text).toContain("所选文件没有待解决的冲突。");
    expect(text).toContain("待处理 0 · 已解决 0");
    expect(text).not.toContain("需手工处理");
    expect(text).not.toContain("保留双方修改");
    expect(text).not.toContain("需要选择保留一侧");
    expect(text).not.toContain("没有待处理的文件");
    expect(
      document.querySelector<HTMLInputElement>(
        ".resolve-sidebar-head input[type='checkbox']",
      )!.disabled,
    ).toBe(true);
    // Opening a clean file must not ask for desktop attention.
    expect(notices).toHaveLength(0);
  } finally {
    window.removeEventListener("p4deck:desktop-notice", listener);
  }
});

it("re-resolves already resolved files with force and warns before overwriting", async () => {
  const resolvedNodes: WorkspaceNode[] = nodes.map((node) => ({
    ...node,
    state: "openedEdit",
    status: {
      primary: "openedEdit",
      sync: "current",
      resolve: "resolved",
      local: "present",
      completeness: "complete",
      evidence: [],
      errors: [],
    },
  }));
  const check = vi.fn().mockResolvedValue(preflight([conflict("a")]));
  const stats = vi.fn().mockResolvedValue({ base: {}, source: {}, target: {} });
  await harness.render(
    <ResolveDialog
      nodes={resolvedNodes}
      source={null}
      connectionKey="connection-a"
      zh
      onDismiss={vi.fn()}
      check={check}
      resolveStats={stats}
    />,
  );
  await flush();
  // Already resolved, nothing unresolved: the whole dialog runs in force mode.
  expect(check).toHaveBeenCalledWith({
    depotPaths: ["//depot/a", "//depot/b", "//depot/c"],
    force: true,
  });
  expect(stats.mock.calls[0][0]).toMatchObject({
    depotPath: "//depot/a",
    force: true,
  });
  const text = document.body.textContent ?? "";
  expect(text).toContain("重新解决");
  expect(text).toContain("p4 resolve -f");
  expect(text).toContain("revert");
  // The force preflight still returns ordinary unresolved conflicts, so the
  // existing strategy buttons stay usable.
  expect(action("保留来源").disabled).toBe(false);
  expect(action("保留本地").disabled).toBe(false);
});

it("completes the initial inspection under React StrictMode", async () => {
  const check = vi.fn().mockResolvedValue(preflight([conflict("a")]));
  await harness.render(
    <StrictMode>
      <ResolveDialog
        nodes={nodes}
        source={null}
        connectionKey="connection-a"
        zh
        onDismiss={vi.fn()}
        check={check}
      />
    </StrictMode>,
  );
  await flush();
  expect(check.mock.calls.length).toBeGreaterThanOrEqual(2);
  expect(document.body.textContent).not.toContain("正在预检，请稍候");
  expect(currentRow()?.textContent?.startsWith("a")).toBe(true);
});

it("times out a hanging inspection and keeps the dialog operable", async () => {
  vi.useFakeTimers();
  await harness.render(
    <ResolveDialog
      nodes={nodes}
      source={null}
      connectionKey="connection-a"
      zh
      onDismiss={vi.fn()}
      check={() => new Promise(() => undefined)}
    />,
  );
  await act(async () => {
    await Promise.resolve();
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30_000);
  });
  expect(document.body.textContent).toContain("超时");
  expect(document.body.textContent).not.toContain("正在预检，请稍候");
  const footerLabels = [
    ...document.querySelectorAll<HTMLButtonElement>("dialog button"),
  ].map((button) => button.textContent?.trim());
  expect(footerLabels).not.toContain("关闭");
  expect(footerLabels).not.toContain("读取冲突");
});

it("blocked files are not executable but other unresolved files stay actionable", async () => {
  const check = vi
    .fn()
    .mockResolvedValue(
      preflight([
        conflict("a", { status: "blocked", availableStrategies: [] }),
        conflict("b"),
      ]),
    );
  await harness.render(
    <ResolveDialog
      nodes={nodes}
      source={null}
      connectionKey="connection-a"
      zh
      onDismiss={vi.fn()}
      check={check}
    />,
  );
  await flush();
  expect(action("保留来源").disabled).toBe(true);
  await act(async () => fileRow("/workspace/b").click());
  expect(action("保留来源").disabled).toBe(false);
});

it("keeps partial or unknown outcomes visible and never presents success", async () => {
  const check = vi.fn().mockResolvedValue(preflight([conflict("a")]));
  const execute = vi
    .fn()
    .mockResolvedValueOnce(
      legacyResult("partial", [{ depotPath: "//depot/a", state: "unknown" }]),
    );
  await harness.render(
    <ResolveDialog
      nodes={nodes}
      source={null}
      connectionKey="connection-a"
      zh
      onDismiss={vi.fn()}
      check={check}
      execute={execute}
    />,
  );
  await flush();
  await act(async () => action("保留来源").click());
  await flush();
  expect(document.body.textContent).toContain("结果：partial");
  expect(document.body.textContent).toContain("unknown · //depot/a");
  expect(document.body.textContent).not.toContain("verified resolved");
  expect(check).toHaveBeenCalledOnce();
});

it("opens P4Merge directly instead of the in-app editor", async () => {
  const open = vi
    .spyOn(backend, "openManualMerge")
    .mockRejectedValueOnce(new Error("P4Merge is not installed"));
  await harness.render(
    <ResolveDialog
      nodes={nodes}
      source={null}
      connectionKey="connection-a"
      zh
      onDismiss={vi.fn()}
      check={async () => preflight([conflict("a")])}
    />,
  );
  await flush();
  await act(async () => action("打开 P4Merge").click());
  await flush();
  expect(open).toHaveBeenCalledOnce();
  expect(document.body.textContent).toContain("P4Merge is not installed");
});

it("has no footer action buttons or discarded-plan state", async () => {
  await harness.render(
    <ResolveDialog
      nodes={nodes}
      source={null}
      connectionKey="connection-a"
      zh
      onDismiss={vi.fn()}
      check={async () => preflight([conflict("a")])}
    />,
  );
  await flush();
  const footerLabels = [
    ...document.querySelectorAll<HTMLButtonElement>("dialog button"),
  ].map((button) => button.textContent?.trim());
  expect(footerLabels).not.toContain("关闭");
  expect(footerLabels).not.toContain("读取冲突");
  expect(document.querySelector(".workflow-discard")).toBeNull();
});

const deferredStats = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
};

it("fills the version panes with host stats", async () => {
  const resolveStats = vi.fn().mockResolvedValue({
    base: {
      depotPath: "//depot/a",
      revision: 2,
      change: 41,
      user: "alice",
      time: "2026-10-31T10:20:30Z",
      description: "base commit",
    },
    source: {
      depotPath: "//depot/a",
      revision: 3,
      change: 42,
      user: "bob",
      time: "2026-10-31T11:00:00Z",
      description: "incoming commit",
      diffBlocks: 2,
    },
    target: { path: "/workspace/a", baseRevision: 2, diffBlocks: 4 },
    conflicts: 3,
  });
  await harness.render(
    <ResolveDialog
      nodes={nodes}
      source={null}
      connectionKey="connection-a"
      zh
      onDismiss={vi.fn()}
      check={async () => preflight([conflict("a")])}
      resolveStats={resolveStats}
    />,
  );
  await flush();
  expect(resolveStats).toHaveBeenCalledWith({
    depotPath: "//depot/a",
    baseDepotPath: "//depot/a",
    baseRevision: 1,
    sourceDepotPath: "//depot/a",
    sourceRevision: 2,
    targetPath: "/workspace/a",
  });
  const text = document.body.textContent;
  expect(text).toContain("#2 · CL 41");
  expect(text).toContain("alice");
  expect(text).toContain("时间:");
  expect(text).toContain("base commit");
  expect(text).toContain("与 base 差异块：2");
  expect(text).toContain("与 base 差异块：4");
  expect(text).toContain("工作区修改 · 基于 #2");
  expect(text).toContain("3 个冲突块");
  expect(text).toContain("仍有冲突");
  expect(text).not.toContain("0 个冲突块");
});

it("keeps placeholders when the host returns empty stats", async () => {
  const resolveStats = vi
    .fn()
    .mockResolvedValue({ base: {}, source: {}, target: {} });
  await harness.render(
    <ResolveDialog
      nodes={nodes}
      source={null}
      connectionKey="connection-a"
      zh
      onDismiss={vi.fn()}
      check={async () => preflight([conflict("a")])}
      resolveStats={resolveStats}
    />,
  );
  await flush();
  const text = document.body.textContent;
  expect(text).toContain("未返回");
  expect(text).toContain("待统计");
  expect(text).not.toContain("NaN");
});

it("ignores a late stats response after switching files", async () => {
  const first = deferredStats<{
    base: Record<string, never>;
    source: { description?: string };
    target: Record<string, never>;
  }>();
  const second = deferredStats<{
    base: Record<string, never>;
    source: { description?: string };
    target: Record<string, never>;
  }>();
  const resolveStats = vi
    .fn()
    .mockImplementationOnce(() => first.promise)
    .mockImplementationOnce(() => second.promise);
  await harness.render(
    <ResolveDialog
      nodes={nodes}
      source={null}
      connectionKey="connection-a"
      zh
      onDismiss={vi.fn()}
      check={async () => preflight([conflict("a"), conflict("b")])}
      resolveStats={
        resolveStats as unknown as (
          request: import("../../../shared/contracts").ResolveStatsRequest,
        ) => Promise<import("../../../shared/contracts").ResolveStats>
      }
    />,
  );
  await flush();
  expect(resolveStats).toHaveBeenCalledTimes(1);
  await act(async () => fileRow("/workspace/b").click());
  await flush();
  expect(resolveStats).toHaveBeenCalledTimes(2);
  expect(resolveStats.mock.calls[1][0]).toMatchObject({
    depotPath: "//depot/b",
  });
  await act(async () => {
    second.resolve({
      base: {},
      source: { description: "b stats" },
      target: {},
    });
    await Promise.resolve();
  });
  expect(document.body.textContent).toContain("b stats");
  await act(async () => {
    first.resolve({ base: {}, source: { description: "a stats" }, target: {} });
    await Promise.resolve();
  });
  expect(document.body.textContent).toContain("b stats");
  expect(document.body.textContent).not.toContain("a stats");
});
