import { describe, expect, it } from "vitest";
import {
  expandSection,
  readCollapsedSections,
  toggleCollapsedSection,
  writeCollapsedSections,
} from "./settingsCollapse";

const IDS = ["connection", "backup", "appearance"];
describe("settings collapse state (UI-14)", () => {
  it("defaults to all-expanded for missing or empty state", () => {
    expect(readCollapsedSections(null, IDS)).toEqual(new Set());
    expect(readCollapsedSections("null", IDS)).toEqual(new Set());
    expect(readCollapsedSections("[]", IDS)).toEqual(new Set());
  });
  it("restores known collapsed ids only", () => {
    expect(
      readCollapsedSections('["backup","no-such-module",42]', IDS),
    ).toEqual(new Set(["backup"]));
  });
  it("falls back to all-expanded for corrupted or non-array state", () => {
    expect(readCollapsedSections("{broken", IDS)).toEqual(new Set());
    expect(readCollapsedSections('{"connection":true}', IDS)).toEqual(
      new Set(),
    );
  });
  it("writes only valid ids in section order", () => {
    const store = new Map<string, string>();
    const original = globalThis.localStorage;
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => store.set(key, value),
      },
    });
    try {
      writeCollapsedSections(
        new Set(["appearance", "bogus", "connection"]),
        IDS,
      );
      expect(JSON.parse(store.get("p4deck.settings.collapsed")!)).toEqual([
        "connection",
        "appearance",
      ]);
    } finally {
      Object.defineProperty(globalThis, "localStorage", {
        configurable: true,
        value: original,
      });
    }
  });
  it("toggles and expands individual modules", () => {
    const collapsed = toggleCollapsedSection(new Set(), "backup");
    expect(collapsed).toEqual(new Set(["backup"]));
    expect(toggleCollapsedSection(collapsed, "backup")).toEqual(new Set());
    expect(expandSection(collapsed, "backup")).toEqual(new Set());
  });
});
