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

it("keeps the resizable header on the rows' column tracks inside one scroll box", async () => {
  const files = Array.from({ length: 3 }, (_, index) => ({
    depotPath: `//depot/main/FormationZone${index}.cs`,
    action: "integrate",
    revision: index + 7,
    changeId: 11562403,
  }));
  await act(async () =>
    root.render(
      <ContextMenuProvider scope="files" zh={false}>
        <MenuEnvironment.Provider value={environment}>
          <RevisionFileList files={files} scope="11562403" demo={false} />
        </MenuEnvironment.Provider>
      </ContextMenuProvider>,
    ),
  );
  const list = host.querySelector<HTMLElement>(
    '[data-testid="revision-file-virtual-list"]',
  )!;
  const header = list.querySelector<HTMLElement>(".workspace-head")!;
  const rows = [...list.querySelectorAll<HTMLButtonElement>('[role="option"]')];
  // One scroll box owns vertical scrolling (header sticks) and horizontal
  // scrolling, so the header cannot drift from the rows it labels.
  expect(header.parentElement).toBe(list);
  expect(header.style.gridTemplateColumns).not.toBe("");
  expect(rows).toHaveLength(files.length);
  for (const row of rows) {
    expect(row.style.gridTemplateColumns).toBe(
      header.style.gridTemplateColumns,
    );
    expect(row.style.minWidth).toBe(header.style.minWidth);
    // Rows live below the sticky header, never underneath it.
    expect(
      Number(/translateY\((-?[\d.]+)px\)/.exec(row.style.transform)![1]),
    ).toBeGreaterThanOrEqual(0);
  }
  // Resize grips stay inside the header cells, after the label.
  expect(header.querySelectorAll('[role="separator"]')).toHaveLength(
    header.children.length,
  );
});

it("lays every row out as a grid so action and revision keep their own cells", async () => {
  // Real `p4 -ztag -Mj describe -s 11562403`: one action per file, and the file
  // path is long enough to overflow any flex-based row.
  const files = [
    "FormationZoneQuery.cs",
    "FormationZoneSolver.cs",
    "FormationZoneTypes.cs",
  ].map((name, index) => ({
    depotPath: `//DM42.Beyond.Project/Development/Beyond_v2d0/Assets/Beyond/Scripts/Gameplay/RemoteFactory/FormationZone/${name}`,
    action: "integrate",
    revision: [14, 7, 11][index],
    fileType: "text",
    changeId: 11562403,
  }));
  await act(async () =>
    root.render(
      <ContextMenuProvider scope="files" zh={false}>
        <MenuEnvironment.Provider value={environment}>
          <RevisionFileList files={files} scope="11562403" demo={false} />
        </MenuEnvironment.Provider>
      </ContextMenuProvider>,
    ),
  );
  const rows = [...host.querySelectorAll<HTMLButtonElement>('[role="option"]')];
  expect(rows).toHaveLength(files.length);
  for (const [index, row] of rows.entries()) {
    // A shared stylesheet made these rows `display: flex`; that silently drops
    // grid-template-columns and squeezes action/revision into the path cell.
    expect(row.style.display).toBe("grid");
    // Cell order is fixed: icon, path, action, revision.
    const cells = [...row.children] as HTMLElement[];
    expect(cells).toHaveLength(4);
    expect(cells[1].textContent).toBe(files[index].depotPath);
    expect(cells[2].textContent).toBe("integrate");
    expect(cells[3].textContent).toBe(`#${files[index].revision}`);
    // The action/revision cells are real children of the grid, not nested in
    // the path cell, so they own their column track.
    expect(cells[2].parentElement).toBe(row);
    expect(cells[3].parentElement).toBe(row);
  }
});

it("keeps every row cell on the same track as its header column", async () => {
  const files = ["FormationZoneQuery.cs", "FormationZoneSolver.cs"].map(
    (name, index) => ({
      depotPath: `//DM42.Beyond.Project/Development/Beyond_v2d0/Assets/Beyond/Scripts/Gameplay/RemoteFactory/FormationZone/${name}`,
      action: "integrate",
      revision: [14, 7][index],
      changeId: 11562403,
    }),
  );
  await act(async () =>
    root.render(
      <ContextMenuProvider scope="files" zh={false}>
        <MenuEnvironment.Provider value={environment}>
          <RevisionFileList files={files} scope="11562403" demo={false} />
        </MenuEnvironment.Provider>
      </ContextMenuProvider>,
    ),
  );
  const list = host.querySelector<HTMLElement>(
    '[data-testid="revision-file-virtual-list"]',
  )!;
  const header = list.querySelector<HTMLElement>(".workspace-head")!;
  const rows = [...list.querySelectorAll<HTMLButtonElement>('[role="option"]')];
  const headerTracks = header.style.gridTemplateColumns;
  expect(headerTracks).not.toBe("");
  for (const row of rows) {
    expect(row.style.gridTemplateColumns).toBe(headerTracks);
    // One cell per header column, or trailing cells fall off the grid.
    expect(row.children.length).toBe(header.children.length);
    // A column gap shifts every cell right of its header divider, so text rides
    // over the column line instead of starting under its own header.
    expect(row.style.columnGap || row.style.gap || "").toBe("");
  }
});
