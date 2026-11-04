/**
 * Public i18n surface. Import from here, not from catalog files directly.
 *
 * Two ways to consume a message:
 *   t("common.refresh")            module level, active locale
 *   useT()("common.refresh")       inside a component, re-renders on locale change
 */
import { useSyncExternalStore } from "react";
import type { Locale } from "../contracts";
import type { MsgKey } from "./catalog.zh";
import type { MsgParams } from "./types";
import { getLocale, lookup, resetMissingReport, setLocale, t, tFor } from "./t";

export { t, tFor, getLocale, resetMissingReport };
export { setLocale };
export type { MsgKey, MsgParams };
export { zh as catalogZh } from "./catalog.zh";
export { en as catalogEn } from "./catalog.en";

const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

let announcedLocale: Locale = getLocale();

/**
 * Set the active locale and notify React consumers. Synchronous so module-level
 * code observes the new locale immediately after the call.
 */
export function changeLocale(locale: Locale) {
  if (locale === announcedLocale) return;
  announcedLocale = locale;
  setLocale(locale);
  for (const listener of listeners) listener();
}

/** The active locale, re-subscribing React consumers when it changes. */
export function useLocale(): Locale {
  return useSyncExternalStore(
    subscribe,
    () =>
      // Keep the module global in sync with whatever the store announced.
      getLocale(),
    () => "zh-CN" as Locale,
  );
}

/** A stable-identity `t` bound to the active locale, for use in components. */
export function useT(): (key: MsgKey, params?: MsgParams) => string {
  useLocale();
  return t;
}

/** True when the active locale is Chinese; mirrors the legacy `zh` flag. */
export function useIsZh(): boolean {
  return useLocale() === "zh-CN";
}

/**
 * Resolve a message for an explicit locale without touching the global. Used by
 * module-level helpers that already carry a locale (notices, error mapping).
 */
export function messageFor(
  locale: Locale,
  key: MsgKey,
  params?: MsgParams,
): string {
  return tFor(locale, key, params);
}

/** Exposed for tooling/tests that need the raw catalog value. */
export { lookup };
