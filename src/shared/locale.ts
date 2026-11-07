/**
 * Locale predicates for code that needs to branch on language.
 *
 * These exist specifically to replace string comparisons against translated
 * text (`t.files === "文件"`, `t.language === "Switch to English"`). Such
 * comparisons silently invert the whole UI when a catalog value is edited, so
 * they are banned by scripts/validate-no-cjk-literals.mjs.
 */
import { getLocale } from "./i18n/t";

/** True when the active locale is Chinese. */
export function isZh(): boolean {
  return getLocale() === "zh-CN";
}

/** Pick a value by active locale without an inline ternary at the call site. */
export function pick<T>(zhValue: T, enValue: T): T {
  return isZh() ? zhValue : enValue;
}
