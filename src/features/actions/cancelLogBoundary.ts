import type { CancelOperationResult } from "../../shared/contracts";

/**
 * S4k cancel + frontend-log boundary (FE side), no business optimization.
 *
 * A cancel is a REQUEST, never a rollback and never proof that nothing ran:
 *  - cancelRequested: live registrations matched this exact id;
 *  - notFound: no live registration matched NOW — not evidence that the operation never ran;
 *  - unknown: invalid/unresolved id; the operation receipt remains the authority.
 * Messages therefore never claim "已取消/已回滚/未提交". frontend-log is best-effort: its receipt
 * always carries businessActionRetryAllowed=false and must never gate or replay the business action.
 */
export type CancelIntentState =
  "cancelRequested" | "notFound" | "unknown" | "legacy";
export function cancelIntentState(
  result: CancelOperationResult | void | undefined,
): CancelIntentState {
  if (!result || typeof result !== "object") return "legacy";
  const state = (result as CancelOperationResult).state;
  if (
    state === "cancelRequested" ||
    state === "notFound" ||
    state === "unknown"
  )
    return state;
  return "unknown";
}
/** Intent wording only: no success/rollback claim is ever produced from a cancel response. */
export function cancelIntentMessage(
  state: CancelIntentState,
  zh: boolean,
): string {
  if (state === "cancelRequested")
    return zh
      ? "取消请求已发送；它不会回滚服务器上已生效的更改，状态仍以操作记录为准。"
      : "Cancellation was requested. It does not roll back changes already applied on the server; the operation record remains authoritative.";
  if (state === "notFound")
    return zh
      ? "当前没有匹配的活动注册；这不代表操作未运行或未完成，请查看操作记录。"
      : "No live registration matched now. This is not evidence that the operation did not run or complete; check the operation record.";
  if (state === "unknown")
    return zh
      ? "取消结果未知；请以操作记录为准，不要据此重试业务操作。"
      : "The cancellation outcome is unknown. Check the operation record; do not retry the business action because of it.";
  return zh
    ? "取消请求已发送（旧响应未提供明细）；不代表回滚或未提交。"
    : "Cancellation was requested (legacy response without details). It does not mean a rollback or that nothing was submitted.";
}
export interface CancelBoundaryReceipt {
  state: CancelIntentState;
  serverRollbackClaimed: false;
  retryAllowed: false;
}
export function cancelBoundaryReceipt(
  result: CancelOperationResult | void | undefined,
): CancelBoundaryReceipt {
  return {
    state: cancelIntentState(result),
    serverRollbackClaimed: false,
    retryAllowed: false,
  };
}
export interface FrontendLogBestEffortReceipt {
  status: "recorded" | "duplicate" | "rejected" | "unavailable";
  businessActionRetryAllowed: false;
  blocksBusiness: false;
  retryAllowed: false;
}
/** Log persistence is never a business signal: failures/duplicates/limits never replay or block. */
export function bestEffortLogReceipt(receipt: {
  status: "recorded" | "duplicate" | "rejected" | "unavailable";
  reason?: string;
}): FrontendLogBestEffortReceipt {
  return {
    status: receipt.status,
    businessActionRetryAllowed: false,
    blocksBusiness: false,
    retryAllowed: false,
  };
}
/** Small optional note for the bottom log/error area; never a modal and never polling. */
export function bestEffortLogNote(
  receipt: { status: "recorded" | "duplicate" | "rejected" | "unavailable" },
  zh: boolean,
): string {
  if (receipt.status === "recorded") return "";
  if (receipt.status === "duplicate")
    return zh
      ? "日志已记录（重复事件已去重）。"
      : "Log already recorded (duplicate deduplicated).";
  if (receipt.status === "rejected")
    return zh
      ? "日志条目被拒绝；业务结果不受影响。"
      : "The log entry was rejected; the business result is unaffected.";
  return zh
    ? "日志暂不可用；业务结果不受影响，也不会重放业务。"
    : "The log is unavailable; the business result is unaffected and the action is not replayed.";
}
