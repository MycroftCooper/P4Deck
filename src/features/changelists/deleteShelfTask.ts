import { t } from "../../shared/i18n";
import { hasResourceConflict } from "../actions/resourceOverlap";
import type { FrontendOperationLog } from "../../infrastructure/backend/frontendOperationLog";
import type {
  RuntimeInfo,
  ShelfDeleteDirectRequest,
  ShelfPreflight,
  ShelfPreflightRequest,
  WorkflowConfirmation,
  WorkflowResult,
} from "../../shared/contracts";
import {
  acceptShelfObservation,
  finishShelfObservation,
  knownNotAppliedWorkflowResult,
} from "../actions/shelfObservation";
import { blockedMovePaths } from "./moveOptimism";
import { removalLedger } from "../actions/actionStore";
import {
  validWorkflowReceipt,
  workflowCommandCompleted,
  workflowEnvelopeTrusted,
  type WorkflowActionLookup,
} from "../actions/workflowReceipt";
import type { ConnectionSnapshot } from "../companySubmit/model";
import { invalidateData } from "../../shared/cache/dataEffects";
export interface DeleteShelfIntent {
  connectionKey: string;
  changeId: number;
  paths: string[];
  server: string;
  user: string;
  client: string;
  workspace: string;
  generation: number;
}
export const shelfIdentity = (runtime: RuntimeInfo) => ({
  server: runtime.context.server,
  user: runtime.context.user,
  client: runtime.context.client,
  workspace: runtime.context.cwd ?? "",
  generation: runtime.contextGeneration,
});

/** Registered outside modal lifetime. A transport-unknown write is never retried. */
export function startDeleteShelf(
  intent: DeleteShelfIntent,
  dependencies: {
    current(): { connectionKey: string; runtime: RuntimeInfo };
    connection?(): Promise<ConnectionSnapshot>;
    lookup?(request: {
      operationId: string;
      connection: ConnectionSnapshot;
    }): Promise<WorkflowActionLookup>;
    report(event: FrontendOperationLog): void;
    check(r: ShelfPreflightRequest): Promise<ShelfPreflight>;
    execute(r: WorkflowConfirmation): Promise<WorkflowResult>;
  },
) {
  const snapshot = { ...intent, paths: [...new Set(intent.paths)].sort() };
  const operationId = crypto.randomUUID();
  const reject = (code: FrontendOperationLog["code"]) => {
    dependencies.report({
      eventId: `${operationId}-preflight`,
      operationId,
      action: "shelfDelete",
      phase: "preflight",
      outcome: "failed",
      code,
      targetCount: Math.min(1000, snapshot.paths.length),
      ...(Number.isSafeInteger(snapshot.changeId) && snapshot.changeId > 0
        ? { changeId: String(snapshot.changeId) }
        : {}),
    });
    return false;
  };
  if (
    !Number.isSafeInteger(snapshot.changeId) ||
    snapshot.changeId <= 0 ||
    !snapshot.paths.length ||
    snapshot.paths.some((p) => !p.startsWith("//"))
  )
    return reject("invalidTarget");
  if (
    hasResourceConflict(
      blockedMovePaths(snapshot.connectionKey),
      snapshot.paths,
    )
  )
    return reject("preflightBlocked");
  const same = () => {
    const c = dependencies.current();
    const id = shelfIdentity(c.runtime);
    return (
      c.connectionKey === snapshot.connectionKey &&
      Object.entries(id).every(([k, v]) => snapshot[k as keyof typeof id] === v)
    );
  };
  if (!same()) return reject("contextChanged");
  const originalRuntime = dependencies.current().runtime;
  if (
    !acceptShelfObservation(
      snapshot.connectionKey,
      operationId,
      snapshot.changeId,
      snapshot.paths,
      originalRuntime,
    )
  )
    return reject("preflightBlocked");
  queueMicrotask(() => {
    void (async () => {
      let writing = false,
        unknown = false,
        dispatched = false;
      let completedResult: WorkflowResult | undefined;
      let connection: ConnectionSnapshot | undefined;
      let code: FrontendOperationLog["code"] = "contextChanged";
      const report = (
        phase: FrontendOperationLog["phase"],
        outcome: FrontendOperationLog["outcome"],
        failure: FrontendOperationLog["code"],
      ) =>
        dependencies.report({
          eventId: `${operationId}-${phase}`,
          operationId,
          action: "shelfDelete",
          phase,
          outcome,
          code: failure,
          targetCount: Math.min(1000, snapshot.paths.length),
          changeId: String(snapshot.changeId),
        });
      try {
        if (!same())
          throw Error(t("pending.connection.changed.nothing.deleted"));
        code = "transportError";
        const check = await dependencies.check({
          changeId: snapshot.changeId,
          depotPaths: snapshot.paths,
          mode: "delete",
        });
        const target = check.target;
        code = "targetMismatch";
        if (
          !same() ||
          target.server !== snapshot.server ||
          target.user !== snapshot.user ||
          target.client !== snapshot.client ||
          target.workspace !== snapshot.workspace ||
          target.contextGeneration !== snapshot.generation ||
          target.kind !== "shelf" ||
          target.sourceChangeId !== snapshot.changeId ||
          JSON.stringify([...target.depotPaths].sort()) !==
            JSON.stringify(snapshot.paths)
        )
          throw Error(t("pending.preflight.identity.or.scope.changed.nothing"));
        code = check.expiresAt <= Date.now() ? "expired" : "preflightBlocked";
        if (
          !check.ready ||
          check.blockers.length ||
          !check.token ||
          !Number.isFinite(check.expiresAt) ||
          check.expiresAt <= Date.now()
        )
          throw Error(
            check.blockers.map((b) => b.message).join(" · ") ||
              t("pending.preflight.blocked.or.expired.nothing.deleted"),
          );
        code = "transportError";
        if (dependencies.connection) {
          connection = await dependencies.connection();
          if (
            !same() ||
            connection.server !== snapshot.server ||
            connection.user !== snapshot.user ||
            connection.client !== snapshot.client
          )
            throw Error("Connection changed");
        }
        writing = true;
        dispatched = true;
        const confirmation = {
          token: check.token,
          target: structuredClone(target),
          operationId,
        };
        const admitted = removalLedger.get(operationId)!;
        removalLedger.update(
          operationId,
          {
            ...admitted.data,
            execution: {
              ...admitted.data.execution!,
              confirmation,
              connection,
            },
          },
          "running",
        );
        const result = await dependencies.execute(confirmation);
        completedResult = result;
        writing = false;
        // S4d wire: delete now returns the same lifecycle envelope as create/replace
        // and claims no per-file facts. `commandCompleted` is command-level only.
        if (
          result.execution?.state === "unknown" &&
          connection &&
          dependencies.lookup
        ) {
          try {
            const request = { operationId, connection };
            const lookup = await dependencies.lookup(request);
            if (
              lookup.kind === "found" &&
              validWorkflowReceipt(request, lookup.receipt, "shelfDelete") &&
              lookup.receipt.state === "settled" &&
              lookup.receipt.result
            ) {
              completedResult = lookup.receipt.result;
              removalLedger.update(
                operationId,
                removalLedger.get(operationId)!.data,
                "unknown",
                {
                  revision: lookup.receipt.revision,
                  payloadDigest: lookup.receipt.payloadDigest,
                },
              );
            }
          } catch {
            /* Receipt lookup never retries the write. */
          }
        }
        // Command-level success is trusted only with an exact envelope for this
        // dispatch; a deterministic host rejection is a known "nothing written".
        const facts = completedResult ?? result;
        const lifecycle = facts.execution;
        const commandCompleted = workflowCommandCompleted(
          facts,
          operationId,
          "shelf",
        );
        const knownNoOp = knownNotAppliedWorkflowResult(facts);
        const envelopeMismatch =
          !!lifecycle && !workflowEnvelopeTrusted(facts, operationId, "shelf");
        unknown = commandCompleted
          ? false
          : knownNoOp
            ? false
            : envelopeMismatch ||
              lifecycle?.state === "unknown" ||
              facts.files.some((f) => f.state === "unknown") ||
              facts.files.length !== snapshot.paths.length;
        const success =
          commandCompleted ||
          (facts.outcome === "succeeded" &&
            !unknown &&
            facts.files.every(
              (f) =>
                f.state === "succeeded" && snapshot.paths.includes(f.depotPath),
            ) &&
            new Set(facts.files.map((f) => f.depotPath)).size ===
              snapshot.paths.length);
        if (!success)
          report(
            "execute",
            unknown
              ? "unknown"
              : facts.files.some((f) => f.state === "succeeded")
                ? "partial"
                : "failed",
            unknown ? "uncertainOutcome" : "operationFailed",
          );
      } catch {
        if (writing) {
          unknown = true;
          if (connection && dependencies.lookup) {
            try {
              const request = { operationId, connection };
              const lookup = await dependencies.lookup(request);
              if (
                lookup.kind === "found" &&
                validWorkflowReceipt(request, lookup.receipt, "shelfDelete") &&
                lookup.receipt.state === "settled" &&
                lookup.receipt.result
              ) {
                completedResult = lookup.receipt.result;
                const record = removalLedger.get(operationId)!;
                removalLedger.update(operationId, record.data, "unknown", {
                  revision: lookup.receipt.revision,
                  payloadDigest: lookup.receipt.payloadDigest,
                });
              }
            } catch {
              /* Memory lookup failure never retries the write. */
            }
          }
        }
        report(
          writing ? "execute" : "preflight",
          writing ? "unknown" : "failed",
          code,
        );
      } finally {
        // `finishShelfObservation` settles the items and releases the local
        // admission for command-level success on both delete call paths.
        finishShelfObservation(
          operationId,
          originalRuntime,
          completedResult,
          !dispatched,
        );
        try {
          await invalidateData(["pending", "workspaceStatus", "depot"], {
            connectionKey: snapshot.connectionKey,
            refetchType: "active",
            affectedPaths: snapshot.paths,
          });
        } catch {
          /* Refresh failure never retries the write; views keep the old data. */
        }
      }
    })();
  });
  return true;
}

/**
 * Direct shelf delete (no confirmation dialog, no FE preflight): the row is optimistically removed
 * before the host call; the host command performs its internal preflight. Success keeps the removal
 * and performs exactly one bounded invalidation; failure/unknown restores the row (unknown stays
 * visible and is reconciled by one same-operationId lookup, never retried with a new id).
 */
export function startDeleteShelfDirect(
  intent: DeleteShelfIntent,
  dependencies: {
    current(): { connectionKey: string; runtime: RuntimeInfo };
    connection?(): Promise<ConnectionSnapshot>;
    lookup?(request: {
      operationId: string;
      connection: ConnectionSnapshot;
    }): Promise<WorkflowActionLookup>;
    report(event: FrontendOperationLog): void;
    execute(request: ShelfDeleteDirectRequest): Promise<WorkflowResult>;
  },
) {
  const snapshot = { ...intent, paths: [...new Set(intent.paths)].sort() };
  const operationId = crypto.randomUUID();
  const reject = (code: FrontendOperationLog["code"]) => {
    dependencies.report({
      eventId: `${operationId}-preflight`,
      operationId,
      action: "shelfDelete",
      phase: "preflight",
      outcome: "failed",
      code,
      targetCount: Math.min(1000, snapshot.paths.length),
      ...(Number.isSafeInteger(snapshot.changeId) && snapshot.changeId > 0
        ? { changeId: String(snapshot.changeId) }
        : {}),
    });
    return false;
  };
  if (
    !Number.isSafeInteger(snapshot.changeId) ||
    snapshot.changeId <= 0 ||
    !snapshot.paths.length ||
    snapshot.paths.some((p) => !p.startsWith("//"))
  )
    return reject("invalidTarget");
  if (
    hasResourceConflict(
      blockedMovePaths(snapshot.connectionKey),
      snapshot.paths,
    )
  )
    return reject("preflightBlocked");
  const same = () => {
    const c = dependencies.current();
    const id = shelfIdentity(c.runtime);
    return (
      c.connectionKey === snapshot.connectionKey &&
      Object.entries(id).every(([k, v]) => snapshot[k as keyof typeof id] === v)
    );
  };
  if (!same()) return reject("contextChanged");
  const originalRuntime = dependencies.current().runtime;
  // Optimistic: remove the rows NOW, before any host result; UI does not wait for the response.
  if (
    !acceptShelfObservation(
      snapshot.connectionKey,
      operationId,
      snapshot.changeId,
      snapshot.paths,
      originalRuntime,
    )
  )
    return reject("preflightBlocked");
  queueMicrotask(() => {
    void (async () => {
      let dispatched = false;
      let connection: ConnectionSnapshot | undefined;
      let completedResult: WorkflowResult | undefined;
      let success = false;
      /**
       * F9: a command-level success must be the exact envelope of this dispatch
       * (same operationId, `kind: "shelf"`, self-consistent outcome). A present but
       * mismatched envelope is never downgraded to the legacy per-file path.
       */
      const succeeded = (result: WorkflowResult) =>
        result.execution
          ? workflowCommandCompleted(result, operationId, "shelf")
          : result.outcome === "succeeded" &&
            result.files.length === snapshot.paths.length &&
            result.files.every(
              (f) =>
                f.state === "succeeded" && snapshot.paths.includes(f.depotPath),
            ) &&
            new Set(result.files.map((f) => f.depotPath)).size ===
              snapshot.paths.length;
      const recover = async () => {
        if (!connection || !dependencies.lookup) return;
        try {
          const request = { operationId, connection };
          const lookup = await dependencies.lookup(request);
          if (
            lookup.kind === "found" &&
            validWorkflowReceipt(request, lookup.receipt, "shelfDelete") &&
            lookup.receipt.state === "settled" &&
            lookup.receipt.result
          ) {
            completedResult = lookup.receipt.result;
            success = succeeded(completedResult);
          }
        } catch {
          /* Lookup failure never retries the write. */
        }
      };
      try {
        if (!same()) throw Error("Connection changed; nothing deleted");
        if (dependencies.connection) {
          connection = await dependencies.connection();
          if (
            !same() ||
            connection.server !== snapshot.server ||
            connection.user !== snapshot.user ||
            connection.client !== snapshot.client
          )
            throw Error("Connection changed; nothing deleted");
        }
        dispatched = true;
        completedResult = await dependencies.execute({
          operationId,
          changeId: snapshot.changeId,
          depotPaths: snapshot.paths,
        });
        success = succeeded(completedResult);
        // A deterministic host rejection is already settled evidence that nothing
        // was written; a same-id receipt lookup cannot improve it.
        if (!success && !knownNotAppliedWorkflowResult(completedResult))
          await recover();
        if (!success)
          dependencies.report({
            eventId: `${operationId}-execute`,
            operationId,
            action: "shelfDelete",
            phase: "execute",
            outcome: "failed",
            code: "operationFailed",
            targetCount: Math.min(1000, snapshot.paths.length),
            changeId: String(snapshot.changeId),
          });
      } catch {
        if (dispatched) await recover();
        dependencies.report({
          eventId: `${operationId}-execute`,
          operationId,
          action: "shelfDelete",
          phase: dispatched ? "execute" : "preflight",
          outcome: dispatched ? "unknown" : "failed",
          code: dispatched ? "uncertainOutcome" : "contextChanged",
          targetCount: Math.min(1000, snapshot.paths.length),
          changeId: String(snapshot.changeId),
        });
      } finally {
        // Success => removal is confirmed and one bounded active refetch replaces caches.
        // Failure/unknown => finish maps to unknown (row visible/reconcilable), no rollback claim.
        // A host rejection is settled inside `finishShelfObservation` (known no-op).
        finishShelfObservation(
          operationId,
          originalRuntime,
          completedResult,
          !dispatched,
        );
        if (success) {
          try {
            await invalidateData(["pending", "workspaceStatus", "depot"], {
              connectionKey: snapshot.connectionKey,
              refetchType: "active",
              affectedPaths: snapshot.paths,
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
