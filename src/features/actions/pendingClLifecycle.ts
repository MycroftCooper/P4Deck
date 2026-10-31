import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ConnectionSnapshot } from "../companySubmit/model";
import type { PendingChangeMutationResult } from "../../shared/contracts";

/**
 * S4f pending-CL create/edit/delete lifecycle — INTENT ONLY.
 *
 * Wire §0: CL mutations are server transactions; before the host result the FE may show only
 * intent/progress and must never fabricate a CL number or claim "created/deleted/saved". Authority:
 * state=committed plus host `changes[]` facts and `mapping.authoritativeChangeId`/`createdChangeId`
 * (write-post `p4 changes` readback). unknown/rejected keep the row and recover via a
 * workflow_action_lookup with the SAME operationId (never a new id, never re-dispatch).
 */
export type PendingClKind =
  "pendingClCreate" | "pendingClEdit" | "pendingClDelete";
export type PendingClState = "intent" | "committed" | "unknown" | "legacy";
export interface PendingClChangeFact {
  changeId: number;
  description: string;
  fileCount?: number;
  jobs?: string[];
  present: boolean;
}
export interface PendingClMapping {
  placeholder: string;
  authoritativeChangeId?: number;
  source: string;
}
export interface PendingClActionResultLike {
  kind: PendingClKind;
  operationId?: string;
  state: PendingClState;
  outcome: string;
  changes?: PendingClChangeFact[];
  createdChangeId?: number;
  mapping?: PendingClMapping;
  optimistic?: "intentOnly";
  message: string;
  legacy?: unknown;
}
export function isPendingClResult(
  value: unknown,
): value is PendingClActionResultLike {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    "state" in value &&
    "mapping" in value &&
    "optimistic" in value
  );
}
export const lifecycleOf = (
  value: unknown,
): PendingClActionResultLike | undefined =>
  isPendingClResult(value) ? value : undefined;
export function unwrapPendingClLegacy<T>(value: unknown): T | undefined {
  if (isPendingClResult(value)) return value.legacy as T | undefined;
  return value as T | undefined;
}
/** Only a committed host result may render success. */
export const pendingClCommitted = (
  result: PendingClActionResultLike | undefined,
): boolean => !!result && result.state === "committed";
/** The ONLY authoritative CL id: mapping.authoritativeChangeId, else createdChangeId (host readback). */
export function authoritativeChangeId(
  result: PendingClActionResultLike | undefined,
): number | undefined {
  if (!pendingClCommitted(result)) return undefined;
  const mapped = result?.mapping?.authoritativeChangeId;
  if (typeof mapped === "number" && Number.isSafeInteger(mapped) && mapped > 0)
    return mapped;
  const created = result?.createdChangeId;
  if (
    typeof created === "number" &&
    Number.isSafeInteger(created) &&
    created > 0
  )
    return created;
  return undefined;
}
/** Committed readback facts only; affectedPaths/exitCode are never used as per-CL evidence. */
export const pendingClFacts = (
  result: PendingClActionResultLike | undefined,
): PendingClChangeFact[] =>
  pendingClCommitted(result) ? [...(result?.changes ?? [])] : [];
/** Delete is applied only when committed and the readback proves the CL absent. */
export function pendingClDeleteConfirmed(
  result: PendingClActionResultLike | undefined,
  changeId: number,
): boolean {
  if (!pendingClCommitted(result)) return false;
  const facts = result?.changes ?? [];
  return !facts.some(
    (fact) => fact.changeId === changeId && fact.present !== false,
  );
}
export interface PendingClIntent {
  operationId: string;
  kind: PendingClKind;
  changeId?: number;
  placeholder?: string;
}
let intents: readonly PendingClIntent[] = [];
const listeners = new Set<() => void>();
const publish = (next: readonly PendingClIntent[]) => {
  intents = next;
  for (const fn of listeners) fn();
};
export const pendingClIntentsSnapshot = () => intents;
export const subscribePendingClIntents = (fn: () => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};
export const usePendingClIntents = () =>
  useSyncExternalStore(subscribePendingClIntents, pendingClIntentsSnapshot);
export function resetPendingClIntentsForTests() {
  publish([]);
}
/** Published in the same tick as dispatch (placeholder is the operationId, never a CL number). */
export function beginPendingClIntent(intent: PendingClIntent): boolean {
  if (
    !intent.operationId ||
    intents.some((i) => i.operationId === intent.operationId)
  )
    return false;
  publish([...intents, { ...intent, placeholder: intent.operationId }]);
  return true;
}
export function settlePendingClIntent(operationId: string) {
  publish(intents.filter((intent) => intent.operationId !== operationId));
}
export const pendingClIntentActive = (operationId: string) =>
  intents.some((intent) => intent.operationId === operationId);
export interface PendingClReceiptLike {
  state: "running" | "settled" | "interrupted";
  result?: PendingClActionResultLike | null;
}
export type PendingClLookup =
  | { kind: "found"; receipt: PendingClReceiptLike }
  | { kind: "notFound" | "scopeMismatch" | "storageUnavailable" };
/** Same-operationId recovery only; notFound is NOT permission to retry with a new id. */
export function lookupPendingClReceipt(
  operationId: string,
  connection: ConnectionSnapshot,
): Promise<PendingClLookup> {
  return invoke<PendingClLookup>("workflow_action_lookup", {
    request: { operationId, connection },
  });
}
export interface PendingClRecoveryDeps {
  connection(): Promise<ConnectionSnapshot>;
  lookup(
    operationId: string,
    connection: ConnectionSnapshot,
  ): Promise<PendingClLookup>;
}
/**
 * Exactly ONE same-operationId lookup for an unknown/rejected lifecycle result. A settled result is
 * returned for authoritative correction; notFound/interrupted/errors stay conservative (caller keeps
 * rows and performs at most one bounded reload). Never mints a new id and never re-dispatches.
 */
export async function recoverPendingClUnknown(
  operationId: string,
  deps: PendingClRecoveryDeps,
): Promise<{ result?: PendingClActionResultLike; found: boolean }> {
  if (!operationId) return { found: false };
  try {
    const connection = await deps.connection();
    const found = await deps.lookup(operationId, connection);
    if (
      found.kind === "found" &&
      found.receipt.state === "settled" &&
      found.receipt.result
    )
      return { result: found.receipt.result, found: true };
    return { found: found.kind === "found" };
  } catch {
    return { found: false };
  }
}
export type PendingClLegacyResult = PendingChangeMutationResult;
