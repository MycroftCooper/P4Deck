import { useSyncExternalStore } from "react";
import { tFor } from "./i18n/t";
import type { MsgKey } from "./i18n/catalog.zh";

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

const prefersChinese = () => {
  try {
    const saved = localStorage.getItem("p4deck.locale");
    if (saved) return saved === "zh-CN";
  } catch {
    /* storage unavailable: fall back to the OS locale */
  }
  return navigator.language.toLowerCase().startsWith("zh");
};

/** Host preflight reasons are English strings; map the known ones for the active UI locale. */
const reasons: readonly [RegExp, string, string][] = [
  [
    /overlap local modifications/i,
    "notify.hostReason.overlap.local.modifications",
    "notify.hostReason.overlap.local.modifications",
  ],
  [
    /force overwrite is not enabled/i,
    "notify.hostReason.force.overwrite.is.not.enabled",
    "notify.hostReason.force.overwrite.is.not.enabled",
  ],
  [
    /preflight is not ready; nothing was written/i,
    "notify.hostReason.preflight.is.not.ready.nothing",
    "notify.hostReason.preflight.is.not.ready.nothing",
  ],
  [
    /preflight blocked/i,
    "notify.hostReason.preflight.blocked",
    "notify.hostReason.preflight.blocked",
  ],
  [
    /existing operation is running or interrupted/i,
    "notify.hostReason.existing.operation.is.running.or",
    "notify.hostReason.existing.operation.is.running.or",
  ],
  [
    /invalidconnection/i,
    "notify.hostReason.invalidconnection",
    "notify.hostReason.invalidconnection",
  ],
  [
    /duplicateChange/i,
    "notify.hostReason.duplicatechange",
    "notify.hostReason.duplicatechange",
  ],
  [
    /(?:^|\b)busy(?:\b|$)/i,
    "notify.hostReason.bbusy.b",
    "notify.hostReason.bbusy.b",
  ],
  [
    /notconfigured/i,
    "notify.hostReason.notconfigured",
    "notify.hostReason.notconfigured",
  ],
  [
    /toolnotfile|invalidExecutablePath/i,
    "notify.hostReason.toolnotfileinvalidexecutablepath",
    "notify.hostReason.toolnotfileinvalidexecutablepath",
  ],
  [
    /singleNumberedChangeRequired|invalidChangeId/i,
    "notify.hostReason.singlenumberedchangerequiredinvalidchangeid",
    "notify.hostReason.singlenumberedchangerequiredinvalidchangeid",
  ],
  [
    /connectionchanged/i,
    "notify.hostReason.connectionchanged",
    "notify.hostReason.connectionchanged",
  ],
  [
    /launchfailed|launchOutcomeUnknown/i,
    "notify.hostReason.launchfailedlaunchoutcomeunknown",
    "notify.hostReason.launchfailedlaunchoutcomeunknown",
  ],
  [
    /requestIdConflict|requestLimitReached/i,
    "notify.hostReason.requestidconflictrequestlimitreached",
    "notify.hostReason.requestidconflictrequestlimitreached",
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
