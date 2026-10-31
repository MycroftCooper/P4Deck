import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ConnectionSnapshot } from "../companySubmit/model";
import type {
  ManualMergeSaveResult,
  ManualMergeSession,
  ManualMergeValidation,
  WorkflowResult,
} from "../../shared/contracts";

/**
 * S4c (resolve / manual-merge-session / save / resolve) — INTENT-ONLY lifecycle.
 *
 * Wire §0 hard boundary: these rows may only show intent/progress before the host answers; showing
 * "resolve succeeded" or "merged content saved" before the authoritative result is forbidden.
 * Authority: state=committed + per-file facts (resolve/manualMergeResolve) or details.resultDigest
 * (manualMergeSave). Legacy/affectedPaths/exitCode/legacy.outcome alone never prove success.
 * unknown/rejected never retries automatically; recovery is a workflow_action_lookup with the SAME
 * operationId (never a freshly minted ID).
 */
export type MergeResolveKind =
  "resolve" | "manualMergeSession" | "manualMergeSave" | "manualMergeResolve";
export type MergeResolveState =
  "intent" | "committed" | "unknown" | "rejected" | "legacy";
export interface MergeResolveFileFact {
  depotPath: string;
  state: string;
  message: string;
  operationId?: string;
}
export interface MergeResolveDetails {
  sessionId?: string;
  resultDigest?: string;
  backupPath?: string;
  valid?: boolean;
  unresolvedBlocks?: number;
  depotPath?: string;
}
export interface MergeResolveActionResultLike {
  kind: MergeResolveKind;
  operationId?: string;
  state: MergeResolveState;
  outcome: string;
  files?: MergeResolveFileFact[];
  message: string;
  optimistic?: "intentOnly";
  details?: MergeResolveDetails;
  legacy?: unknown;
}
export function isMergeResolveResult(
  value: unknown,
): value is MergeResolveActionResultLike {
  return (
    typeof value === "object" &&
    value !== null &&
    "state" in value &&
    "kind" in value &&
    "optimistic" in value
  );
}
export const lifecycleOf = (
  value: unknown,
): MergeResolveActionResultLike | undefined =>
  isMergeResolveResult(value) ? value : undefined;
/** Old payloads (mock/pre-S4c) remain readable; the legacy fields stay the only source for them. */
export function unwrapMergeLegacy<T>(value: unknown): T | undefined {
  if (isMergeResolveResult(value)) return value.legacy as T | undefined;
  return value as T | undefined;
}
export function newMergeRootId(): string {
  return `manual-merge-${crypto.randomUUID()}`;
}
/** Same-step retries reuse this deterministic id; it is never the root and never a fresh retry id. */
export const mergeStepOperationId = (root: string, step: string) =>
  `${root}:${step}`;
/** Only committed per-file facts may render resolve success. */
export function mergeResolveSucceeded(
  result: MergeResolveActionResultLike | undefined,
): boolean {
  if (!result || result.state !== "committed" || result.outcome !== "succeeded")
    return false;
  const files = result.files ?? [];
  return files.length > 0 && files.every((file) => file.state === "succeeded");
}
/** Save is proven only by the reviewed CAS digest, never by exitCode/affectedPaths/legacy.outcome. */
export function mergeSaveCommitted(
  result: MergeResolveActionResultLike | undefined,
): boolean {
  return (
    !!result &&
    result.state === "committed" &&
    result.outcome === "succeeded" &&
    !!result.details?.resultDigest
  );
}
export function mergeRemaining(
  result: MergeResolveActionResultLike | undefined,
) {
  return (result?.files ?? []).filter((file) => file.state !== "succeeded");
}
export function mergeUncertain(
  result: MergeResolveActionResultLike | undefined,
): boolean {
  return (
    !result ||
    result.state === "unknown" ||
    result.state === "rejected" ||
    result.outcome === "unknown" ||
    (result.files ?? []).some((file) => file.state === "unknown")
  );
}
/** Multi-step manual-merge: open/validate are read-only intents and may never claim success. */
export function mergeKindCanSucceed(kind: MergeResolveKind): boolean {
  return (
    kind === "resolve" ||
    kind === "manualMergeSave" ||
    kind === "manualMergeResolve"
  );
}
export interface MergeIntent {
  operationId: string;
  kind: MergeResolveKind;
  targetKey?: string;
}
let intents: readonly MergeIntent[] = [];
const listeners = new Set<() => void>();
const publish = (next: readonly MergeIntent[]) => {
  intents = next;
  for (const fn of listeners) fn();
};
export const mergeIntentsSnapshot = () => intents;
export const subscribeMergeIntents = (fn: () => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};
export const useMergeIntents = () =>
  useSyncExternalStore(subscribeMergeIntents, mergeIntentsSnapshot);
export function resetMergeIntentsForTests() {
  publish([]);
}
/** Intent/progress only: published before dispatch, cleared by the authoritative settle. */
export function beginMergeIntent(intent: MergeIntent): boolean {
  if (
    !intent.operationId ||
    intents.some((i) => i.operationId === intent.operationId)
  )
    return false;
  publish([...intents, { ...intent }]);
  return true;
}
export function settleMergeIntent(operationId: string) {
  publish(intents.filter((intent) => intent.operationId !== operationId));
}
export const mergeIntentActive = (operationId: string) =>
  intents.some((intent) => intent.operationId === operationId);
export interface MergeReceiptLike {
  state: "running" | "settled" | "interrupted";
  result?: MergeResolveActionResultLike | null;
}
export type MergeLookup =
  | { kind: "found"; receipt: MergeReceiptLike }
  | { kind: "notFound" | "scopeMismatch" | "storageUnavailable" };
/** Same-operationId recovery only; a not-found answer is NOT evidence that nothing was written. */
export function lookupMergeReceipt(
  operationId: string,
  connection: ConnectionSnapshot,
): Promise<MergeLookup> {
  return invoke<MergeLookup>("workflow_action_lookup", {
    request: { operationId, connection },
  });
}
/** Typed helpers for dialogs that must read old fields behind the new union. */
export type MergeLegacyResult =
  | WorkflowResult
  | ManualMergeSession
  | ManualMergeValidation
  | ManualMergeSaveResult;
