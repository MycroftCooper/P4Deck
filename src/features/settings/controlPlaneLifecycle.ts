import type { ConnectionSnapshot } from "../companySubmit/model";
import type {
  ControlPlaneActionKind,
  ControlPlaneActionResult,
} from "../../shared/contracts";
import {
  lookupControlPlaneAction,
  validControlPlaneReceipt,
  type ControlPlaneActionLookup,
} from "../actions/workflowReceipt";

/**
 * S4j2 control-plane lifecycle adapter helpers.
 *
 * Backup/export/log rows are local file/config control-plane operations whose
 * only authority is the host post-write readback. The UI may show **intent and
 * progress only**; `committed` is shown only when the artifact/readback facts
 * prove it, and restore can only ever be shown as `pending` (staged; applies on
 * the next start). Unknown outcomes are never retried with a new operationId.
 */
export function isControlPlaneActionResult(
  value: unknown,
): value is ControlPlaneActionResult {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<ControlPlaneActionResult>;
  return (
    typeof candidate.kind === "string" &&
    typeof candidate.state === "string" &&
    typeof candidate.outcome === "string" &&
    typeof candidate.message === "string" &&
    typeof candidate.optimistic === "string" &&
    typeof candidate.artifact === "object" &&
    candidate.artifact !== null
  );
}

export function controlPlaneDetails<T>(result: ControlPlaneActionResult) {
  return (result.details ?? undefined) as T | undefined;
}

/** Old wrapped payload for operationId-less calls; never itself an authority. */
export function controlPlaneLegacy<T>(result: ControlPlaneActionResult) {
  return result.state === "legacy"
    ? (result.legacy as T | undefined)
    : undefined;
}

/**
 * Committed only when the host readback proved the artifact for this row:
 * backup create / diagnostics export -> existing non-empty file; log policy ->
 * persisted policy.json; log clear -> empty readback (artifact intentionally empty).
 */
export function controlPlaneCommitted(result: ControlPlaneActionResult) {
  if (result.state !== "committed" || result.outcome !== "succeeded")
    return false;
  if (result.kind === "logClear")
    return (
      (controlPlaneDetails<{ remainingEntries?: number }>(result)
        ?.remainingEntries ?? -1) === 0
    );
  if (result.kind === "logPolicySet") return result.artifact.exists;
  return result.artifact.exists && result.artifact.sizeBytes > 0;
}

/** Restore is staged only: pending + rollback/pending manifest verified by host. */
export function controlPlaneRestorePending(result: ControlPlaneActionResult) {
  return (
    result.kind === "backupRestore" &&
    result.state === "pending" &&
    controlPlaneDetails<{ pendingStaged?: boolean }>(result)?.pendingStaged ===
      true
  );
}

export function syntheticUnknownControlPlane(
  kind: ControlPlaneActionKind,
  operationId: string,
  message: string,
): ControlPlaneActionResult {
  return {
    kind,
    operationId,
    state: "unknown",
    outcome: "unknown",
    artifact: { exists: false, sizeBytes: 0 },
    details: undefined,
    optimistic: "intentOnly",
    message,
    legacy: null,
  };
}

export interface ControlPlaneRunDeps {
  kind: ControlPlaneActionKind;
  operationId: string;
  connection: ConnectionSnapshot;
  execute(): Promise<ControlPlaneActionResult>;
  lookup?(request: {
    operationId: string;
    connection: ConnectionSnapshot;
  }): Promise<ControlPlaneActionLookup>;
}

export interface ControlPlaneRun {
  result: ControlPlaneActionResult;
  recovered: boolean;
  lookup?: ControlPlaneActionLookup | "error";
}

/**
 * One dispatch + at most one same-operationId receipt lookup. A transport
 * failure is unknown (never "not applied") and is never re-dispatched.
 */
export async function runControlPlaneAction(
  deps: ControlPlaneRunDeps,
): Promise<ControlPlaneRun> {
  let result: ControlPlaneActionResult | undefined;
  let lookup: ControlPlaneActionLookup | "error" | undefined;
  let recovered = false;
  try {
    result = await deps.execute();
  } catch {
    result = undefined;
  }
  const needsLookup =
    result === undefined ||
    result.state === "unknown" ||
    result.state === "rejected";
  if (needsLookup && deps.lookup) {
    try {
      const request = {
        operationId: deps.operationId,
        connection: deps.connection,
      };
      lookup = await deps.lookup(request);
      if (
        lookup?.kind === "found" &&
        validControlPlaneReceipt(request, lookup.receipt, deps.kind) &&
        lookup.receipt.state === "settled" &&
        lookup.receipt.result
      ) {
        result = lookup.receipt.result;
        recovered = true;
      }
    } catch {
      lookup = "error";
    }
  }
  return {
    result:
      result ??
      syntheticUnknownControlPlane(
        deps.kind,
        deps.operationId,
        "Outcome unconfirmed: the receipt was queried with the same operation id and no settled result was found. Refresh and inspect before any retry; never dispatch a new id.",
      ),
    recovered,
    lookup,
  };
}

/** Default adapter for the dialog-free cards (tests inject their own). */
export const defaultControlPlaneLookup = lookupControlPlaneAction;
