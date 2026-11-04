import { recordFrontendOperationLog } from "../../../infrastructure/backend/frontendOperationLog";
vi.mock("../../../infrastructure/backend/frontendOperationLog", () => ({
  recordFrontendOperationLog: vi.fn(async () => ({ status: "recorded" })),
}));
import { startOptimisticMove } from "../moveOptimism";
import type { SelectedMoveReceipt } from "../selectedMove";
// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ContextMenuProvider } from "../../../app/context-menu/ContextMenu";
import {
  MenuEnvironment,
  type MenuEnvironmentValue,
} from "../../../app/context-menu/environment";
import { defaultUi } from "../../settings/preferences";
import type {
  PendingChange,
  PendingChangePage,
  RuntimeInfo,
} from "../../../shared/contracts";
import { activateLocale, messages } from "../../../shared/i18n";
import { PendingPage } from "./PendingPage";
import { CommandExecutionContext } from "../../../app/shell/CommandContext";
import { workspaceCache } from "../../files/workspaceQueries";
import { pendingSnapshotKey, usePendingCacheSync } from "../pendingCache";
import { writeSnapshot } from "../../../shared/cache/snapshots";
import { PageHeaderActionsContext } from "../../../app/docking/chrome";

const backend = vi.hoisted(() => ({
  queryPendingChanges: vi.fn(),
  companySubmitConnectionSnapshot: vi.fn(),
  selectedMoveExecute: vi.fn(),
  selectedMoveStatus: vi.fn(),
  cancelOperation: vi.fn().mockResolvedValue(undefined),
  mutatePendingChange: vi.fn(),
  localPathCapabilities: vi.fn(),
}));
vi.mock("../../../infrastructure/backend", () => ({ backend }));

const runtime: RuntimeInfo = {
  mode: "tauri",
  p4Version: "P4/TEST",
  contextGeneration: 1,
  context: { server: "fixture:1666", user: "tester", client: "workspace" },
  connection: {
    state: "connected",
    message: "connected",
    recovery: "none",
    server: "fixture:1666",
  },
};
const change: PendingChange = {
  id: 202,
  description: "Search target",
  user: "tester",
  client: "workspace",
  status: "pending",
  jobs: [],
  files: [],
  shelvedFiles: [],
};

let host: HTMLDivElement;
let root: Root;

/** App mounts this owner once; it turns refresh events into snapshot reads. */
function PendingSync() {
  usePendingCacheSync(runtime, "fixture");
  return null;
}

function environment(): MenuEnvironmentValue {
  return {
    runtime,
    connectionKey: "fixture",
    commandBusy: false,
    openPage: vi.fn(),
    searchInDirectory: vi.fn(),
    navigate: vi.fn(),
    openFilePage: vi.fn(),
    preferences: {
      locale: "en-US",
      setLocale: vi.fn(),
      theme: "light",
      setTheme: vi.fn(),
      ui: defaultUi,
      setUi: vi.fn(),
      t: messages["en-US"],
      zh: false,
    },
  };
}

beforeEach(() => {
  // This suite renders the English UI; align the module resolver.
  activateLocale("en-US");
  workspaceCache.clear();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  backend.queryPendingChanges.mockReset();
  localStorage.removeItem("p4deck.pending-filter.v1");
  backend.queryPendingChanges.mockImplementation((query) =>
    Promise.resolve({
      requestGeneration: query.requestGeneration,
      defaultChange: undefined,
      items: [change],
      hasMore: false,
      partial: false,
      stats: {
        scannedCount: 1,
        matchedCount: 1,
        truncatedBySafetyLimit: false,
      },
    }),
  );
  backend.localPathCapabilities.mockResolvedValue({
    reveal: false,
    openWith: false,
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

it("toggles numeric CL order locally, retaining Default and the saved choice after remount", async () => {
  backend.queryPendingChanges.mockImplementation((query) =>
    Promise.resolve({
      requestGeneration: query.requestGeneration,
      defaultChange: { ...change, id: 0 },
      items: [100, 2, 11].map((id) => ({ ...change, id })),
      hasMore: false,
      partial: false,
      stats: {
        scannedCount: 4,
        matchedCount: 4,
        truncatedBySafetyLimit: false,
      },
    }),
  );
  const render = () => (
    <ContextMenuProvider scope="numeric-sort" zh={false}>
      <MenuEnvironment.Provider value={environment()}>
        <PendingPage
          t={messages["en-US"]}
          clientName="workspace"
          connectionKey="numeric-sort"
          demo={false}
          ready
        />
      </MenuEnvironment.Provider>
    </ContextMenuProvider>
  );
  await act(async () => root.render(render()));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 350)));
  const ids = () =>
    [...host.querySelectorAll("[data-pending-change]")].map((node) =>
      Number(node.getAttribute("data-pending-change")),
    );
  expect(ids()).toEqual([0, 100, 11, 2]);
  const count = backend.queryPendingChanges.mock.calls.length;
  await act(async () =>
    host
      .querySelector<HTMLButtonElement>(
        '[aria-label="Toggle ascending/descending CL number"]',
      )!
      .click(),
  );
  expect(ids()).toEqual([0, 2, 11, 100]);
  expect(backend.queryPendingChanges).toHaveBeenCalledTimes(count);
  await act(async () => root.render(null));
  await act(async () => root.render(render()));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 350)));
  expect(ids()).toEqual([0, 2, 11, 100]);
  expect(
    host
      .querySelector('[aria-label="Toggle ascending/descending CL number"]')
      ?.getAttribute("aria-pressed"),
  ).toBe("true");
});

it("shows a login recovery action instead of raw P4 diagnostics after a ticket expires", async () => {
  backend.queryPendingChanges.mockRejectedValue(
    'p4 changes -s pending {"code0":805575992,"data":"Your session has expired, please login again."}',
  );
  const env = environment();
  await act(async () =>
    root.render(
      <ContextMenuProvider scope="expired-ticket" zh={false}>
        <MenuEnvironment.Provider value={env}>
          <PendingPage
            t={messages["en-US"]}
            clientName="workspace"
            connectionKey="expired-ticket"
            demo={false}
            ready
          />
        </MenuEnvironment.Provider>
      </ContextMenuProvider>,
    ),
  );
  await act(async () => new Promise((resolve) => setTimeout(resolve, 350)));
  const alert = host.querySelector('[role="alert"]')!;
  expect(alert.textContent).toContain("Sign in again in connection settings");
  expect(alert.textContent).not.toContain("code0");
  expect(alert.textContent).not.toContain("p4 changes");
  await act(async () =>
    alert.querySelector<HTMLButtonElement>("button")!.click(),
  );
  expect(env.openPage).toHaveBeenCalledWith("settings");
});

it("keeps cached changelists visible while checking and after a connection failure", async () => {
  const env = environment();
  const header = document.createElement("div");
  writeSnapshot(pendingSnapshotKey(runtime), {
    changes: [change],
    partial: false,
    stats: {
      scannedCount: 1,
      matchedCount: 1,
      truncatedBySafetyLimit: false,
    },
  });
  const render = (
    state: RuntimeInfo["connection"]["state"],
    checking = false,
  ) =>
    root.render(
      <ContextMenuProvider scope="cached-startup" zh={false}>
        <MenuEnvironment.Provider
          value={{
            ...env,
            runtime: {
              ...runtime,
              connection: {
                ...runtime.connection,
                state,
                recovery: state === "connected" ? "none" : "retry",
              },
            },
          }}
        >
          <PageHeaderActionsContext.Provider value={header}>
            <PendingPage
              t={messages["en-US"]}
              clientName="workspace"
              connectionKey="cached-startup"
              demo={false}
              ready
              checkingConnection={checking}
            />
          </PageHeaderActionsContext.Provider>
        </MenuEnvironment.Provider>
      </ContextMenuProvider>,
    );
  await act(async () => render("notTested", true));
  expect(host.querySelector('[data-pending-change="202"]')).toBeTruthy();
  expect(
    header.querySelector(".pending-operation-state")?.textContent,
  ).toContain("Checking connection and login");
  expect(
    [...header.querySelectorAll("button")].find(
      (button) => button.textContent === "New CL",
    )?.disabled,
  ).toBe(true);
  expect(backend.queryPendingChanges).not.toHaveBeenCalled();

  await act(async () => render("networkError"));
  expect(host.querySelector('[data-pending-change="202"]')).toBeTruthy();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(
    "Showing the local cache",
  );
  const retry = vi.fn();
  window.addEventListener("p4deck:auto-refresh", retry);
  try {
    const button = [...host.querySelectorAll("button")].find(
      (button) => button.textContent === "Retry connection",
    )!;
    await act(async () => button.click());
    expect(retry).toHaveBeenCalledTimes(1);
  } finally {
    window.removeEventListener("p4deck:auto-refresh", retry);
  }
  expect(backend.queryPendingChanges).not.toHaveBeenCalled();

  await act(async () => render("connected"));
  expect(host.querySelector('[data-pending-change="202"]')).toBeTruthy();
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(header.querySelector(".pending-operation-state")).toBeNull();
});

it("runs header actions for the entire clicked CL despite file filters, and disables unavailable actions", async () => {
  const files = [
    {
      depotPath: "//depot/a.cs",
      clientPath: "//workspace/a.cs",
      action: "edit",
    },
    {
      depotPath: "//depot/new.txt",
      clientPath: "//workspace/new.txt",
      action: "move/add",
    },
    {
      depotPath: "//depot/old.txt",
      clientPath: "//workspace/old.txt",
      action: "move/delete",
    },
  ];
  backend.queryPendingChanges.mockImplementation((query) =>
    Promise.resolve({
      requestGeneration: query.requestGeneration,
      defaultChange: { ...change, id: 0, files: [files[0]] },
      items: [
        { ...change, files },
        { ...change, id: 203 },
      ],
      hasMore: false,
      partial: false,
      stats: {
        scannedCount: 3,
        matchedCount: 3,
        truncatedBySafetyLimit: false,
      },
    }),
  );
  const run = vi.fn();
  const render = (busy = false) =>
    root.render(
      <ContextMenuProvider scope="fixture-actions" zh={false}>
        <MenuEnvironment.Provider
          value={{ ...environment(), commandBusy: busy }}
        >
          <CommandExecutionContext.Provider value={run}>
            <PendingPage
              t={messages["en-US"]}
              clientName="workspace"
              connectionKey="fixture-actions"
              demo={false}
              ready
              navigation={{ changeId: 202, nonce: 1 }}
            />
          </CommandExecutionContext.Provider>
        </MenuEnvironment.Provider>
      </ContextMenuProvider>,
    );
  await act(async () => render());
  await act(async () => new Promise((resolve) => setTimeout(resolve, 350)));
  const filter = host.querySelector<HTMLSelectElement>(
    '[aria-label="Filter by type"]',
  )!;
  await act(async () => {
    filter.value = ".cs";
    filter.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(host.querySelectorAll(".pending-file")).toHaveLength(1);
  const submit = host.querySelector<HTMLButtonElement>(
    '[aria-label="Submit CL 202"]',
  )!;
  await act(async () => submit.click());
  expect(run).toHaveBeenLastCalledWith(
    "submit",
    { type: "pending", id: 202, count: 3 },
    submit,
  );
  const revert = host.querySelector<HTMLButtonElement>(
    '[aria-label="Revert all CL 202"]',
  )!;
  await act(async () => revert.click());
  expect(run).toHaveBeenLastCalledWith(
    "revert",
    expect.objectContaining({
      type: "file",
      wholeChangelistId: 202,
      scopeLabel: "CL 202 · All opened files",
      nodes: [
        expect.objectContaining({
          depotPath: "//depot/a.cs",
          state: "openedEdit",
        }),
        expect.objectContaining({
          depotPath: "//depot/new.txt",
          state: "openedMoveAdd",
        }),
        expect.objectContaining({
          depotPath: "//depot/old.txt",
          state: "openedMoveDelete",
        }),
      ],
    }),
    revert,
  );
  expect(host.querySelector(".pending-body")).toBeTruthy();
  const unchanged = host.querySelector<HTMLButtonElement>(
    '[aria-label="Revert unchanged CL 202"]',
  )!;
  await act(async () => unchanged.click());
  expect(run).toHaveBeenLastCalledWith(
    "revertUnchanged",
    expect.objectContaining({
      nodes: expect.arrayContaining(
        files.map((file) =>
          expect.objectContaining({
            depotPath: file.depotPath,
            changelistId: 202,
          }),
        ),
      ),
    }),
    unchanged,
  );
  expect(
    host.querySelector<HTMLButtonElement>('[aria-label="Submit Default"]')!
      .disabled,
  ).toBe(true);
  expect(
    host.querySelector<HTMLButtonElement>('[aria-label="Shelve all Default"]')!
      .disabled,
  ).toBe(true);
  expect(
    host.querySelector<HTMLButtonElement>('[aria-label="Revert all Default"]')!
      .disabled,
  ).toBe(false);
  expect(
    [
      ...host.querySelectorAll<HTMLButtonElement>(
        '[data-pending-change="203"] .pending-cl-actions button',
      ),
    ].every((button) => button.disabled),
  ).toBe(true);
  await act(async () => render(true));
  expect(
    [
      ...host.querySelectorAll<HTMLButtonElement>(".pending-cl-actions button"),
    ].every((button) => button.disabled),
  ).toBe(true);
});

it("deletes an empty CL immediately, blocks duplicate clicks, and never opens a confirmation dialog", async () => {
  const header = document.createElement("div");
  let finish!: (value: unknown) => void;
  backend.mutatePendingChange.mockReset();
  backend.mutatePendingChange.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  await act(async () =>
    root.render(
      <ContextMenuProvider scope="direct-delete" zh={false}>
        <MenuEnvironment.Provider value={environment()}>
          <PageHeaderActionsContext.Provider value={header}>
            <PendingPage
              t={messages["en-US"]}
              clientName="workspace"
              connectionKey="direct-delete"
              demo={false}
              ready
            />
          </PageHeaderActionsContext.Provider>
        </MenuEnvironment.Provider>
      </ContextMenuProvider>,
    ),
  );
  await act(async () => new Promise((resolve) => setTimeout(resolve, 350)));
  const button = host.querySelector<HTMLButtonElement>(
    '[aria-label="Delete"]',
  )!;
  await act(async () => {
    button.click();
    button.click();
  });
  expect(host.querySelector('[role="dialog"]')).toBeNull();
  expect(host.querySelector('[data-pending-change="202"]')).toBeNull();
  expect(backend.mutatePendingChange).toHaveBeenCalledTimes(1);
  expect(backend.mutatePendingChange).toHaveBeenCalledWith(
    expect.objectContaining({ type: "delete", changeId: 202 }),
  );
  await act(async () =>
    finish({
      operation: {
        operationId: "delete",
        exitCode: 0,
        events: [],
        durationMs: 1,
      },
      affectedChanges: [202],
      affectedPaths: [],
      refreshedChanges: [],
    }),
  );
  expect(host.querySelector('[data-pending-change="202"]')).toBeNull();
  expect(header.textContent).not.toContain("Changelist deleted");
  expect(header.querySelector(".pending-operation-state")).toBeNull();
  expect(
    [...header.querySelectorAll("button")].some(
      (button) => button.textContent === "New CL",
    ),
  ).toBe(true);
});

it("restores an optimistically deleted empty CL when the P4 request fails", async () => {
  const header = document.createElement("div");
  let fail!: (reason: unknown) => void;
  backend.mutatePendingChange.mockReset();
  backend.mutatePendingChange.mockReturnValue(
    new Promise((_, reject) => {
      fail = reject;
    }),
  );
  await act(async () =>
    root.render(
      <ContextMenuProvider scope="delete-rollback" zh={false}>
        <MenuEnvironment.Provider value={environment()}>
          <PageHeaderActionsContext.Provider value={header}>
            <PendingPage
              t={messages["en-US"]}
              clientName="workspace"
              connectionKey="delete-rollback"
              demo={false}
              ready
            />
          </PageHeaderActionsContext.Provider>
        </MenuEnvironment.Provider>
      </ContextMenuProvider>,
    ),
  );
  await act(async () => new Promise((resolve) => setTimeout(resolve, 350)));
  const button = host.querySelector<HTMLButtonElement>(
    '[aria-label="Delete"]',
  )!;
  await act(async () => button.click());
  expect(host.querySelector('[data-pending-change="202"]')).toBeNull();

  await act(async () => {
    fail(new Error("delete failed"));
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  expect(host.querySelector('[data-pending-change="202"]')).toBeTruthy();
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(recordFrontendOperationLog).toHaveBeenCalledWith(
    expect.objectContaining({ code: "operationFailed" }),
  );
});

it("keeps expanded rows during a refresh, coalesces automatic reads, and retains data on failure", async () => {
  await act(async () =>
    root.render(
      <ContextMenuProvider scope="fixture" zh={false}>
        <MenuEnvironment.Provider value={environment()}>
          <PendingSync />
          <PendingPage
            t={messages["en-US"]}
            clientName="workspace"
            connectionKey="fixture"
            demo={false}
            ready
            navigation={{ changeId: 202, nonce: 1 }}
          />
        </MenuEnvironment.Provider>
      </ContextMenuProvider>,
    ),
  );
  await act(async () => new Promise((resolve) => setTimeout(resolve, 300)));
  const header = host.querySelector('[data-pending-change="202"]');
  const body = host.querySelector(".pending-body");
  let finish!: () => void;
  let fail!: (error: Error) => void;
  backend.queryPendingChanges.mockImplementationOnce(
    (query) =>
      new Promise<PendingChangePage>((resolve, reject) => {
        finish = () =>
          resolve({
            requestGeneration: query.requestGeneration,
            items: [{ ...change, description: "Updated target" }],
            hasMore: false,
            partial: false,
            stats: {
              scannedCount: 1,
              matchedCount: 1,
              truncatedBySafetyLimit: false,
            },
          });
        fail = reject;
      }),
  );
  const refresh = () =>
    window.dispatchEvent(
      new CustomEvent("p4deck:pending-refresh", {
        detail: { reason: "interval" },
      }),
    );
  await act(async () => refresh());
  await act(async () => new Promise((resolve) => setTimeout(resolve, 300)));
  expect(host.querySelector('[data-pending-change="202"]')).toBe(header);
  expect(host.querySelector(".pending-body")).toBe(body);
  expect(host.textContent).toContain("Search target");
  await act(async () => refresh());
  await act(async () => new Promise((resolve) => setTimeout(resolve, 300)));
  expect(backend.queryPendingChanges).toHaveBeenCalledTimes(2);
  await act(async () => {
    finish();
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  expect(host.textContent).toContain("Updated target");
  backend.queryPendingChanges.mockImplementationOnce(
    () =>
      new Promise((_, reject) => {
        fail = reject;
      }),
  );
  await act(async () => refresh());
  await act(async () => new Promise((resolve) => setTimeout(resolve, 300)));
  await act(async () => {
    fail(new Error("Refresh unavailable"));
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  expect(host.textContent).toContain("Updated target");
  expect(host.textContent).not.toContain("Refresh unavailable");
  expect(recordFrontendOperationLog).toHaveBeenCalledWith(
    expect.objectContaining({ phase: "refresh", code: "refreshFailed" }),
  );
  expect(host.querySelector(".pending-body")).toBe(body);
});

it("expands and focuses a pending changelist selected by global search", async () => {
  await act(async () =>
    root.render(
      <ContextMenuProvider scope="fixture" zh={false}>
        <MenuEnvironment.Provider value={environment()}>
          <PendingPage
            t={messages["en-US"]}
            clientName="workspace"
            connectionKey="fixture"
            demo={false}
            ready
            navigation={{ changeId: 202, nonce: 1 }}
          />
        </MenuEnvironment.Provider>
      </ContextMenuProvider>,
    ),
  );
  await act(async () => new Promise((resolve) => setTimeout(resolve, 350)));
  const target = host.querySelector<HTMLElement>('[data-pending-change="202"]');
  expect(target).toBeTruthy();
  expect(document.activeElement).toBe(target);
  expect(host.querySelector(".pending-body")).toBeTruthy();
  expect(host.textContent).toContain("Search target");
});

it("filters cached CL descriptions, IDs and files immediately without P4 reads or cancellation", async () => {
  const cached = [
    change,
    {
      ...change,
      id: 303,
      description: "Material fixes",
      files: [{ depotPath: "//depot/Assets/Water.mat", action: "edit" }],
    },
  ];
  backend.queryPendingChanges.mockImplementation((query) =>
    Promise.resolve({
      requestGeneration: query.requestGeneration,
      items: cached,
      hasMore: false,
      partial: false,
      stats: {
        scannedCount: 2,
        matchedCount: 2,
        truncatedBySafetyLimit: false,
      },
    }),
  );
  await act(async () =>
    root.render(
      <ContextMenuProvider scope="fixture" zh={false}>
        <MenuEnvironment.Provider value={environment()}>
          <PendingPage
            t={messages["en-US"]}
            clientName="workspace"
            connectionKey="fixture"
            demo={false}
            ready
          />
        </MenuEnvironment.Provider>
      </ContextMenuProvider>,
    ),
  );
  await act(async () => new Promise((resolve) => setTimeout(resolve, 300)));
  const input = host.querySelector<HTMLInputElement>(
    '[aria-label="Filter pending changelists"]',
  )!;
  const cancelCount = backend.cancelOperation.mock.calls.length;
  for (const [keyword, ids] of [
    ["Search", [202]],
    ["Water.mat", [303]],
    ["303", [303]],
    ["nothing", []],
    ["", [303, 202]],
  ] as const) {
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!.call(input, keyword);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(
      [...host.querySelectorAll("[data-pending-change]")].map((item) =>
        Number(item.getAttribute("data-pending-change")),
      ),
    ).toEqual(ids);
  }
  await act(async () => new Promise((resolve) => setTimeout(resolve, 350)));
  expect(backend.queryPendingChanges).toHaveBeenCalledTimes(1);
  expect(backend.queryPendingChanges.mock.calls[0][0].keyword).toBe("");
  expect(backend.cancelOperation.mock.calls.length).toBe(cancelCount);
});

it("keeps the initial cache read alive while the user types", async () => {
  let finish!: (value: PendingChangePage) => void;
  let generation = 0;
  backend.queryPendingChanges.mockImplementationOnce((query) => {
    generation = query.requestGeneration;
    return new Promise<PendingChangePage>((resolve) => {
      finish = resolve;
    });
  });
  await act(async () =>
    root.render(
      <ContextMenuProvider scope="fixture" zh={false}>
        <MenuEnvironment.Provider value={environment()}>
          <PendingPage
            t={messages["en-US"]}
            clientName="workspace"
            connectionKey="fixture"
            demo={false}
            ready
          />
        </MenuEnvironment.Provider>
      </ContextMenuProvider>,
    ),
  );
  await act(async () => new Promise((resolve) => setTimeout(resolve, 270)));
  const input = host.querySelector<HTMLInputElement>(
    '[aria-label="Filter pending changelists"]',
  )!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, "new");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => new Promise((resolve) => setTimeout(resolve, 270)));
  expect(backend.queryPendingChanges).toHaveBeenCalledTimes(1);
  await act(async () =>
    finish({
      requestGeneration: generation,
      items: [{ ...change, description: "new cached result" }],
      hasMore: false,
      partial: false,
      stats: {
        scannedCount: 1,
        matchedCount: 1,
        truncatedBySafetyLimit: false,
      },
    }),
  );
  await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
  expect(host.textContent).toContain("new cached result");
});
it("auto-loads cursor pages, deduplicates IDs, and keeps Default singular", async () => {
  const defaultChange = { ...change, id: 0, description: "" };
  backend.queryPendingChanges.mockReset().mockImplementation((query) =>
    Promise.resolve(
      query.cursor
        ? {
            requestGeneration: query.requestGeneration,
            items: [change, { ...change, id: 101, description: "Older" }],
            hasMore: false,
            partial: false,
            stats: {
              scannedCount: 2,
              matchedCount: 2,
              truncatedBySafetyLimit: false,
            },
          }
        : {
            requestGeneration: query.requestGeneration,
            defaultChange,
            items: [change],
            hasMore: true,
            nextCursor: "page-2",
            partial: false,
            stats: {
              scannedCount: 2,
              matchedCount: 2,
              truncatedBySafetyLimit: false,
            },
          },
    ),
  );
  await act(async () =>
    root.render(
      <ContextMenuProvider scope="fixture" zh={false}>
        <MenuEnvironment.Provider value={environment()}>
          <PendingPage
            t={messages["en-US"]}
            clientName="workspace"
            connectionKey="fixture"
            demo={false}
            ready
          />
        </MenuEnvironment.Provider>
      </ContextMenuProvider>,
    ),
  );
  await act(async () => new Promise((resolve) => setTimeout(resolve, 380)));
  expect(backend.queryPendingChanges).toHaveBeenCalledTimes(2);
  expect(host.querySelectorAll('[data-pending-change="0"]')).toHaveLength(1);
  expect(host.querySelectorAll('[data-pending-change="202"]')).toHaveLength(1);
  expect(host.querySelector('[data-pending-change="101"]')).toBeTruthy();
  const first = host.querySelector<HTMLElement>('[data-pending-change="0"]')!;
  const second = host.querySelector<HTMLElement>(
    '[data-pending-change="202"]',
  )!;
  first.focus();
  await act(async () =>
    first.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "ArrowDown",
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
  await act(
    async () =>
      new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
  );
  expect(document.activeElement).toBe(second);
});
it("selects a Shift range across visible CL file tables without selecting collapsed files", async () => {
  const entry = (id: number) => ({
    ...change,
    id,
    files: [
      { depotPath: `//fixture/${id}`, action: "edit", state: "openedEdit" },
    ],
  });
  backend.queryPendingChanges.mockImplementation((query) =>
    Promise.resolve({
      requestGeneration: query.requestGeneration,
      defaultChange: entry(0),
      items: [entry(25), entry(12), entry(5)],
      hasMore: false,
      partial: false,
      stats: {
        scannedCount: 4,
        matchedCount: 4,
        truncatedBySafetyLimit: false,
      },
    }),
  );
  await act(async () =>
    root.render(
      <ContextMenuProvider scope="cross-range" zh={false}>
        <MenuEnvironment.Provider value={environment()}>
          <PendingPage
            t={messages["en-US"]}
            clientName="workspace"
            connectionKey="cross-range"
            demo={false}
            ready
          />
        </MenuEnvironment.Provider>
      </ContextMenuProvider>,
    ),
  );
  await act(async () => new Promise((resolve) => setTimeout(resolve, 350)));
  for (const id of [0, 25, 12])
    await act(async () =>
      host.querySelector<HTMLElement>(`[data-pending-change="${id}"]`)!.click(),
    );
  expect(
    host.querySelectorAll('.pending-file[aria-selected="true"]'),
  ).toHaveLength(0);
  const rows = [...host.querySelectorAll<HTMLElement>(".pending-file")];
  expect(rows).toHaveLength(3);
  await act(async () => rows[0].click());
  await act(async () => {
    rows[2].dispatchEvent(
      new MouseEvent("click", { bubbles: true, shiftKey: true }),
    );
  });
  expect(
    host.querySelectorAll('.pending-file[aria-selected="true"]'),
  ).toHaveLength(3);
  expect(
    host
      .querySelector('[data-pending-change="5"]')!
      .parentElement!.querySelector(".pending-file"),
  ).toBeNull();
});

it("renders moved files under the target before the server resolves with no full-table reread", async () => {
  const rows = [
    {
      ...change,
      id: 10,
      files: [{ depotPath: "//fixture/optimistic", action: "edit" }],
    },
    {
      ...change,
      id: 20,
      files: [{ depotPath: "//fixture/extra", action: "edit" }],
    },
  ];
  backend.queryPendingChanges.mockImplementation((query) =>
    Promise.resolve({
      requestGeneration: query.requestGeneration,
      items: rows,
      hasMore: false,
      partial: false,
      stats: {
        scannedCount: 2,
        matchedCount: 2,
        truncatedBySafetyLimit: false,
      },
    }),
  );
  let finish!: (receipt: SelectedMoveReceipt) => void;
  backend.selectedMoveExecute.mockImplementation(
    () => new Promise((resolve) => (finish = resolve)),
  );
  await act(async () =>
    root.render(
      <ContextMenuProvider scope="optimistic-ui" zh={false}>
        <MenuEnvironment.Provider value={environment()}>
          <PendingPage
            t={messages["en-US"]}
            clientName="workspace"
            connectionKey="optimistic-ui"
            demo={false}
            ready
          />
        </MenuEnvironment.Provider>
      </ContextMenuProvider>,
    ),
  );
  await act(async () => new Promise((resolve) => setTimeout(resolve, 350)));
  for (const id of [10, 20])
    await act(async () =>
      host.querySelector<HTMLElement>(`[data-pending-change="${id}"]`)!.click(),
    );
  const count = backend.queryPendingChanges.mock.calls.length;
  const request = {
    operationId: "ui-deferred",
    connection: {
      profileId: "fixture",
      generation: "1",
      server: "synthetic",
      user: "fixture",
      client: "workspace",
    },
    target: { kind: "existing" as const, changeId: 20 },
    files: [{ depotPath: "//fixture/optimistic", sourceChangeId: 10 }],
  };
  await act(async () => {
    expect(startOptimisticMove("optimistic-ui", request, rows)).toBe(true);
  });
  const card = (id: number) =>
    host
      .querySelector(`[data-pending-change="${id}"]`)!
      .closest(".pending-card")!;
  expect(card(10).textContent).not.toContain("//fixture/optimistic");
  expect(card(20).textContent).toContain("//fixture/optimistic");
  expect(card(20).textContent).toContain("//fixture/extra");
  expect(
    host.querySelector(".pending-query-bar input")?.hasAttribute("disabled"),
  ).toBe(false);
  expect(backend.queryPendingChanges).toHaveBeenCalledTimes(count);
  await act(async () =>
    finish({
      operationId: request.operationId,
      targetCreationUnknown: false,
      targetChangeId: 20,
      stage: "completed",
      files: [{ ...request.files[0], state: "moved" }],
      message: "done",
    }),
  );
  expect(backend.queryPendingChanges).toHaveBeenCalledTimes(count);
  expect(card(20).textContent).toContain("//fixture/optimistic");
});

it.each([20, 0, 10])(
  "trusted drag directly targets CL %s without a dialog; same target is a no-op",
  async (targetId) => {
    const path = `//fixture/drop-${targetId}`;
    const source = {
      ...change,
      id: 10,
      files: [{ depotPath: path, action: "edit" }],
    };
    const target = { ...change, id: targetId, files: [] };
    backend.companySubmitConnectionSnapshot.mockResolvedValue({
      profileId: "fixture",
      generation: "1",
      server: "synthetic",
      user: "fixture",
      client: "workspace",
    });
    backend.selectedMoveExecute
      .mockReset()
      .mockImplementation(() => new Promise(() => {}));
    backend.queryPendingChanges.mockImplementation((query) =>
      Promise.resolve({
        requestGeneration: query.requestGeneration,
        defaultChange: targetId === 0 ? target : undefined,
        items: targetId === 10 || targetId === 0 ? [source] : [source, target],
        hasMore: false,
        partial: false,
        stats: {
          scannedCount: 2,
          matchedCount: 2,
          truncatedBySafetyLimit: false,
        },
      }),
    );
    await act(async () =>
      root.render(
        <ContextMenuProvider scope={`drop-${targetId}`} zh={false}>
          <MenuEnvironment.Provider value={environment()}>
            <PendingPage
              t={messages["en-US"]}
              clientName="workspace"
              connectionKey={`drop-${targetId}`}
              demo={false}
              ready
            />
          </MenuEnvironment.Provider>
        </ContextMenuProvider>,
      ),
    );
    await act(async () => new Promise((resolve) => setTimeout(resolve, 350)));
    await act(async () =>
      host.querySelector<HTMLElement>('[data-pending-change="10"]')!.click(),
    );
    const sourceRow = host.querySelector<HTMLElement>(".pending-file")!;
    const card = host
      .querySelector(`[data-pending-change="${targetId}"]`)!
      .closest(".pending-card")!;
    const transfer = { effectAllowed: "", setData: vi.fn() };
    const event = (type: string) => {
      const e = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(e, "dataTransfer", { value: transfer });
      return e;
    };
    // An external payload has no trusted in-memory snapshot.
    await act(async () => card.dispatchEvent(event("drop")));
    expect(backend.selectedMoveExecute).not.toHaveBeenCalled();
    await act(async () => sourceRow.dispatchEvent(event("dragstart")));
    await act(async () => {
      card.dispatchEvent(event("drop"));
      card.dispatchEvent(event("drop"));
    });
    expect(host.querySelector(".move-workflow")).toBeNull();
    if (targetId === 10) {
      expect(backend.selectedMoveExecute).not.toHaveBeenCalled();
      return;
    }
    expect(backend.selectedMoveExecute).toHaveBeenCalledTimes(1);
    expect(backend.selectedMoveExecute).toHaveBeenCalledWith(
      expect.objectContaining({
        files: [{ depotPath: path, sourceChangeId: 10 }],
        target: { kind: "existing", changeId: targetId },
      }),
    );
    // Execute promise remains unresolved: projection already moved the row.
    expect(card.textContent).toContain(path);
    expect(
      host
        .querySelector('[data-pending-change="10"]')!
        .closest(".pending-card")!.textContent,
    ).not.toContain(path);
  },
);
