import { backend } from "../../infrastructure/backend";
import { recordFrontendOperationLog } from "../../infrastructure/backend/frontendOperationLog";
import { invalidateData } from "../../shared/cache/dataEffects";
import { notifyUser, writeFailureText } from "../../shared/notice";
import {
  beginUnshelveProjection,
  withdrawUnshelveProjection,
} from "./unshelveProjection";

/**
 * One-step unshelve into the workspace/default CL: no dialog and no FE preflight, the host
 * validates internally. Outcomes are reported once; nothing is retried with a new id.
 */
export function startUnshelveDirect(
  intent: {
    connectionKey: string;
    sourceChangeId: number;
    depotPaths: string[];
    targetWorkspace?: string;
    /** Shelved content is opened into this pending CL; 0 means the default changelist. */
    targetChangeId?: number;
  },
  dependencies: { onRefresh?(): Promise<void> | void } = {},
) {
  const operationId = crypto.randomUUID();
  const paths = [...new Set(intent.depotPaths)].sort();
  const report = (
    phase: "preflight" | "execute",
    outcome: "failed" | "unknown",
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
  if (
    !paths.length ||
    !Number.isSafeInteger(intent.sourceChangeId) ||
    intent.sourceChangeId <= 0
  ) {
    report("preflight", "failed", "preflightBlocked");
    return;
  }
  // Optimistic: rows appear in the target CL before the host answers; the refresh corrects them.
  beginUnshelveProjection(
    operationId,
    intent.connectionKey,
    intent.targetChangeId ?? 0,
    paths,
  );
  void (async () => {
    try {
      const result = await backend.unshelveFiles({
        operationId,
        sourceChangeId: intent.sourceChangeId,
        depotPaths: paths,
        targetWorkspace: intent.targetWorkspace,
        targetChangeId: intent.targetChangeId ?? 0,
      });
      const commandCompleted = result.execution?.state === "commandCompleted";
      if (!commandCompleted && result.outcome !== "succeeded") {
        withdrawUnshelveProjection(operationId);
        report(
          "execute",
          result.outcome === "unknown" ? "unknown" : "failed",
          result.outcome === "unknown" ? "uncertainOutcome" : "operationFailed",
        );
        notifyUser(
          writeFailureText(result.message, {
            zh: "移动全部到CL失败。",
            en: "Unshelve failed.",
          }),
          "error",
        );
      }
      await Promise.resolve(dependencies.onRefresh?.()).catch(() => undefined);
      await invalidateData(["pending", "workspaceStatus", "depot"], {
        connectionKey: intent.connectionKey,
        refetchType: "active",
        affectedPaths: paths,
      }).catch(() => undefined);
      withdrawUnshelveProjection(operationId);
    } catch (error) {
      withdrawUnshelveProjection(operationId);
      notifyUser(
        writeFailureText(String(error), {
          zh: "移动全部到CL失败。",
          en: "Unshelve failed.",
        }),
        "error",
      );
      report("execute", "unknown", "uncertainOutcome");
      await Promise.resolve(dependencies.onRefresh?.()).catch(() => undefined);
    }
  })();
}
