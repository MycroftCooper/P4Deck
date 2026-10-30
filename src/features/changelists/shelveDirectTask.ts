import type { FrontendOperationLog } from "../../infrastructure/backend/frontendOperationLog";
import type {
  RuntimeInfo,
  ShelveDirectRequest,
  WorkflowResult,
} from "../../shared/contracts";
import type { ConnectionSnapshot } from "../companySubmit/model";
import {
  validWorkflowReceipt,
  type WorkflowActionLookup,
} from "../actions/workflowReceipt";
import { notifyUser, writeFailureText } from "../../shared/notice";
import { invalidateData } from "../../shared/cache/dataEffects";

/**
 * Direct shelve (no confirmation dialog, no FE preflight): the host command `shelve_files`
 * performs its internal preflight. There is deliberately no optimistic shelf claim — the shelf
 * result is command-level and the authoritative refresh replaces caches. Success => exactly one
 * bounded active invalidation; failure => one report (never a fake success); unknown/exception =>
 * one same-operationId lookup, never a retry with a new id.
 */
export interface ShelveDirectIntent {
  connectionKey: string;
  changeId: number;
  paths: string[];
  server: string;
  user: string;
  client: string;
  workspace: string;
  generation: number;
  replace?: boolean;
}
export function startShelveDirect(
  intent: ShelveDirectIntent,
  dependencies: {
    current(): { connectionKey: string; runtime: RuntimeInfo };
    connection?(): Promise<ConnectionSnapshot>;
    lookup?(request: {
      operationId: string;
      connection: ConnectionSnapshot;
    }): Promise<WorkflowActionLookup>;
    report(event: FrontendOperationLog): void;
    execute(request: ShelveDirectRequest): Promise<WorkflowResult>;
  },
) {
  const paths = [...new Set(intent.paths)].sort();
  const operationId = crypto.randomUUID();
  if (
    !Number.isSafeInteger(intent.changeId) ||
    intent.changeId <= 0 ||
    !paths.length ||
    paths.some((path) => !path.startsWith("//"))
  ) {
    dependencies.report({
      eventId: `${operationId}-preflight`,
      operationId,
      action: "shelfDelete",
      phase: "preflight",
      outcome: "failed",
      code: "invalidTarget",
      targetCount: Math.min(1000, paths.length),
    });
    return false;
  }
  const same = () => {
    const c = dependencies.current();
    return (
      c.connectionKey === intent.connectionKey &&
      c.runtime.context.server === intent.server &&
      c.runtime.context.user === intent.user &&
      c.runtime.context.client === intent.client &&
      (c.runtime.context.cwd ?? "") === intent.workspace &&
      c.runtime.contextGeneration === intent.generation
    );
  };
  queueMicrotask(() => {
    void (async () => {
      let dispatched = false;
      let connection: ConnectionSnapshot | undefined;
      let result: WorkflowResult | undefined;
      let success = false;
      const succeeded = (value: WorkflowResult) =>
        value.execution?.state === "commandCompleted" ||
        value.outcome === "succeeded";
      const report = () =>
        dependencies.report({
          eventId: `${operationId}-execute`,
          operationId,
          action: "shelfDelete",
          phase: "execute",
          outcome: dispatched ? "unknown" : "failed",
          code: dispatched ? "uncertainOutcome" : "contextChanged",
          targetCount: Math.min(1000, paths.length),
          changeId: String(intent.changeId),
        });
      try {
        if (!same()) throw Error("Connection changed; nothing shelved");
        if (dependencies.connection) {
          connection = await dependencies.connection();
          if (
            !same() ||
            connection.server !== intent.server ||
            connection.user !== intent.user ||
            connection.client !== intent.client
          )
            throw Error("Connection changed; nothing shelved");
        }
        dispatched = true;
        result = await dependencies.execute({
          operationId,
          changeId: intent.changeId,
          depotPaths: paths,
          replace: intent.replace ?? false,
        });
        success = succeeded(result);
        if (!success && connection && dependencies.lookup) {
          try {
            const request = { operationId, connection };
            const lookup = await dependencies.lookup(request);
            if (
              lookup.kind === "found" &&
              validWorkflowReceipt(request, lookup.receipt) &&
              lookup.receipt.state === "settled" &&
              lookup.receipt.result
            ) {
              result = lookup.receipt.result;
              success = succeeded(result);
            }
          } catch {
            /* Lookup failure never retries the write. */
          }
        }
        if (!success) {
          notifyUser(
            writeFailureText(result?.message, {
              zh: "搁置失败。",
              en: "Shelve failed.",
            }),
            "error",
          );
          report();
        }
      } catch (error) {
        notifyUser(
          writeFailureText(String(error), {
            zh: "搁置失败。",
            en: "Shelve failed.",
          }),
          "error",
        );
        report();
      } finally {
        if (success) {
          try {
            await invalidateData(["pending", "workspaceStatus", "depot"], {
              connectionKey: intent.connectionKey,
              refetchType: "active",
              affectedPaths: paths,
            });
          } catch {
            /* Refresh failure never retries the write. */
          }
        }
      }
    })();
  });
  return true;
}
