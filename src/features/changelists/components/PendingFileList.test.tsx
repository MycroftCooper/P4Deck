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
import type { PendingFile, RuntimeInfo } from "../../../shared/contracts/types";
import { PendingFileList } from "./PendingFileList";

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
  await act(
    async () =>
      new Promise<void>((resolve) => setTimeout(() => resolve(), 200)),
  );
  await act(async () => root.unmount());
  host.remove();
});

it("windows 100,000 pending files and preserves keyboard focus and selection", async () => {
  const files: PendingFile[] = Array.from({ length: 100_000 }, (_, index) => ({
    depotPath: `//depot/长路径/${String(index).padStart(6, "0")}/file-${index}.txt`,
    action: index % 3 === 0 ? "add" : index % 3 === 1 ? "edit" : "delete",
    state: index % 3 === 0 ? "openedAdd" : "openedEdit",
  }));
  await act(async () =>
    root.render(
      <ContextMenuProvider scope="pending-files" zh={false}>
        <MenuEnvironment.Provider value={environment}>
          <PendingFileList files={files} changeId={42} refresh={vi.fn()} />
        </MenuEnvironment.Provider>
      </ContextMenuProvider>,
    ),
  );
  await act(
    async () =>
      new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
  );
  const list = host.querySelector<HTMLElement>(
    '[data-testid="pending-file-virtual-list"]',
  )!;
  let rows = list.querySelectorAll<HTMLElement>('[role="option"]');
  expect(rows.length).toBeGreaterThan(1);
  expect(rows.length).toBeLessThan(40);
  expect(
    list.querySelector<HTMLElement>(".pending-file-spacer")!.style.height,
  ).toBe("3600000px");

  await act(async () => {
    rows[0].focus();
    rows[0].dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
    );
  });
  await act(
    async () =>
      new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
  );
  const next = list.querySelector<HTMLElement>(
    '[data-pending-file-index="1"]',
  )!;
  expect(document.activeElement).toBe(next);
  await act(async () =>
    next.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    ),
  );
  expect(next.getAttribute("aria-selected")).toBe("true");
  rows = list.querySelectorAll<HTMLElement>('[role="option"]');
  expect(rows.length).toBeLessThan(40);
});
