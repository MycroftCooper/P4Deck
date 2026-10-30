import { acceptRemoval } from "./removalProjection";
import { useSyncExternalStore } from "react";
import type {
  PendingChange,
  RuntimeInfo,
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
/** Exact per-file success only. A newer observation cannot be modified by this older receipt. */
export function finishRemovalObservation(
  operationId: string,
  runtime: RuntimeInfo,
  result?: WorkflowResult,
  notDispatched = false,
) {
  const record = removalLedger.get(operationId);
  if (!record) return;
  // `retained` is a known no-op fact only for revertUnchanged: the file was deliberately left
  // modified and open. It keeps the current row, retires this operation's optimistic hide,
  // releases only this operation's claim, and never claims "restored"/"reverted" content.
  const confirmation = record.data.execution?.confirmation;
  const retainedNoop =
    record.data.kind === "revert" &&
    !!confirmation &&
    "action" in confirmation &&
    confirmation.action === "revertUnchanged";
  const items = record.data.items.map((item) => {
    const matches =
      result?.files.filter((f) => f.depotPath === item.path) ?? [];
    const state = matches.length === 1 ? matches[0].state : undefined;
    const outcome = notDispatched
      ? ("notApplied" as const)
      : state === "succeeded"
        ? ("confirmed" as const)
        : state === "retained" && retainedNoop
          ? ("notApplied" as const)
          : ("unknown" as const);
    return { ...item, outcome, ioComplete: true };
  });
  removalLedger.update(
    operationId,
    {
      ...record.data,
      items,
      execution: record.data.execution
        ? { ...record.data.execution, busy: false }
        : undefined,
    },
    items.some((i) => i.outcome === "unknown") ? "unknown" : "settled",
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
