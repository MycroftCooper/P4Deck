import { acceptRemoval } from "./removalProjection";
import { useSyncExternalStore } from "react";
import type {
  PendingChange,
  RuntimeInfo,
  WorkflowFailureCode,
  WorkflowResult,
} from "../../shared/contracts";
import { appCache } from "../../shared/cache/appCache";
import { readSnapshot, writeSnapshot } from "../../shared/cache/snapshots";
import {
  pendingSnapshotKey,
  type PendingSnapshot,
} from "../changelists/pendingCache";
import { removalLedger } from "./actionStore";
import { projectRemoval } from "./removalProjection";
export function shelfObservation(runtime: RuntimeInfo) {
  const key = pendingSnapshotKey(runtime),
    state = appCache.getQueryState(key);
  // Local cache observation only, never a server content version.
  return { key, version: JSON.stringify([key, state?.dataUpdateCount ?? 0]) };
}
export function acceptRemovalObservation(
  kind: "shelfDelete" | "revert",
  scope: string,
  operationId: string,
  changeId: number,
  paths: string[],
  runtime: RuntimeInfo,
  sources?: ReadonlyMap<string, number>,
) {
  const observation = shelfObservation(runtime).version;
  const admitted = acceptRemoval(removalLedger, kind, {
    scope,
    operationId,
    confirmed: true,
    items: paths.map((path) => ({
      path,
      changeId: sources?.get(path) ?? changeId,
      version: observation,
    })),
  });
  if (admitted !== "accepted") return false;
  const record = removalLedger.get(operationId)!;
  removalLedger.update(
    operationId,
    {
      ...record.data,
      execution: {
        observation,
        busy: true,
        transport: {
          server: runtime.context.server,
          user: runtime.context.user,
          client: runtime.context.client,
        },
      },
    },
    "localAccepted",
  );
  return true;
}
export const useRemovalActions = () =>
  useSyncExternalStore(removalLedger.subscribe, removalLedger.getSnapshot);
export function projectRemovalChanges(
  kind: "shelfDelete" | "revert",
  changes: PendingChange[],
  scope: string,
  observation: string,
  records = removalLedger.getSnapshot(),
) {
  let changed = false;
  const rows = changes.map((cl) => {
    const entities = (kind === "shelfDelete" ? cl.shelvedFiles : cl.files).map(
      (file) => ({
        path: file.depotPath,
        changeId: cl.id,
        version: observation,
        file,
      }),
    );
    const projected = projectRemoval(kind, scope, entities, records);
    if (projected.items === entities) return cl;
    changed = true;
    return kind === "shelfDelete"
      ? { ...cl, shelvedFiles: projected.items.map((i) => i.file) }
      : { ...cl, files: projected.items.map((i) => i.file) };
  });
  return changed ? rows : changes;
}
/**
 * Failure codes that prove the host rejected the operation before it wrote
 * anything (token/identity/content revalidation and internal preflight all run
 * before the P4 command). Such a result is a known no-op, never "unknown".
 * `cancelled`/`commandFailure`/`uncertainOutcome` are deliberately excluded:
 * a cancelled or failed command may still have partially applied.
 */
const KNOWN_NOT_APPLIED_FAILURES: ReadonlySet<WorkflowFailureCode> = new Set([
  "preflightBlocked",
  "contentChanged",
  "contextChanged",
  "tokenUnknown",
  "tokenExpired",
  "targetMismatch",
]);

/**
 * True when the host result deterministically did not write: `rejected` is only
 * produced by pre-execution revalidation, and `failed` with a pre-write failure
 * code is the internal-preflight rejection of the direct delete path.
 */
export function knownNotAppliedWorkflowResult(
  result: WorkflowResult | undefined,
) {
  return (
    !!result &&
    (result.outcome === "rejected" ||
      (result.outcome === "failed" &&
        !!result.failure &&
        KNOWN_NOT_APPLIED_FAILURES.has(result.failure)))
  );
}
/**
 * Settle one removal observation from a host result. A command-level success
 * (`execution.state === "commandCompleted"`) is authoritative only when the
 * envelope belongs to this exact dispatch (same operationId/kind/outcome);
 * P4's `retained` is a known no-op ("revert -a kept a modified file"); a host
 * deterministic rejection is a known "nothing was written". Only genuinely
 * missing/unknown facts stay blocking. Once every item is terminal there is no
 * host unknown fence to wait for, so the local admission is released for both
 * shelf-delete call paths.
 */
export function finishRemovalObservation(
  operationId: string,
  runtime: RuntimeInfo,
  result?: WorkflowResult,
  notDispatched = false,
) {
  const record = removalLedger.get(operationId);
  if (!record) return;
  const execution = result?.execution;
  // F9: the envelope is evidence only for the dispatch that produced it. The
  // host writes `execution.kind = "shelf"` for both shelf create and shelf
  // delete, so the removal kind maps to the wire kind.
  const expectedKind = record.data.kind === "shelfDelete" ? "shelf" : undefined;
  const envelopeTrusted =
    !execution ||
    (!!result &&
      execution.operationId === operationId &&
      (expectedKind === undefined || execution.kind === expectedKind) &&
      execution.outcome === result.outcome);
  const commandCompleted =
    envelopeTrusted && execution?.state === "commandCompleted";
  const knownNoOp = notDispatched || knownNotAppliedWorkflowResult(result);
  const items = record.data.items.map((item) => {
    const matches =
      result?.files.filter((f) => f.depotPath === item.path) ?? [];
    const state = matches.length === 1 ? matches[0].state : undefined;
    const outcome = knownNoOp
      ? ("notApplied" as const)
      : state === "succeeded"
        ? ("confirmed" as const)
        : state === "retained"
          ? ("notApplied" as const)
          : matches.length > 0
            ? // Any per-file fact (including a duplicate/contradictory one) wins
              // over the command-level fallback: never synthesize a success.
              ("unknown" as const)
            : commandCompleted
              ? ("confirmed" as const)
              : ("unknown" as const);
    return { ...item, outcome, ioComplete: true };
  });
  const settled = items.every((item) => item.outcome !== "unknown");
  removalLedger.update(
    operationId,
    {
      ...record.data,
      items,
      execution: record.data.execution
        ? {
            ...record.data.execution,
            busy: false,
            ...(settled ? { admissionReleased: true } : {}),
          }
        : undefined,
    },
    settled ? "settled" : "unknown",
  );
  const observation = shelfObservation(runtime);
  if (record.data.execution?.observation !== observation.version) return;
  const snapshot = readSnapshot<PendingSnapshot>(observation.key);
  if (!snapshot) return;
  const successful = new Set(
    items
      .filter((i) => i.outcome === "confirmed" && !i.retired)
      .map((i) => JSON.stringify([i.changeId, i.path])),
  );
  if (!successful.size) return;
  const changes = snapshot.data.changes.map((cl) => {
    const original =
      record.data.kind === "shelfDelete" ? cl.shelvedFiles : cl.files;
    const files = original.filter(
      (f) => !successful.has(JSON.stringify([cl.id, f.depotPath])),
    );
    return files.length === original.length
      ? cl
      : record.data.kind === "shelfDelete"
        ? { ...cl, shelvedFiles: files }
        : { ...cl, files };
  });
  writeSnapshot(
    observation.key,
    { ...snapshot.data, changes },
    { persist: true, updatedAt: snapshot.updatedAt },
  );
}

/** A newer explicit shelf action invalidates older visual assumptions, never their unknown locks. */
export function invalidateShelfObservations(
  scope: string,
  paths: readonly string[],
) {
  const selected = new Set(paths);
  for (const record of removalLedger.getSnapshot()) {
    if (record.scope !== scope || record.data.kind !== "shelfDelete") continue;
    if (!record.data.items.some((i) => selected.has(i.path) && !i.retired))
      continue;
    removalLedger.update(
      record.operationId,
      {
        ...record.data,
        items: record.data.items.map((i) =>
          selected.has(i.path) ? { ...i, retired: true } : i,
        ),
      },
      record.phase,
    );
  }
}

export const acceptShelfObservation = (
  scope: string,
  id: string,
  cl: number,
  paths: string[],
  runtime: RuntimeInfo,
) => acceptRemovalObservation("shelfDelete", scope, id, cl, paths, runtime);
export const projectShelfChanges = (
  changes: PendingChange[],
  scope: string,
  observation: string,
  records = removalLedger.getSnapshot(),
) => projectRemovalChanges("shelfDelete", changes, scope, observation, records);
export const finishShelfObservation = finishRemovalObservation;
