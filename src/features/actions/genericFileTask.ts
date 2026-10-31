import { hasResourceConflict } from "./resourceOverlap";
import { invoke } from "@tauri-apps/api/core";
import { backend } from "../../infrastructure/backend";
import type {
  FileActionRequest,
  FileActionResult,
  RuntimeInfo,
} from "../../shared/contracts";
import type { ConnectionSnapshot } from "../companySubmit/model";
import { sameSubmitIdentity } from "../changelists/selectedSubmit";
import { blockedMovePaths } from "../changelists/moveOptimism";
import { fileActionLedger } from "./actionStore";
import { canonicalRevision, type ReceiptAuthority } from "./ledger";
import {
  recordFrontendOperationLog,
  type FrontendOperationLog,
} from "../../infrastructure/backend/frontendOperationLog";
import { invalidateData } from "../../shared/cache/dataEffects";
import { appCache } from "../../shared/cache/appCache";
import { pendingSnapshotKey } from "../changelists/pendingCache";
import {
  beginGenericFileProjection,
  clearGenericFileProjection,
  confirmGenericFileProjection,
  withdrawGenericFileProjection,
} from "./genericFileProjection";
import { isHostPreDispatchRejection } from "./revertTask";
export const genericP4Actions = [
  "checkout",
  "checkoutAndOpen",
  "add",
  "addRecursive",
  "markForDelete",
  "delete",
  "changeFiletype",
  "reconcile",
  "integrate",
  "copy",
  "branch",
  "clean",
  "tagWithLabel",
] as const;
export function isGenericP4Write(request: FileActionRequest) {
  return (
    (genericP4Actions as readonly string[]).includes(request.action) &&
    (request.action !== "delete" ||
      (request.states?.length === request.paths.length &&
        request.states.every(
          (state) => state !== "untracked" && state !== "unknown",
        )))
  );
}
export interface GenericFileIntent {
  request: FileActionRequest;
  paths: readonly string[];
  busy: boolean;
  outcome: "pending" | "commandCompleted" | "unknown" | "notDispatched";
  connection?: ConnectionSnapshot;
  result?: FileActionResult;
  admissionReleased?: boolean;
}
export interface FileReceipt {
  operationId: string;
  kind: "fileAction";
  connection: ConnectionSnapshot;
  payloadDigest: string;
  revision: string;
  state: "running" | "settled" | "interrupted";
  result: FileActionResult | null;
}
export type FileLookup =
  | { kind: "found"; receipt: FileReceipt }
  | { kind: "notFound" | "scopeMismatch" | "storageUnavailable" };
export interface GenericFilePort {
  connection(): Promise<ConnectionSnapshot>;
  execute(
    request: FileActionRequest,
    connection: ConnectionSnapshot,
  ): Promise<FileActionResult>;
  lookup(request: {
    operationId: string;
    connection: ConnectionSnapshot;
  }): Promise<FileLookup>;
  report(event: FrontendOperationLog): void;
  invalidate(
    scope: string,
    runtime: RuntimeInfo,
    paths: readonly string[],
    current: boolean,
  ): Promise<void>;
}
export const genericFilePort: GenericFilePort = {
  connection: () => backend.companySubmitConnectionSnapshot(),
  execute: (request, connection) =>
    backend.performFileAction(request, connection),
  lookup: (request) => invoke("workflow_action_lookup", { request }),
  report: (event) => {
    void recordFrontendOperationLog(event);
  },
  invalidate: async (scope, runtime, paths, current) => {
    await Promise.all([
      appCache.invalidateQueries({
        queryKey: pendingSnapshotKey(runtime),
        exact: true,
        refetchType: "none",
      }),
      invalidateData(["workspaceStatus", "depot", "localCapabilities"], {
        connectionKey: scope,
        affectedPaths: paths,
        refetchType: current ? "active" : "none",
      }),
    ]);
  },
};
/**
 * Provisional local projection: the requested opened state is shown immediately (same tick as the
 * ledger intent) and corrected by the bounded active refetch. The S3a wire still has no per-file
 * evidence, so `affectedPaths` is never treated as per-file success.
 */
export function startGenericFileAction(
  scope: string,
  runtime: RuntimeInfo,
  input: FileActionRequest,
  aliases: readonly string[],
  current: () => boolean,
  port: GenericFilePort = genericFilePort,
  targetKey?: string,
) {
  const request = structuredClone({
    ...input,
    operationId: input.operationId ?? crypto.randomUUID(),
  });
  const operationId = request.operationId;
  const report = (
    outcome: FrontendOperationLog["outcome"],
    code: FrontendOperationLog["code"],
    phase: FrontendOperationLog["phase"] = "execute",
  ) =>
    port.report({
      eventId: `${operationId}-${phase}`,
      operationId,
      action: "otherOperation",
      phase,
      outcome,
      code,
      targetCount: Math.min(1000, request.paths.length),
    });
  if (!isGenericP4Write(request) || !request.paths.length) {
    report("failed", "invalidTarget");
    return false;
  }
  if (!current()) {
    report("failed", "contextChanged");
    return false;
  }
  const paths = [
    ...new Set([
      ...request.paths,
      ...aliases,
      ...(request.targetPath ? [request.targetPath] : []),
    ]),
  ];
  if (hasResourceConflict(blockedMovePaths(scope), paths)) {
    report("failed", "preflightBlocked");
    return false;
  }
  if (
    !fileActionLedger.admit(scope, operationId, {
      request,
      paths,
      busy: true,
      outcome: "pending",
    })
  ) {
    report("failed", "preflightBlocked");
    return false;
  }
  beginGenericFileProjection(scope, operationId, request, targetKey);
  queueMicrotask(() => {
    void (async () => {
      let connection: ConnectionSnapshot | undefined,
        result: FileActionResult | undefined,
        authority: ReceiptAuthority | undefined,
        dispatched = false,
        hostRejected = false;
      try {
        connection = await port.connection();
        if (
          !current() ||
          connection.server !== runtime.context.server ||
          connection.user !== runtime.context.user ||
          connection.client !== runtime.context.client
        )
          throw Error("connection changed");
        fileActionLedger.update(
          operationId,
          { ...fileActionLedger.get(operationId)!.data, connection },
          "running",
        );
        dispatched = true;
        result = await port.execute(request, connection);
      } catch (error) {
        let receiptMissing = false;
        if (dispatched && connection) {
          try {
            const found = await port.lookup({ operationId, connection });
            if (found.kind === "notFound") receiptMissing = true;
            if (found.kind === "found") {
              const r = found.receipt;
              if (
                r.kind === "fileAction" &&
                r.operationId === operationId &&
                sameSubmitIdentity(r.connection, connection) &&
                typeof r.revision === "string" &&
                canonicalRevision(r.revision) &&
                /^[a-f0-9]{64}$/.test(r.payloadDigest) &&
                r.state === "settled" &&
                r.result
              ) {
                result = r.result;
                authority = {
                  revision: r.revision,
                  payloadDigest: r.payloadDigest,
                };
              }
            }
          } catch {
            /* Read failure is not permission to retry. */
          }
        }
        // The action receipt is reserved before any write, so notFound + a known
        // pre-dispatch refusal proves the host never reached the write path.
        // Everything else (transport/unknown, existing-but-unsettled receipt)
        // stays unknown and waits for the host fence/receipt.
        hostRejected = receiptMissing && isHostPreDispatchRejection(error);
      } finally {
        const complete =
          result?.execution?.operationId === operationId &&
          result.execution.outcome === "commandCompleted" &&
          result.execution.perFileEvidence === "notCollected";
        const outcome =
          !dispatched || hostRejected
            ? "notDispatched"
            : complete
              ? "commandCompleted"
              : "unknown";
        const record = fileActionLedger.get(operationId)!;
        fileActionLedger.update(
          operationId,
          {
            ...record.data,
            busy: false,
            outcome,
            result,
            // No fence can exist for a proven pre-dispatch refusal; release the
            // local claim so it never blocks later writes on these paths.
            ...(outcome === "notDispatched" ? { admissionReleased: true } : {}),
          },
          outcome === "unknown" ? "unknown" : "settled",
          authority,
        );
        if (outcome !== "commandCompleted")
          report(
            outcome === "unknown" ? "unknown" : "failed",
            outcome === "unknown"
              ? "uncertainOutcome"
              : hostRejected
                ? "preflightBlocked"
                : "contextChanged",
          );
        if (dispatched && !hostRejected) {
          // commandCompleted: keep the projection until the bounded active refetch lands (then the
          // authoritative rows replace it). unknown: withdraw first, then correct by the same refetch.
          if (outcome === "commandCompleted")
            confirmGenericFileProjection(operationId, targetKey);
          else withdrawGenericFileProjection(operationId, targetKey);
          try {
            await port.invalidate(scope, runtime, paths, current());
            if (outcome === "commandCompleted")
              clearGenericFileProjection(operationId, targetKey);
          } catch {
            report("failed", "refreshFailed", "refresh");
          }
        } else withdrawGenericFileProjection(operationId, targetKey);
      }
    })();
  });
  return true;
}
