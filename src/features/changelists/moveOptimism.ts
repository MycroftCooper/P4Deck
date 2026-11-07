import { tFor } from "../../shared/i18n";
import type { MsgKey } from "../../shared/i18n/catalog.zh";
import { hasResourceConflict } from "../actions/resourceOverlap";
import { recordFrontendOperationLog } from "../../infrastructure/backend/frontendOperationLog";
import { useMemo, useSyncExternalStore } from "react";
import type { ActionPhase } from "../actions/ledger";
import {
  moveLedger,
  removalLedger,
  fileActionLedger,
} from "../actions/actionStore";
import { localDeleteBlockedPaths } from "../actions/localDeleteTask";
import { backend } from "../../infrastructure/backend";
import type { PendingChange, PendingFile } from "../../shared/contracts";
import {
  validMoveReceipt,
  type SelectedMoveRequest,
  type SelectedMoveReceipt,
} from "./selectedMove";
export interface MoveAttempt {
  scope: string;
  request: SelectedMoveRequest;
  originals: Record<string, PendingFile>;
  receipt?: SelectedMoveReceipt;
  busy: boolean;
  error?: string;
  reconciled?: boolean;
  admissionReleased?: boolean;
}
const ledger = moveLedger;
const attempts = () => ledger.getSnapshot().map((r) => r.data);
const phaseOf = (a: MoveAttempt): ActionPhase =>
  a.busy || a.receipt?.execution?.executionState === "running"
    ? "running"
    : a.error ||
        a.receipt?.execution?.outcome === "unknown" ||
        a.receipt?.execution?.executionState === "interrupted"
      ? "unknown"
      : "settled";
const publish = (next: readonly MoveAttempt[]) => {
  for (const a of next) {
    const old = ledger.get(a.request.operationId);
    if (old && old.data !== a)
      ledger.update(a.request.operationId, a, phaseOf(a));
  }
};
export function useMoveAttempts() {
  const records = useSyncExternalStore(ledger.subscribe, ledger.getSnapshot);
  return useMemo(() => records.map((r) => r.data), [records]);
}
export type MoveBlockReason = "running" | "unknown" | "verificationRequired";

/**
 * Why (or whether) a move attempt still blocks a path.
 *
 * Only genuinely unresolved work may block: running/interrupted, recovery
 * required, an `unknown` outcome, or a per-file `unknown` fact that was never
 * reconciled. A settled, terminal attempt is authoritative even when its
 * receipt omits the per-file row for a path (`!result`), when a stale `error`
 * string from an older lookup lingers, or when a `targetCreationUnknown`
 * attempt reached a terminal `notDispatched` state — those must not disable the
 * submit button forever.
 */
export function moveUnresolvedReason(
  attempt: MoveAttempt,
  path: string,
): MoveBlockReason | undefined {
  if (attempt.busy) return "running";
  const receipt = attempt.receipt;
  if (!receipt) return attempt.error ? "unknown" : undefined;
  const execution = receipt.execution ?? undefined;
  if (receipt.stage === "inProgress") return "running";
  if (execution) {
    if (
      execution.executionState === "running" ||
      execution.executionState === "interrupted"
    )
      return execution.executionState === "running" ? "running" : "unknown";
    if (execution.recoveryRequired) return "verificationRequired";
    if (execution.outcome === "unknown") return "unknown";
    // A settled notDispatched dispatch proves nothing was written for ANY path.
    if (execution.outcome === "notDispatched") return undefined;
  }
  const result = receipt.files.find((f) => f.depotPath === path);
  if (!execution) {
    // Legacy receipt shape (no execution envelope): durable per-file facts are
    // authoritative, but an unconfirmed new-CL identity still blocks retries.
    if (receipt.targetCreationUnknown) return "unknown";
    if (!result) return "unknown";
    return result.state === "unknown" ? "unknown" : undefined;
  }
  if (!result) {
    // Settled/terminal receipts may omit per-file rows; only a missing fact on a
    // non-terminal shape is still unresolved.
    return undefined;
  }
  if (result.state === "unknown") return "unknown";
  // moved / notMoved / alreadyInTarget are known terminal ownership facts.
  return undefined;
}
export function unresolvedMove(attempt: MoveAttempt, path: string) {
  if (attempt.admissionReleased && !attempt.busy) return false;
  return moveUnresolvedReason(attempt, path) !== undefined;
}
/** Only called after the host accepts this exact unknown fence release. History is unchanged. */
export function releaseLocalMoveAdmission(
  operationId: string,
  scope: { server: string; user: string; client: string },
) {
  const record = ledger.get(operationId);
  if (!record) return;
  const connection = record.data.request.connection;
  if (
    connection.server !== scope.server ||
    connection.user !== scope.user ||
    connection.client !== scope.client
  )
    return;
  const next = { ...record.data, admissionReleased: true };
  ledger.update(operationId, next, phaseOf(next));
}
export type BlockedSource = "move" | "removal" | "localDelete" | "fileAction";
export interface BlockedPathDetail {
  path: string;
  source: BlockedSource;
  reason: MoveBlockReason;
  operationId?: string;
}
/**
 * Diagnostics for the submit-blocking paths: which subsystem claims the path is
 * still unresolved and why. `blockedMovePaths` is the aggregated set form.
 */
export function blockedPathDetails(
  scope: string,
): Map<string, BlockedPathDetail> {
  const details = new Map<string, BlockedPathDetail>();
  const add = (detail: BlockedPathDetail) => {
    if (!details.has(detail.path)) details.set(detail.path, detail);
  };
  for (const record of removalLedger.getSnapshot()) {
    if (record.scope !== scope) continue;
    for (const item of record.data.items) {
      if (
        (record.data.execution?.busy ||
          !record.data.execution?.admissionReleased) &&
        (item.outcome === "pending" ||
          item.outcome === "unknown" ||
          (record.data.kind === "revert" && !item.ioComplete))
      )
        add({
          path: item.path,
          source: "removal",
          reason: record.data.execution?.busy ? "running" : "unknown",
          operationId: record.operationId,
        });
    }
  }
  for (const path of localDeleteBlockedPaths(scope))
    add({ path, source: "localDelete", reason: "unknown" });
  for (const record of fileActionLedger.getSnapshot()) {
    if (
      record.scope === scope &&
      (record.data.busy ||
        (record.data.outcome === "unknown" && !record.data.admissionReleased))
    )
      for (const path of record.data.paths)
        add({
          path,
          source: "fileAction",
          reason: record.data.busy ? "running" : "unknown",
          operationId: record.operationId,
        });
  }
  for (const attempt of attempts()) {
    if (attempt.scope !== scope) continue;
    if (attempt.admissionReleased && !attempt.busy) continue;
    for (const file of attempt.request.files) {
      const reason = moveUnresolvedReason(attempt, file.depotPath);
      if (reason)
        add({
          path: file.depotPath,
          source: "move",
          reason,
          operationId: attempt.request.operationId,
        });
    }
  }
  return details;
}
const BLOCKED_SOURCE_LABELS: Record<BlockedSource, string> = {
  move: "pending.move",
  removal: "pending.removal",
  localDelete: "pending.localDelete",
  fileAction: "pending.fileAction",
};
const BLOCKED_REASON_LABELS: Record<MoveBlockReason, string> = {
  running: "pending.running",
  unknown: "pending.moveBlockedOutcomeUnknown",
  verificationRequired: "pending.verificationRequired",
};
/** Human-readable, source/reason-aware explanation for blocked paths. */
export function formatBlockedPaths(
  paths: Iterable<string>,
  details: Map<string, BlockedPathDetail>,
  zh: boolean,
): string | undefined {
  const grouped = new Map<
    BlockedSource,
    { count: number; reasons: Set<MoveBlockReason> }
  >();
  for (const path of paths) {
    const detail = details.get(path);
    if (!detail) continue;
    const entry = grouped.get(detail.source) ?? {
      count: 0,
      reasons: new Set<MoveBlockReason>(),
    };
    entry.count += 1;
    entry.reasons.add(detail.reason);
    grouped.set(detail.source, entry);
  }
  if (!grouped.size) return undefined;
  const parts = [...grouped].map(([source, entry]) => {
    const sourceLabel = tFor(
      zh ? "zh-CN" : "en-US",
      BLOCKED_SOURCE_LABELS[source] as MsgKey,
    );
    const reasonLabel = [...entry.reasons]
      .map((reason) =>
        tFor(zh ? "zh-CN" : "en-US", BLOCKED_REASON_LABELS[reason] as MsgKey),
      )
      .join(zh ? "、" : ", ");
    return zh
      ? `${sourceLabel}×${entry.count}（${reasonLabel}）`
      : `${sourceLabel}×${entry.count} (${reasonLabel})`;
  });
  return zh
    ? `有未确认项：${parts.join("；")}，请先核实。`
    : `Unresolved items: ${parts.join("; ")}. Verify before submitting.`;
}
export function blockedMovePaths(scope: string): Set<string> {
  return new Set(blockedPathDetails(scope).keys());
}
async function lookupMove(
  request: import("./selectedMove").SelectedMoveLookup,
) {
  const result = await backend.selectedMoveLookup(request);
  if (result.kind === "found") return result.receipt;
  throw Error(`Move lookup ${result.kind}; no move was repeated.`);
}
async function readMove(attempt: MoveAttempt, execute: boolean) {
  const id = attempt.request.operationId;
  const lookup = { operationId: id, connection: attempt.request.connection };
  let receipt: SelectedMoveReceipt | undefined, error: string | undefined;
  try {
    let value: SelectedMoveReceipt | null;
    if (execute) {
      try {
        value = await backend.selectedMoveExecute(attempt.request);
      } catch {
        value = await lookupMove(lookup);
      }
    } else value = await lookupMove(lookup);
    if (!value || !validMoveReceipt(attempt.request, value))
      throw Error("Outcome unknown; no move was repeated.");
    const known = ledger.get(id)?.authority;
    if (
      known &&
      (!value.execution ||
        known.payloadDigest !== value.execution.payloadDigest)
    )
      throw Error("Receipt authority mismatch; no move was repeated.");
    receipt = value;
  } catch (cause) {
    error = String(cause);
    void recordFrontendOperationLog({
      eventId: `${id}-${execute ? "execute" : "refresh"}-unknown`,
      operationId: id,
      action: "moveFiles",
      phase: execute ? "execute" : "refresh",
      outcome: "unknown",
      code: "uncertainOutcome",
      targetCount: Math.min(1000, attempt.request.files.length),
    });
  }
  const current = ledger.get(id);
  if (!current) return;
  const next = {
    ...current.data,
    busy: false,
    receipt: receipt ?? current.data.receipt,
    error,
  };
  const authority = receipt?.execution
    ? {
        revision: receipt.execution.revision,
        payloadDigest: receipt.execution.payloadDigest,
      }
    : undefined;
  const accepted = ledger.update(id, next, phaseOf(next), authority);
  if (
    accepted &&
    receipt &&
    receipt.execution?.executionState !== "running" &&
    (receipt.execution?.outcome === "partial" ||
      receipt.execution?.outcome === "unknown")
  ) {
    void recordFrontendOperationLog({
      eventId: `${id}-receipt-${receipt.execution.revision}`,
      operationId: id,
      action: "moveFiles",
      phase: "execute",
      outcome: receipt.execution.outcome,
      code:
        receipt.execution.outcome === "unknown"
          ? "uncertainOutcome"
          : "operationFailed",
      targetCount: Math.min(1000, attempt.request.files.length),
    });
  }
  if (!accepted && current.data.busy) {
    // Equal/older receipts never replace known facts. A lookup finishing can clear local read busy.
    const retained = { ...current.data, busy: false };
    ledger.update(id, retained, phaseOf(retained));
  }
}
export function startOptimisticMove(
  scope: string,
  request: SelectedMoveRequest,
  changes: readonly PendingChange[],
): boolean {
  const blocked = blockedMovePaths(scope);
  if (
    hasResourceConflict(
      blocked,
      request.files.map((f) => f.depotPath),
    ) ||
    attempts().some((a) => a.request.operationId === request.operationId)
  )
    return false;
  const originals: Record<string, PendingFile> = {};
  for (const f of request.files) {
    const file = changes
      .find((c) => c.id === f.sourceChangeId)
      ?.files.find((v) => v.depotPath === f.depotPath);
    if (!file) return false;
    originals[f.depotPath] = { ...file };
  }
  const attempt: MoveAttempt = {
    scope,
    request: {
      ...request,
      connection: { ...request.connection },
      target: { ...request.target },
      files: request.files.map((f) => ({ ...f })),
    },
    originals,
    busy: true,
  };
  if (!ledger.admit(scope, request.operationId, attempt)) return false;
  ledger.update(request.operationId, attempt, "dispatching");
  void readMove(attempt, true);
  return true;
}
export function checkOptimisticMove(operationId: string) {
  const a = attempts().find((a) => a.request.operationId === operationId);
  if (
    !a ||
    a.busy ||
    (a.receipt?.stage === "completed" &&
      !a.receipt.execution?.recoveryRequired &&
      a.receipt.execution?.outcome !== "unknown")
  )
    return;
  const next = { ...a, busy: true };
  publish(attempts().map((v) => (v === a ? next : v)));
  void readMove(next, false);
}
/** Overlay fresh/old cache responses; each path is owned by its latest accepted intent. */
export function projectMoves(
  base: readonly PendingChange[],
  scope: string,
  all: readonly MoveAttempt[],
) {
  // Reconciled intents still supersede earlier intents for the same path.
  // Choose ownership before skipping retired overlays, or an older move revives.
  const current = all.filter((a) => a.scope === scope);
  const latest = new Map<string, MoveAttempt>();
  for (const a of current)
    for (const f of a.request.files) latest.set(f.depotPath, a);
  const changes = base.map((c) => ({ ...c, files: [...c.files] }));
  const temporary = new Map<
    string,
    { operationId: string; description: string; files: PendingFile[] }
  >();
  for (const a of current) {
    if (a.receipt?.targetCreationUnknown && a.request.target.kind === "new")
      temporary.set(a.request.operationId, {
        operationId: a.request.operationId,
        description: a.request.target.description,
        files: [],
      });
  }
  for (const [path, a] of latest) {
    if (a.reconciled) continue;
    const source = a.request.files.find((f) => f.depotPath === path)!;
    const fact = a.receipt?.files.find((f) => f.depotPath === path);
    const target =
      fact?.state === "notMoved"
        ? source.sourceChangeId
        : (a.receipt?.targetChangeId ??
          (a.request.target.kind === "existing"
            ? a.request.target.changeId
            : null));
    const file =
      changes.flatMap((c) => c.files).find((f) => f.depotPath === path) ??
      a.originals[path];
    for (const c of changes)
      c.files = c.files.filter((f) => f.depotPath !== path);
    if (target === null) {
      const group = temporary.get(a.request.operationId) ?? {
        operationId: a.request.operationId,
        description:
          a.request.target.kind === "new" ? a.request.target.description : "",
        files: [],
      };
      group.files.push(file);
      temporary.set(group.operationId, group);
    } else {
      let group = changes.find((c) => c.id === target);
      if (!group) {
        group = {
          id: target,
          description:
            a.request.target.kind === "new" ? a.request.target.description : "",
          user: a.request.connection.user,
          client: a.request.connection.client,
          status: "pending",
          jobs: [],
          files: [],
          shelvedFiles: [],
        };
        changes.push(group);
      }
      group.files.push(file);
    }
  }
  return { changes, temporary: [...temporary.values()] };
}

/** Retire an overlay only after the authoritative cache contains every confirmed ownership. */
export function reconcileMoveCache(
  scope: string,
  base: readonly PendingChange[],
) {
  let changed = false;
  const next = attempts().map((a) => {
    if (
      a.scope !== scope ||
      a.busy ||
      !!a.error ||
      a.receipt?.stage === "inProgress" ||
      a.receipt?.execution?.executionState === "running" ||
      a.reconciled ||
      !a.receipt ||
      a.receipt.targetCreationUnknown ||
      a.receipt.execution?.recoveryRequired ||
      a.receipt.files.some((f) => f.state === "unknown")
    )
      return a;
    const matched = a.receipt.files.every((f) => {
      const expected =
        f.state === "notMoved" ? f.sourceChangeId : a.receipt!.targetChangeId;
      return (
        expected !== null &&
        base
          .find((c) => c.id === expected)
          ?.files.some((v) => v.depotPath === f.depotPath)
      );
    });
    if (!matched) return a;
    changed = true;
    return { ...a, reconciled: true };
  });
  if (changed) publish(next);
}

/** Merge only terminal, individually known ownership. Unconfirmed projections never become cache facts. */
export function mergeConfirmedMoves(
  base: readonly PendingChange[],
  scope: string,
  all: readonly MoveAttempt[],
): PendingChange[] {
  const current = all.filter((a) => a.scope === scope);
  const latest = new Map<string, MoveAttempt>();
  for (const a of current)
    for (const f of a.request.files) latest.set(f.depotPath, a);
  const confirmed = current.flatMap((a) => {
    if (
      a.busy ||
      !!a.error ||
      a.receipt?.stage === "inProgress" ||
      a.receipt?.execution?.executionState === "running" ||
      a.reconciled ||
      !a.receipt
    )
      return [];
    const files = a.request.files.filter((f) => {
      if (latest.get(f.depotPath) !== a) return false;
      const fact = a.receipt!.files.find((v) => v.depotPath === f.depotPath);
      if (!fact || fact.state === "unknown") return false;
      const expected =
        fact.state === "notMoved"
          ? fact.sourceChangeId
          : a.receipt!.targetChangeId;
      if (expected === null) return false;
      const owners = base.filter((c) =>
        c.files.some((v) => v.depotPath === f.depotPath),
      );
      return owners.length !== 1 || owners[0].id !== expected;
    });
    if (!files.length) return [];
    return [
      {
        ...a,
        request: { ...a.request, files },
        receipt: {
          ...a.receipt,
          targetCreationUnknown: false,
          files: a.receipt.files.filter((f) =>
            files.some((v) => v.depotPath === f.depotPath),
          ),
        },
      },
    ];
  });
  return confirmed.length
    ? projectMoves(base, scope, confirmed).changes
    : (base as PendingChange[]);
}
