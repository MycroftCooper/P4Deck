// @vitest-environment jsdom
import { act } from "react";
import { expect, it, vi } from "vitest";
import {
  dialogHarness,
  dialogButton,
  chooseSelect,
} from "../../../app/dialogs/testHarness";
import { ResolveDialog } from "./ResolveDialog";
import type {
  ResolveConflictDetail,
  ResolvePreflight,
  WorkflowResult,
  WorkspaceNode,
} from "../../../shared/contracts/types";

const harness = dialogHarness();
const nodes: WorkspaceNode[] = ["a", "b"].map((name) => ({
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
  availableStrategies: ["safe", "acceptYours", "mergePreview"],
  sources: [
    {
      role: "base",
      depotPath: `//depot/${name}`,
      revision: 1,
      description: "base",
    },
    {
      role: "yours",
      description: "workspace",
    },
    {
      role: "theirs",
      revision: 2,
      description: "incoming",
    },
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
const result = (
  outcome: WorkflowResult["outcome"],
  states: Array<WorkflowResult["files"][number]["state"]>,
): WorkflowResult => ({
  outcome,
  message: `${outcome} result`,
  operationIds: ["resolve-1", "resolve-2"],
  logReference: "resolve-log",
  files: states.map((state, index) => ({
    depotPath: nodes[index].depotPath!,
    state,
    message: state === "succeeded" ? "verified resolved" : "remains unresolved",
  })),
  refresh: {
    pendingChanges: true,
    workspaceStatus: true,
    depotPaths: nodes.map((node) => node.depotPath!),
    reason: "refresh conflicts",
  },
});

it("shows only backend-approved executable strategies and executes each file", async () => {
  const check = vi
    .fn()
    .mockResolvedValue(preflight([conflict("a"), conflict("b")]));
  const execute = vi
    .fn()
    .mockResolvedValue(result("succeeded", ["succeeded", "succeeded"]));
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
  await act(async () => dialogButton("检查冲突").click());
  const optionValues = [
    ...document.querySelectorAll<HTMLOptionElement>("dialog option"),
  ].map((option) => option.value);
  expect(optionValues).toEqual(["", "safe", "acceptYours"]);
  await chooseSelect("safe");
  await act(async () => dialogButton("下一项").click());
  await chooseSelect("acceptYours");
  await act(async () => dialogButton("执行逐文件计划").click());
  expect(execute).toHaveBeenCalledExactlyOnceWith({
    token: "resolve-token",
    target: expect.objectContaining({ kind: "resolve" }),
    resolutions: [
      { depotPath: "//depot/a", strategy: "safe" },
      { depotPath: "//depot/b", strategy: "acceptYours" },
    ],
  });
  expect(document.body.textContent).toContain("verified resolved");
  expect(document.body.textContent).toContain("操作记录 resolve-1, resolve-2");
});

it("keeps blocked and unknown conflicts non-executable", async () => {
  const check = vi.fn().mockResolvedValue(
    preflight(
      [
        conflict("a", { status: "blocked", availableStrategies: [] }),
        conflict("b", {
          status: "unknown",
          conflictType: "unknown",
          availableStrategies: ["mergePreview"],
        }),
      ],
      { ready: false, token: undefined },
    ),
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
  await act(async () => dialogButton("检查冲突").click());
  expect(document.body.textContent).toContain("后端标记为阻塞");
  expect(document.body.textContent).toContain("没有后端允许的可执行策略");
  expect(dialogButton("执行逐文件计划").disabled).toBe(true);
  await act(async () => dialogButton("下一项").click());
  expect(document.body.textContent).toContain("冲突状态未知");
  expect(dialogButton("执行逐文件计划").disabled).toBe(true);
});

it("does not present partial or post-verification unknown outcomes as success", async () => {
  const execute = vi
    .fn()
    .mockResolvedValue(result("partial", ["succeeded", "unknown"]));
  await harness.render(
    <ResolveDialog
      nodes={nodes}
      source={null}
      connectionKey="connection-a"
      zh
      onDismiss={vi.fn()}
      check={async () => preflight([conflict("a"), conflict("b")])}
      execute={execute}
    />,
  );
  await act(async () => dialogButton("检查冲突").click());
  await chooseSelect("safe");
  await act(async () => dialogButton("下一项").click());
  await chooseSelect("safe");
  await act(async () => dialogButton("执行逐文件计划").click());
  expect(document.body.textContent).toContain("结果：partial");
  expect(document.body.textContent).toContain("unknown · //depot/b");
  expect(document.body.textContent).toContain("remains unresolved");
  expect(dialogButton("执行逐文件计划").disabled).toBe(true);
});

it("prevents duplicate execution and protects an unexecuted plan on close", async () => {
  let finish!: (value: WorkflowResult) => void;
  const execute = vi.fn().mockReturnValue(
    new Promise<WorkflowResult>((resolve) => {
      finish = resolve;
    }),
  );
  const close = vi.fn();
  await harness.render(
    <ResolveDialog
      nodes={[nodes[0]]}
      source={null}
      connectionKey="connection-a"
      zh
      onDismiss={close}
      check={async () =>
        preflight([conflict("a")], {
          target: {
            ...preflight([]).target,
            depotPaths: ["//depot/a"],
          },
        })
      }
      execute={execute}
    />,
  );
  await act(async () => dialogButton("检查冲突").click());
  await chooseSelect("safe");
  await act(async () => dialogButton("关闭").click());
  expect(close).not.toHaveBeenCalled();
  await act(async () => dialogButton("继续编辑").click());
  await act(async () => {
    dialogButton("执行逐文件计划").click();
    dialogButton("执行逐文件计划").click();
  });
  expect(execute).toHaveBeenCalledOnce();
  expect(dialogButton("关闭").disabled).toBe(true);
  await act(async () => finish(result("succeeded", ["succeeded"])));
});
