import { useSyncExternalStore } from "react";

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
    "搁置内容会与本地修改冲突，当前未启用强制覆盖。",
    "Shelved content would overlap local modifications; force overwrite is not enabled.",
  ],
  [
    /force overwrite is not enabled/i,
    "当前未启用强制覆盖。",
    "Force overwrite is not enabled.",
  ],
  [
    /preflight is not ready; nothing was written/i,
    "预检未通过，未写入任何内容。",
    "Preflight did not pass; nothing was written.",
  ],
  [
    /preflight blocked/i,
    "预检未通过，未执行。",
    "Preflight blocked; nothing was executed.",
  ],
  [
    /existing operation is running or interrupted/i,
    "该操作仍在进行或已中断，不会自动重试；请先核对状态。",
    "The operation is running or was interrupted; it is never auto-retried. Check its state first.",
  ],
  [
    /invalidconnection/i,
    "当前连接无效。",
    "The current connection is invalid.",
  ],
  [
    /duplicateChange/i,
    "该 CL 已有自定义提交工具在运行；同一个 CL 不能同时打开多个。",
    "A custom submit tool is already running for this CL; only one per changelist.",
  ],
  [
    /(?:^|\b)busy(?:\b|$)/i,
    "已有自定义提交工具在运行；请等它结束，不要重复提交。",
    "Another custom submit tool is already running; wait for it to finish.",
  ],
  [
    /notconfigured/i,
    "当前连接没有配置自定义提交工具路径。",
    "This connection has no custom submit tool path configured.",
  ],
  [
    /toolnotfile|invalidExecutablePath/i,
    "自定义提交工具路径无效（需为存在的绝对路径）。",
    "The custom submit tool path is invalid (must be an absolute existing file).",
  ],
  [
    /singleNumberedChangeRequired|invalidChangeId/i,
    "自定义提交只能提交单个编号 CL；Default / 多选请使用普通提交。",
    "Custom submit supports exactly one numbered changelist; use normal submit for Default or multi-select.",
  ],
  [
    /connectionchanged/i,
    "连接在操作期间已变化，请重新确认后再提交。",
    "The connection changed during the operation; confirm again.",
  ],
  [
    /launchfailed|launchOutcomeUnknown/i,
    "自定义提交工具启动失败或结果未知；请核对 P4 中的实际状态，不要重复提交。",
    "The custom submit tool failed to start or its outcome is unknown; check P4 before retrying.",
  ],
  [
    /requestIdConflict|requestLimitReached/i,
    "提交请求被拒绝（请求 ID 冲突或过多）；请重启应用后重试。",
    "The submit request was rejected (id conflict or too many requests); restart the app and retry.",
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
  for (const [pattern, cn, en] of reasons) {
    if (pattern.test(text)) return zh ? cn : en;
  }
  return zh ? `操作未完成：${text}` : text;
}

/** Single entry for every operation failure toast: host reason + localized fallback. */
export function notifyFailure(
  reason: string | null | undefined,
  fallback: { zh: string; en: string },
): void {
  notifyUser(writeFailureText(reason ?? undefined, fallback), "error");
}
