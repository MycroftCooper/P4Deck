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
import type { PendingChange, RuntimeInfo } from "../../../shared/contracts";
import { messages } from "../../../shared/i18n";
import type { ShelfRequest } from "./ShelfDialog";
import { PendingPage } from "./PendingPage";
import { workspaceCache } from "../../files/workspaceQueries";

const backend = vi.hoisted(() => ({
  queryPendingChanges: vi.fn(),
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

const shelfDialogs = vi.hoisted(() => ({
  request: undefined as unknown,
  kind: "",
}));
vi.mock("./ShelfDialog", () => ({
  ShelfDialog: (props: { request: ShelfRequest; onDismiss(): void }) => {
    shelfDialogs.request = props.request;
    shelfDialogs.kind = "delete";
    return <button onClick={props.onDismiss}>Cancel shelf preview</button>;
  },
}));
const unshelveDirect = vi.hoisted(() => ({ calls: [] as unknown[] }));
vi.mock("../unshelveDirectTask", () => ({
  startUnshelveDirect: (intent: unknown) => {
    unshelveDirect.calls.push(intent);
  },
}));
async function mountShelf(zh = false, partial = false) {
  const source = {
    ...change,
    shelvedFiles: ["//fixture/a", "//fixture/b"].map((depotPath) => ({
      depotPath,
      action: "edit",
    })),
  };
  backend.queryPendingChanges.mockImplementation((query) =>
    Promise.resolve({
      requestGeneration: query.requestGeneration,
      items: [source],
      hasMore: false,
      partial,
      stats: {
        scannedCount: 1,
        matchedCount: 1,
        truncatedBySafetyLimit: false,
      },
    }),
  );
  const env = environment();
  env.preferences.zh = zh;
  await act(async () =>
    root.render(
      <ContextMenuProvider scope="shelf-actions" zh={zh}>
        <MenuEnvironment.Provider value={env}>
          <PendingPage
            t={messages[zh ? "zh-CN" : "en-US"]}
            clientName="workspace"
            connectionKey="shelf-actions"
            demo={false}
            ready
          />
        </MenuEnvironment.Provider>
      </ContextMenuProvider>,
    ),
  );
  await act(async () => new Promise((resolve) => setTimeout(resolve, 350)));
  await act(async () =>
    host.querySelector<HTMLElement>('[data-pending-change="202"]')!.click(),
  );
  return source;
}
it.each([false, true])(
  "localizes shelf heading and places the CL chevron before it (zh=%s)",
  async (zh) => {
    await mountShelf(zh);
    const header = host.querySelector(".pending-shelf-heading")!;
    expect(header.textContent).toContain(zh ? "已搁置文件" : "Shelved Files");
    const toggle = header.firstElementChild as HTMLButtonElement;
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(toggle.querySelector("svg")).not.toBeNull();
    await act(async () => toggle.click());
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.querySelector(".pending-chevron-collapsed")).not.toBeNull();
    expect(host.querySelector(".pending-body")).not.toBeNull();
    expect(host.querySelector(".pending-file.shelf")).toBeNull();
    await act(async () => toggle.click());
    expect(host.querySelector(".pending-file.shelf")).not.toBeNull();
  },
);
it("explicit delete all opens the delete confirmation with only this CL full scope", async () => {
  await mountShelf();
  const filter = host.querySelector<HTMLSelectElement>(
    '.pending-file-table-wrap:last-child select[aria-label="Filter by type"]',
  );
  if (filter)
    await act(async () => {
      filter.value = "(none)";
      filter.dispatchEvent(new Event("change", { bubbles: true }));
    });
  const button = [
    ...host.querySelectorAll<HTMLButtonElement>(
      ".pending-shelf-actions button",
    ),
  ].find((button) => button.textContent?.includes("Delete"))!;
  await act(async () => button.click());
  expect(shelfDialogs.kind).toBe("delete");
  expect(shelfDialogs.request).toMatchObject({
    changeId: 202,
    paths: ["//fixture/a", "//fixture/b"],
  });
  expect(backend.mutatePendingChange).not.toHaveBeenCalled();
  const cancel = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent === "Cancel shelf preview",
  )!;
  await act(async () => cancel.click());
  expect(backend.mutatePendingChange).not.toHaveBeenCalled();
});
it("explicit unshelve all runs immediately without a dialog or preflight", async () => {
  await mountShelf();
  const filter = host.querySelector<HTMLSelectElement>(
    '.pending-file-table-wrap:last-child select[aria-label="Filter by type"]',
  );
  if (filter)
    await act(async () => {
      filter.value = "(none)";
      filter.dispatchEvent(new Event("change", { bubbles: true }));
    });
  const button = [
    ...host.querySelectorAll<HTMLButtonElement>(
      ".pending-shelf-actions button",
    ),
  ].find((button) => button.textContent?.includes("Move all to CL"))!;
  await act(async () => button.click());
  expect(unshelveDirect.calls).toHaveLength(1);
  expect(unshelveDirect.calls[0]).toMatchObject({
    sourceChangeId: 202,
    depotPaths: ["//fixture/a", "//fixture/b"],
  });
  expect(backend.mutatePendingChange).not.toHaveBeenCalled();
  expect(document.body.textContent).not.toContain("Cancel shelf preview");
});

it("blocks all-shelf actions while scope completeness is unknown", async () => {
  await mountShelf(false, true);
  const buttons = [
    ...host.querySelectorAll<HTMLButtonElement>(
      ".pending-shelf-actions button",
    ),
  ];
  expect(buttons).toHaveLength(2);
  expect(buttons.every((button) => button.disabled)).toBe(true);
  expect(buttons[0].title).toContain("incomplete");
});
