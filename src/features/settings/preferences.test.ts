import { afterEach, expect, it, vi } from "vitest";
import { defaultUi, readUiPreferences, toggleAutoRefresh } from "./preferences";
afterEach(() => vi.unstubAllGlobals());
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
