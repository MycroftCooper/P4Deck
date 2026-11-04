// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { CommandBar } from "./CommandBar";
import type { CommandTarget } from "./commandPolicy";
import type { RuntimeInfo } from "../../shared/contracts";

vi.mock("../../infrastructure/backend", () => ({ backend: {} }));
vi.mock("../context-menu/ContextMenu", () => ({
  useContextMenu: () => vi.fn(),
}));
vi.mock("../context-menu/environment", () => ({
  useMenuEnvironment: () => ({
    preferences: { ui: { toolbarText: true } },
    openPage: vi.fn(),
  }),
}));
vi.mock("../dialogs/useCommandDialogs", () => ({
  useCommandDialogs: () => ({ pending: false, element: null }),
  refreshFileLockFacts: vi.fn(),
}));
vi.mock("./useLocalPathCapabilities", () => ({
  useLocalPathCapabilities: () => ({ reveal: false, openWith: false }),
}));

const runtime: RuntimeInfo = {
  mode: "mock",
  contextGeneration: 1,
  p4Version: "synthetic",
  context: {
    server: "fixture.invalid",
    user: "fixture",
    client: "fixture",
    cwd: "",
  },
  connection: {
    state: "connected",
    message: "mock",
    recovery: "none",
    server: "fixture.invalid",
  },
};

function renderBar(target: CommandTarget) {
  return renderToStaticMarkup(
    <CommandBar
      runtime={runtime}
      zh={false}
      connectionKey="fixture"
      target={target}
      targetError=""
      onBusyChange={vi.fn()}
      onOpenOperations={vi.fn()}
      registerCommand={vi.fn()}
      onNavigate={vi.fn()}
      onFocus={vi.fn()}
      onReview={vi.fn()}
    />,
  );
}

it.each(["pending", "submitted"] as const)(
  "omits only the duplicate CL details toolbar entry for %s",
  (type) => {
    const html = renderBar({ type, id: 42, count: 1 });
    expect(html).not.toContain("View changelist details");
    expect(html).not.toContain("CL details");
    expect(html).toContain("Refresh");
    expect(html).toContain("Preview");
  },
);

it("renders no persistent notice while the toolbar is idle", () => {
  const html = renderBar({ type: "none" });
  expect(html).not.toContain("command-notice");
  expect(html).not.toContain('role="alert"');
});
