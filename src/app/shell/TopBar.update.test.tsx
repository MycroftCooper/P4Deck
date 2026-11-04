// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { dialogHarness } from "../dialogs/testHarness";
import type { RuntimeInfo } from "../../shared/contracts";
import {
  closeUpdatePanel,
  isUpdatePanelOpen,
} from "../update/updatePanelStore";
import { updateStore } from "../update/updateStore";
import { TopBar } from "./TopBar";
import { setLocale } from "../../shared/i18n";

const d = vi.hoisted(() => ({
  native: true,
  label: "main",
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => d.native }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ label: d.label }),
}));
vi.mock("../../features/workspaces/WorkspaceSwitcher", () => ({
  WorkspaceSwitcher: () => (
    <div className="connection-picker" data-tauri-drag-region="false">
      workspace
    </div>
  ),
}));
vi.mock("./WindowControls", () => ({
  WindowControls: () =>
    d.native && d.label === "main" ? (
      <div className="window-controls" data-tauri-drag-region="false">
        controls
      </div>
    ) : null,
}));

const h = dialogHarness();
const listeners: Array<[string, EventListener]> = [];

beforeEach(() => {
  // Components translate through the module-level locale.
  setLocale("en-US");
  vi.clearAllMocks();
  d.native = true;
  d.label = "main";
  closeUpdatePanel();
  updateStore.reset();
  // Exercise the exact lockfile-version Tauri routing, not a reimplementation.
  const script = readFileSync(
    "tests/fixtures/tauri-2.11.5-drag.js",
    "utf8",
  ).replace("__TEMPLATE_os_name__", JSON.stringify("windows"));
  new Function("document", "window", "HTMLElement", script)(
    {
      addEventListener: (type: string, fn: EventListener) => {
        listeners.push([type, fn]);
        document.addEventListener(type, fn);
      },
    },
    { __TAURI_INTERNALS__: { invoke: d.invoke } },
    HTMLElement,
  );
});

afterEach(async () => {
  for (const [type, fn] of listeners) document.removeEventListener(type, fn);
  listeners.length = 0;
  await act(async () => {
    updateStore.reset();
    closeUpdatePanel();
  });
});

const mount = (zh = true) =>
  h.render(
    <TopBar
      runtime={{ context: {} } as RuntimeInfo}
      zh={zh}
      onRuntime={() => {}}
      onSettings={() => {}}
    />,
  );

const entry = () =>
  document.querySelector<HTMLButtonElement>("[data-update-entry]");

const down = (element: Element) =>
  element.dispatchEvent(
    new MouseEvent("mousedown", {
      bubbles: true,
      composed: true,
      button: 0,
      detail: 1,
    }),
  );

async function seed(patch: Parameters<typeof updateStore.patch>[0]) {
  await act(async () => {
    updateStore.patch(patch);
  });
}

it("adds no entry while idle and keeps the titlebar order and drag region", async () => {
  await mount();
  expect(entry()).toBeNull();
  const header = document.querySelector(".topbar")!;
  expect(header.getAttribute("data-tauri-drag-region")).toBe("deep");
  expect(
    [...header.children].map(
      (child) => child.className || child.tagName.toLowerCase(),
    ),
  ).toEqual(["brand", "connection-picker", "window-controls"]);
});

it("shows the new version between the workspace switcher and window controls", async () => {
  await seed({
    phase: "available",
    currentVersion: "0.1.6",
    version: "0.1.7",
  });
  await mount();
  const button = entry()!;
  expect(button.textContent).toContain("有新版本 v0.1.7");
  expect(button.getAttribute("aria-label")).toContain("有新版本 v0.1.7");
  expect([...document.querySelector(".topbar")!.children].indexOf(button)).toBe(
    2,
  );
  await act(async () => button.click());
  expect(isUpdatePanelOpen()).toBe(true);
});

it("localizes the entry and keeps its state label", async () => {
  await seed({ phase: "available", currentVersion: "0.1.6", version: "0.1.7" });
  await mount(false);
  expect(entry()!.textContent).toContain("New version v0.1.7");

  await seed({
    phase: "downloading",
    totalBytes: 1000,
    downloadedBytes: 250,
  });
  expect(entry()!.textContent).toContain("25%");
  expect(entry()!.getAttribute("aria-label")).toContain("25%");

  await seed({ phase: "installing" });
  expect(entry()!.textContent).toContain("Installing update");

  await seed({ phase: "ready" });
  expect(entry()!.textContent).toContain("Restart to update v0.1.7");

  await seed({ phase: "error", errorScope: "download" });
  expect(entry()!.textContent).toContain("Update failed");

  await seed({ phase: "error", errorScope: "restart", applied: true });
  expect(entry()!.textContent).toContain("Restart pending");
});

it("never turns the entry into a drag region and keeps the rest draggable", async () => {
  await seed({ phase: "available", currentVersion: "0.1.6", version: "0.1.7" });
  await mount();
  const button = entry()!;
  expect(button.getAttribute("data-tauri-drag-region")).toBe("false");
  down(button);
  expect(d.invoke).not.toHaveBeenCalled();
  down(document.querySelector(".topbar")!);
  expect(d.invoke).toHaveBeenCalledExactlyOnceWith(
    "plugin:window|start_dragging",
  );
});

it("does not render the entry outside the main native window", async () => {
  await seed({ phase: "available", currentVersion: "0.1.6", version: "0.1.7" });
  d.label = "popout";
  await mount();
  expect(entry()).toBeNull();
  expect(document.querySelector(".window-controls")).toBeNull();
});
