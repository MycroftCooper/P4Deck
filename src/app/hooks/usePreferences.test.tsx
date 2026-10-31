// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { backgroundTokens } from "../../features/settings/background";
import { storage } from "../../shared/lib/storage";
import { usePreferences } from "./usePreferences";

const d = vi.hoisted(() => ({ notifyFailure: vi.fn() }));
vi.mock("../../shared/notice", () => ({
  notifyFailure: d.notifyFailure,
  notifyUser: vi.fn(),
}));

let host: HTMLDivElement;
let root: Root;
let preferences: ReturnType<typeof usePreferences>;

function Probe() {
  preferences = usePreferences();
  return null;
}

const rootStyle = () => document.documentElement.style;

beforeEach(async () => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
  for (const name of [
    "--bg",
    "--panel",
    "--panel-2",
    "--panel-3",
    "--border",
    "--text",
    "--muted",
    "--faint",
  ])
    rootStyle().removeProperty(name);
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    onchange: null,
    dispatchEvent: vi.fn(),
  }));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<Probe />));
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = false;
});

it("applies a custom background to the DOM and persists it", async () => {
  await act(async () => preferences.setTheme("dark"));
  await act(async () =>
    preferences.setUi({ ...preferences.ui, backgroundTone: "#2b3442" }),
  );
  const expected = backgroundTokens("#2b3442", true)!;
  expect(document.documentElement.dataset.theme).toBe("dark");
  for (const [name, value] of Object.entries(expected))
    expect(rootStyle().getPropertyValue(name)).toBe(value);
  // Accent selection/hover surfaces follow the custom panel too.
  expect(rootStyle().getPropertyValue("--selected")).not.toBe("");
  expect(rootStyle().getPropertyValue("--hover")).not.toBe("");
  expect(JSON.parse(localStorage.getItem("p4deck.ui")!).backgroundTone).toBe(
    "#2b3442",
  );

  await act(async () =>
    preferences.setUi({ ...preferences.ui, backgroundTone: "" }),
  );
  for (const name of Object.keys(expected))
    expect(rootStyle().getPropertyValue(name)).toBe("");
  expect(JSON.parse(localStorage.getItem("p4deck.ui")!).backgroundTone).toBe(
    "",
  );
});

it("recomputes the background when the theme switches", async () => {
  await act(async () =>
    preferences.setUi({ ...preferences.ui, backgroundTone: "#2b3442" }),
  );
  await act(async () => preferences.setTheme("light"));
  expect(document.documentElement.dataset.theme).toBe("light");
  expect(rootStyle().getPropertyValue("--bg")).toBe(
    backgroundTokens("#2b3442", false)!["--bg"],
  );
  await act(async () => preferences.setTheme("dark"));
  expect(rootStyle().getPropertyValue("--bg")).toBe(
    backgroundTokens("#2b3442", true)!["--bg"],
  );
});

it("notifies when the preference save is refused", async () => {
  const setItem = vi.spyOn(storage, "setItem").mockImplementation(() => {});
  try {
    await act(async () =>
      preferences.setUi({ ...preferences.ui, backgroundTone: "#2b3442" }),
    );
    expect(d.notifyFailure).toHaveBeenCalled();
  } finally {
    setItem.mockRestore();
  }
});
