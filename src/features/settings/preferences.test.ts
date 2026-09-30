import { afterEach, expect, it, vi } from "vitest";
import { defaultUi, readUiPreferences } from "./preferences";
afterEach(() => vi.unstubAllGlobals());
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
