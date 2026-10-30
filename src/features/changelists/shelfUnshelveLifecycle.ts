import type { ConnectionSnapshot } from "../companySubmit/model";
import type {
  WorkflowConfirmation,
  WorkflowFileResult,
  WorkflowResult,
  WorkflowTargetSnapshot,
} from "../../shared/contracts";
import {
  validWorkflowReceipt,
  type WorkflowActionLookup,
} from "../actions/workflowReceipt";
import { invalidateData } from "../../shared/cache/dataEffects";

/**
 * S4d (shelve / unshelve) FE lifecycle adapter.
 *
 * The frozen host wire adds an OPTIONAL additive envelope on `WorkflowResult`:
 * `execution = { kind, operationId, state: "commandCompleted" | "unknown",
 * outcome, files: [] }`. An absent envelope is a legacy payload (rejected or
 * pre-migration host) and keeps the old top-level fields.
 *
 * Optimism boundary (user decision 2026-10-30): shelve create/replace and
 * unshelve are content-irreversible and have no authoritative per-file facts.
 * The UI may only show intent/progress. `commandCompleted` means the command
 * lifecycle finished; it is NOT "shelf created" / "unshelve done", and the
 * empty `execution.files` must never be turned into per-file success.
 *
 * Correction rules implemented here (single dispatch, no retry):
 *  - commandCompleted: keep the progress row, one bounded active refetch
 *    replaces the displayed caches; no per-file success is synthesized.
 *  - unknown: one same-operationId `workflow_action_lookup` (never a new id),
 *    then one bounded active refetch; the dialog shows explicit uncertainty.
 *  - legacy (no envelope): old payload is displayed as-is, one bounded active
 *    refetch; the old publishWorkflowResult/Failure path is not used.
 */
export type ShelfUnshelveKind = "shelf" | "unshelve";
export type ShelfUnshelveCommandState =
  "commandCompleted" | "unknown" | "legacy";

export interface ShelfUnshelveLifecycle {
  kind: ShelfUnshelveKind;
  operationId?: string;
  state: ShelfUnshelveCommandState;
  outcome: WorkflowResult["outcome"];
  /** Only wire-authoritative per-file facts; empty for this slice. */
  files: WorkflowFileResult[];
  /** Command-level lifecycle only; never per-file success. */
  commandCompleted: boolean;
  /** True when the frozen `execution` envelope was present and valid. */
  envelope: boolean;
}

export function shelfUnshelveLifecycle(
  result: WorkflowResult,
  kind: ShelfUnshelveKind,
  operationId: string,
): ShelfUnshelveLifecycle {
  const execution = result.execution;
  if (!execution) {
    return {
      kind,
      operationId,
      state: "legacy",
      outcome: result.outcome,
      files: result.files,
      commandCompleted: false,
      envelope: false,
    };
  }
  const consistent =
    execution.kind === kind &&
    execution.operationId === operationId &&
    (execution.state === "commandCompleted" || execution.state === "unknown");
  if (!consistent) {
    return {
      kind,
      operationId,
      state: "unknown",
      outcome: result.outcome,
      files: [],
      commandCompleted: false,
      envelope: true,
    };
  }
  return {
    kind,
    operationId: execution.operationId,
    state: execution.state,
    outcome: execution.outcome,
    files: execution.files,
    commandCompleted: execution.state === "commandCompleted",
    envelope: true,
  };
}

/** Exact pre-dispatch connection check; an unshelve target client is the target workspace. */
export function workflowConnectionMatchesTarget(
  target: WorkflowTargetSnapshot,
  connection: ConnectionSnapshot,
  kind: ShelfUnshelveKind,
) {
  if (target.server !== connection.server || target.user !== connection.user)
    return false;
  if (String(target.contextGeneration) !== connection.generation) return false;
  // SHELF runs in the current client; UNSHELVE may target another workspace,
  // so the target snapshot client is not the dispatching connection client.
  if (kind === "shelf" && target.client !== connection.client) return false;
  return true;
}

/** Pure posture used by the dialogs: only wire `files` can ever confirm rows. */
export function confirmedFilePaths(lifecycle: ShelfUnshelveLifecycle) {
  if (lifecycle.state === "legacy") return new Set<string>();
  return new Set(
    lifecycle.files
      .filter((file) => file.state === "succeeded")
      .map((file) => file.depotPath),
  );
}

export function boundedRefresh(
  connectionKey: string,
  target: WorkflowTargetSnapshot,
  result?: WorkflowResult,
): Promise<void> {
  const advice = result?.refresh;
  const paths =
    advice && advice.depotPaths.length ? advice.depotPaths : target.depotPaths;
  return invalidateData(["pending", "workspaceStatus", "depot"], {
    connectionKey,
    refetchType: "active",
    affectedPaths: paths,
  });
}

export interface ShelfUnshelveRunDeps {
  connection: ConnectionSnapshot;
  execute(confirmation: WorkflowConfirmation): Promise<WorkflowResult>;
  lookup?(request: {
    operationId: string;
    connection: ConnectionSnapshot;
  }): Promise<WorkflowActionLookup>;
  /** Exactly once per dispatch; must be the only post-action refresh. */
  refresh(
    connectionKey: string,
    target: WorkflowTargetSnapshot,
    result?: WorkflowResult,
  ): Promise<void>;
  connectionKey: string;
}

export interface ShelfUnshelveRun {
  lifecycle: ShelfUnshelveLifecycle;
  /** Raw wire result (legacy payloads are still displayed from here). */
  result?: WorkflowResult;
  /** Set when the unknown recovery returned a settled authoritative result. */
  recovered: boolean;
  refreshSucceeded: boolean;
  /** The one lookup outcome for diagnostics/tests; never a retry identity. */
  lookup?: WorkflowActionLookup | "error";
}

/**
 * Dispatch one confirmation with one operationId, then correct the UI from the
 * command-level facts. The write is never retried here; `unknown` only queries
 * the durable receipt with the SAME operationId.
 */
export async function runShelfUnshelve(
  confirmation: WorkflowConfirmation & { operationId: string },
  kind: ShelfUnshelveKind,
  deps: ShelfUnshelveRunDeps,
): Promise<ShelfUnshelveRun> {
  const operationId = confirmation.operationId;
  let result: WorkflowResult | undefined;
  let lifecycle: ShelfUnshelveLifecycle | undefined;
  let lookup: WorkflowActionLookup | "error" | undefined;
  let recovered = false;
  try {
    result = await deps.execute(confirmation);
    lifecycle = shelfUnshelveLifecycle(result, kind, operationId);
  } catch {
    // The write may have reached the host: transport failure is unknown, not
    // "not applied". Never re-dispatch; query the durable receipt by identity.
    lifecycle = {
      kind,
      operationId,
      state: "unknown",
      outcome: "unknown",
      files: [],
      commandCompleted: false,
      envelope: false,
    };
  }
  if (lifecycle.state === "unknown" && deps.lookup) {
    // Any uncertain write is recovered by identity only: same operationId and
    // the exact dispatching ConnectionSnapshot. A new id would be a retry.
    try {
      lookup = await deps.lookup({
        operationId,
        connection: deps.connection,
      });
      if (
        lookup?.kind === "found" &&
        validWorkflowReceipt(
          { operationId, connection: deps.connection },
          lookup.receipt,
          kind,
        ) &&
        lookup.receipt.state === "settled" &&
        lookup.receipt.result
      ) {
        result = lookup.receipt.result;
        lifecycle = shelfUnshelveLifecycle(result, kind, operationId);
        recovered = true;
      }
    } catch {
      lookup = "error";
    }
  }
  let refreshSucceeded = false;
  try {
    await deps.refresh(deps.connectionKey, confirmation.target, result);
    refreshSucceeded = true;
  } catch {
    refreshSucceeded = false;
  }
  const finalLifecycle =
    lifecycle ??
    shelfUnshelveLifecycle(
      {
        outcome: "unknown",
        message: "",
        operationIds: [operationId],
        files: [],
        refresh: {
          pendingChanges: true,
          workspaceStatus: true,
          depotPaths: confirmation.target.depotPaths,
          reason: "unknown",
        },
      },
      kind,
      operationId,
    );
  return {
    lifecycle: finalLifecycle,
    result,
    recovered,
    refreshSucceeded,
    lookup,
  };
}
