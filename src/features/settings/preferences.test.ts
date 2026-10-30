import { afterEach, expect, it, vi } from "vitest";
import {
  defaultUi,
  readUiPreferences,
  saveUiPreferences,
  toggleAutoRefresh,
} from "./preferences";
afterEach(() => vi.unstubAllGlobals());
it("migrates old accent preferences and restores only valid literal colors", () => {
  for (const accentColor of [undefined, null, "red", "#abc", "url(x)"]) {
    vi.stubGlobal("localStorage", {
      getItem: () => JSON.stringify({ accentColor }),
    });
    expect(readUiPreferences().accentColor).toBe(defaultUi.accentColor);
  }
  vi.stubGlobal("localStorage", {
    getItem: () => JSON.stringify({ accentColor: "#ABCDEF" }),
  });
  expect(readUiPreferences().accentColor).toBe("#abcdef");
});
it("defaults to asking for a checkout CL and only restores an explicit true preference", () => {
  for (const checkoutUseDefault of [undefined, false, "true", 1, null]) {
    vi.stubGlobal("localStorage", {
      getItem: () => JSON.stringify({ checkoutUseDefault }),
    });
    expect(readUiPreferences().checkoutUseDefault).toBe(false);
  }
  vi.stubGlobal("localStorage", {
    getItem: () => JSON.stringify({ checkoutUseDefault: true }),
  });
  expect(readUiPreferences().checkoutUseDefault).toBe(true);
});
it("validates saved UI preferences", () => {
  vi.stubGlobal("localStorage", {
    getItem: () =>
      JSON.stringify({ compact: true, fontSize: 900, sidebarWidth: -1 }),
  });
  expect(readUiPreferences()).toEqual({ ...defaultUi, compact: true });
  vi.stubGlobal("localStorage", { getItem: () => "null" });
  expect(readUiPreferences()).toEqual(defaultUi);
});
it("persists independent label options and migrates invalid values to visible", () => {
  vi.stubGlobal("localStorage", {
    getItem: () =>
      JSON.stringify({ activityBarText: false, toolbarText: true }),
  });
  expect(readUiPreferences()).toEqual({ ...defaultUi, activityBarText: false });
  vi.stubGlobal("localStorage", {
    getItem: () =>
      JSON.stringify({ activityBarText: "false", toolbarText: false }),
  });
  expect(readUiPreferences()).toEqual({ ...defaultUi, toolbarText: false });
});
it("restores arbitrary dragged sidebar widths within the supported range", () => {
  for (const sidebarWidth of [200, 377, 600]) {
    vi.stubGlobal("localStorage", {
      getItem: () => JSON.stringify({ sidebarWidth }),
    });
    expect(readUiPreferences().sidebarWidth).toBe(sidebarWidth);
  }
  for (const sidebarWidth of [96, 601, "320", null]) {
    vi.stubGlobal("localStorage", {
      getItem: () => JSON.stringify({ sidebarWidth }),
    });
    expect(readUiPreferences().sidebarWidth).toBe(defaultUi.sidebarWidth);
  }
});

it("restores non-negative whole-minute intervals and preserves old disabled preferences", () => {
  for (const autoRefreshMinutes of [0, 1, 5, 30, 120]) {
    vi.stubGlobal("localStorage", {
      getItem: () => JSON.stringify({ autoRefreshMinutes }),
    });
    expect(readUiPreferences().autoRefreshMinutes).toBe(autoRefreshMinutes);
  }
  for (const autoRefreshMinutes of [-1, 0.5, "10", null, 1e20]) {
    vi.stubGlobal("localStorage", {
      getItem: () => JSON.stringify({ autoRefreshMinutes }),
    });
    expect(readUiPreferences().autoRefreshMinutes).toBe(5);
  }
  vi.stubGlobal("localStorage", {
    getItem: () => JSON.stringify({ autoRefresh: false }),
  });
  expect(readUiPreferences()).toMatchObject({
    autoRefresh: false,
    autoRefreshMinutes: 5,
  });
});

it("remembers a custom interval when paused and can resume an interval disabled with zero", () => {
  const custom = { ...defaultUi, autoRefreshMinutes: 12 };
  const paused = toggleAutoRefresh(custom);
  expect(paused).toMatchObject({ autoRefresh: false, autoRefreshMinutes: 12 });
  expect(toggleAutoRefresh(paused)).toEqual(custom);
  expect(
    toggleAutoRefresh({
      ...defaultUi,
      autoRefresh: false,
      autoRefreshMinutes: 0,
    }),
  ).toMatchObject({ autoRefresh: true, autoRefreshMinutes: 5 });
});

it("defaults the background to the theme and restores only literal tones", () => {
  vi.stubGlobal("localStorage", {
    getItem: () => JSON.stringify({ backgroundTone: undefined }),
  });
  expect(readUiPreferences().backgroundTone).toBe("");
  vi.stubGlobal("localStorage", {
    getItem: () => JSON.stringify({ backgroundTone: "#ABCDEF" }),
  });
  expect(readUiPreferences().backgroundTone).toBe("#abcdef");
  for (const backgroundTone of [
    null,
    12,
    "red",
    "#abc",
    "",
    "url(x)",
    "#12345678",
  ]) {
    vi.stubGlobal("localStorage", {
      getItem: () => JSON.stringify({ backgroundTone }),
    });
    expect(readUiPreferences().backgroundTone).toBe("");
  }
});

it("verifies the preference round-trip and reports refused storage", () => {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
  });
  expect(saveUiPreferences({ ...defaultUi, backgroundTone: "#2b3442" })).toBe(
    true,
  );
  expect(JSON.parse(store.get("p4deck.ui") ?? "{}").backgroundTone).toBe(
    "#2b3442",
  );
  vi.stubGlobal("localStorage", {
    getItem: () => null,
    setItem: () => {},
  });
  expect(saveUiPreferences(defaultUi)).toBe(false);
});
