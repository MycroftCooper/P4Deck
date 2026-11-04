import { ContextMenuProvider } from "../../../app/context-menu/ContextMenu";
import { CommandExecutionContext } from "../../../app/shell/CommandContext";
import type { SyncDialogRequest } from "../../files/components/SyncDialog";
import { CommandContext } from "../../../app/shell/CommandContext";
import { PageActiveContext } from "../../../app/docking/chrome";
import type { CommandTarget } from "../../../app/shell/commandPolicy";
// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  FileHistoryPage,
  FileRevision,
  RuntimeInfo,
  StreamSummary,
} from "../../../shared/contracts";
import { ReadOnlyPage } from "./ReadOnlyPages";
import { PageRefreshSlotContext } from "../../../app/docking/chrome";
import { setLocale } from "../../../shared/i18n";

vi.mock("../../files/components/SyncDialog", () => ({
  SyncDialog: ({
    request,
    onDismiss,
  }: {
    request: SyncDialogRequest;
    onDismiss(): void;
  }) => (
    <div data-testid="sync-request">
      <output>
        {JSON.stringify({
          revision: request.fixedRevision,
          paths: request.nodes.map((node) => node.depotPath),
        })}
      </output>
      <button onClick={onDismiss}>Cancel sync dialog</button>
    </div>
  ),
}));
vi.mock("../../files/components/UndoDialog", () => ({
  UndoDialog: ({
    request,
    onDismiss,
  }: {
    request: import("../../files/components/UndoDialog").UndoDialogRequest;
    onDismiss(): void;
  }) => (
    <div data-testid="undo-request">
      <output>
        {JSON.stringify({
          depotPath: request.depotPath,
          revision: request.revision,
          changelistId: request.changelistId,
        })}
      </output>
      <button onClick={onDismiss}>Cancel undo dialog</button>
    </div>
  ),
}));
const backend = vi.hoisted(() => ({
  getFileHistory: vi.fn(),
  getDiff: vi.fn(),
  listStreams: vi.fn<() => Promise<StreamSummary[]>>(async () => []),
  cancelOperation: vi.fn(async () => undefined),
}));
vi.mock("../../../infrastructure/backend", () => ({ backend }));
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    measure: () => undefined,
    measureElement: () => undefined,
    getTotalSize: () => count * 52,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        index,
        key: index,
        start: index * 52,
        size: 52,
      })),
  }),
}));

const runtime: RuntimeInfo = {
  mode: "tauri",
  p4Version: "P4/TEST",
  activeProfileId: "profile-a",
  contextGeneration: 7,
  context: {
    server: "fixture:1666",
    user: "tester",
    client: "workspace",
    cwd: "C:/workspace",
  },
  connection: {
    state: "connected",
    message: "ok",
    recovery: "none",
    server: "fixture:1666",
  },
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function revision(
  revisionNumber: number,
  path = "//depot/a.txt",
): FileRevision {
  return {
    depotPath: path,
    revision: revisionNumber,
    changelistId: revisionNumber,
    user: "tester",
    action: "edit",
    fileType: "text",
    time: "",
    description: `REVISION-${revisionNumber}`,
    integrations: [],
  };
}

function page(
  revisions: number[],
  path = "//depot/a.txt",
  overrides: Partial<FileHistoryPage> = {},
): FileHistoryPage {
  return {
    items: revisions.map((value) => revision(value, path)),
    hasMore: false,
    partial: false,
    truncated: false,
    operationIds: [],
    ...overrides,
  };
}

let host: HTMLDivElement;
let root: Root;

async function render(target: string, nextRuntime = runtime) {
  await act(async () => {
    root.render(
      <ReadOnlyPage
        kind="history"
        runtime={nextRuntime}
        target={target}
        onTargetChange={() => undefined}
        zh={false}
      />,
    );
    await Promise.resolve();
  });
}

function button(text: string) {
  return [...host.querySelectorAll<HTMLButtonElement>("button")].find((item) =>
    item.textContent?.includes(text),
  )!;
}

async function click(element: Element, options: MouseEventInit = {}) {
  await act(async () =>
    element.dispatchEvent(
      new MouseEvent("click", { bubbles: true, ...options }),
    ),
  );
}

beforeEach(() => {
  // Components translate through the module-level locale.
  setLocale("en-US");
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  backend.getFileHistory.mockReset();
  backend.getDiff.mockReset();
  backend.listStreams.mockReset();
  backend.listStreams.mockResolvedValue([]);
  backend.cancelOperation.mockClear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

it("portals icon-only history refresh and retains the search, comparison and records", async () => {
  const slot = document.createElement("span");
  document.body.append(slot);
  const next = deferred<FileHistoryPage>();
  backend.getFileHistory
    .mockResolvedValueOnce(page([2, 1]))
    .mockReturnValueOnce(next.promise);
  try {
    await act(async () => {
      root.render(
        <PageRefreshSlotContext.Provider value={slot}>
          <ReadOnlyPage
            kind="history"
            runtime={runtime}
            target="//depot/a.txt"
            zh={false}
          />
        </PageRefreshSlotContext.Provider>,
      );
    });
    expect(host.querySelector(".section-title")).toBeNull();
    expect(host.querySelector(".history-path")).toBeNull();
    expect(host.textContent).not.toContain("Configure Swarm");
    expect(host.querySelector('[aria-label="Search list"]')).not.toBeNull();
    expect(host.textContent).not.toContain("Compare two selected revisions");
    expect(host.textContent).toContain("REVISION-2");
    const refresh = slot.querySelector<HTMLButtonElement>(
      'button[aria-label="Refresh"]',
    )!;
    expect(refresh.title).toBe("Refresh");
    expect(refresh.textContent).toBe("");
    expect(refresh.disabled).toBe(false);
    await click(refresh);
    expect(backend.getFileHistory).toHaveBeenCalledTimes(2);
    expect(refresh.disabled).toBe(true);
    expect(refresh.getAttribute("aria-busy")).toBe("true");
    await act(async () => next.resolve(page([3, 2, 1])));
    expect(refresh.disabled).toBe(false);
    expect(host.textContent).toContain("REVISION-3");
  } finally {
    slot.remove();
  }
});

it("retains all history pages and selection while a refresh is pending or fails", async () => {
  backend.getFileHistory
    .mockResolvedValueOnce(
      page([4, 3], "//depot/a.txt", { hasMore: true, nextCursor: "c1" }),
    )
    .mockResolvedValueOnce(page([2, 1]));
  await render("//depot/a.txt");
  await click(button("Load more history"));
  const rows = host.querySelectorAll(".workspace-row");
  await click(rows[0]);
  await click(rows[1], { ctrlKey: true });
  const next = deferred<FileHistoryPage>();
  backend.getFileHistory.mockImplementationOnce(() => next.promise);
  await act(async () =>
    window.dispatchEvent(
      new CustomEvent("p4deck:auto-refresh", {
        detail: { activePage: "history" },
      }),
    ),
  );
  expect(host.textContent).toContain("REVISION-1");
  await act(async () => next.reject(new Error("Refresh unavailable")));
  expect(host.textContent).toContain("Refresh unavailable");
  expect(host.textContent).toContain("REVISION-1");
  backend.getFileHistory.mockResolvedValueOnce(page([5, 4, 3]));
  await click(button("Refresh"));
  expect(host.textContent).toContain("REVISION-5");
  expect(host.textContent).not.toContain("REVISION-1");
});

it("cancels a history page on path drift and ignores its late rows", async () => {
  const more = deferred<FileHistoryPage>();
  backend.getFileHistory
    .mockResolvedValueOnce(
      page([4, 3], "//depot/a.txt", { hasMore: true, nextCursor: "c1" }),
    )
    .mockImplementationOnce(() => more.promise)
    .mockResolvedValueOnce(page([9], "//depot/b.txt"));
  await render("//depot/a.txt");
  await act(async () => Promise.resolve());
  await click(button("Load more history"));
  const pageOperation = backend.getFileHistory.mock.calls[1][0].operationId;
  await render("//depot/b.txt");
  await act(async () => Promise.resolve());
  expect(backend.cancelOperation).toHaveBeenCalledWith(pageOperation);
  await act(async () => more.resolve(page([2], "//depot/a.txt")));
  expect(host.textContent).toContain("REVISION-9");
  expect(host.textContent).not.toContain("REVISION-2");
});

it("rejects a duplicate history cursor without losing trusted rows", async () => {
  backend.getFileHistory
    .mockResolvedValueOnce(
      page([3], "//depot/a.txt", { hasMore: true, nextCursor: "same" }),
    )
    .mockResolvedValueOnce(
      page([3, 2], "//depot/a.txt", { hasMore: true, nextCursor: "same" }),
    );
  await render("//depot/a.txt");
  await act(async () => Promise.resolve());
  await click(button("Load more history"));
  await act(async () => Promise.resolve());
  expect(host.textContent).toContain("REVISION-3");
  expect(host.textContent).toContain("REVISION-2");
  expect(host.textContent).toContain("repeated cursor");
  expect(button("Load more history")).toBeUndefined();
});

it("hides generation-stale history and accepts the replacement request", async () => {
  const first = deferred<FileHistoryPage>();
  const second = deferred<FileHistoryPage>();
  backend.getFileHistory
    .mockImplementationOnce(() => first.promise)
    .mockImplementationOnce(() => second.promise);
  await render("//depot/a.txt");
  await render("//depot/a.txt", {
    ...runtime,
    activeProfileId: "profile-b",
    contextGeneration: 8,
  });
  expect(host.textContent).not.toContain("REVISION-1");
  await act(async () => second.resolve(page([8])));
  await act(async () => first.resolve(page([1])));
  expect(host.textContent).toContain("REVISION-8");
  expect(host.textContent).not.toContain("REVISION-1");
});

it("shows an explicit result when Global Search locates or cannot locate a stream", async () => {
  backend.listStreams.mockResolvedValue([
    {
      stream: "//atlas/main",
      name: "Main",
      owner: "tester",
      parent: "none",
      kind: "mainline",
      description: "Main stream",
    },
  ]);
  await act(async () => {
    root.render(
      <ReadOnlyPage
        kind="streams"
        runtime={runtime}
        navigation={{ stream: "//atlas/main", nonce: 1 }}
        zh={false}
      />,
    );
    await Promise.resolve();
  });
  expect(host.textContent).toContain("Located stream: //atlas/main");

  await act(async () => {
    root.render(
      <ReadOnlyPage
        kind="streams"
        runtime={runtime}
        navigation={{ stream: "//atlas/missing", nonce: 2 }}
        zh={false}
      />,
    );
    await Promise.resolve();
  });
  expect(host.textContent).toContain("current list has no exact match");
});

it("publishes at most two revisions to the toolbar and ignores hidden History tabs", async () => {
  backend.getFileHistory.mockResolvedValue(
    page([3, 2, 1], "//depot/a.txt", {
      items: [
        { ...revision(3), description: "first\nsecond" },
        revision(2),
        revision(1),
      ],
    }),
  );
  const focus = vi.fn<(target: CommandTarget) => void>();
  async function mount(active: boolean) {
    await act(async () =>
      root.render(
        <CommandContext.Provider value={focus}>
          <PageActiveContext.Provider value={active}>
            <ReadOnlyPage
              kind="history"
              runtime={runtime}
              target="//depot/a.txt"
              zh={false}
            />
          </PageActiveContext.Provider>
        </CommandContext.Provider>,
      ),
    );
  }
  await mount(true);
  const rows = host.querySelectorAll(".history-row");
  await click(rows[0]);
  await click(rows[1], { ctrlKey: true });
  expect(focus).toHaveBeenLastCalledWith({
    type: "history",
    path: "//depot/a.txt",
    revisions: [3, 2],
  });
  expect(host.textContent).not.toContain("Select up to two revisions");
  await click(rows[2], { ctrlKey: true });
  expect(
    host.querySelectorAll('.history-row[aria-selected="true"]'),
  ).toHaveLength(2);
  await click(host.querySelector('[aria-label="Expand description"]')!);
  expect(focus).toHaveBeenLastCalledWith({
    type: "history",
    path: "//depot/a.txt",
    revisions: [2, 1],
  });
  expect(host.querySelector(".graph-node-diff, .workspace-details")).toBeNull();
  expect(button("Compare two selected revisions")).toBeUndefined();
  expect(backend.getDiff).not.toHaveBeenCalled();
  await mount(false);
  focus.mockClear();
  await click(rows[2], { ctrlKey: true });
  expect(focus).not.toHaveBeenCalled();
  await mount(true);
  expect(focus).toHaveBeenLastCalledWith({
    type: "history",
    path: "//depot/a.txt",
    revisions: [2],
  });
});

it("shows exactly four history menu entries, keeps FIFO order, and gets the last-selected revision", async () => {
  backend.getFileHistory.mockResolvedValue(page([17, 42]));
  const preview = vi.fn(),
    execute = vi.fn();
  await act(async () =>
    root.render(
      <ContextMenuProvider scope="mock" zh={false}>
        <CommandExecutionContext.Provider value={execute}>
          <ReadOnlyPage
            kind="history"
            runtime={runtime}
            target="//depot/a.txt"
            zh={false}
            onPreviewChange={preview}
          />
        </CommandExecutionContext.Provider>
      </ContextMenuProvider>,
    ),
  );
  const rows = host.querySelectorAll<HTMLElement>(".history-row");
  await click(rows[0]);
  await click(rows[1]);
  async function openFirst() {
    await act(async () =>
      rows[0].dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
      ),
    );
  }
  const menuButton = (label: string) =>
    [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
      (button) => button.textContent === label,
    )!;
  await openFirst();
  expect(
    [...document.querySelectorAll('[role="menuitem"]')].map(
      (button) => button.textContent,
    ),
  ).toEqual(["View submitted CL", "Get this revision", "Undo", "Diff"]);
  expect(rows[0].dataset.selectionOrder).toBe("1");
  expect(rows[1].dataset.selectionOrder).toBe("2");
  expect(rows[1].getAttribute("aria-label")).toContain(
    "Get this revision target",
  );
  expect(menuButton("Undo").getAttribute("aria-disabled")).not.toBe("true");
  await click(menuButton("Diff"));
  expect(execute).toHaveBeenCalledWith("diff", {
    type: "history",
    path: "//depot/a.txt",
    revisions: [17, 42],
  });
  await openFirst();
  await click(menuButton("View submitted CL"));
  expect(preview).toHaveBeenCalledWith(17);
  await openFirst();
  await click(menuButton("Get this revision"));
  expect(
    host.querySelector('[data-testid="sync-request"]')?.textContent,
  ).toContain('"revision":42');
  expect(
    host.querySelector('[data-testid="sync-request"]')?.textContent,
  ).toContain("//depot/a.txt");
  await click(button("Cancel sync dialog"));
  expect(host.querySelector('[data-testid="sync-request"]')).toBeNull();
  await openFirst();
  await click(menuButton("Undo"));
  expect(
    host.querySelector('[data-testid="undo-request"]')?.textContent,
  ).toContain('"revision":17');
  expect(
    host.querySelector('[data-testid="undo-request"]')?.textContent,
  ).toContain('"changelistId":17');
  expect(rows[0].dataset.selectionOrder).toBe("1");
  expect(rows[1].dataset.selectionOrder).toBe("2");
  await click(button("Cancel undo dialog"));
  expect(host.querySelector('[data-testid="undo-request"]')).toBeNull();
  expect(backend.getDiff).not.toHaveBeenCalled();
});

it("streams retain selection, column tracks and switch menu without a detail sidebar", async () => {
  backend.listStreams.mockResolvedValue([
    {
      stream: "//mock/main",
      name: "main",
      owner: "tester",
      parent: "none",
      kind: "mainline",
      description: "Main",
    },
  ]);
  await act(async () => {
    root.render(
      <ContextMenuProvider scope="stream-no-details" zh={false}>
        <ReadOnlyPage
          kind="streams"
          runtime={runtime}
          target=""
          onTargetChange={() => undefined}
          zh={false}
        />
      </ContextMenuProvider>,
    );
    await Promise.resolve();
  });
  const row = host.querySelector<HTMLButtonElement>(".workspace-row")!;
  await click(row);
  expect(row.classList.contains("selected")).toBe(true);
  expect(host.querySelector(".workspace-details")).toBeNull();
  expect(host.querySelector(".with-detail")).toBeNull();
  expect(host.querySelectorAll('[role="separator"]')).toHaveLength(3);
  await act(async () =>
    row.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        clientX: 20,
        clientY: 20,
      }),
    ),
  );
  expect(document.querySelector('[role="menu"]')?.textContent).toContain(
    "Switch workspace to this stream",
  );
  expect(document.querySelector('[role="menu"]')?.textContent).not.toContain(
    "View details",
  );
});
