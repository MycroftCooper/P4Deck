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
import { CommandContext } from "../../../app/shell/CommandContext";
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
  vi.unstubAllGlobals();
});

async function renderTable(
  files: PendingFile[],
  drag = vi.fn(),
  focus = vi.fn(),
  changeId = 42,
) {
  await act(async () =>
    root.render(
      <ContextMenuProvider scope="pending-table" zh={false}>
        <MenuEnvironment.Provider value={environment}>
          <CommandContext.Provider value={focus}>
            <PendingFileList
              files={files}
              changeId={changeId}
              refresh={vi.fn()}
              onDragFiles={drag}
            />
          </CommandContext.Provider>
        </MenuEnvironment.Provider>
      </ContextMenuProvider>,
    ),
  );
}
const tablePaths = () =>
  [...host.querySelectorAll(".pending-file-path")].map(
    (element) => element.textContent,
  );
async function filterBy(label: string, value: string) {
  const select = host.querySelector<HTMLSelectElement>(
    `[aria-label="${label}"]`,
  )!;
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
const tableFiles: PendingFile[] = [
  {
    depotPath: "//depot/aaa.cs",
    clientPath: "//workspace/Scripts/z10.CS",
    action: "edit",
    state: "openedEdit",
  },
  {
    depotPath: "//depot/zzz.mat",
    clientPath: "//workspace/Assets/a2.mat",
    action: "delete",
    state: "openedDelete",
  },
  {
    depotPath: "//depot/mmm.cs",
    clientPath: "//workspace/Scripts/z2.cs",
    action: "add",
    state: "openedAdd",
  },
  {
    depotPath: "//depot/hidden",
    clientPath: "//workspace/.p4ignore",
    action: "edit",
    state: "openedEdit",
  },
];

it("shows file names before paths, sorts by displayed relative paths, and keeps actions bound to the sorted file", async () => {
  const drag = vi.fn();
  await renderTable(tableFiles, drag);
  expect(host.querySelectorAll('[role="columnheader"]')).toHaveLength(5);
  expect(
    [...host.querySelectorAll(".pending-file-name")].map(
      (cell) => cell.textContent,
    ),
  ).toEqual([".p4ignore", "a2.mat", "z2.cs", "z10.CS"]);
  expect(host.querySelector(".pending-file-name")?.getAttribute("title")).toBe(
    ".p4ignore",
  );
  expect(
    host.querySelector('[role="grid"]')?.getAttribute("aria-rowcount"),
  ).toBe("5");
  expect(tablePaths()).toEqual([
    ".p4ignore",
    "Assets/a2.mat",
    "Scripts/z2.cs",
    "Scripts/z10.CS",
  ]);
  const sort = host.querySelector<HTMLButtonElement>(
    '[aria-label="Sort by path"]',
  )!;
  await act(async () => sort.click());
  expect(sort.parentElement?.getAttribute("aria-sort")).toBe("descending");
  expect(tablePaths()).toEqual([
    "Scripts/z10.CS",
    "Scripts/z2.cs",
    "Assets/a2.mat",
    ".p4ignore",
  ]);
  const first = host.querySelector<HTMLElement>(".pending-file")!;
  expect(first.querySelector(".pending-file-status")?.textContent).toBe("edit");
  expect(first.querySelector(".pending-file-type")?.textContent).toBe(".cs");
  expect(
    first.querySelector(".file-status-icon")?.getAttribute("aria-label"),
  ).toContain("Open for edit");
  await act(async () =>
    first.dispatchEvent(new MouseEvent("click", { bubbles: true })),
  );
  const event = new Event("dragstart", { bubbles: true });
  await act(async () => first.dispatchEvent(event));
  expect(drag.mock.calls[0][0]).toEqual(["//depot/aaa.cs"]);
});

it("combines state and case-insensitive suffix filters, includes extensionless files and clears hidden selections", async () => {
  await renderTable(tableFiles);
  const first = host.querySelector<HTMLElement>(".pending-file")!;
  await act(async () =>
    first.dispatchEvent(new MouseEvent("click", { bubbles: true })),
  );
  await filterBy("Filter by status", "edit");
  await filterBy("Filter by type", ".cs");
  expect(tablePaths()).toEqual(["Scripts/z10.CS"]);
  expect(host.querySelector('.pending-file[aria-selected="true"]')).toBeNull();
  await filterBy("Filter by status", "delete");
  expect(tablePaths()).toEqual([]);
  expect(host.textContent).toContain("No matching files");
  const clear = [...host.querySelectorAll("button")].find(
    (button) => button.textContent === "Clear filters",
  )!;
  await act(async () => clear.click());
  expect(tablePaths()).toHaveLength(4);
  await filterBy("Filter by type", "(none)");
  expect(tablePaths()).toEqual([".p4ignore"]);
  expect(host.querySelector(".pending-file-type")?.textContent).toBe(
    "No extension",
  );
  await renderTable(tableFiles.slice(0, 3));
  expect(tablePaths()).toEqual([]);
  expect(
    host.querySelector<HTMLSelectElement>('[aria-label="Filter by type"]')
      ?.value,
  ).toBe("(none)");
  expect(host.textContent).toContain("No matching files");
});

it("windows 100,000 pending files and preserves keyboard focus and selection", { timeout: 15_000 }, async () => {
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
  let rows = list.querySelectorAll<HTMLElement>('.pending-file[role="row"]');
  expect(rows.length).toBeGreaterThan(1);
  expect(rows.length).toBeLessThan(40);
  expect(
    list.querySelector<HTMLElement>(".pending-file-spacer")!.style.height,
  ).toBe("3000000px");

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
  rows = list.querySelectorAll<HTMLElement>('.pending-file[role="row"]');
  expect(rows.length).toBeLessThan(40);
});

it("freezes selected opened files for drag while shelves remain non-draggable", async () => {
  const files: PendingFile[] = [
    {
      depotPath: "//depot/a b.txt",
      clientPath: "//workspace/Assets/a b.txt",
      action: "edit",
    },
    {
      depotPath: "//depot/项目.txt",
      clientPath: "//workspace/Scripts/项目.txt",
      action: "add",
    },
  ];
  const drag = vi.fn();
  const render = (shelf = false) =>
    root.render(
      <ContextMenuProvider scope={`pending-drag-${shelf}`} zh={false}>
        <MenuEnvironment.Provider value={environment}>
          <PendingFileList
            files={files}
            changeId={42}
            shelf={shelf}
            refresh={vi.fn()}
            onDragFiles={drag}
          />
        </MenuEnvironment.Provider>
      </ContextMenuProvider>,
    );
  await act(async () => render());
  const rows = host.querySelectorAll<HTMLElement>('.pending-file[role="row"]');
  expect(rows[0].querySelector(".pending-file-path")?.textContent).toBe(
    "Assets/a b.txt",
  );
  expect(
    rows[0].querySelector(".pending-file-path")?.getAttribute("title"),
  ).toBe("Assets/a b.txt");
  expect(rows[1].querySelector(".pending-file-path")?.textContent).toBe(
    "Scripts/项目.txt",
  );
  await act(async () => {
    rows[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    rows[1].dispatchEvent(
      new MouseEvent("click", { bubbles: true, ctrlKey: true }),
    );
  });
  const event = new Event("dragstart", { bubbles: true });
  Object.defineProperty(event, "dataTransfer", {
    value: { effectAllowed: "none", setData: vi.fn() },
  });
  await act(async () => rows[1].dispatchEvent(event));
  expect(drag.mock.calls[0][0]).toEqual([
    "//depot/a b.txt",
    "//depot/项目.txt",
  ]);
  expect(rows[0].draggable).toBe(true);

  await act(async () => render(true));
  expect(
    host.querySelector<HTMLElement>('.pending-file[role="row"]')!.draggable,
  ).toBe(false);
});

it("marks only a complete pending file selection as a whole changelist", async () => {
  const focus = vi.fn();
  await renderTable(tableFiles, vi.fn(), focus);
  let rows = host.querySelectorAll<HTMLElement>('.pending-file[role="row"]');
  await act(async () => {
    rows[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    for (const row of [...rows].slice(1))
      row.dispatchEvent(
        new MouseEvent("click", { bubbles: true, ctrlKey: true }),
      );
  });
  expect(focus.mock.lastCall?.[0]).toMatchObject({
    type: "file",
    wholeChangelistId: 42,
  });
  expect(focus.mock.lastCall?.[0].nodes).toHaveLength(4);

  await act(async () =>
    rows[0].dispatchEvent(new MouseEvent("click", { bubbles: true })),
  );
  expect(focus.mock.lastCall?.[0]).not.toHaveProperty("wholeChangelistId");

  await renderTable(tableFiles, vi.fn(), focus, 0);
  rows = host.querySelectorAll<HTMLElement>('.pending-file[role="row"]');
  await act(async () => {
    rows[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    for (const row of [...rows].slice(1))
      row.dispatchEvent(
        new MouseEvent("click", { bubbles: true, ctrlKey: true }),
      );
  });
  expect(focus.mock.lastCall?.[0]).toMatchObject({
    type: "file",
    wholeChangelistId: 0,
  });
});
