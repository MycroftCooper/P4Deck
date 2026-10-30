// @vitest-environment jsdom
import { act } from "react";
import { expect, it, vi } from "vitest";
import { dialogHarness } from "../dialogs/testHarness";
import { CommandBar } from "./CommandBar";
import type { CommandId, CommandTarget } from "./commandPolicy";
import type { RuntimeInfo } from "../../shared/contracts";
import {
  resetLocalDeleteForTests,
  localDeleteSnapshot,
} from "../../features/actions/localDeleteTask";
const api = vi.hoisted(() => ({
  invoke: vi.fn(),
  confirm: vi.fn(),
  old: vi.fn(),
  cancel: vi.fn(),
  connection: vi.fn(),
  invalidate: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: api.invoke,
  isTauri: () => false,
}));
vi.mock("../../infrastructure/backend", () => ({
  backend: {
    performFileAction: api.old,
    cancelOperation: api.cancel,
    companySubmitConnectionSnapshot: api.connection,
    subscribeOperationEvents: async () => () => {},
  },
}));
vi.mock("../context-menu/ContextMenu", () => ({
  useContextMenu: () => vi.fn(),
}));
vi.mock("../context-menu/environment", () => ({
  useMenuEnvironment: () => ({
    preferences: { ui: { toolbarText: true, checkoutUseDefault: true } },
    openPage: vi.fn(),
  }),
}));
vi.mock("../dialogs/useCommandDialogs", () => ({
  useCommandDialogs: () => ({
    pending: false,
    element: null,
    confirm: api.confirm,
  }),
  refreshFileLockFacts: vi.fn(),
}));
vi.mock("./useLocalPathCapabilities", () => ({
  useLocalPathCapabilities: () => ({ reveal: false, openWith: false }),
}));
vi.mock("../../shared/cache/dataEffects", async (original) => ({
  ...(await original<typeof import("../../shared/cache/dataEffects")>()),
  invalidateData: api.invalidate,
}));
const h = dialogHarness();
let seq = 0;

it.each(["checkout", "add", "delete"] as const)(
  "actual %s entry uses shared lifecycle and no legacy refresh",
  async (action) => {
    const scope = `ui-generic-${++seq}`;
    const runtime = {
      mode: "mock",
      contextGeneration: 1,
      context: { server: "s", user: "u", client: scope },
      connection: { state: "connected" },
    } as RuntimeInfo;
    const node = {
      id: "a",
      name: "a",
      relativePath: "a",
      absolutePath: "C:/fixture/a",
      depotPath: "//fixture/a",
      kind: "file" as const,
      state:
        action === "add" ? ("untracked" as const) : ("controlled" as const),
      changelistId: 11,
    };
    const target: CommandTarget = { type: "file", node, nodes: [node] };
    api.confirm.mockResolvedValue(true);
    api.old.mockClear();
    api.invalidate.mockClear();
    api.connection.mockResolvedValue({
      profileId: "p",
      generation: "1",
      server: "s",
      user: "u",
      client: scope,
    });
    let finish!: (
      value: import("../../shared/contracts").FileActionResult,
    ) => void;
    api.old.mockReturnValue(new Promise((r) => (finish = r)));
    let handler: ((id: CommandId, target?: CommandTarget) => void) | undefined;
    await h.render(
      <CommandBar
        runtime={runtime}
        zh={false}
        connectionKey={scope}
        target={target}
        targetError=""
        onBusyChange={vi.fn()}
        onOpenOperations={vi.fn()}
        registerCommand={(h) => (handler = h)}
        onNavigate={vi.fn()}
        onFocus={vi.fn()}
        onReview={vi.fn()}
      />,
    );
    await act(async () => {
      handler!(action, target);
      await Promise.resolve();
    });
    expect(api.old).toHaveBeenCalledOnce();
    const [request, connection] = api.old.mock.calls[0];
    expect(connection).toMatchObject({ generation: "1", client: scope });
    expect(request.action).toBe(action === "delete" ? "markForDelete" : action);
    expect(api.invalidate).not.toHaveBeenCalled();
    await act(async () =>
      finish({
        message: "",
        affectedPaths: request.paths,
        execution: {
          operationId: request.operationId,
          outcome: "commandCompleted",
          perFileEvidence: "notCollected",
        },
      }),
    );
    expect(api.invalidate).toHaveBeenCalledTimes(1);
    expect(api.invalidate.mock.calls[0][0]).not.toContain("pending");
  },
);
it("untracked delete uses deleteLocal and the existing cancel command reaches cancel_operation with the same id", async () => {
  resetLocalDeleteForTests();
  const scope = `ui-local-${++seq}`;
  const runtime = {
    mode: "mock",
    contextGeneration: 1,
    context: { server: "s", user: "u", client: scope },
    connection: { state: "connected" },
  } as RuntimeInfo;
  const node = {
    id: "a",
    name: "a",
    relativePath: "a",
    absolutePath: "C:/fixture/a",
    kind: "file" as const,
    state: "untracked" as const,
  };
  const target: CommandTarget = { type: "file", node, nodes: [node] };
  api.confirm.mockResolvedValue(true);
  api.old.mockClear();
  api.cancel.mockClear();
  api.connection.mockResolvedValue({
    profileId: "p",
    generation: "1",
    server: "s",
    user: "u",
    client: scope,
  });
  let finish!: (
    value: import("../../shared/contracts").FileActionResult,
  ) => void;
  api.old.mockReturnValue(new Promise((r) => (finish = r)));
  let handler: ((id: CommandId, target?: CommandTarget) => void) | undefined;
  await h.render(
    <CommandBar
      runtime={runtime}
      zh={false}
      connectionKey={scope}
      target={target}
      targetError=""
      onBusyChange={vi.fn()}
      onOpenOperations={vi.fn()}
      registerCommand={(fn) => (handler = fn)}
      onNavigate={vi.fn()}
      onFocus={vi.fn()}
      onReview={vi.fn()}
    />,
  );
  await act(async () => {
    handler!("delete", target);
    await Promise.resolve();
  });
  for (let i = 0; i < 6; i++)
    await act(async () => {
      await Promise.resolve();
    });
  expect(localDeleteSnapshot()).toHaveLength(1);
  expect(api.old).toHaveBeenCalledOnce();
  const [request, connection] = api.old.mock.calls[0];
  expect(request.action).toBe("deleteLocal");
  expect(request.paths).toEqual(["C:/fixture/a"]);
  expect(connection).toMatchObject({ generation: "1", client: scope });
  expect(api.cancel).not.toHaveBeenCalled();
  await act(async () => {
    handler!("cancel");
    await Promise.resolve();
  });
  expect(api.cancel).toHaveBeenCalledExactlyOnceWith(request.operationId);
  expect(api.old).toHaveBeenCalledOnce();
  await act(async () =>
    finish({
      affectedPaths: request.paths,
      message: "Local batch was not dispatched",
      execution: {
        operationId: request.operationId,
        outcome: "notDispatched",
        perFileEvidence: "localIoAcknowledgements",
        files: [{ depotPath: "C:/fixture/a", state: "blocked", message: "" }],
      },
    }),
  );
  expect(api.old).toHaveBeenCalledOnce();
  expect(api.cancel).toHaveBeenCalledExactlyOnceWith(request.operationId);
});
