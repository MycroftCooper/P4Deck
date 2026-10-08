// @vitest-environment jsdom
import { act } from "react";
import { expect, it, vi } from "vitest";
import {
  dialogHarness,
  dialogButton,
  chooseSelect,
} from "../../../app/dialogs/testHarness";
import {
  PreflightStatus,
  type PreflightState,
} from "../../../app/dialogs/PreflightStatus";
import type {
  PendingChange,
  ShelfPreflight,
  UnshelvePreflight,
  WorkflowResult,
} from "../../../shared/contracts/types";
import { ShelfDialog, type ShelfRequest } from "./ShelfDialog";
import { UnshelveDialog } from "./UnshelveDialog";

const harness = dialogHarness();
const request: ShelfRequest = {
  changeId: 10,
  paths: ["//depot/a"],
  mode: "shelve",
  hasShelf: true,
  source: null,
};
const change: PendingChange = {
  id: 10,
  description: "Source",
  user: "tester",
  client: "workspace",
  status: "pending",
  jobs: [],
  files: [{ depotPath: "//depot/a", action: "edit" }],
  shelvedFiles: [{ depotPath: "//depot/a", action: "edit" }],
};
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
const shelfCheck = (
  overrides: Partial<ShelfPreflight> = {},
): ShelfPreflight => ({
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
  token: "token",
  expiresAt: Date.now() + 60_000,
  ttlMs: 60_000,
  operationIds: ["preflight-op"],
  ...overrides,
});
const success = (message = "done"): WorkflowResult => ({
  outcome: "succeeded",
  message,
  operationIds: ["op-1"],
  logReference: "log-1",
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

it("executes first-time shelving only with a matching preflight token", async () => {
  const check = vi.fn().mockResolvedValue(shelfCheck());
  const execute = vi.fn().mockResolvedValue(success("Shelf created"));
  await harness.render(
    <ShelfDialog
      request={{ ...request, hasShelf: false }}
      connectionKey="connection-a"
      zh
      onDismiss={vi.fn()}
      check={check}
      execute={execute}
    />,
  );
  expect(dialogButton("确认搁置所选文件").disabled).toBe(true);
  await act(async () => dialogButton("运行预检").click());
  await act(async () => dialogButton("确认搁置所选文件").click());
  expect(check).toHaveBeenCalledExactlyOnceWith({
    changeId: 10,
    depotPaths: ["//depot/a"],
    mode: "createOrUpdate",
    replace: false,
  });
  expect(execute).toHaveBeenCalledExactlyOnceWith({
    token: "token",
    target,
  });
  expect(document.body.textContent).toContain("Shelf created");
  expect(document.body.textContent).toContain("操作记录 op-1");
});

it("requires explicit acknowledgement for replacement and resets stale checks", async () => {
  const check = vi.fn().mockResolvedValue(
    shelfCheck({
      scope: {
        ...shelfCheck().scope,
        createPaths: [],
        replacePaths: ["//depot/a"],
      },
    }),
  );
  await harness.render(
    <ShelfDialog
      request={request}
      connectionKey="connection-a"
      zh
      onDismiss={vi.fn()}
      check={check}
    />,
  );
  await chooseSelect("replace");
  await act(async () => dialogButton("运行预检").click());
  expect(document.body.textContent).toContain("替换 1");
  expect(dialogButton("确认搁置所选文件").disabled).toBe(true);
  await act(async () =>
    document.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click(),
  );
  expect(dialogButton("确认搁置所选文件").disabled).toBe(false);
  await chooseSelect("preserve");
  expect(document.body.textContent).toContain("尚未预检");
  expect(dialogButton("确认搁置所选文件").disabled).toBe(true);
});

it("deletes only the explicit shelf subset after dangerous confirmation", async () => {
  const check = vi.fn().mockResolvedValue(
    shelfCheck({
      scope: {
        ...shelfCheck().scope,
        createPaths: [],
        deletePaths: ["//depot/a"],
      },
    }),
  );
  const execute = vi.fn().mockResolvedValue(success("Deleted"));
  await harness.render(
    <ShelfDialog
      request={{ ...request, mode: "delete" }}
      connectionKey="connection-a"
      zh
      onDismiss={vi.fn()}
      check={check}
      execute={execute}
    />,
  );
  expect(document.body.textContent).toContain(
    "不会同时删除工作区文件或整个 CL",
  );
  await act(async () => dialogButton("运行预检").click());
  await act(async () =>
    document.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click(),
  );
  await act(async () => dialogButton("确认删除所选搁置版本").click());
  expect(check).toHaveBeenCalledWith(
    expect.objectContaining({ mode: "delete", depotPaths: ["//depot/a"] }),
  );
  expect(execute).toHaveBeenCalledOnce();
});

it("never executes an expired token or a preflight invalidated by connection drift", async () => {
  const execute = vi.fn().mockResolvedValue(success());
  const props = {
    request: { ...request, hasShelf: false },
    zh: true,
    onDismiss: vi.fn(),
    check: vi.fn().mockResolvedValue(shelfCheck({ expiresAt: Date.now() - 1 })),
    execute,
  };
  await harness.render(<ShelfDialog {...props} connectionKey="connection-a" />);
  await act(async () => dialogButton("运行预检").click());
  expect(document.body.textContent).toContain("预检已过期");
  expect(dialogButton("确认搁置所选文件").disabled).toBe(true);
  await harness.render(<ShelfDialog {...props} connectionKey="connection-b" />);
  expect(document.body.textContent).toContain("预检已过期");
  expect(execute).not.toHaveBeenCalled();
});

it("invalidates confirmation when the fixed source scope drifts", async () => {
  const execute = vi.fn().mockResolvedValue(success());
  const common = {
    connectionKey: "connection-a",
    zh: true,
    onDismiss: vi.fn(),
    check: vi.fn().mockResolvedValue(shelfCheck()),
    execute,
  };
  await harness.render(
    <ShelfDialog {...common} request={{ ...request, hasShelf: false }} />,
  );
  await act(async () => dialogButton("运行预检").click());
  expect(dialogButton("确认搁置所选文件").disabled).toBe(false);
  await harness.render(
    <ShelfDialog
      {...common}
      request={{ ...request, hasShelf: false, paths: ["//depot/b"] }}
    />,
  );
  expect(document.body.textContent).toContain("目标已改变");
  expect(dialogButton("确认搁置所选文件").disabled).toBe(true);
  expect(execute).not.toHaveBeenCalled();
});

it("drops an old preflight result after the connection changes", async () => {
  let finish!: (value: ShelfPreflight) => void;
  const check = vi.fn().mockReturnValue(
    new Promise<ShelfPreflight>((resolve) => {
      finish = resolve;
    }),
  );
  const props = {
    request: { ...request, hasShelf: false },
    zh: true,
    onDismiss: vi.fn(),
    check,
  };
  await harness.render(<ShelfDialog {...props} connectionKey="connection-a" />);
  await act(async () => dialogButton("运行预检").click());
  await harness.render(<ShelfDialog {...props} connectionKey="connection-b" />);
  await act(async () => finish(shelfCheck()));
  expect(document.body.textContent).toContain("目标已改变");
  expect(dialogButton("确认搁置所选文件").disabled).toBe(true);
});

const unshelveCheck = (
  targetWorkspace: string,
  targetChangeId: number,
): UnshelvePreflight => ({
  ready: true,
  source: change,
  targetChange: targetChangeId === 0 ? { ...change, id: 0 } : undefined,
  mappings: [
    {
      depotPath: "//depot/a",
      targetPath: `C:/${targetWorkspace}/a`,
      mapped: true,
      locallyModified: true,
      openedChangeId: 23,
      locked: true,
      resolveRisk: "likely",
    },
  ],
  blockers: [],
  warnings: [
    {
      code: "resolveLikely",
      certainty: "confirmed",
      message: "Resolve likely",
      paths: ["//depot/a"],
    },
  ],
  target: {
    ...target,
    kind: "unshelve",
    client: targetWorkspace,
    targetChangeId,
  },
  contentDigest: "digest",
  token: "unshelve-token",
  expiresAt: Date.now() + 60_000,
  ttlMs: 60_000,
  operationIds: [],
});

it("supports Default, numbered and cross-workspace unshelve with visible risks", async () => {
  const check = vi
    .fn()
    .mockImplementation(({ targetWorkspace, targetChangeId }) =>
      Promise.resolve(unshelveCheck(targetWorkspace, targetChangeId)),
    );
  const execute = vi.fn().mockResolvedValue(success("Unshelved"));
  await harness.render(
    <UnshelveDialog
      request={request}
      changes={[change]}
      currentWorkspace="workspace"
      connectionKey="connection-a"
      zh
      onDismiss={vi.fn()}
      loadWorkspaces={async () => [
        {
          name: "workspace",
          owner: "tester",
          host: "",
          root: "C:/workspace",
          stream: "",
          description: "",
          updated: null,
          accessed: null,
        },
        {
          name: "workspace-b",
          owner: "tester",
          host: "",
          root: "C:/workspace-b",
          stream: "",
          description: "",
          updated: null,
          accessed: null,
        },
      ]}
      check={check}
      execute={execute}
    />,
  );
  await act(async () => dialogButton("运行预检").click());
  expect(check).toHaveBeenLastCalledWith(
    expect.objectContaining({
      targetWorkspace: "workspace",
      targetChangeId: 0,
    }),
  );
  expect(document.body.textContent).toContain("本地修改");
  expect(document.body.textContent).toContain("已锁定");
  expect(document.body.textContent).toContain("Resolve 风险: likely");
  const workspace = document.querySelector<HTMLSelectElement>("dialog select")!;
  await act(async () => {
    workspace.value = "workspace-b";
    workspace.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await act(async () => {
    const input = document.querySelector<HTMLInputElement>(
      'input[type="number"]',
    )!;
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, "42");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(dialogButton("确认 Unshelve").disabled).toBe(true);
  await act(async () => dialogButton("运行预检").click());
  expect(check).toHaveBeenLastCalledWith(
    expect.objectContaining({
      targetWorkspace: "workspace-b",
      targetChangeId: 42,
    }),
  );
  expect(document.body.textContent).toContain("workspace-b · CL 42");
  await act(async () =>
    document.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click(),
  );
  await act(async () => dialogButton("确认 Unshelve").click());
  expect(execute).toHaveBeenCalledExactlyOnceWith({
    token: "unshelve-token",
    target: expect.objectContaining({
      client: "workspace-b",
      targetChangeId: 42,
    }),
  });
});

it("renders all shared preflight states with explicit status information", async () => {
  const states: PreflightState[] = [
    { kind: "unavailable" },
    { kind: "idle" },
    { kind: "checking" },
    { kind: "empty" },
    { kind: "stale" },
    { kind: "offline" },
    { kind: "failed", message: "network error" },
    { kind: "blocked", blockers: ["locked"], warnings: [] },
    { kind: "ready", blockers: [], warnings: ["resolve required"] },
  ];
  for (const state of states) {
    await harness.render(<PreflightStatus state={state} zh />);
    expect(document.querySelector("section")!.getAttribute("aria-busy")).toBe(
      String(state.kind === "checking"),
    );
  }
});
