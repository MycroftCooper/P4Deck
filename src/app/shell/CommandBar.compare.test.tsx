// @vitest-environment jsdom
// Comparing two selected files is a read-only command: it must open a diff of the
// two exact revisions and never fall through to the single-file review path.
import { act } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { dialogHarness } from "../dialogs/testHarness";
import { CommandBar } from "./CommandBar";
import type { CommandId, CommandTarget } from "./commandPolicy";
import type { RuntimeInfo, WorkspaceNode } from "../../shared/contracts";
import { setLocale } from "../../shared/i18n";
const deps = vi.hoisted(() => ({
  open: vi.fn(),
  invalidate: vi.fn(),
  resolveSelection: vi.fn(),
  refresh: vi.fn(),
  cancel: vi.fn(),
  log: vi.fn(),
  busy: vi.fn(),
  feedback: vi.fn(),
  focus: vi.fn(),
}));
vi.mock("../../infrastructure/backend", () => ({
  backend: {
    previewSync: vi.fn(),
    syncLatest: vi.fn(),
    cancelOperation: deps.cancel,
    subscribeOperationEvents: async () => () => {},
    runP4: vi.fn(),
    companySubmitConnectionSnapshot: vi.fn(),
  },
}));
vi.mock("../../infrastructure/backend/frontendOperationLog", () => ({
  recordFrontendOperationLog: deps.log,
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
  useCommandDialogs: () => ({
    pending: false,
    element: null,
    open: deps.open,
  }),
  refreshFileLockFacts: deps.refresh,
}));
vi.mock("./useLocalPathCapabilities", () => ({
  useLocalPathCapabilities: () => ({ reveal: false, openWith: false }),
}));
vi.mock("../../shared/cache/dataEffects", async (original) => ({
  ...(await original<typeof import("../../shared/cache/dataEffects")>()),
  invalidateData: deps.invalidate,
}));
vi.mock("../../features/files/resolveSelection", () => ({
  resolveSelection: deps.resolveSelection,
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
const node = (
  depotPath: string,
  headRevision?: number,
  state: WorkspaceNode["state"] = "controlled",
): WorkspaceNode => ({
  id: depotPath,
  depotPath,
  name: depotPath.split("/").pop() ?? depotPath,
  kind: "file",
  absolutePath: `/work/${depotPath.split("/").pop()}`,
  relativePath: depotPath.split("/").pop() ?? depotPath,
  state,
  headRevision,
});

const compareOnFiles = vi.fn();
const onReview = vi.fn();
let handler: ((id: CommandId, target?: CommandTarget) => void) | undefined;

async function mount(target: CommandTarget) {
  await root.render(
    <CommandBar
      runtime={runtime}
      zh={false}
      connectionKey="fixture"
      target={target}
      targetError=""
      onBusyChange={deps.busy}
      onOpenOperations={deps.feedback}
      registerCommand={(h) => {
        handler = h;
      }}
      onNavigate={vi.fn()}
      onFocus={deps.focus}
      onReview={onReview}
      onCompareFiles={compareOnFiles}
    />,
  );
}

async function run(id: CommandId, target: CommandTarget) {
  await act(async () => {
    handler!(id, target);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  setLocale("en-US");
  vi.clearAllMocks();
  deps.invalidate.mockResolvedValue(undefined);
  deps.resolveSelection.mockImplementation(async (nodes: unknown) => nodes);
  deps.refresh.mockResolvedValue(undefined);
  deps.cancel.mockResolvedValue(undefined);
  deps.log.mockResolvedValue({ status: "unavailable" });
});

it("compares two selected files through the pair the policy approves", async () => {
  const b = node("//fixture/b.txt", 3);
  const a = node("//fixture/a.txt", 17);
  const target: CommandTarget = { type: "file", node: b, nodes: [b, a] };
  await mount(target);
  await run("diff", target);
  expect(compareOnFiles).toHaveBeenCalledWith(
    { path: "//fixture/a.txt", revision: 17 },
    { path: "//fixture/b.txt", revision: 3 },
  );
  expect(onReview).not.toHaveBeenCalled();
});

it("keeps a single file on the ordinary review path", async () => {
  const single = node("//fixture/a.txt", 17);
  const target: CommandTarget = { type: "file", node: single };
  await mount(target);
  await run("diff", target);
  expect(compareOnFiles).not.toHaveBeenCalled();
  expect(onReview).toHaveBeenCalledWith("diff", single);
});

it("refuses a pair without released revisions instead of sending it", async () => {
  const b = node("//fixture/b.txt", undefined, "openedAdd");
  const a = node("//fixture/a.txt", 17);
  const target: CommandTarget = { type: "file", node: a, nodes: [a, b] };
  await mount(target);
  await run("diff", target);
  // The blocked command surfaces its reason in the bar instead of opening a diff.
  expect(compareOnFiles).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain("Comparing needs exactly two");
});
