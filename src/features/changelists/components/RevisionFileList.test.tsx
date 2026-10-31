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
import { messages } from "../../../shared/i18n";
import type { RuntimeInfo } from "../../../shared/contracts";
import { RevisionFileList } from "./RevisionFileList";

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

const environment: MenuEnvironmentValue = {
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

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

it("windows a large submitted file list and supports roving keyboard focus", async () => {
  const files = Array.from({ length: 10_000 }, (_, index) => ({
    depotPath: `//depot/main/file-${String(index).padStart(5, "0")}.ts`,
    action: index % 2 ? "edit" : "add",
    revision: index + 1,
    changeId: 42,
  }));
  await act(async () =>
    root.render(
      <ContextMenuProvider scope="files" zh={false}>
        <MenuEnvironment.Provider value={environment}>
          <RevisionFileList files={files} scope="42" demo={false} />
        </MenuEnvironment.Provider>
      </ContextMenuProvider>,
    ),
  );
  await act(
    async () =>
      new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
  );
  const list = host.querySelector<HTMLElement>(
    '[data-testid="revision-file-virtual-list"]',
  )!;
  const rendered = list.querySelectorAll<HTMLButtonElement>('[role="option"]');
  expect(rendered.length).toBeGreaterThan(1);
  expect(rendered.length).toBeLessThan(40);
  expect(
    list.querySelector<HTMLElement>(".revision-file-spacer")!.style.height,
  ).toBe("400000px");
  await act(async () => {
    rendered[0].focus();
    rendered[0].dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
    );
  });
  await act(
    async () =>
      new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
  );
  expect(document.activeElement).toBe(
    list.querySelector<HTMLButtonElement>('[data-file-index="1"]'),
  );
});
