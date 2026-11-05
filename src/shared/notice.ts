import { useSyncExternalStore } from "react";
import { getLocale, tFor } from "./i18n/t";
import type { MsgKey } from "./i18n/catalog.zh";
import { fallbackLocale } from "./i18n/types";

export type UserNotice = {
  id: number;
  kind: "info" | "error";
  message: string;
};
let nextId = 1;
let notices: UserNotice[] = [];
const listeners = new Set<() => void>();
const emit = () => {
  for (const listener of listeners) listener();
};
const publish = () => emit();

/** Small non-blocking toast, used where a write is refused before/after dispatch. */
export function notifyUser(message: string, kind: "info" | "error" = "info") {
  if (!message.trim()) return;
  const notice = { id: nextId++, kind, message };
  notices = [...notices.slice(-2), notice];
  publish();
  setTimeout(() => dismissNotice(notice.id), kind === "error" ? 9000 : 5000);
}
export function dismissNotice(id: number) {
  if (!notices.some((notice) => notice.id === id)) return;
  notices = notices.filter((notice) => notice.id !== id);
  publish();
}
export const useUserNotices = () =>
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => notices,
    () => [],
  );

/**
 * The active UI locale. Reading storage or navigator here would duplicate the
 * locale store and could disagree with it after an in-session switch.
 */
const prefersChinese = () => getLocale() === fallbackLocale;

/** Host preflight reasons are English strings; map the known ones for the active UI locale. */
const reasons: readonly [RegExp, string][] = [
  // Exact enum codes the backend serialises (serde camelCase).
  [/^invalidconnection$/i, "notify.hostReason.invalidConnection"],
  [/^duplicatechange$/i, "notify.hostReason.duplicateChange"],
  [/^busy$/i, "notify.hostReason.busy"],
  [/^notconfigured$/i, "notify.hostReason.notConfigured"],
  [/^toolmissing$/i, "notify.hostReason.toolMissing"],
  [/^toolnotfile$|^invalidexecutablepath$/i, "notify.hostReason.toolNotFile"],
  [/^toolunverified$/i, "notify.hostReason.toolUnverified"],
  [/^toolchanged$/i, "notify.hostReason.toolChanged"],
  [/^stalesession$/i, "notify.hostReason.staleSession"],
  [/^invalidtransition$/i, "notify.hostReason.invalidTransition"],
  [/^realstartdisabled$/i, "notify.hostReason.realStartDisabled"],
  [
    /^singlenumberedchangerequired$|^invalidchangeid$/i,
    "notify.hostReason.invalidChangeId",
  ],
  [/^connectionchanged$/i, "notify.hostReason.connectionChanged"],
  [/^launchfailed$|^launchoutcomeunknown$/i, "notify.hostReason.launchFailed"],
  [
    /^requestidconflict$|^requestlimitreached$/i,
    "notify.hostReason.requestConflict",
  ],
  // Free-text preflight sentences from the host.
  [
    /overlap local modifications/i,
    "notify.hostReason.overlap.local.modifications",
  ],
  [
    /force overwrite is not enabled/i,
    "notify.hostReason.force.overwrite.is.not.enabled",
  ],
  [
    /preflight is not ready; nothing was written/i,
    "notify.hostReason.preflight.is.not.ready.nothing",
  ],
  [/preflight blocked/i, "notify.hostReason.preflight.blocked"],
  [
    /existing operation is running or interrupted/i,
    "notify.hostReason.existing.operation.is.running.or",
  ],
];

/**
 * Localized failure text for a direct write. Unknown host reasons keep their original text, but
 * the fallback (empty reason) follows the active UI locale.
 */
export function writeFailureText(
  message: string | undefined,
  fallback: { zh: string; en: string },
): string {
  const zh = prefersChinese();
  const text = (message ?? "").trim();
  if (!text) return zh ? fallback.zh : fallback.en;
  for (const [pattern, key] of reasons) {
    if (pattern.test(text)) return tFor(zh ? "zh-CN" : "en-US", key as MsgKey);
  }
  return tFor(zh ? "zh-CN" : "en-US", "notify.operation.incomplete", { text });
}

/** Single entry for every operation failure toast: host reason + localized fallback. */
export function notifyFailure(
  reason: string | null | undefined,
  fallback: { zh: string; en: string },
): void {
  notifyUser(writeFailureText(reason ?? undefined, fallback), "error");
}
