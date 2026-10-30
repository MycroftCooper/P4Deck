import type { ConnectionSnapshot } from "../companySubmit/model";
import type {
  BranchMappingDetail,
  BranchMutationResult,
  BranchMutationTarget,
  StreamSwitchResult,
  StreamSwitchTargetSnapshot,
} from "../../shared/contracts";

/**
 * S4i1 (branch-mapping CRUD / stream-switch) lifecycle helpers.
 *
 * Both operations touch server-side specs / workspace identity and are NOT
 * locally reversible. The UI may only show intent/progress while confirming;
 * authority is the host readback:
 *  - branch mapping: `outcome === "succeeded"` + `observed` detail readback;
 *  - stream switch: `outcome === "succeeded"` + `streamChanged` + `runtime`
 *    (verified new workspace/stream identity).
 * Unknown/cancelled/lost responses stay visibly uncertain and are never
 * retried with a new operationId.
 */
export function branchConnectionMatchesTarget(
  target: BranchMutationTarget,
  connection: ConnectionSnapshot,
) {
  return (
    target.server === connection.server &&
    target.user === connection.user &&
    target.client === connection.client &&
    String(target.contextGeneration) === connection.generation
  );
}

export function streamConnectionMatchesTarget(
  target: StreamSwitchTargetSnapshot,
  connection: ConnectionSnapshot,
) {
  return (
    target.server === connection.server &&
    target.user === connection.user &&
    target.client === connection.client &&
    String(target.contextGeneration) === connection.generation
  );
}

/** The written mapping read back from the server; never inferred from the request. */
export function branchObservedSummary(detail: BranchMappingDetail | undefined) {
  if (!detail) return undefined;
  return {
    name: detail.name,
    owner: detail.owner,
    viewLines: detail.view.length,
    locked: detail.locked,
  };
}

/** Succeeded only when the host readback proves the new identity. */
export function verifiedStreamSwitch(result: StreamSwitchResult | undefined) {
  if (
    !result ||
    result.outcome !== "succeeded" ||
    !result.streamChanged ||
    !result.verifiedStream ||
    !result.runtime
  )
    return undefined;
  return {
    stream: result.verifiedStream,
    contextGeneration: result.runtime.contextGeneration,
    client: result.runtime.context.client,
  };
}

export function unknownBranchMutationResult(
  operationId: string,
  message: string,
): BranchMutationResult {
  return {
    outcome: "unknown",
    failure: "uncertainOutcome",
    message,
    operationIds: [operationId],
    refreshBranchMappings: true,
    // `observed` intentionally absent: no readback authority.
  };
}

export function unknownStreamSwitchResult(
  operationId: string,
  message: string,
): StreamSwitchResult {
  return {
    outcome: "unknown",
    failure: "uncertainOutcome",
    message,
    streamChanged: false,
    syncPerformed: false,
    syncCompleted: false,
    operationId,
    logReference: operationId,
    refresh: {
      workspace: true,
      streams: true,
      pendingChanges: true,
      submittedChanges: true,
      search: true,
      depot: true,
      reason:
        "Verify the client spec/stream identity and refresh workspace/Stream views after an unconfirmed switch.",
    },
  };
}
