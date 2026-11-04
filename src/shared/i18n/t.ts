/**
 * The translation runtime: a module-level `t()` with no React dependency.
 *
 * Several call sites live outside components (notices, action confirmations,
 * error mapping), so the resolver has to work from a module global. React picks
 * up locale changes through useT()/the store subscription in index.ts.
 */
import type { Locale } from "../contracts";
import { zh } from "./catalog.zh";
import { en } from "./catalog.en";
import type { MsgKey } from "./catalog.zh";
import { fallbackLocale, pluralPattern, placeholderPattern } from "./types";
import type { Catalog, MsgParams } from "./types";

const catalogs: Record<Locale, Catalog> = { "zh-CN": zh, "en-US": en };

let activeLocale: Locale = "zh-CN";

export function getLocale(): Locale {
  return activeLocale;
}

/** Set the module-level locale. React consumers re-render via the store. */
export function setLocale(locale: Locale) {
  activeLocale = locale;
}

/**
 * Resolve a catalog value for a locale.
 *
 * Returns `undefined` for a missing or empty key so callers can distinguish
 * "no translation" from an empty string.
 */
export function lookup(locale: Locale, key: MsgKey): string | undefined {
  const value = catalogs[locale]?.[key];
  if (typeof value !== "string" || !value) return undefined;
  return value;
}

/**
 * Choose a plural branch using the locale's own rules, without assuming the
 * English one/other split.
 */
function pluralBranch(
  locale: Locale,
  count: number,
  one: string,
  other: string,
): string {
  const category = new Intl.PluralRules(locale).select(count);
  return category === "one" ? one : other;
}

/** Expand inline plural forms, then `{name}` placeholders. */
function interpolate(
  locale: Locale,
  template: string,
  params: MsgParams,
): string {
  const withPlurals = template.replace(
    pluralPattern,
    (whole, name: string, one: string, other: string) => {
      const count = params[name];
      if (typeof count !== "number") return whole;
      // `#` is the ICU count placeholder inside a plural branch.
      const format = (branch: string) =>
        branch.trim().replaceAll("#", String(count));
      return pluralBranch(locale, count, format(one), format(other));
    },
  );
  return withPlurals.replace(placeholderPattern, (whole, name: string) => {
    const value = params[name];
    return value === undefined ? whole : String(value);
  });
}

const reported = new Set<string>();

function reportMissing(locale: Locale, key: MsgKey) {
  if (!import.meta.env.DEV || reported.has(key)) return;
  reported.add(key);
  console.warn(
    `[i18n] missing message for "${key}" in ${locale}` +
      (locale === fallbackLocale ? "" : ` (fell back to ${fallbackLocale})`),
  );
}

/**
 * Translate a key for the active locale.
 *
 * Fallback order: active locale -> fallback locale -> the key itself. A missing
 * key never renders as blank; it renders as the key so it is visible in review
 * and in tests.
 */
export function t(key: MsgKey, params: MsgParams = {}): string {
  const locale = activeLocale;
  let template = lookup(locale, key);
  if (template === undefined && locale !== fallbackLocale) {
    reportMissing(locale, key);
    template = lookup(fallbackLocale, key);
  }
  if (template === undefined) {
    reportMissing(locale, key);
    return key;
  }
  return interpolate(locale, template, params);
}

/** Translate explicitly for a locale — for module-level, locale-aware helpers. */
export function tFor(
  locale: Locale,
  key: MsgKey,
  params: MsgParams = {},
): string {
  const template = lookup(locale, key) ?? lookup(fallbackLocale, key);
  return template === undefined ? key : interpolate(locale, template, params);
}

/** Test seam: clear the reported-missing set. */
export function resetMissingReport() {
  reported.clear();
}
