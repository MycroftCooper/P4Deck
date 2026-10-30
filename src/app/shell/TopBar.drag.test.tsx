// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { act } from "react";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { dialogHarness } from "../dialogs/testHarness";
import { TopBar } from "./TopBar";
import type { RuntimeInfo } from "../../shared/contracts";
const d = vi.hoisted(() => ({
  native: true,
  label: "main",
  invoke: vi.fn(),
  settings: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => d.native }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ label: d.label }),
}));
vi.mock("./WindowControls", () => ({
  WindowControls: () => (
    <div className="window-controls" data-tauri-drag-region="false">
      <button>
        <svg>
          <path />
        </svg>
      </button>
    </div>
  ),
}));
vi.mock("../../features/workspaces/WorkspaceSwitcher", () => ({
  WorkspaceSwitcher: () => (
    <div className="connection-picker" data-tauri-drag-region="false">
      <button onClick={d.settings}>
        <span>Workspace</span>
      </button>
      <div role="menu">
        <input />
        <select />
        <textarea />
        <div contentEditable suppressContentEditableWarning>
          edit
        </div>
        <button>Menu item</button>
        <p>Menu explanation</p>
      </div>
    </div>
  ),
}));
const h = dialogHarness();
const listeners: Array<[string, EventListener]> = [];
beforeEach(() => {
  d.native = true;
  d.label = "main";
  vi.clearAllMocks();
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
afterEach(() => {
  for (const [type, fn] of listeners) document.removeEventListener(type, fn);
  listeners.length = 0;
});
const mount = () =>
  h.render(
    <TopBar
      runtime={{ context: {} } as RuntimeInfo}
      zh={false}
      onRuntime={() => {}}
      onSettings={() => {}}
    />,
  );
const down = (element: Element, button = 0, detail = 1) =>
  element.dispatchEvent(
    new MouseEvent("mousedown", {
      bubbles: true,
      composed: true,
      button,
      detail,
    }),
  );
it.each([".topbar", ".brand", ".brand-mark", ".brand strong"])(
  "left dragging %s invokes exactly one native drag",
  async (selector) => {
    await mount();
    down(document.querySelector(selector)!);
    expect(d.invoke).toHaveBeenCalledExactlyOnceWith(
      "plugin:window|start_dragging",
    );
  },
);
it("double click delegates one maximize/restore and ignores right/middle clicks", async () => {
  await mount();
  const header = document.querySelector(".topbar")!;
  down(header, 2);
  down(header, 1);
  expect(d.invoke).not.toHaveBeenCalled();
  down(header, 0, 2);
  expect(d.invoke).toHaveBeenCalledExactlyOnceWith(
    "plugin:window|internal_toggle_maximize",
  );
});
it("workspace, inputs, popup text and control icons never drag", async () => {
  await mount();
  for (const el of document.querySelectorAll(
    ".connection-picker,.connection-picker *, .window-controls,.window-controls *",
  )) {
    down(el);
    down(el, 0, 2);
  }
  expect(d.invoke).not.toHaveBeenCalled();
  await act(async () =>
    document
      .querySelector<HTMLButtonElement>(".connection-picker button")!
      .click(),
  );
  expect(d.settings).toHaveBeenCalledOnce();
});
it.each(["browser", "popout"])(
  "does not install main drag regions for %s",
  async (kind) => {
    d.native = kind !== "browser";
    d.label = kind === "popout" ? "popout" : "main";
    await mount();
    expect(
      document.querySelector('[data-tauri-drag-region="deep"]'),
    ).toBeNull();
    down(document.querySelector(".topbar")!);
    expect(d.invoke).not.toHaveBeenCalled();
  },
);

it("nested noninteractive decoration across left middle and right titlebar blanks uses one route", async () => {
  await mount();
  const header = document.querySelector(".topbar")!;
  for (const position of ["left", "middle", "right"]) {
    const outer = document.createElement("div");
    const inner = document.createElement("span");
    inner.dataset.position = position;
    outer.append(inner);
    header.append(outer);
    d.invoke.mockClear();
    down(inner);
    expect(d.invoke).toHaveBeenCalledExactlyOnceWith(
      "plugin:window|start_dragging",
    );
    outer.remove();
  }
});
