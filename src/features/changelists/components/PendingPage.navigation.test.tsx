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
  RuntimeInfo,
} from "../../../shared/contracts/types";
import { messages } from "../../../shared/i18n";
import { PendingPage } from "./PendingPage";

const backend = vi.hoisted(() => ({
  queryPendingChanges: vi.fn(),
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
  backend.queryPendingChanges.mockResolvedValue([change]);
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
  await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  const target = host.querySelector<HTMLElement>('[data-pending-change="202"]');
  expect(target).toBeTruthy();
  expect(document.activeElement).toBe(target);
  expect(host.querySelector(".pending-body")).toBeTruthy();
  expect(host.textContent).toContain("Search target");
});
