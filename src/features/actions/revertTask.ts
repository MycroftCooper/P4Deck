import { hasResourceConflict } from "./resourceOverlap";
import { invoke } from "@tauri-apps/api/core";
import { backend } from "../../infrastructure/backend";
import {
  recordFrontendOperationLog,
  type FrontendOperationLog,
} from "../../infrastructure/backend/frontendOperationLog";
import type {
  RuntimeInfo,
  WorkspaceNode,
  FileActionRequest,
  WorkflowResult,
} from "../../shared/contracts";
import type { ConnectionSnapshot } from "../companySubmit/model";
import { selectionRequest } from "../files/selectionCommands";
import { readSnapshot } from "../../shared/cache/snapshots";
import { invalidateData } from "../../shared/cache/dataEffects";
import {
  pendingSnapshotKey,
  type PendingSnapshot,
} from "../changelists/pendingCache";
import { blockedMovePaths } from "../changelists/moveOptimism";
import {
  acceptRemovalObservation,
  finishRemovalObservation,
  knownNotAppliedWorkflowResult,
} from "./shelfObservation";
import { removalLedger } from "./actionStore";
import {
  lookupWorkflowAction,
  validWorkflowReceipt,
  type WorkflowActionLookup,
} from "./workflowReceipt";
/** Expand only a complete observed Pending scope; never invent a depot mapping or wildcard. */
export function revertTargets(
  nodes: WorkspaceNode[],
  snapshot?: PendingSnapshot,
): WorkspaceNode[] {
  const result: WorkspaceNode[] = [];
  for (const node of nodes) {
    if (node.kind !== "directory") {
      result.push({ ...node });
      continue;
    }
    if (!snapshot || snapshot.partial)
      throw Error("Complete pending snapshot required for folder revert");
    const depot = node.depotPath?.replace(/\/$/, "");
    const local = node.absolutePath
      ?.replaceAll("\\", "/")
      .replace(/\/$/, "")
      .toLowerCase();
    if (!depot && !local) throw Error("Unmapped folder");
    for (const cl of snapshot.changes)
      for (const file of cl.files) {
        const client = file.clientPath?.replaceAll("\\", "/").toLowerCase();
        if (
          (depot && file.depotPath.startsWith(depot + "/")) ||
          (!depot && local && client?.startsWith(local + "/"))
        )
          result.push({
            ...node,
            id: file.depotPath,
            name: file.depotPath.split("/").at(-1)!,
            kind: "file",
            depotPath: file.depotPath,
            absolutePath: file.clientPath ?? "",
            changelistId: cl.id,
          });
      }
  }
  if (
    !result.length ||
    result.some(
      (n) =>
        !n.depotPath?.startsWith("//") ||
        n.depotPath.includes("...") ||
        /[#@*]/.test(n.depotPath),
    )
  )
    throw Error("Exact escaped depot file paths required");
  return [...new Map(result.map((n) => [n.depotPath!, n])).values()];
}
export interface RevertPort {
  connection(): Promise<ConnectionSnapshot>;
  execute(
    request: FileActionRequest,
    connection: ConnectionSnapshot,
  ): Promise<WorkflowResult>;
  lookup(request: {
    operationId: string;
    connection: ConnectionSnapshot;
  }): Promise<WorkflowActionLookup>;
  report(event: FrontendOperationLog): void;
  /** Local workspace facts for optimistic hiding; missing/rejecting facts never hide rows. */
  workspaceChildren?(dir: string): Promise<WorkspaceNode[]>;
}
const MAX_STATUS_DIRECTORIES = 20;
const normalizeLocalPath = (value: string) =>
  value.replaceAll("\\", "/").toLowerCase();
function parentDirectory(absolutePath: string): string | undefined {
  const path = normalizeLocalPath(absolutePath).replace(/\/+$/, "");
  const slash = path.lastIndexOf("/");
  return slash > 0 ? path.slice(0, slash) : undefined;
}
/**
 * Only files proven `status.local === "present"` may be hidden optimistically.
 * Modified/missing/unknown/unreadable/missing-fact/query-failure rows stay visible
 * until the host result arrives (revert -a retains modified files).
 */
export async function localUnchangedPaths(
  targets: readonly WorkspaceNode[],
  status: (dir: string) => Promise<WorkspaceNode[]>,
): Promise<string[]> {
  const groups = new Map<string, WorkspaceNode[]>();
  for (const target of targets) {
    if (!target.absolutePath) continue;
    const dir = parentDirectory(target.absolutePath);
    if (!dir) continue;
    const batch = groups.get(dir) ?? [];
    batch.push(target);
    groups.set(dir, batch);
  }
  // Too many directories or no path facts: do not guess; keep every row visible.
  if (!groups.size || groups.size > MAX_STATUS_DIRECTORIES) return [];
  const unchanged: string[] = [];
  await Promise.all(
    [...groups].map(async ([dir, batch]) => {
      let items: WorkspaceNode[];
      try {
        items = await status(dir);
      } catch {
        return;
      }
      const facts = new Map(
        items.map((item) => [normalizeLocalPath(item.absolutePath), item]),
      );
      for (const target of batch) {
        const fact = facts.get(normalizeLocalPath(target.absolutePath));
        if (fact?.status?.local === "present" && target.depotPath)
          unchanged.push(target.depotPath);
      }
    }),
  );
  return [...new Set(unchanged)];
}
export const revertPort: RevertPort = {
  connection: () => backend.companySubmitConnectionSnapshot(),
  execute: (request, connection) =>
    invoke("confirm_revert_action", { request, connection }),
  lookup: lookupWorkflowAction,
  report: (event) => {
    void recordFrontendOperationLog(event);
  },
  workspaceChildren: (dir) =>
    backend.listWorkspaceChildren(dir).then((listing) => listing.items),
};
/**
 * Host pre-dispatch rejections. Both written slices reserve their durable action
 * receipt BEFORE any write (`reserve_action` → `lock_write_transaction` → write),
 * so a same-operationId lookup returning `notFound` proves the write path was
 * never reached. Only the known pre-dispatch failure classes below may use that
 * proof to settle as "not dispatched"; a generic transport error could still
 * have reached the host and stays `unknown` until a durable fence/refresh proves
 * the opposite. Never infer "nothing was written" from the exception alone.
 *
 * Shared with `genericFileTask` (same host contract); it lives here because this
 * slice's write scope is the two task modules.
 */
const HOST_PRE_DISPATCH_ERRORS: readonly RegExp[] = [
  /invalidConnection/i,
  // Also matches `connectionChangedBeforeDispatch` and message-wrapped variants.
  /connectionChanged/i,
  /contextChanged/i,
  /preflightBlocked/i,
  /targetMismatch/i,
  /tokenUnknown|tokenExpired/i,
  /requestLimit|requestIdConflict/i,
  /operationIdPayloadConflict/i,
  /payloadTooLarge|capacityReached|receiptUnavailable/i,
  /operation was cancelled while waiting to run/i,
  /operation timed out/i,
  /p4 CLI was not found/i,
  /invalid P4 command/i,
  /requires a stable operationId|stable operationId is required/i,
  /A connection snapshot is required for modifying file actions/i,
  /Revert must use confirm_revert_action/i,
  /GUI changelist moves must use|GUI lock\/unlock must use/i,
  /Expected (?:revert action|P4 revert)/i,
  /operationId must be a UUID/i,
  /rejected before dispatch|nothing was written|nothing was (?:deleted|shelved|reverted)/i,
];
/** True only for the host's known "refused before the write path" reasons. */
export function isHostPreDispatchRejection(error: unknown): boolean {
  const text =
    typeof error === "string"
      ? error
      : error instanceof Error
        ? `${error.name}: ${error.message}`
        : error && typeof error === "object" && "message" in error
          ? String((error as { message?: unknown }).message ?? "")
          : "";
  return (
    !!text && HOST_PRE_DISPATCH_ERRORS.some((pattern) => pattern.test(text))
  );
}
/** Called only after existing confirmation. No modal lifetime, whole-list refresh, or write retry. */
export function startRevert(
  scope: string,
  runtime: RuntimeInfo,
  nodes: WorkspaceNode[],
  action: "revert" | "revertUnchanged",
  current: () => boolean,
  wholeCl?: number,
  port: RevertPort = revertPort,
) {
  const operationId = crypto.randomUUID();
  const report = (
    outcome: FrontendOperationLog["outcome"],
    code: FrontendOperationLog["code"],
  ) =>
    port.report({
      eventId: `${operationId}-execute`,
      operationId,
      action: "otherOperation",
      phase: "execute",
      outcome,
      code,
      targetCount: Math.min(1000, nodes.length),
    });
  const observed = readSnapshot<PendingSnapshot>(pendingSnapshotKey(runtime));
  let targets: WorkspaceNode[];
  try {
    targets = revertTargets(nodes, observed?.data);
  } catch {
    report("failed", "invalidTarget");
    return false;
  }
  const sources = new Map<string, number>();
  for (const target of targets) {
    const cached =
      observed?.data.changes.filter((cl) =>
        cl.files.some((f) => f.depotPath === target.depotPath),
      ) ?? [];
    const id = cached.length === 1 ? cached[0].id : target.changelistId;
    if (id === undefined || !Number.isSafeInteger(id) || id < 0) {
      report("failed", "invalidTarget");
      return false;
    }
    sources.set(target.depotPath!, id);
  }
  if (!current()) {
    report("failed", "contextChanged");
    return false;
  }
  if (
    hasResourceConflict(
      blockedMovePaths(scope),
      targets.map((n) => n.depotPath!),
    )
  ) {
    report("failed", "preflightBlocked");
    return false;
  }
  const request = {
    ...selectionRequest(action, targets, operationId, wholeCl),
    paths: targets.map((n) => n.depotPath!),
  };
  queueMicrotask(() => {
    void (async () => {
      let connection: ConnectionSnapshot | undefined,
        dispatched = false,
        result: WorkflowResult | undefined,
        hostRejected = false;
      try {
        // Hide only files the local workspace proves unmodified; modified rows stay
        // visible because the host retains them (no "flash all rows away").
        const unchanged = await localUnchangedPaths(
          targets,
          port.workspaceChildren ?? revertPort.workspaceChildren!,
        );
        if (!current()) throw Error("context changed");
        if (
          unchanged.length &&
          !acceptRemovalObservation(
            "revert",
            scope,
            operationId,
            0,
            unchanged,
            runtime,
            sources,
          )
        ) {
          report("failed", "preflightBlocked");
          return;
        }
        connection = await port.connection();
        if (
          !current() ||
          connection.server !== runtime.context.server ||
          connection.user !== runtime.context.user ||
          connection.client !== runtime.context.client
        )
          throw Error("context changed");
        const record = removalLedger.get(operationId);
        if (record)
          removalLedger.update(
            operationId,
            {
              ...record.data,
              execution: {
                ...record.data.execution!,
                confirmation: structuredClone(request),
                connection,
              },
            },
            "running",
          );
        dispatched = true;
        result = await port.execute(request, connection);
      } catch (error) {
        let receiptMissing = false;
        if (dispatched && connection) {
          try {
            const lookup = { operationId, connection };
            const found = await port.lookup(lookup);
            if (found.kind === "notFound") receiptMissing = true;
            if (
              found.kind === "found" &&
              validWorkflowReceipt(lookup, found.receipt, "revert") &&
              found.receipt.state === "settled" &&
              found.receipt.result
            ) {
              result = found.receipt.result;
              const record = removalLedger.get(operationId)!;
              removalLedger.update(operationId, record.data, "unknown", {
                revision: found.receipt.revision,
                payloadDigest: found.receipt.payloadDigest,
              });
            }
          } catch {
            /* No write retry. */
          }
        }
        // The durable receipt is reserved before any write, so notFound + a known
        // pre-dispatch refusal proves no write was dispatched. Anything else
        // (transport/unknown, or a receipt that exists but is not settled) stays
        // unknown and waits for the host fence/receipt instead of self-releasing.
        hostRejected = receiptMissing && isHostPreDispatchRejection(error);
        if (!result)
          report(
            !dispatched || hostRejected ? "failed" : "unknown",
            hostRejected
              ? "preflightBlocked"
              : dispatched
                ? "uncertainOutcome"
                : "contextChanged",
          );
      } finally {
        if (result && result.outcome !== "succeeded")
          report(
            result.files.some((f) => f.state === "succeeded")
              ? "partial"
              : "unknown",
            "uncertainOutcome",
          );
        finishRemovalObservation(
          operationId,
          runtime,
          result,
          !dispatched || hostRejected,
        );
        // The removal ledger only reconciles rows it was able to admit optimistically
        // (a file must have a local path whose status proves it unmodified). A
        // whole-changelist "还原全部" (Revert all) starts from depot-only rows, so
        // nothing is admitted and, on success, nothing removed the reverted rows.
        // `revert`/`revertUnchanged` declare `fileState` effects in the action
        // catalog, so a dispatched (possibly applied) write must always revalidate
        // those domains; the authoritative refetch is what repaints the Pending list.
        if (
          dispatched &&
          !hostRejected &&
          !knownNotAppliedWorkflowResult(result)
        ) {
          try {
            await invalidateData(["pending", "workspaceStatus", "depot"], {
              connectionKey: scope,
              refetchType: "active",
              affectedPaths: targets
                .map((target) => target.depotPath!)
                .filter(Boolean),
            });
          } catch {
            /* Refresh failure never retries the write; views keep the prior data. */
          }
        }
      }
    })();
  });
  return true;
}
