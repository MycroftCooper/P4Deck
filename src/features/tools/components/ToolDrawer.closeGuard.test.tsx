// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ToolDrawer } from "./ToolDrawer";
import { messages } from "../../../shared/i18n";
const guard = vi.hoisted(() => ({
  state: vi.fn((_state: string, _scope?: string) => () => {}),
}));
vi.mock("../../../app/closeGuard", () => ({ useUnsavedEditor: guard.state }));
vi.mock("../../../infrastructure/backend", () => ({ backend: {} }));
vi.mock("../../../app/context-menu/ContextMenu", () => ({
  useContextMenu: () => () => ({}),
}));
it("protects unexecuted terminal input even while the drawer is hidden, without running a command", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div"),
    root = createRoot(host),
    run = vi.fn();
  document.body.append(host);
  const props: ComponentProps<typeof ToolDrawer> = {
    t: messages["en-US"],
    zh: false,
    native: false,
    connectionKey: "synthetic-window",
    logRefreshKey: 0,
    open: true,
    active: "terminal",
    unread: 0,
    context: {
      server: "synthetic.invalid",
      user: "fixture",
      client: "workspace",
    },
    operationEvents: [],
    onOpenChange: vi.fn(),
    onActiveChange: vi.fn(),
    onOperationFilter: vi.fn(),
    onJournalOperation: vi.fn(),
    onRun: run,
    onCancel: vi.fn(),
    onOpenSettings: vi.fn(),
  };
  try {
    await act(async () => root.render(<ToolDrawer {...props} />));
    const input = host.querySelector<HTMLInputElement>(
      ".terminal-input input",
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!.call(input, "synthetic unexecuted command");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(guard.state).toHaveBeenLastCalledWith("dirty", "synthetic-window");
    await act(async () => root.render(<ToolDrawer {...props} open={false} />));
    expect(guard.state).toHaveBeenLastCalledWith("dirty", "synthetic-window");
    expect(run).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});
