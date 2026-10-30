import type { FileActionResult } from "../../shared/contracts";
/** Existing generic results identify invalidation paths, not per-item ownership or completion. */
export function normalizeLegacyFileResult(
  request: { operationId?: string; paths: readonly string[] },
  receipt?: FileActionResult,
) {
  const expected = request.operationId,
    actual = receipt?.operation?.operationId;
  return {
    operationId: expected ?? actual,
    correlation:
      expected && actual && expected !== actual
        ? ("mismatch" as const)
        : ("compatible" as const),
    outcome: "unknown" as const,
    requiresReconciliation: true as const,
    items: request.paths.map((path) => ({ path, outcome: "unknown" as const })),
    invalidationPaths: [...new Set(receipt?.affectedPaths ?? [])],
  };
}
/** Explicit local gate facts only; an exception/exit code is never proof of zero writes. */
export function normalizeDispatchFailure(evidence?: {
  kind: "notDispatched";
  source: "localValidation" | "hostAdmission";
}) {
  return evidence?.kind === "notDispatched"
    ? { outcome: "notDispatched" as const, mayHaveWritten: false }
    : { outcome: "unknown" as const, mayHaveWritten: true };
}
