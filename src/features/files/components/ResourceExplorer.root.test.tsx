// @vitest-environment jsdom
import { act, useCallback, useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { dialogHarness } from "../../../app/dialogs/testHarness";
import { ResourceExplorer } from "./ResourceExplorer";
import { SelectionContext } from "../SelectionContext";
import { selectionRequest } from "../selectionCommands";
import { flattenResourceTree, type ResourceFolder } from "../resourceTree";
import type { WorkspaceNode } from "../../../shared/contracts";
import { messages } from "../../../shared/i18n";

const d = vi.hoisted(() => ({
  tree: {} as any,
  cwd: "C:/fixture",
  select: vi.fn(),
  menuCalls: [] as Array<{
    nodes: WorkspaceNode[];
    primary: WorkspaceNode;
    options: { object?: string; onOpen?: () => void };
  }>,
  menuOpen: undefined as (() => void) | undefined,
}));
vi.mock("../useResourceTree", () => ({ useResourceTree: () => d.tree }));
vi.mock("../workspaceQueries", () => ({
  canListWorkspace: () => Boolean(d.cwd),
}));
vi.mock("../../../app/context-menu/useFileMenu", () => ({
  useFileMenu:
    () =>
    (
      nodes: WorkspaceNode[],
      primary: WorkspaceNode,
      options: { object?: string; onOpen?: () => void } = {},
    ) => {
      d.menuCalls.push({ nodes, primary, options });
      if (options.object === "F05") d.menuOpen = options.onOpen;
      return {
        onContextMenu: (event: { preventDefault(): void }) => {
          event.preventDefault();
          options.onOpen?.();
        },
        onKeyDown: () => {},
      };
    },
}));
vi.mock("../../../app/context-menu/useDirectoryMenu", () => ({
  useDirectoryMenu: () => ({ onKeyDown: () => {} }),
}));
vi.mock("../../../app/context-menu/ContextMenu", () => ({
  useContextMenu: () => () => ({}),
}));
vi.mock("../../../app/context-menu/environment", () => ({
  useMenuEnvironment: () => ({
    runtime: {
      context: { cwd: d.cwd },
      p4Version: "test",
      connection: { state: "connected" },
    },
    openPage: () => {},
  }),
}));
vi.mock("./FileStatusIcon", () => ({ FileStatusIcon: () => null }));
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    scrollToIndex: () => {},
    getTotalSize: () => count * 33,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        index,
        key: index,
        start: index * 33,
        size: 33,
      })),
  }),
}));

const h = dialogHarness();
const node = (
  name: string,
  kind: "file" | "directory" = "file",
): WorkspaceNode => ({
  id: name,
  name,
  absolutePath: `C:/fixture/${name}`,
  relativePath: name,
  kind,
  state: "controlled",
});
const dir = node("dir", "directory");
const a = node("dir/a");
const loaded = (items: WorkspaceNode[]): ResourceFolder => ({
  items,
  loaded: true,
  loading: false,
});
function seedTree() {
  const folders = new Map([
    ["", loaded([dir])],
    [dir.absolutePath, loaded([a])],
  ]);
  const expanded = new Set([dir.absolutePath]);
  d.tree = {
    folders,
    expanded,
    rows: flattenResourceTree("workspace", expanded, folders),
    root: folders.get(""),
    toggle: vi.fn(),
    refresh: vi.fn(),
  };
}
function Harness() {
  const [nodes, setNodes] = useState<WorkspaceNode[]>([]);
  const select = useCallback(
    (next: WorkspaceNode[], primary?: WorkspaceNode) => {
      setNodes(next);
      d.select(next, primary);
    },
    [],
  );
  return (
    <SelectionContext.Provider value={{ nodes, select }}>
      <ResourceExplorer
        collapsed={false}
        onToggle={() => {}}
        zh={false}
        t={messages["en-US"]}
        mode="workspace"
        onModeChange={() => {}}
        clientName="fixture"
        connectionKey="scope"
        ready
        workspaceReady
        onNavigate={() => {}}
      />
    </SelectionContext.Provider>
  );
}
const mount = () => h.render(<Harness />);
const rootRow = () => document.querySelector<HTMLElement>(".tree-root")!;
const toggle = () =>
  rootRow().querySelector<HTMLButtonElement>(".tree-toggle")!;
beforeEach(() => {
  vi.clearAllMocks();
  d.cwd = "C:/fixture";
  d.menuCalls = [];
  d.menuOpen = undefined;
  seedTree();
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => {});
});
afterEach(() => vi.unstubAllGlobals());

it("selects the configured root on click and content rows replace that selection", async () => {
  await mount();
  expect(rootRow().getAttribute("aria-selected")).toBe("false");
  await act(async () => rootRow().click());
  expect(d.select).toHaveBeenLastCalledWith(
    [
      expect.objectContaining({
        kind: "directory",
        absolutePath: "C:/fixture",
      }),
    ],
    expect.objectContaining({ kind: "directory", absolutePath: "C:/fixture" }),
  );
  expect(rootRow().getAttribute("aria-selected")).toBe("true");
  expect(rootRow().classList.contains("selected")).toBe(true);
  // The selected root feeds the existing Get Latest path builder unchanged.
  const rootNode: WorkspaceNode = {
    id: "C:/fixture",
    name: "fixture",
    absolutePath: "C:/fixture",
    relativePath: "",
    kind: "directory",
    state: "controlled",
  };
  expect(selectionRequest("getLatest", [rootNode]).paths).toEqual([
    "C:/fixture/...",
  ]);
  const contentRow = document.querySelector<HTMLElement>(
    '[data-resource-path="C:/fixture/dir"]',
  )!;
  await act(async () => contentRow.click());
  expect(d.select).toHaveBeenLastCalledWith([dir], dir);
  expect(rootRow().getAttribute("aria-selected")).toBe("false");
});

it("selects the root with Enter/Space and keeps chevron as expand/collapse only", async () => {
  await mount();
  const root = rootRow();
  await act(async () =>
    root.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    ),
  );
  expect(d.select).toHaveBeenLastCalledWith(
    [expect.objectContaining({ absolutePath: "C:/fixture" })],
    expect.anything(),
  );
  d.select.mockClear();
  await act(async () =>
    root.dispatchEvent(
      new KeyboardEvent("keydown", { key: " ", bubbles: true }),
    ),
  );
  expect(d.select).toHaveBeenCalledTimes(1);
  // Chevron only toggles; it must not change the selection.
  d.select.mockClear();
  const before = toggle().getAttribute("aria-expanded");
  await act(async () => toggle().click());
  expect(d.select).not.toHaveBeenCalled();
  expect(toggle().getAttribute("aria-expanded")).not.toBe(before);
  // Arrow keys still expand/collapse the root.
  await act(async () =>
    root.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }),
    ),
  );
  expect(toggle().getAttribute("aria-expanded")).toBe("false");
  await act(async () =>
    root.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
    ),
  );
  expect(toggle().getAttribute("aria-expanded")).toBe("true");
});

it("right-clicking the root selects it first and keeps the F05 workspace menu", async () => {
  await mount();
  await act(async () => {
    rootRow().dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
    );
  });
  const f05 = d.menuCalls.find((call) => call.options.object === "F05")!;
  expect(f05.nodes).toHaveLength(1);
  expect(f05.nodes[0]).toMatchObject({
    kind: "directory",
    absolutePath: "C:/fixture",
  });
  expect(d.menuOpen).toBeDefined();
  expect(d.select).toHaveBeenLastCalledWith(
    [expect.objectContaining({ absolutePath: "C:/fixture" })],
    expect.anything(),
  );
});

it("refuses to select an unconfigured workspace root with a readable message", async () => {
  d.cwd = "";
  await mount();
  await act(async () => rootRow().click());
  expect(d.select).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain(
    "No workspace root configured. Select a workspace first.",
  );
});
