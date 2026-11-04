// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { it, expect, vi } from "vitest";
import { PendingPage } from "../changelists/components/PendingPage";
import { activateLocale, messages } from "../../shared/i18n";
import {
  MenuEnvironment,
  type MenuEnvironmentValue,
} from "../../app/context-menu/environment";
import { ContextMenuProvider } from "../../app/context-menu/ContextMenu";
import { defaultUi } from "../settings/preferences";
import type { PendingChange, RuntimeInfo } from "../../shared/contracts";
const deps = vi.hoisted(() => ({
  read: vi.fn(),
  menus: new Map<
    string,
    Record<string, { run?: (source?: HTMLElement) => void; reason?: string }>
  >(),
}));
vi.mock("../../infrastructure/backend", () => ({
  backend: { companySubmitConnectionSnapshot: deps.read },
}));
vi.mock("../changelists/pendingCache", async (importOriginal) => ({
  // Keep real exports (e.g. pendingSnapshotKey used by shelfObservation) while
  // replacing only the React cache hook this smoke test needs to control.
  ...(await importOriginal<typeof import("../changelists/pendingCache")>()),
  usePendingCache: () => ({
    changes: [0, 10, 20].map(
      (id) =>
        ({
          id,
          description: "synthetic",
          files: [],
          shelvedFiles: [],
          jobs: [],
          user: "fixture",
          client: "synthetic",
          status: "pending",
        }) satisfies PendingChange,
    ),
    data: { stats: { scannedCount: 3, matchedCount: 3 } },
    updateChanges: () => {},
    refresh: async () => {},
    error: "",
  }),
}));
vi.mock("../../app/context-menu/ContextMenu", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../app/context-menu/ContextMenu")
  >()),
  useContextMenu:
    () =>
    (
      scope: string,
      bindings: () => Record<string, { run?: () => void; reason?: string }>,
    ) => ({
      onContextMenu: (e: Event) => {
        e.preventDefault();
        deps.menus.set(scope, bindings());
      },
    }),
}));
it("removes the standalone preview from all Pending menus while retaining original Submit", async () => {
  // This suite renders the English UI; align the module resolver.
  activateLocale("en-US");
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value: function () {
      this.open = true;
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, "close", {
    configurable: true,
    value: function () {
      this.open = false;
    },
  });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const runtime: RuntimeInfo = {
    mode: "tauri",
    p4Version: "synthetic",
    activeProfileId: "fixture",
    contextGeneration: 1,
    context: {
      server: "synthetic.invalid:1666",
      user: "fixture",
      client: "synthetic",
    },
    connection: {
      state: "connected",
      message: "synthetic",
      recovery: "none",
      server: "synthetic.invalid:1666",
    },
  };
  const env = {
    runtime,
    connectionKey: "synthetic",
    commandBusy: false,
    preferences: {
      locale: "en-US",
      zh: false,
      t: messages["en-US"],
      ui: defaultUi,
    },
  } as MenuEnvironmentValue;
  deps.read.mockResolvedValue({
    profileId: "fixture",
    generation: "9007199254740993",
    ...runtime.context,
  });
  const render = (key: string) =>
    act(async () =>
      root.render(
        <ContextMenuProvider scope="company" zh={false}>
          <MenuEnvironment.Provider value={env}>
            <PendingPage
              t={messages["en-US"]}
              clientName="synthetic"
              connectionKey={key}
              demo={false}
              ready
            />
          </MenuEnvironment.Provider>
        </ContextMenuProvider>,
      ),
    );
  const menu = async (id: number) =>
    act(async () =>
      host
        .querySelector(`[data-pending-change="${id}"]`)!
        .dispatchEvent(
          new MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
        ),
    );
  try {
    await render("one");
    await menu(0);
    expect(deps.menus.get("C01")!["公司提交预览…"]).toBeUndefined();
    await menu(10);
    expect(deps.menus.get("C02")!["公司提交预览…"]).toBeUndefined();
    expect(host.querySelector('[aria-label="Submit CL 10"]')).not.toBeNull();
    expect(deps.read).not.toHaveBeenCalled();
    await render("two");
    expect(document.querySelector("dialog")).toBeNull();
    await act(async () => {
      host
        .querySelector('[data-pending-change="10"]')!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
      host
        .querySelector('[data-pending-change="20"]')!
        .dispatchEvent(
          new MouseEvent("click", { bubbles: true, ctrlKey: true }),
        );
    });
    await menu(20);
    expect(deps.menus.get("C12")!["公司提交预览…"]).toBeUndefined();
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});
