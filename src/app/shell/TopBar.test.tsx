// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TopBar } from "./TopBar";
import type { RuntimeInfo } from "../../shared/contracts";
const onSettings = vi.fn(),
  onRuntime = vi.fn();
vi.mock("../../features/workspaces/WorkspaceSwitcher", () => ({
  WorkspaceSwitcher: ({ onSettings }: { onSettings(): void }) => (
    <button className="connection" onClick={onSettings}>
      Workspace
    </button>
  ),
}));
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  vi.clearAllMocks();
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
it("keeps brand and connection navigation without duplicate controls or drag regions", async () => {
  await act(async () =>
    root.render(
      <TopBar
        runtime={{} as RuntimeInfo}
        zh
        onRuntime={onRuntime}
        onSettings={onSettings}
      />,
    ),
  );
  expect(host.textContent).toContain("P4Deck");
  expect(
    host.querySelector(
      ".window-controls,.titlebar-reserved,[data-tauri-drag-region],.system-drag",
    ),
  ).toBeNull();
  await act(async () =>
    host.querySelector<HTMLButtonElement>(".connection")!.click(),
  );
  expect(onSettings).toHaveBeenCalledOnce();
});
