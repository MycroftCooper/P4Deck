import type { ConnectionSnapshot } from "../companySubmit/model";
import type {
  SubmitExecution,
  SubmitResult,
  SubmitTargetSnapshot,
} from "../../shared/contracts";

/**
 * S4g (submit-native) FE lifecycle adapter.
 *
 * A submit is a server-side, irreversible transaction: the UI may only show
 * intent/progress ("submitting…") until the authoritative result arrives. The
 * frozen host wire adds an OPTIONAL additive envelope on `SubmitResult`:
 * `execution = { kind: "submit", operationId, state: "commandCompleted" |
 * "unknown", outcome, files: [] }`. Absent envelope means a pre-dispatch
 * rejection (nothing was submitted) or a legacy payload.
 *
 * "Submitted" is presented only with `outcome === "submitted"` AND a valid
 * numeric `submittedChangeId`; `commandCompleted` alone is never success and
 * `execution.files` is empty by design (no per-file authority).
 */
export type SubmitCommandState =
  "submitted" | "unknown" | "rejected" | "failed" | "cancelled" | "legacy";

export interface SubmitLifecycle {
  kind: "submit";
  state: SubmitCommandState;
  outcome: SubmitResult["outcome"];
  operationId?: string;
  /** Authoritative new CL number; present only when the host proved it. */
  submittedChangeId?: number;
  /** True only for an authoritative submitted outcome + valid new CL id. */
  authoritativeSubmitted: boolean;
  /** True when the frozen `execution` envelope was present and consistent. */
  envelope: boolean;
}

export function validSubmittedChangeId(
  value: number | undefined,
): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function submitLifecycle(
  result: SubmitResult,
  operationId?: string,
): SubmitLifecycle {
  const execution: SubmitExecution | undefined = result.execution;
  const authoritativeId = validSubmittedChangeId(result.submittedChangeId)
    ? result.submittedChangeId
    : undefined;
  if (!execution) {
    // Legacy host / pre-dispatch payload: old semantics are kept, but success
    // still requires the authoritative submitted outcome + id.
    const submitted =
      result.outcome === "submitted" && authoritativeId !== undefined;
    return {
      kind: "submit",
      state: submitted
        ? "submitted"
        : result.outcome === "rejected"
          ? "rejected"
          : result.outcome === "failed"
            ? "failed"
            : result.outcome === "cancelled"
              ? "cancelled"
              : "unknown",
      outcome: result.outcome,
      operationId: result.operationId ?? operationId,
      submittedChangeId: submitted ? authoritativeId : undefined,
      authoritativeSubmitted: submitted,
      envelope: false,
    };
  }
  const consistent =
    execution.kind === "submit" &&
    (operationId === undefined || execution.operationId === operationId) &&
    (execution.state === "commandCompleted" || execution.state === "unknown") &&
    execution.outcome === result.outcome;
  const submitted =
    consistent &&
    execution.state === "commandCompleted" &&
    result.outcome === "submitted" &&
    authoritativeId !== undefined;
  return {
    kind: "submit",
    state: submitted
      ? "submitted"
      : consistent && result.outcome === "rejected"
        ? "rejected"
        : consistent && result.outcome === "cancelled"
          ? "cancelled"
          : consistent && result.outcome === "failed"
            ? "failed"
            : "unknown",
    outcome: result.outcome,
    operationId: execution.operationId,
    submittedChangeId: submitted ? authoritativeId : undefined,
    authoritativeSubmitted: submitted,
    envelope: true,
  };
}

/** Pre-dispatch identity check against the reviewed submit target. */
export function submitConnectionMatchesTarget(
  target: SubmitTargetSnapshot,
  connection: ConnectionSnapshot,
) {
  return (
    target.server === connection.server &&
    target.user === connection.user &&
    target.client === connection.client &&
    String(target.contextGeneration) === connection.generation
  );
}

/**
 * The client-side synthesis used when a transport failure left the write
 * unconfirmed and the durable receipt has no settled result. It is explicitly
 * unknown and never carries a new CL id.
 */
export function unknownSubmitResult(
  changeId: number,
  operationId: string,
  depotPaths: readonly string[],
): SubmitResult {
  return {
    outcome: "unknown",
    changeId,
    failure: "uncertainOutcome",
    message:
      "Outcome unconfirmed: the submit request may have reached the server. The durable receipt was queried with the same operation id and no settled result was found. Refresh and inspect before any retry; do not resubmit with a new operation id.",
    operationId,
    logReference: operationId,
    refresh: {
      pendingChanges: true,
      submittedChanges: true,
      workspaceStatus: true,
      depotPaths: [...depotPaths],
      reason:
        "Verify pending/submitted state after an unconfirmed transport failure.",
    },
  };
}
