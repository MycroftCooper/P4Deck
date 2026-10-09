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
} from "../../../shared/contracts/types";
import { messages } from "../../../shared/i18n";
import { PendingPage } from "./PendingPage";

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

it("cancels and ignores a stale response after a rapid filter change", async () => {
  let resolveOld!: (value: PendingChangePage) => void;
  let resolveNew!: (value: PendingChangePage) => void;
  let oldGeneration = 0;
  let newGeneration = 0;
  backend.queryPendingChanges
    .mockReset()
    .mockImplementationOnce((query) => {
      oldGeneration = query.requestGeneration;
      return new Promise((resolve) => (resolveOld = resolve));
    })
    .mockImplementationOnce((query) => {
      newGeneration = query.requestGeneration;
      return new Promise((resolve) => (resolveNew = resolve));
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
  const page = (
    value: PendingChange,
    requestGeneration: number,
  ): PendingChangePage => ({
    requestGeneration,
    items: [value],
    hasMore: false,
    partial: false,
    stats: {
      scannedCount: 1,
      matchedCount: 1,
      truncatedBySafetyLimit: false,
    },
  });
  const newer = { ...change, id: 303, description: "new result" };
  await act(async () => resolveNew(page(newer, newGeneration)));
  expect(host.textContent).toContain("new result");
  await act(async () =>
    resolveOld(page({ ...change, description: "stale result" }, oldGeneration)),
  );
  expect(host.textContent).not.toContain("stale result");
  expect(backend.cancelOperation).toHaveBeenCalled();
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
