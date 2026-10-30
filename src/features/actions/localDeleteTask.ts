import { useSyncExternalStore } from "react";
import { backend } from "../../infrastructure/backend";
import type { FileActionResult, RuntimeInfo } from "../../shared/contracts";
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
}
export interface LocalDeleteRequest {
  action: "deleteLocal";
  paths: string[];
  operationId: string;
}
export interface LocalDeletePort {
  connection(): Promise<ConnectionSnapshot>;
  execute(
    request: LocalDeleteRequest,
    connection: ConnectionSnapshot,
  ): Promise<FileActionResult>;
  cancel(
    operationId: string,
  ): Promise<void | import("../../shared/contracts").CancelOperationResult>;
}
export const localDeletePort: LocalDeletePort = {
  connection: () => backend.companySubmitConnectionSnapshot(),
  execute: (request, connection) =>
    backend.performFileAction(request, connection),
  cancel: (operationId) => backend.cancelOperation(operationId),
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
 * affectedPaths). No receipt lookup, no automatic retry, no automatic refresh/dialog side effects.
 * Cancellation reuses the existing `cancel_operation` channel with the same operationId.
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
      let result: FileActionResult | undefined;
      let dispatched = false;
      try {
        const connection = await port.connection();
        if (
          !current() ||
          connection.server !== runtime.context.server ||
          connection.user !== runtime.context.user ||
          connection.client !== runtime.context.client
        )
          throw Error("context changed");
        dispatched = true;
        result = await port.execute(request, connection);
      } catch {
        // Zero I/O (context drift / connection failure before dispatch): withdraw every intent.
        // After dispatch, a transport failure is not "nothing happened": rows stay unknown and visible.
        update(operationId, (r) => ({
          ...r,
          busy: false,
          outcome: dispatched ? "unknown" : "notDispatched",
          rows: r.rows.map((row) => {
            if (!dispatched) return { ...row, state: "blocked" as const };
            return row.state === "succeeded"
              ? row
              : { ...row, state: "unknown" as const };
          }),
        }));
        hooks?.onSettled?.(
          operationId,
          dispatched ? "unknown" : "notDispatched",
        );
        return;
      }
      const execution = result?.execution;
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
