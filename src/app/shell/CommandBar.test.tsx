// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { CommandBar } from "./CommandBar";
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

it.each(["pending", "submitted"] as const)(
  "omits only the duplicate CL details toolbar entry for %s",
  (type) => {
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
    const html = renderToStaticMarkup(
      <CommandBar
        runtime={runtime}
        zh={false}
        connectionKey="fixture"
        target={{ type, id: 42, count: 1 }}
        targetError=""
        onBusyChange={vi.fn()}
        onOpenOperations={vi.fn()}
        registerCommand={vi.fn()}
        onNavigate={vi.fn()}
        onFocus={vi.fn()}
        onReview={vi.fn()}
      />,
    );
    expect(html).not.toContain("View changelist details");
    expect(html).not.toContain("CL details");
    expect(html).toContain("Refresh");
    expect(html).toContain("Preview");
  },
);
