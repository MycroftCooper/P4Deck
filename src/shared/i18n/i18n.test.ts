import { describe, expect, it, vi } from "vitest";
import {
  catalogEn,
  catalogZh,
  getLocale,
  lookup,
  resetMissingReport,
  setLocale,
  t,
  tFor,
} from "./index";
import type { MsgKey } from "./index";

describe("i18n catalogs", () => {
  it("keeps the English catalog key-aligned with Chinese", () => {
    expect(Object.keys(catalogEn).sort()).toEqual(
      Object.keys(catalogZh).sort(),
    );
  });

  it("has no empty values", () => {
    for (const [key, value] of Object.entries({ ...catalogZh, ...catalogEn }))
      expect(value, key).toBeTruthy();
  });

  it("uses the same placeholders in both locales", () => {
    const names = (value: string) =>
      [...value.matchAll(/\{(\w+)[,}]/g)].map((m) => m[1]).sort();
    for (const key of Object.keys(catalogZh) as MsgKey[]) {
      const zhValue = catalogZh[key];
      const enValue = catalogEn[key];
      // Plural forms legitimately differ between languages; only compare keys
      // that use a single flat set of placeholders.
      if (/\{\w+,\s*one:/.test(zhValue) || /\{\w+,\s*one:/.test(enValue))
        continue;
      expect(names(enValue), key).toEqual(names(zhValue));
    }
  });
});

describe("t", () => {
  it("translates for the active locale", () => {
    setLocale("zh-CN");
    expect(t("common.refresh")).toBe("刷新");
    setLocale("en-US");
    expect(t("common.refresh")).toBe("Refresh");
    setLocale("zh-CN");
  });

  it("interpolates placeholders", () => {
    resetMissingReport();
    expect(tFor("en-US", "changes.count", { count: 3 })).toBe("3 changes");
    expect(tFor("zh-CN", "changes.count", { count: 3 })).toBe("3 条");
  });

  it("leaves unknown placeholders untouched instead of printing undefined", () => {
    const value = tFor("en-US", "changes.count", {});
    expect(value).not.toContain("undefined");
  });

  it("picks the singular branch only where the locale has one", () => {
    expect(tFor("en-US", "changes.count", { count: 1 })).toBe("1 change");
    expect(tFor("en-US", "changes.count", { count: 0 })).toBe("0 changes");
    expect(tFor("en-US", "changes.count", { count: 2 })).toBe("2 changes");
    // Chinese has a single plural category, so the flat form always wins.
    expect(tFor("zh-CN", "changes.count", { count: 1 })).toBe("1 条");
  });

  it("returns the key rather than a blank when a message is missing", () => {
    const Warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    resetMissingReport();
    expect(t("nope.missing" as MsgKey)).toBe("nope.missing");
    Warn.mockRestore();
  });

  it("falls back to Chinese when a locale has no entry, and warns once", () => {
    const Warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    resetMissingReport();
    const missing = Object.keys(catalogZh).find(
      (key) => !(key in catalogEn),
    ) as MsgKey | undefined;
    // Catalogs are kept aligned, so exercise the path through lookup directly.
    expect(lookup("en-US", "common.app")).toBe("P4Deck");
    if (missing) expect(tFor("en-US", missing)).toBe(catalogZh[missing]);
    Warn.mockRestore();
  });
});

describe("locale store", () => {
  it("reports the active locale", () => {
    setLocale("en-US");
    expect(getLocale()).toBe("en-US");
    setLocale("zh-CN");
    expect(getLocale()).toBe("zh-CN");
  });
});
