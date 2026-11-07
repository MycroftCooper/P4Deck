import { backend } from "../../infrastructure/backend";
import { recordFrontendOperationLog } from "../../infrastructure/backend/frontendOperationLog";
import { notifyUser, writeFailureText } from "../../shared/notice";
import type { WorkspaceNode } from "../../shared/contracts";
import {
  beginFileLockProjection,
  settleFileLockProjection,
  withdrawFileLockProjection,
} from "./fileLockProjection";

/**
 * Lock/unlock without a preflight dialog: apply the optimistic row projection first, then let the
 * host validate-and-write in one call. Any refusal rolls the projection back and is reported once;
 * nothing is retried with a new id.
 */
export function startFileLockDirect(
  nodes: readonly WorkspaceNode[],
  operation: "lock" | "unlock",
  connectionKey: string,
  dependencies: { onRefresh(): Promise<void> | void },
) {
  const operationId = crypto.randomUUID();
  const paths = [
    ...new Set(
      nodes
        .flatMap((node) => [node.depotPath, node.absolutePath])
        .filter((path): path is string => !!path),
    ),
  ].sort();
  const report = (
    phase: "preflight" | "execute" | "refresh",
    outcome: "failed" | "partial" | "unknown",
    code: "preflightBlocked" | "operationFailed" | "uncertainOutcome",
  ) =>
    void recordFrontendOperationLog({
      eventId: `${operationId}-${phase}`,
      operationId,
      action: "otherOperation",
      phase,
      outcome,
      code,
      targetCount: paths.length,
    });
  if (!paths.length) {
    report("preflight", "failed", "preflightBlocked");
    return;
  }
  if (!beginFileLockProjection(operationId, operation, paths, connectionKey)) {
    report("preflight", "failed", "preflightBlocked");
    return;
  }
  void (async () => {
    try {
      const preflight = await backend.preflightFileLock({
        operation,
        paths,
        operationId,
      });
      if (
        !preflight.ready ||
        !preflight.token ||
        !preflight.targetSnapshot ||
        preflight.expiresAt <= Date.now()
      ) {
        withdrawFileLockProjection(operationId);
        notifyUser(
          writeFailureText(
            preflight.blockers.map((item) => item.message).join("; "),
            {
              zh: "actions.lock.preflight.blocked.nothing.was.written",
              en: "actions.lock.preflight.blocked.nothing.was.written",
            },
          ),
          "error",
        );
        report("preflight", "failed", "preflightBlocked");
        return;
      }
      const result = await backend.confirmFileLock({
        token: preflight.token,
        target: preflight.targetSnapshot,
        stateDigest: preflight.stateDigest,
        operationId,
      });
      settleFileLockProjection(operationId, result, false);
      // `partial` means a mix of acknowledged and failed/blocked rows: the
      // overlay already keeps only acknowledged rows, but the user must be told
      // once that the requested files were NOT all locked/unlocked.
      if (result.outcome !== "succeeded") {
        if (result.outcome !== "partial")
          withdrawFileLockProjection(operationId);
        notifyUser(
          writeFailureText(
            result.message,
            result.outcome === "partial"
              ? {
                  zh: "actions.only.part.of.the.operation.completed",
                  en: "actions.only.part.of.the.operation.completed",
                }
              : {
                  zh: "actions.lock.request.failed",
                  en: "actions.lock.request.failed",
                },
          ),
          "error",
        );
        report(
          "execute",
          result.outcome === "unknown"
            ? "unknown"
            : result.outcome === "partial"
              ? "partial"
              : "failed",
          result.outcome === "unknown" ? "uncertainOutcome" : "operationFailed",
        );
      }
      await Promise.resolve(dependencies.onRefresh())
        .then(() => settleFileLockProjection(operationId, result, true))
        .catch(() => undefined);
    } catch (error) {
      notifyUser(
        writeFailureText(String(error), {
          zh: "actions.lock.request.failed",
          en: "actions.lock.request.failed",
        }),
        "error",
      );
      withdrawFileLockProjection(operationId);
      report("execute", "unknown", "uncertainOutcome");
      await Promise.resolve(dependencies.onRefresh()).catch(() => undefined);
    }
  })();
}
