// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TopBar } from "./TopBar";
import type { RuntimeInfo } from "../../shared/contracts";

const version = { value: undefined as string | undefined };
vi.mock("./useAppVersion", () => ({
  useAppVersion: () => version.value,
}));
vi.mock("../../features/workspaces/WorkspaceSwitcher", () => ({
  WorkspaceSwitcher: () => <button className="connection">Workspace</button>,
}));

let host: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

async function render() {
  await act(async () =>
    root.render(
      <TopBar
        runtime={{} as RuntimeInfo}
        zh
        onRuntime={() => undefined}
        onSettings={() => undefined}
      />,
    ),
  );
}

it("shows the running version right after the product name", async () => {
  version.value = "0.1.9";
  await render();
  const label = host.querySelector<HTMLElement>(".brand .titlebar-version");
  expect(label?.textContent).toBe("v0.1.9");
  expect(label?.getAttribute("title")).toBe("P4Deck v0.1.9");
  const brand = host.querySelector(".brand")!;
  expect(brand.lastElementChild).toBe(label);
  expect(brand.querySelector("strong")?.nextElementSibling).toBe(label);
});

it("renders no version chip when the host cannot report it", async () => {
  version.value = undefined;
  await render();
  expect(host.querySelector(".titlebar-version")).toBeNull();
  expect(host.textContent).toContain("P4Deck");
});
