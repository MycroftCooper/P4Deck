// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  GlobalSearchItem,
  GlobalSearchQuery,
  GlobalSearchResult,
  RuntimeInfo,
} from "../../shared/contracts";
import { messages, setLocale } from "../../shared/i18n";
import { ContextMenuProvider } from "../../app/context-menu/ContextMenu";
import {
  MenuEnvironment,
  type MenuEnvironmentValue,
} from "../../app/context-menu/environment";
import { CommandExecutionContext } from "../../app/shell/CommandContext";
import type { CommandId, CommandTarget } from "../../app/shell/commandPolicy";
import { defaultUi } from "../settings/preferences";
import { SearchPage } from "./SearchPage";

const backend = vi.hoisted(() => ({
  globalSearch: vi.fn(),
  cancelOperation: vi.fn(async () => undefined),
}));
vi.mock("../../infrastructure/backend", () => ({ backend }));

const runtime: RuntimeInfo = {
  mode: "tauri",
  p4Version: "P4/TEST",
  contextGeneration: 1,
  context: {
    server: "fixture:1666",
    user: "tester",
    client: "workspace",
    cwd: "C:\\workspace",
  },
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

/** One workspace file result; `name` only affects the row text. */
function workspaceFile(name: string, absolutePath: string): GlobalSearchItem {
  return {
    identity: `workspace-file:${absolutePath}`,
    kind: "workspaceFile",
    title: name,
    summary: `//depot/main/${name}`,
    target: { type: "workspaceFile", absolutePath },
    matchedFields: ["title"],
    highlights: [],
    rank: 1,
  };
}

function submittedChange(
  changeId: number,
  description: string,
): GlobalSearchItem {
  return {
    identity: `submitted-change:${changeId}`,
    kind: "submittedChange",
    title: `CL ${changeId}`,
    summary: `${description} · tester · workspace`,
    target: { type: "submittedChange", changeId },
    matchedFields: ["description"],
    highlights: [],
    rank: 1,
  };
}

function depotFile(name: string, depotPath: string): GlobalSearchItem {
  return {
    identity: `depot-file:${depotPath}`,
    kind: "depotFile",
    title: name,
    summary: depotPath,
    target: { type: "depotFile", depotPath },
    matchedFields: ["title"],
    highlights: [],
    rank: 1,
  };
}

function result(
  query: GlobalSearchQuery,
  items: GlobalSearchItem[],
): GlobalSearchResult {
  return {
    requestGeneration: query.requestGeneration,
    normalizedQuery: query.text,
    groups: query.kinds
      .map((kind) => ({
        kind,
        items: items.filter((item) => item.kind === kind),
      }))
      .filter((group) => group.items.length),
    facets: query.kinds.map((kind) => ({
      kind,
      matchedCount: items.filter((item) => item.kind === kind).length,
      scannedCount: 4,
      partial: false,
    })),
    hasMore: false,
    partial: false,
    simulated: false,
    stats: {
      scannedCount: 4,
      matchedCount: items.length,
      returnedCount: items.length,
      categoryFailureCount: 0,
      safetyLimit: 1000,
    },
  };
}

let host: HTMLDivElement;
let root: Root;
let navigate: ReturnType<typeof vi.fn>;
let execute: ReturnType<typeof vi.fn>;

async function render() {
  await act(async () =>
    root.render(
      <ContextMenuProvider scope="search-menu" zh={false}>
        <MenuEnvironment.Provider value={environment}>
          <CommandExecutionContext.Provider value={execute}>
            <SearchPage zh={false} runtimeMode="tauri" onNavigate={navigate} />
          </CommandExecutionContext.Provider>
        </MenuEnvironment.Provider>
      </ContextMenuProvider>,
    ),
  );
}

async function submitQuery(value = "needle") {
  const input = host.querySelector<HTMLInputElement>("#global-search-input")!;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () =>
    input
      .closest("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
}

const rows = () => [
  ...host.querySelectorAll<HTMLButtonElement>(".search-result-row"),
];

const rowFor = (text: string) =>
  rows().find((row) => row.textContent?.includes(text))!;

const menuItem = (id: string) =>
  document.querySelector<HTMLButtonElement>(`[data-menu-item="${id}"]`);

const menuObjects = () =>
  [...document.querySelectorAll("[data-menu-item]")].length;

async function rightClick(element: HTMLElement) {
  await act(async () => {
    element.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: 20,
        clientY: 20,
      }),
    );
  });
}

async function pressItem(id: string) {
  const item = menuItem(id);
  expect(item, `${id} should be offered`).not.toBeNull();
  await act(async () => item!.click());
  // Menu actions run on a microtask after the panel closes.
  await act(async () => {
    await Promise.resolve();
  });
}

async function click(row: HTMLButtonElement, ctrlKey = false) {
  await act(async () => {
    row.dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey }));
  });
}

beforeEach(() => {
  setLocale("en-US");
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  backend.globalSearch.mockReset();
  backend.cancelOperation.mockReset().mockResolvedValue(undefined);
  navigate = vi.fn(async () => undefined);
  execute = vi.fn();
  environment.navigate = vi.fn();
  environment.openFilePage = vi.fn();
  backend.globalSearch.mockImplementation(async (query: GlobalSearchQuery) =>
    result(query, [
      workspaceFile("alpha.ts", "C:\\workspace\\src\\alpha.ts"),
      workspaceFile("beta.ts", "C:\\workspace\\src\\beta.ts"),
      depotFile("gamma.ts", "//depot/main/gamma.ts"),
      submittedChange(101, "needle fix"),
    ]),
  );
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

it("opens the S01 menu from a file row and runs the real preview command", async () => {
  await render();
  await submitQuery();
  const row = rowFor("alpha.ts");
  expect(row.getAttribute("data-menu-object")).toBe("S01");

  await rightClick(row);
  await pressItem("S01-01");

  expect(execute).toHaveBeenCalledTimes(1);
  const [id, target] = execute.mock.calls[0] as [CommandId, CommandTarget];
  expect(id).toBe("preview");
  expect(target.type).toBe("file");
  if (target.type !== "file") throw new Error("expected a file target");
  expect(target.node.absolutePath).toBe("C:\\workspace\\src\\alpha.ts");
  expect(target.node.relativePath).toBe("src\\alpha.ts");
  expect(target.nodes).toHaveLength(1);
});

it("offers the file actions that the search payload can prove", async () => {
  await render();
  await submitQuery();
  await rightClick(rowFor("alpha.ts"));

  // Directory navigation goes through the shared menu environment, not a guess.
  await pressItem("S01-14");
  expect(environment.navigate).toHaveBeenCalledWith(
    expect.objectContaining({ absolutePath: "C:\\workspace\\src\\alpha.ts" }),
  );

  await rightClick(rowFor("alpha.ts"));
  // The result carries no depot path, so the entry is disabled with a reason.
  expect(menuItem("S01-16")?.getAttribute("aria-disabled")).toBe("true");
  // File writes keep the standard "current file state" gate instead of guessing.
  expect(menuItem("S01-10")?.getAttribute("aria-disabled")).toBe("true");
  expect(menuItem("S01-05")?.getAttribute("aria-disabled")).toBe("false");

  // Copy submenu: the row knows its name, local and relative path, not its depot path.
  await act(async () => menuItem("S01:group:复制")!.click());
  expect(menuItem("S01-17")?.getAttribute("aria-disabled")).toBe("false");
  expect(menuItem("S01-18")?.getAttribute("aria-disabled")).toBe("false");
  expect(menuItem("S01-19")?.getAttribute("aria-disabled")).toBe("false");
  expect(menuItem("S01-20")?.getAttribute("aria-disabled")).toBe("true");
});

it("opens a CL row menu and runs its detail entry", async () => {
  await render();
  await submitQuery();
  const row = rowFor("CL 101");
  expect(row.getAttribute("data-menu-object")).toBe("S03");

  await rightClick(row);
  await pressItem("S03-01");

  expect(navigate).toHaveBeenCalledWith({
    type: "submittedChange",
    changeId: 101,
  });
  expect(execute).not.toHaveBeenCalled();
});

it("disables what a depot-only result cannot prove instead of guessing", async () => {
  await render();
  await submitQuery();
  const row = rowFor("gamma.ts");
  await rightClick(row);
  expect(row.getAttribute("data-menu-object")).toBe("S01");

  // No local copy is known, so the local-only entries explain themselves.
  expect(menuItem("S01-01")?.getAttribute("aria-disabled")).toBe("true");
  expect(menuItem("S01-04")?.getAttribute("aria-disabled")).toBe("true");
  // The depot path IS known, so depot navigation works.
  expect(menuItem("S01-16")?.getAttribute("aria-disabled")).toBe("false");

  await act(async () => menuItem("S01:group:复制")!.click());
  expect(menuItem("S01-20")?.getAttribute("aria-disabled")).toBe("false");
  expect(menuItem("S01-18")?.getAttribute("aria-disabled")).toBe("true");
  expect(menuItem("S01-19")?.getAttribute("aria-disabled")).toBe("true");
});

it("acts on the whole selected file set from a multi-row menu", async () => {
  await render();
  await submitQuery();
  const alpha = rowFor("alpha.ts");
  const beta = rowFor("beta.ts");

  await click(alpha);
  // A modifier click extends the selection without navigating.
  await click(beta, true);
  expect(navigate).toHaveBeenCalledTimes(1);

  await rightClick(beta);
  expect(beta.getAttribute("data-menu-object")).toBe("S02");
  await pressItem("S02-01");

  const [id, target] = execute.mock.calls[0] as [CommandId, CommandTarget];
  expect(id).toBe("getLatest");
  if (target.type !== "file") throw new Error("expected a file target");
  // The right-clicked row stays the primary target; both rows are the scope.
  expect(target.node.absolutePath).toBe("C:\\workspace\\src\\beta.ts");
  expect(target.nodes?.map((node) => node.absolutePath)).toEqual([
    "C:\\workspace\\src\\alpha.ts",
    "C:\\workspace\\src\\beta.ts",
  ]);
});

it("opens the row menu with Shift+F10 and leaves loading/empty states bare", async () => {
  await render();
  // Idle: the results area must not advertise a menu of nothing.
  expect(
    host.querySelector(".search-results")?.hasAttribute("data-menu-object"),
  ).toBe(false);
  await submitQuery();
  expect(
    host.querySelector(".search-results")?.getAttribute("data-menu-object"),
  ).toBe("S05");

  const row = rowFor("alpha.ts");
  await act(async () => {
    row.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "F10",
        shiftKey: true,
        bubbles: true,
      }),
    );
  });
  expect(menuObjects()).toBeGreaterThan(0);
});

it("re-runs the accepted query from the results blank area", async () => {
  await render();
  await submitQuery();
  expect(backend.globalSearch).toHaveBeenCalledTimes(1);

  await rightClick(host.querySelector<HTMLElement>(".search-results")!);
  await pressItem("S05-04");

  expect(backend.globalSearch).toHaveBeenCalledTimes(2);
  expect(backend.globalSearch.mock.calls[1][0]).toMatchObject({
    text: "needle",
  });
});
