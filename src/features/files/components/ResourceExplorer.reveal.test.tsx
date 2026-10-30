import { recordFrontendOperationLog } from "../../../infrastructure/backend/frontendOperationLog";
vi.mock("../../../infrastructure/backend/frontendOperationLog", () => ({
  recordFrontendOperationLog: vi.fn(async () => ({ status: "recorded" })),
}));
// @vitest-environment jsdom
import { act } from "react";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { dialogHarness } from "../../../app/dialogs/testHarness";
import { ResourceExplorer } from "./ResourceExplorer";
import { SelectionContext } from "../SelectionContext";
import { flattenResourceTree, type ResourceFolder } from "../resourceTree";
import type { WorkspaceNode } from "../../../shared/contracts";
import { messages } from "../../../shared/i18n";
const d = vi.hoisted(() => ({
  tree: {} as any,
  scroll: vi.fn(),
  select: vi.fn(),
  consume: vi.fn(),
  toggle: vi.fn(),
}));
vi.mock("../useResourceTree", () => ({ useResourceTree: () => d.tree }));
vi.mock("../workspaceQueries", () => ({ canListWorkspace: () => true }));
vi.mock("../../../app/context-menu/useFileMenu", () => ({
  useFileMenu: () => () => ({ onKeyDown: () => {} }),
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
      context: { cwd: "C:/fixture" },
      p4Version: "test",
      connection: { state: "connected" },
    },
    openPage: () => {},
  }),
}));
vi.mock("./FileStatusIcon", () => ({ FileStatusIcon: () => null }));
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    scrollToIndex: d.scroll,
    getTotalSize: () => count * 33,
    getVirtualItems: () => [],
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
const a = node("dir/a"),
  b = node("dir/b"),
  dir = node("dir", "directory");
const loaded = (items: WorkspaceNode[]): ResourceFolder => ({
  items,
  loaded: true,
  loading: false,
});
function tree(child: ResourceFolder, expanded = true) {
  const folders = new Map([
    ["", loaded([dir])],
    [dir.absolutePath, child],
  ]);
  const set = new Set(expanded ? [dir.absolutePath] : []);
  d.tree = {
    folders,
    expanded: set,
    rows: flattenResourceTree("workspace", set, folders),
    root: folders.get(""),
    toggle: d.toggle,
    refresh: vi.fn(),
  };
}
const mount = (
  id = 1,
  path = a.absolutePath,
  connectionKey = "scope",
  requestScope = "scope",
) =>
  h.render(
    <SelectionContext.Provider value={{ nodes: [], select: d.select }}>
      <ResourceExplorer
        collapsed={false}
        onToggle={() => {}}
        zh={false}
        t={messages["en-US"]}
        mode="workspace"
        onModeChange={() => {}}
        clientName="fixture"
        connectionKey={connectionKey}
        ready
        workspaceReady
        onNavigate={() => {}}
        reveal={{ id, path, connectionKey: requestScope }}
        onRevealConsumed={d.consume}
      />
    </SelectionContext.Provider>,
  );
beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(200);
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => {});
  tree(loaded([a, b]));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it("consumes once, refresh does not jump, same path explicit new request scrolls again", async () => {
  await mount();
  expect(d.scroll).toHaveBeenCalledTimes(1);
  expect(d.select).toHaveBeenCalledWith([a], a);
  await mount();
  expect(d.scroll).toHaveBeenCalledTimes(1);
  await mount(2);
  expect(d.scroll).toHaveBeenCalledTimes(2);
});
it("opens the actual ancestor key then waits for its listing", async () => {
  tree({ items: [], loaded: false, loading: true }, false);
  await mount();
  expect(d.toggle).toHaveBeenCalledWith(dir.absolutePath, true);
  expect(d.scroll).not.toHaveBeenCalled();
  tree(loaded([a, b]));
  await mount();
  expect(d.scroll).toHaveBeenCalledExactlyOnceWith(1, { align: "auto" });
});
it("latest request wins while old folder response arrives", async () => {
  tree({ items: [], loaded: false, loading: true });
  await mount(1);
  await mount(2, b.absolutePath);
  tree(loaded([a, b]));
  await mount(2, b.absolutePath);
  expect(d.scroll).toHaveBeenCalledExactlyOnceWith(2, { align: "auto" });
  expect(d.consume).toHaveBeenCalledExactlyOnceWith(2);
});
it("wheel cancels slow reveal; programmatic scroll does not", async () => {
  tree({ items: [], loaded: false, loading: true });
  await mount();
  await act(async () =>
    document
      .querySelector(".tree-list")!
      .dispatchEvent(new WheelEvent("wheel", { bubbles: true })),
  );
  tree(loaded([a, b]));
  await mount();
  expect(d.scroll).not.toHaveBeenCalled();
  expect(d.consume).toHaveBeenCalledWith(1);
  await mount(2);
  await act(async () =>
    document
      .querySelector(".tree-list")!
      .dispatchEvent(new Event("scroll", { bubbles: true })),
  );
  expect(d.scroll).toHaveBeenCalledTimes(1);
});
it("old connection request cannot select or scroll", async () => {
  await mount(1, a.absolutePath, "new", "old");
  expect(d.scroll).not.toHaveBeenCalled();
  expect(d.select).not.toHaveBeenCalled();
});
it.each(["missing", "error"])(
  "reports %s and stops without retry",
  async (kind) => {
    tree(
      kind === "error"
        ? {
            items: [],
            loaded: false,
            loading: false,
            error: "Synthetic load failure",
          }
        : loaded([]),
    );
    await mount();
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(recordFrontendOperationLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "addressNavigation",
        phase: "navigation",
        outcome: "failed",
      }),
    );
    expect(d.consume).toHaveBeenCalledExactlyOnceWith(1);
    await mount();
    expect(d.consume).toHaveBeenCalledTimes(1);
    expect(d.scroll).not.toHaveBeenCalled();
  },
);

it("uses full virtual row index for a far target, then never locks subsequent scroll", async () => {
  const siblings = Array.from({ length: 500 }, (_, i) => node(`dir/file${i}`));
  tree(loaded(siblings));
  await mount(40, siblings[499].absolutePath);
  expect(d.scroll).toHaveBeenCalledExactlyOnceWith(500, { align: "auto" });
  await mount(40, siblings[499].absolutePath);
  expect(d.scroll).toHaveBeenCalledTimes(1);
});
it("root navigation is consumed without a false missing-file error", async () => {
  await mount(41, "C:/fixture");
  expect(d.consume).toHaveBeenCalledExactlyOnceWith(41);
  expect(document.querySelector('[role="alert"]')).toBeNull();
});
