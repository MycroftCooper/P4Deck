import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { backend } from "../../infrastructure/backend";
import type { FileActionResult, RuntimeInfo } from "../../shared/contracts";
import { sameSubmitIdentity } from "../changelists/selectedSubmit";
import { canonicalRevision } from "./ledger";
import type { ConnectionSnapshot } from "../companySubmit/model";

/** Per-row truth for the local-trash route. States come only from execution.files[]. */
export type LocalDeleteRowState =
  "pending" | "succeeded" | "unknown" | "blocked";
export interface LocalDeleteRow {
  readonly path: string;
  readonly state: LocalDeleteRowState;
}
export type LocalDeleteOutcome =
  "commandCompleted" | "unknown" | "notDispatched";
export interface LocalDeleteRecord {
  readonly operationId: string;
  readonly scope: string;
  readonly rows: readonly LocalDeleteRow[];
  readonly busy: boolean;
  readonly cancelRequested?: boolean;
  readonly outcome?: LocalDeleteOutcome;
  /** Dispatch transport; a host fence release must match it before releasing claims. */
  readonly transport?: { server: string; user: string; client: string };
  /** Set only by an explicit host `action_release_unknown` for this operation/scope. */
  readonly admissionReleased?: boolean;
}
export interface LocalDeleteRequest {
  action: "deleteLocal";
  paths: string[];
  operationId: string;
}
/** Durable `fileAction` receipt returned by `workflow_action_lookup`. */
export interface LocalDeleteReceipt {
  operationId: string;
  kind: string;
  connection: ConnectionSnapshot;
  payloadDigest: string;
  revision: string;
  state: "running" | "settled" | "interrupted";
  result: FileActionResult | null;
}
export type LocalDeleteReceiptLookup =
  | { kind: "found"; receipt: LocalDeleteReceipt }
  | { kind: "notFound" | "scopeMismatch" | "storageUnavailable" };
export interface LocalDeletePort {
  connection(): Promise<ConnectionSnapshot>;
  execute(
    request: LocalDeleteRequest,
    connection: ConnectionSnapshot,
  ): Promise<FileActionResult>;
  cancel(
    operationId: string,
  ): Promise<void | import("../../shared/contracts").CancelOperationResult>;
  /** Identity-only receipt read; never re-dispatches the write. */
  lookup?(request: {
    operationId: string;
    connection: ConnectionSnapshot;
  }): Promise<LocalDeleteReceiptLookup>;
}
export const localDeletePort: LocalDeletePort = {
  connection: () => backend.companySubmitConnectionSnapshot(),
  execute: (request, connection) =>
    backend.performFileAction(request, connection),
  cancel: (operationId) => backend.cancelOperation(operationId),
  lookup: (request) =>
    invoke<LocalDeleteReceiptLookup>("workflow_action_lookup", { request }),
};
let records: readonly LocalDeleteRecord[] = [];
const listeners = new Set<() => void>();
const publish = (next: readonly LocalDeleteRecord[]) => {
  records = next;
  for (const fn of listeners) fn();
};
export const localDeleteSnapshot = () => records;
export const subscribeLocalDeletes = (fn: () => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};
function update(
  operationId: string,
  mutate: (record: LocalDeleteRecord) => LocalDeleteRecord,
) {
  publish(records.map((r) => (r.operationId === operationId ? mutate(r) : r)));
}
export const localDeleteRecord = (operationId: string) =>
  records.find((record) => record.operationId === operationId);
/**
 * Host command failures that are raised before a durable receipt/fence exists
 * (`Err(String)` from preflight/plan/lease validation). Only these classes may
 * downgrade "invoke rejected" to "nothing was written"; transport, panic and
 * storage errors are never pre-dispatch evidence.
 */
const PRE_DISPATCH_ERROR_PATTERNS: readonly RegExp[] = [
  /^invalidConnection\b/i,
  /^connectionChanged\b/i,
  /^contextChanged\b/i,
  /^preflightBlocked\b/i,
  /^targetMismatch\b/i,
  /^token(?:Unknown|Expired)\b/i,
  /^operationIdPayloadConflict\b/i,
  /^actionPayloadTooLarge\b/i,
  /^actionReceiptCapacityReached\b/i,
  /^admissionEvidenceCapacityReached\b/i,
  /^at least one path is required\b/i,
  /^duplicate file path:/i,
  /^invalid file path:/i,
  /^Workspace Root\b/i,
  /^path escapes workspace root$/i,
  /^A connection snapshot is required\b/i,
  /^GUI .* must use the /i,
  /^Local trash\b/i,
  /^Existing operation is running or interrupted\b/i,
  /\(os error \d+\)$/i,
];
export function isPreDispatchHostError(error: unknown) {
  const message = (
    error instanceof Error ? error.message : String(error ?? "")
  ).trim();
  return PRE_DISPATCH_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}
/** Identity/shape check for a recovered receipt; `settled` is never a success claim by itself. */
function trustedReceipt(
  receipt: LocalDeleteReceipt,
  operationId: string,
  connection: ConnectionSnapshot,
) {
  return (
    receipt.kind === "fileAction" &&
    receipt.operationId === operationId &&
    sameSubmitIdentity(receipt.connection, connection) &&
    typeof receipt.revision === "string" &&
    canonicalRevision(receipt.revision) &&
    /^[a-f0-9]{64}$/.test(receipt.payloadDigest) &&
    receipt.state === "settled" &&
    !!receipt.result
  );
}
/**
 * Cancel through the existing `cancel_operation` channel with the SAME operationId used for
 * dispatch. Exactly one cancel call per in-flight operation; settled operations cannot be cancelled.
 */
export function cancelLocalDelete(
  operationId: string,
  port: LocalDeletePort = localDeletePort,
): boolean {
  const record = localDeleteRecord(operationId);
  if (!record || !record.busy || record.cancelRequested) return false;
  publish(
    records.map((r) =>
      r.operationId === operationId ? { ...r, cancelRequested: true } : r,
    ),
  );
  void port.cancel(operationId).catch(() => undefined);
  return true;
}
/**
 * Host fence release (`action_release_unknown`) for the local-trash claim: the
 * same operationId + transport scope downgrades every unknown row to the
 * terminal `blocked` state, so `localDeleteBlockedPaths` stops blocking the
 * submit/revert/move/shelve entries. Other operations, busy records and other
 * scopes are never touched. Idempotent.
 */
export function releaseLocalDeleteAdmission(
  operationId: string,
  scope: { server: string; user: string; client: string },
): boolean {
  const record = localDeleteRecord(operationId);
  if (!record || record.busy || record.admissionReleased) return false;
  if (
    record.transport &&
    (record.transport.server !== scope.server ||
      record.transport.user !== scope.user ||
      record.transport.client !== scope.client)
  )
    return false;
  if (!record.rows.some((row) => row.state === "unknown")) return false;
  update(operationId, (r) => ({
    ...r,
    admissionReleased: true,
    rows: r.rows.map((row) =>
      row.state === "unknown" ? { ...row, state: "blocked" as const } : row,
    ),
  }));
  return true;
}
export const localDeleteHiddenPathsForTests = (scope: string) =>
  hiddenFor(scope);
/** Pending (in flight) and unknown (attempted, unconfirmed) rows keep their local claim. */
export function localDeleteBlockedPaths(scope: string): Set<string> {
  const blocked = new Set<string>();
  for (const r of records) {
    if (r.scope !== scope) continue;
    for (const row of r.rows)
      if (row.state === "pending" || row.state === "unknown")
        blocked.add(row.path);
  }
  return blocked;
}
let lastRecords: readonly LocalDeleteRecord[] | undefined;
const hiddenCache = new Map<string, ReadonlySet<string>>();
function hiddenFor(scope: string): ReadonlySet<string> {
  if (records !== lastRecords) {
    lastRecords = records;
    hiddenCache.clear();
  }
  let cached = hiddenCache.get(scope);
  if (!cached) {
    const hidden = new Set<string>();
    for (const r of records)
      if (r.scope === scope)
        for (const row of r.rows)
          if (row.state === "pending") hidden.add(row.path);
    cached = hidden;
    hiddenCache.set(scope, cached);
  }
  return cached;
}
/** Optimistic hide for rows not yet acknowledged (removed once the operation settles). */
export const useLocalDeleteHidden = (scope: string) =>
  useSyncExternalStore(subscribeLocalDeletes, () => hiddenFor(scope));
export function resetLocalDeleteForTests() {
  publish([]);
}
/**
 * One caller-visible entry for the local-trash route: generate ONE operationId before dispatch,
 * send the exact connection snapshot, and map truth strictly from execution.files[] (never from
 * affectedPaths). No automatic retry and no automatic refresh/dialog side effects. Cancellation
 * reuses the existing `cancel_operation` channel with the same operationId. An invoke rejection is
 * corrected by ONE same-operationId receipt lookup: found+settled settles from the receipt; a
 * pre-dispatch host error with no receipt releases the claim as `notDispatched`; anything else
 * stays unknown and keeps its host fence for explicit release.
 */
export function startLocalDelete(
  scope: string,
  runtime: RuntimeInfo,
  paths: readonly string[],
  current: () => boolean,
  port: LocalDeletePort = localDeletePort,
  hooks?: {
    onStarted?(operationId: string): void;
    onSettled?(operationId: string, outcome: LocalDeleteOutcome): void;
  },
): boolean {
  const unique = [...new Set(paths)].filter(
    (path): path is string => typeof path === "string" && path.length > 0,
  );
  if (!unique.length || !current()) return false;
  if (unique.some((path) => localDeleteBlockedPaths(scope).has(path)))
    return false;
  const operationId = crypto.randomUUID();
  publish([
    ...records,
    {
      operationId,
      scope,
      busy: true,
      transport: {
        server: runtime.context.server,
        user: runtime.context.user,
        client: runtime.context.client,
      },
      rows: unique.map((path) => ({ path, state: "pending" as const })),
    },
  ]);
  hooks?.onStarted?.(operationId);
  queueMicrotask(() => {
    void (async () => {
      const request: LocalDeleteRequest = {
        action: "deleteLocal",
        paths: unique,
        operationId,
      };
      let connection: ConnectionSnapshot | undefined;
      let dispatched = false;
      let result: FileActionResult | undefined;
      try {
        connection = await port.connection();
        if (
          !current() ||
          connection.server !== runtime.context.server ||
          connection.user !== runtime.context.user ||
          connection.client !== runtime.context.client
        )
          throw Error("context changed");
        dispatched = true;
        result = await port.execute(request, connection);
      } catch (error) {
        // The write may have reached the host: query the durable receipt by the
        // SAME operationId (never a new id) before deciding the outcome.
        let receiptMissing = false;
        if (dispatched && connection && port.lookup) {
          try {
            const found = await port.lookup({ operationId, connection });
            if (found.kind === "found") {
              if (trustedReceipt(found.receipt, operationId, connection))
                result = found.receipt.result ?? undefined;
            } else if (found.kind === "notFound") receiptMissing = true;
          } catch {
            /* A read failure is never permission to retry or to release blindly. */
          }
        }
        if (!result) {
          // Zero I/O (context drift / connection failure before dispatch): withdraw every intent.
          // After dispatch, a transport failure is not "nothing happened": rows stay unknown and
          // visible. Only a classified pre-dispatch host error plus a missing receipt releases it.
          const rejectedBeforeWrite =
            dispatched && receiptMissing && isPreDispatchHostError(error);
          const settled: LocalDeleteOutcome =
            !dispatched || rejectedBeforeWrite ? "notDispatched" : "unknown";
          update(operationId, (r) => ({
            ...r,
            busy: false,
            outcome: settled,
            rows: r.rows.map((row) => {
              if (settled === "notDispatched")
                return { ...row, state: "blocked" as const };
              return row.state === "succeeded"
                ? row
                : { ...row, state: "unknown" as const };
            }),
          }));
          hooks?.onSettled?.(operationId, settled);
          return;
        }
      }
      const execution = result.execution;
      const files = execution?.files ?? [];
      const byPath = new Map<string, (typeof files)[number]>();
      let duplicate = false;
      for (const file of files) {
        if (byPath.has(file.depotPath)) duplicate = true;
        byPath.set(file.depotPath, file);
      }
      const trusted =
        !!execution &&
        !duplicate &&
        execution.operationId === operationId &&
        (execution.outcome === "commandCompleted" ||
          execution.outcome === "unknown" ||
          execution.outcome === "notDispatched")
          ? execution.outcome
          : undefined;
      const settled: LocalDeleteOutcome = trusted ?? "unknown";
      update(operationId, (r) => ({
        ...r,
        busy: false,
        outcome: settled,
        rows: r.rows.map((row) => {
          if (!trusted) return { ...row, state: "unknown" as const };
          if (trusted === "notDispatched")
            return { ...row, state: "blocked" as const };
          const fact = byPath.get(row.path);
          if (!fact) return { ...row, state: "unknown" as const };
          if (fact.state === "succeeded")
            return { ...row, state: "succeeded" as const };
          if (fact.state === "blocked")
            return { ...row, state: "blocked" as const };
          return { ...row, state: "unknown" as const };
        }),
      }));
      hooks?.onSettled?.(operationId, settled);
    })();
  });
  return true;
}
