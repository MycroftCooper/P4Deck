// @vitest-environment jsdom
import { act } from "react";
import { expect, it, vi } from "vitest";
import { dialogHarness } from "../dialogs/testHarness";
import { CommandBar } from "./CommandBar";
import type { CommandId, CommandTarget } from "./commandPolicy";
import type { RuntimeInfo, WorkflowResult } from "../../shared/contracts";
import { writeSnapshot } from "../../shared/cache/snapshots";
import {
  pendingSnapshotKey,
  type PendingSnapshot,
} from "../../features/changelists/pendingCache";
import {
  projectRemovalChanges,
  shelfObservation,
  useRemovalActions,
} from "../../features/actions/shelfObservation";
const api = vi.hoisted(() => ({
  invoke: vi.fn(),
  confirm: vi.fn(),
  old: vi.fn(),
  connection: vi.fn(),
  invalidate: vi.fn(),
  listWorkspaceChildren: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: api.invoke,
  isTauri: () => false,
}));
vi.mock("../../infrastructure/backend", () => ({
  backend: {
    performFileAction: api.old,
    companySubmitConnectionSnapshot: api.connection,
    listWorkspaceChildren: api.listWorkspaceChildren,
    subscribeOperationEvents: async () => () => {},
  },
}));
vi.mock("../context-menu/ContextMenu", () => ({
  useContextMenu: () => vi.fn(),
}));
vi.mock("../context-menu/environment", () => ({
  useMenuEnvironment: () => ({
    preferences: { ui: { toolbarText: true } },
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
it.each([
  [false, false],
  [true, false],
  [false, true],
] as const)(
  "actual selected/whole-CL route projects before host completion (whole=%s, cancel=%s)",
  async (whole, cancel) => {
    const scope = `ui-revert-${++seq}`;
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
      state: "openedEdit" as const,
      changelistId: 11,
    };
    const target: CommandTarget = {
      type: "file",
      node,
      nodes: [node],
      ...(whole ? { wholeChangelistId: 11 } : {}),
    };
    const snapshot = {
      changes: [
        {
          id: 11,
          description: "fixture",
          user: "u",
          client: scope,
          status: "pending",
          jobs: [],
          files: [{ depotPath: "//fixture/a", action: "edit" }],
          shelvedFiles: [],
        },
      ],
      partial: false,
      stats: {
        scannedCount: 1,
        matchedCount: 1,
        truncatedBySafetyLimit: false,
      },
    } as PendingSnapshot;
    writeSnapshot(pendingSnapshotKey(runtime), snapshot);
    // Local facts: the single file is unmodified, so it may be hidden optimistically.
    api.listWorkspaceChildren.mockResolvedValue({
      items: [{ ...node, status: { local: "present" } }],
      completeness: "complete",
      errors: [],
      operationIds: [],
      truncated: false,
      safetyLimit: 500,
      cacheFreshness: "fresh",
    });
    let finish!: (v: WorkflowResult) => void;
    api.invoke.mockImplementation((command: string) =>
      command === "confirm_revert_action"
        ? new Promise((r) => (finish = r))
        : Promise.resolve("recorded"),
    );
    api.connection.mockResolvedValue({
      profileId: "p",
      generation: "1",
      server: "s",
      user: "u",
      client: scope,
    });
    api.confirm.mockResolvedValue(!cancel);
    api.invoke.mockClear();
    api.old.mockClear();
    api.invalidate.mockClear();
    let handler: ((id: CommandId, target?: CommandTarget) => void) | undefined;
    function View() {
      const records = useRemovalActions();
      const rows = projectRemovalChanges(
        "revert",
        snapshot.changes,
        scope,
        shelfObservation(runtime).version,
        records,
      );
      return (
        <>
          <div data-testid="files">
            {rows[0].files.map((f) => f.depotPath).join(",")}
          </div>
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
          />
        </>
      );
    }
    await h.render(<View />);
    await act(async () => {
      handler!("revert", target);
      // Local-status facts are read before the optimistic hide is claimed.
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(api.confirm).toHaveBeenCalled();
    if (cancel) {
      expect(api.invoke).not.toHaveBeenCalled();
      expect(document.querySelector('[data-testid="files"]')!.textContent).toBe(
        "//fixture/a",
      );
      return;
    }
    expect(document.querySelector('[data-testid="files"]')!.textContent).toBe(
      "",
    );
    expect(api.old).not.toHaveBeenCalled();
    expect(api.invalidate).not.toHaveBeenCalled();
    expect(api.invoke).toHaveBeenCalledWith(
      "confirm_revert_action",
      expect.objectContaining({
        request: expect.objectContaining({ paths: ["//fixture/a"] }),
      }),
    );
    await act(async () =>
      finish({
        outcome: "succeeded",
        message: "",
        operationIds: [],
        files: [{ depotPath: "//fixture/a", state: "succeeded", message: "" }],
        refresh: {
          pendingChanges: false,
          workspaceStatus: false,
          depotPaths: [],
          reason: "",
        },
      }),
    );
    expect(api.invalidate).not.toHaveBeenCalled();
  },
);
