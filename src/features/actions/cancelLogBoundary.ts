import { tFor } from "../../shared/i18n";
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
    return tFor(
      zh ? "zh-CN" : "en-US",
      "actions.cancellation.was.requested.it.does",
    );
  if (state === "notFound")
    return tFor(
      zh ? "zh-CN" : "en-US",
      "actions.no.live.registration.matched.now",
    );
  if (state === "unknown")
    return tFor(
      zh ? "zh-CN" : "en-US",
      "actions.the.cancellation.outcome.is.unknown",
    );
  return tFor(
    zh ? "zh-CN" : "en-US",
    "actions.cancellation.was.requested.legacy.response",
  );
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
    return tFor(
      zh ? "zh-CN" : "en-US",
      "actions.log.already.recorded.duplicate.deduplicated",
    );
  if (receipt.status === "rejected")
    return tFor(zh ? "zh-CN" : "en-US", "actions.the.log.entry.was.rejected");
  return tFor(zh ? "zh-CN" : "en-US", "actions.the.is.unavailable");
}
