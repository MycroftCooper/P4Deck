// @vitest-environment jsdom
import { act } from "react";
import { afterEach, expect, it, vi, beforeEach } from "vitest";
import {
  getShortcutOverrides,
  resetShortcutOverrides,
  setShortcutOverride,
} from "../commands/keymap";
import { dialogHarness } from "../dialogs/testHarness";
import { CommandBar } from "./CommandBar";
import type { RuntimeInfo } from "../../shared/contracts";
import { setLocale } from "../../shared/i18n";

afterEach(() => {
  resetShortcutOverrides();
  localStorage.removeItem("p4deck.keymap:environment");
});

vi.mock("../../infrastructure/backend", () => ({
  backend: {
    subscribeOperationEvents: async () => () => {},
    companySubmitConnectionSnapshot: vi.fn(),
    listConnectionProfiles: vi.fn(),
    customSubmitStart: vi.fn(),
    customSubmitStatus: vi.fn(),
    localPathCapabilities: vi.fn(),
  },
}));
vi.mock("../context-menu/ContextMenu", () => ({
  useContextMenu: () => () => ({}),
}));
vi.mock("../context-menu/environment", () => ({
  useMenuEnvironment: () => ({
    preferences: { ui: { toolbarText: true } },
    openPage: vi.fn(),
  }),
}));
vi.mock("../dialogs/useCommandDialogs", () => ({
  useCommandDialogs: () => ({ pending: false, element: null }),
  refreshFileLockFacts: vi.fn(),
}));
vi.mock("./useLocalPathCapabilities", () => ({
  useLocalPathCapabilities: () => ({ reveal: false, openWith: false }),
}));

const root = dialogHarness();
const runtime: RuntimeInfo = {
  mode: "mock",
  p4Version: "synthetic",
  contextGeneration: 1,
  context: { server: "fixture.invalid", user: "u", client: "c" },
  connection: {
    state: "connected",
    message: "mock",
    recovery: "none",
    server: "fixture.invalid",
  },
};

// Components translate through the module-level locale.
beforeEach(() => {
  setLocale("en-US");
});

it("focuses and selects the unified address bar for navigation.focusAddress", async () => {
  await root.render(
    <CommandBar
      runtime={runtime}
      zh={false}
      connectionKey="fixture"
      target={{
        type: "file",
        node: {
          id: "//fixture/a",
          depotPath: "//fixture/a",
          name: "a",
          kind: "file",
          absolutePath: "",
          relativePath: "a",
          state: "openedEdit",
        },
      }}
      targetError=""
      onBusyChange={vi.fn()}
      onOpenOperations={vi.fn()}
      registerCommand={vi.fn()}
      onNavigate={vi.fn()}
      onFocus={vi.fn()}
      onReview={vi.fn()}
    />,
  );
  const input = document.querySelector<HTMLInputElement>(
    'input[aria-label="Address"]',
  )!;
  expect(input).toBeTruthy();
  const background = document.createElement("button");
  document.body.append(background);
  background.focus();
  expect(document.activeElement).toBe(background);
  await act(async () => {
    window.dispatchEvent(new Event("p4deck:focus-address"));
  });
  expect(document.activeElement).toBe(input);
  expect(input.value).toBe("//fixture/a");
  expect(input.selectionStart).toBe(0);
  expect(input.selectionEnd).toBe(input.value.length);
  background.remove();
});

it("ignores the focus event when the address input is disabled", async () => {
  await root.render(
    <CommandBar
      runtime={{ ...runtime, p4Version: "loading" }}
      zh={false}
      connectionKey="fixture"
      target={{ type: "none" }}
      targetError=""
      onBusyChange={vi.fn()}
      onOpenOperations={vi.fn()}
      registerCommand={vi.fn()}
      onNavigate={vi.fn()}
      onFocus={vi.fn()}
      onReview={vi.fn()}
    />,
  );
  const input = document.querySelector<HTMLInputElement>(
    'input[aria-label="Address"]',
  )!;
  expect(input.disabled).toBe(true);
  await act(async () => {
    window.dispatchEvent(new Event("p4deck:focus-address"));
  });
  expect(document.activeElement).not.toBe(input);
});

it("loads the persisted profile keymap on mount and saves later edits", async () => {
  localStorage.setItem(
    "p4deck.keymap:environment",
    JSON.stringify({
      schemaVersion: 1,
      profileId: "environment",
      bindings: { "view.pending": "Mod+Shift+9" },
    }),
  );
  await root.render(
    <CommandBar
      runtime={runtime}
      zh={false}
      connectionKey="fixture"
      target={{ type: "none" }}
      targetError=""
      onBusyChange={vi.fn()}
      onOpenOperations={vi.fn()}
      registerCommand={vi.fn()}
      onNavigate={vi.fn()}
      onFocus={vi.fn()}
      onReview={vi.fn()}
    />,
  );
  expect(getShortcutOverrides()).toEqual({ "view.pending": "Mod+Shift+9" });
  await act(async () => setShortcutOverride("view.streams", "Mod+Shift+8"));
  const stored = JSON.parse(localStorage.getItem("p4deck.keymap:environment")!);
  expect(stored.bindings).toEqual({
    "view.pending": "Mod+Shift+9",
    "view.streams": "Mod+Shift+8",
  });
});
