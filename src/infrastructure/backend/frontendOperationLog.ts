import { invoke, isTauri } from "@tauri-apps/api/core";
export interface FrontendOperationLog {
  eventId: string;
  operationId: string;
  action:
    | "shelfDelete"
    | "moveFiles"
    | "customSubmit"
    | "addressNavigation"
    | "otherOperation";
  phase: "preflight" | "execute" | "refresh" | "navigation";
  outcome: "failed" | "partial" | "unknown";
  code:
    | "preflightBlocked"
    | "contextChanged"
    | "targetMismatch"
    | "expired"
    | "transportError"
    | "operationFailed"
    | "uncertainOutcome"
    | "refreshFailed"
    | "pathNotFound"
    | "invalidTarget";
  targetCount: number;
  changeId?: string;
}
export interface FrontendLogReceipt {
  status: "recorded" | "duplicate" | "rejected" | "unavailable";
  reason?: string;
  /** S4k: always false — log persistence never authorizes replaying the business action. */
  businessActionRetryAllowed?: false;
}
/** Never forwards exception strings, paths, credentials or arbitrary metadata. */
export async function recordFrontendOperationLog(
  r: FrontendOperationLog,
): Promise<FrontendLogReceipt> {
  if (!isTauri())
    return {
      status: "unavailable",
      reason: "hostUnavailable",
      businessActionRetryAllowed: false,
    };
  const request: FrontendOperationLog = {
    eventId: r.eventId,
    operationId: r.operationId,
    action: r.action,
    phase: r.phase,
    outcome: r.outcome,
    code: r.code,
    targetCount: r.targetCount,
    ...(r.changeId ? { changeId: r.changeId } : {}),
  };
  try {
    const receipt = await invoke<FrontendLogReceipt>(
      "record_frontend_operation_log",
      { request },
    );
    return { ...receipt, businessActionRetryAllowed: false };
  } catch {
    return {
      status: "unavailable",
      reason: "ipcUnavailable",
      businessActionRetryAllowed: false,
    };
  }
}
