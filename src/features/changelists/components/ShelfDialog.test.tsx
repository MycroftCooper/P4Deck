import {
  MenuEnvironment,
  type MenuEnvironmentValue,
} from "../../../app/context-menu/environment";
import type { ReactNode } from "react";
// @vitest-environment jsdom
import { act } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { dialogHarness, dialogButton } from "../../../app/dialogs/testHarness";
import {
  PreflightStatus,
  type PreflightState,
} from "../../../app/dialogs/PreflightStatus";
import type {
  PendingChange,
  UnshelvePreflight,
  WorkflowResult,
} from "../../../shared/contracts";
import { type ShelfRequest } from "./ShelfDialog";
import { UnshelveDialog } from "./UnshelveDialog";

const invalidateData = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("../../../shared/cache/dataEffects", () => ({ invalidateData }));
const connectionSnapshot = {
  profileId: "fixture",
  generation: "1",
  server: "server:1666",
  user: "tester",
  client: "workspace",
};
const provideConnection = async () => connectionSnapshot;
beforeEach(() => {
  invalidateData.mockClear();
  invalidateData.mockResolvedValue(undefined);
});
const reports = vi.fn();
const env = {
  runtime: {
    context: {
      server: "server:1666",
      user: "tester",
      client: "workspace",
      cwd: "/work",
    },
    contextGeneration: 1,
  },
  getOperationContext: () => ({
    connectionKey: "connection-a",
    runtime: env.runtime,
  }),
  reportOperationError: reports,
} as unknown as MenuEnvironmentValue;
const baseHarness = dialogHarness();
const harness = {
  render: (node: ReactNode) =>
    baseHarness.render(
      <MenuEnvironment.Provider value={env}>{node}</MenuEnvironment.Provider>,
    ),
};
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

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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
      connection={provideConnection}
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
  const confirmation = execute.mock.calls[0][0] as {
    token: string;
    target: typeof target & { client: string; targetChangeId: number };
    operationId: string;
  };
  expect(confirmation).toMatchObject({
    token: "unshelve-token",
    target: expect.objectContaining({
      client: "workspace-b",
      targetChangeId: 42,
    }),
  });
  expect(confirmation.operationId).toMatch(uuidPattern);
  expect(execute).toHaveBeenCalledOnce();
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
