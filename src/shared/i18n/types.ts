import type { Locale } from "../contracts";

/** Parameters interpolated into a catalog message: `{name}` placeholders. */
export type MsgParams = Record<string, string | number>;

/**
 * A message key is a dot-separated path into the catalogs, e.g.
 * `common.refresh`. Keys are grouped by owning business domain, not by page.
 */
export type MsgKey = string;

export interface Catalog {
  readonly [key: string]: string;
}

/** Locales the UI can render. Adding one means adding a catalog file only. */
export const locales: readonly Locale[] = ["zh-CN", "en-US"];

/** Locale used when the active locale has no value for a key. */
export const fallbackLocale: Locale = "zh-CN";

/**
 * Plural forms are declared inline in a catalog value so that a catalog stays a
 * single flat map of strings:
 *
 *   "files.count": "{count, one: # file, other: # files}"
 *
 * `one` is only reachable for languages that have a distinct singular; the
 * resolver consults Intl.PluralRules and falls back to `other`.
 */
export const pluralPattern = /\{(\w+),\s*one:\s*([^,}]*),\s*other:\s*([^}]*)\}/g;

export const placeholderPattern = /\{(\w+)\}/g;
