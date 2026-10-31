import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ConnectionStatus } from "../../shared/contracts";
import type { ConnectionSnapshot } from "../companySubmit/model";

/**
 * S4j1 connection-control lifecycle — INTENT ONLY.
 *
 * login/logout/trust/profile writes are credential/control-plane operations whose success is only
 * knowable from the adapter's authoritative ConnectionStatus readback or the persisted profile
 * document. Before that readback the UI may show only intent/progress. Credentials are NEVER part of
 * an intent record, receipt lookup request, log or error text: an intent carries only the kind,
 * operationId and a redacted label. Unknown recovery uses workflow_action_lookup with the SAME
 * operationId; credentials are never replayed and no new id is minted.
 */
export type ConnectionControlKind =
  | "authLogin"
  | "authLogout"
  | "authTrust"
  | "connectionProfileCreate"
  | "connectionProfileUpdate"
  | "connectionProfileDelete"
  | "connectionProfileSetActive";
export interface ConnectionControlIntent {
  operationId: string;
  kind: ConnectionControlKind;
  /** Redacted label only (server/user/name) — never a password/ticket/token. */
  label: string;
}
let intents: readonly ConnectionControlIntent[] = [];
const listeners = new Set<() => void>();
const publish = (next: readonly ConnectionControlIntent[]) => {
  intents = next;
  for (const fn of listeners) fn();
};
export const connectionControlIntentsSnapshot = () => intents;
export const subscribeConnectionControlIntents = (fn: () => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};
export const useConnectionControlIntents = () =>
  useSyncExternalStore(
    subscribeConnectionControlIntents,
    connectionControlIntentsSnapshot,
  );
export function resetConnectionControlIntentsForTests() {
  publish([]);
}
/** The intent record type structurally cannot carry credentials; this also strips stray fields. */
export function beginConnectionControlIntent(
  intent: ConnectionControlIntent,
): ConnectionControlIntent | undefined {
  if (!intent.operationId || !intent.kind) return undefined;
  if (intents.some((item) => item.operationId === intent.operationId))
    return intents.find((item) => item.operationId === intent.operationId);
  const safe: ConnectionControlIntent = {
    operationId: intent.operationId,
    kind: intent.kind,
    label: intent.label.replace(/\s+/g, " ").slice(0, 200),
  };
  publish([...intents, safe]);
  return safe;
}
export function settleConnectionControlIntent(operationId: string) {
  publish(intents.filter((intent) => intent.operationId !== operationId));
}
export const connectionControlIntentActive = (operationId: string) =>
  intents.some((intent) => intent.operationId === operationId);
export type ConnectionStatusVerdict = "success" | "notProven";
/**
 * Wire truth table (§4): only the adapter's authoritative status proves the auth outcome.
 * exitCode/message alone are never used; logout success requires a non-connected state.
 */
export function connectionStatusVerdict(
  kind: Extract<
    ConnectionControlKind,
    "authLogin" | "authLogout" | "authTrust"
  >,
  status: ConnectionStatus,
): ConnectionStatusVerdict {
  if (kind === "authLogin")
    return status.state === "connected" && !status.errorCode
      ? "success"
      : "notProven";
  if (kind === "authLogout")
    return status.state !== "connected" && !status.errorCode
      ? "success"
      : "notProven";
  return !status.errorCode ? "success" : "notProven";
}
export interface ConnectionControlReceiptLike {
  state: "running" | "settled" | "interrupted";
  result?: unknown;
}
export type ConnectionControlLookup =
  | { kind: "found"; receipt: ConnectionControlReceiptLike }
  | { kind: "notFound" | "scopeMismatch" | "storageUnavailable" };
/** Same-operationId recovery only; notFound/running/interrupted are never permission to retry. */
export function lookupConnectionControlReceipt(
  operationId: string,
  connection: ConnectionSnapshot,
): Promise<ConnectionControlLookup> {
  return invoke<ConnectionControlLookup>("workflow_action_lookup", {
    request: { operationId, connection },
  });
}
/** Exactly one same-id lookup; never mints a new id and never replays credentials. */
export async function recoverConnectionControlUnknown(
  operationId: string,
  deps: {
    connection(): Promise<ConnectionSnapshot>;
    lookup(
      operationId: string,
      connection: ConnectionSnapshot,
    ): Promise<ConnectionControlLookup>;
  },
): Promise<{ found: boolean; result?: ConnectionStatus }> {
  if (!operationId) return { found: false };
  try {
    const connection = await deps.connection();
    const found = await deps.lookup(operationId, connection);
    if (found.kind === "found" && found.receipt.state === "settled") {
      const result = found.receipt.result;
      if (
        typeof result === "object" &&
        result !== null &&
        "state" in result &&
        "server" in result
      )
        return { found: true, result: result as ConnectionStatus };
      return { found: true };
    }
    return { found: found.kind === "found" };
  } catch {
    return { found: false };
  }
}
