import { invoke } from "@tauri-apps/api/core";
import type { ConnectionSnapshot } from "./model";
import type { CustomSubmitSession } from "./customSubmit";

/**
 * S4h custom-submit lifecycle — INTENT ONLY.
 *
 * The host can only observe the external tool's parent process; it can never prove that the
 * company tool submitted anything. Therefore:
 *  - `started`      -> running/intent (never success);
 *  - `notStarted`   -> rejected with positive "tool not launched / not submitted" evidence;
 *  - `outcomeUnknown` (parent exited or unpollable, exitCode 0 or not) -> explicit unknown.
 * exitCode is display-only and never success/failure evidence. No new CL id is produced by the host;
 * a submitted CL may only be confirmed later by a submitted-CL readback (`query_changelists`).
 * Unknown recovery uses workflow_action_lookup with the SAME requestId (never a new id).
 */
export type CustomSubmitIntent = "running" | "rejected" | "unknown";
export interface CustomSubmitToolFacts {
  requestId: string;
  changeId: string;
  executablePath: string;
  toolState: "started" | "notStarted" | "outcomeUnknown";
  parentRunning: boolean;
  exitCode: number | null;
  reason: string | null;
}
export interface CustomSubmitActionResult {
  kind: "customSubmit";
  operationId?: string;
  state: "running" | "rejected" | "unknown";
  outcome: "unknown" | "rejected";
  tool: CustomSubmitToolFacts;
  optimistic: "intentOnly";
  message: string;
  legacy?: CustomSubmitSession;
}
export function isCustomSubmitActionResult(
  value: unknown,
): value is CustomSubmitActionResult {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    (value as { kind?: unknown }).kind === "customSubmit" &&
    "tool" in value &&
    "optimistic" in value
  );
}
/** Accepts the new envelope and the legacy raw Session (mock / pre-migration host). */
export function customSubmitSessionOf(
  value: unknown,
): CustomSubmitSession | undefined {
  if (isCustomSubmitActionResult(value))
    return value.legacy ?? sessionFromFacts(value);
  if (
    typeof value === "object" &&
    value !== null &&
    "requestId" in value &&
    "changeId" in value &&
    "state" in value
  )
    return value as CustomSubmitSession;
  return undefined;
}
/** Facts -> legacy-compatible session view (only for UI display; never invents a CL id). */
export function sessionFromFacts(
  action: CustomSubmitActionResult,
): CustomSubmitSession | undefined {
  const tool = action.tool;
  if (!tool) return undefined;
  return {
    requestId: tool.requestId,
    changeId: tool.changeId,
    state: tool.toolState,
    executablePath: tool.executablePath,
    exitCode: tool.exitCode,
    reason: tool.reason,
  };
}
/** Map any payload to the intent-only UI state; state never implies success. */
export function customSubmitIntentOf(value: unknown): CustomSubmitIntent {
  const action = isCustomSubmitActionResult(value) ? value : undefined;
  if (action) {
    if (action.state === "running") return "running";
    if (action.state === "rejected") return "rejected";
    return "unknown";
  }
  const session = customSubmitSessionOf(value);
  if (session?.state === "started") return "running";
  if (session?.state === "notStarted") return "rejected";
  return "unknown";
}
export interface CustomSubmitReceiptLike {
  state: "running" | "settled" | "interrupted";
  result?: CustomSubmitActionResult | null;
}
export type CustomSubmitLookup =
  | { kind: "found"; receipt: CustomSubmitReceiptLike }
  | { kind: "notFound" | "scopeMismatch" | "storageUnavailable" };
/** Same-requestId recovery only; running/interrupted are never treated as "not submitted". */
export function lookupCustomSubmitReceipt(
  operationId: string,
  connection: ConnectionSnapshot,
): Promise<CustomSubmitLookup> {
  return invoke<CustomSubmitLookup>("workflow_action_lookup", {
    request: { operationId, connection },
  });
}
