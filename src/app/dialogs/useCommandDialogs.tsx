import { useEffect, useRef } from "react";
import type {
  PendingChange,
  SubmitResult,
  WorkspaceNode,
} from "../../shared/contracts";
import {
  lookupSubmitAction,
  validSubmitReceipt,
} from "../../features/actions/workflowReceipt";
import { unknownSubmitResult } from "../../features/changelists/submitLifecycle";
import {
  CheckoutChangelistDialog,
  type CheckoutDestination,
} from "../../features/files/components/CheckoutChangelistDialog";
import { backend } from "../../infrastructure/backend";
import { queryAllPendingChanges } from "../../features/changelists/pendingQueries";
import { SubmitDialog } from "../../features/changelists/components/SubmitDialog";
import { FileClWorkflow } from "../../features/changelists/components/FileClWorkflow";
import { RenameDialog } from "../../features/files/components/RenameDialog";
import { startFileLockDirect } from "../../features/actions/directFileLock";
import { ResolveDialog } from "../../features/files/components/ResolveDialog";
import {
  SyncDialog,
  type SyncDialogRequest,
} from "../../features/files/components/SyncDialog";
import {
  RevisionDialog,
  type RevisionRequest,
} from "../../features/files/components/RevisionDialog";
import {
  OperationConfirmDialog,
  type OperationConfirmation,
} from "./OperationConfirmDialog";
import { useDialogRequest } from "./useDialogRequest";
import {
  refreshWorkspaceDirectory,
  workspaceCache,
} from "../../features/files/workspaceQueries";
import { invalidateData } from "../../shared/cache/dataEffects";
import { stableConnectionKey } from "../../shared/cache/connectionKey";
import { commandActions } from "../commands/actionCatalog";

type Origin = { source: HTMLElement | null };
type PreviewRequest = Origin &
  (
    | { kind: "rename"; node: WorkspaceNode }
    | { kind: "fileLock"; nodes: WorkspaceNode[]; operation: "lock" | "unlock" }
    | { kind: "resolve"; nodes: WorkspaceNode[] }
    | { kind: "fileCl"; nodes: WorkspaceNode[]; mode: "moveFiles" | "shelve" }
    | { kind: "submit"; id: number; count: number }
    | ({ kind: "sync" } & SyncDialogRequest)
  );
type Request =
  | PreviewRequest
  | {
      kind: "checkout";
      changes: PendingChange[];
      count: number;
      recursive: boolean;
      source: HTMLElement | null;
    }
  | { kind: "revision"; value: RevisionRequest }
  | { kind: "confirm"; value: OperationConfirmation };

/** Lock mutations can change both the active listing and current selection facts. */
export async function refreshFileLockFacts(connectionKey: string) {
  const stableKey = stableConnectionKey(connectionKey);
  const workspacePaths = workspaceCache
    .getQueryCache()
    .findAll({ queryKey: ["workspace-files", stableKey] })
    .map((query) => String(query.queryKey[2] ?? ""));
  await Promise.allSettled([
    ...workspacePaths.map((path) =>
      refreshWorkspaceDirectory(connectionKey, path || undefined, true),
    ),
    workspaceCache.refetchQueries({
      queryKey: ["depot-files", stableKey],
      type: "all",
    }),
  ]);
  await Promise.allSettled([
    workspaceCache.invalidateQueries({
      queryKey: ["global-search", connectionKey],
    }),
    // History, Diff and Rev Graph data can show the old lock owner.
    workspaceCache.invalidateQueries({ queryKey: ["target"] }),
  ]);
}

/**
 * Lock/unlock runs immediately: no preflight dialog and no confirm modal. The optimistic row
 * projection is applied by the task; any refusal rolls it back and is reported once.
 */
function DirectFileLock({
  nodes,
  operation,
  connectionKey,
  onDismiss,
  onRefresh,
}: {
  nodes: WorkspaceNode[];
  operation: "lock" | "unlock";
  connectionKey: string;
  onDismiss(): void;
  onRefresh(): Promise<void> | void;
}) {
  const once = useRef(false);
  useEffect(() => {
    if (once.current) return;
    once.current = true;
    startFileLockDirect(nodes, operation, connectionKey, { onRefresh });
    onDismiss();
  }, []);
  return null;
}

/** One command modal at a time, across all documents hosted by this app instance. */
export function useCommandDialogs(
  connectionKey: string,
  client: string,
  zh: boolean,
  demo = false,
  targetKey = "",
  onFileLockRefresh?: (nodes: WorkspaceNode[]) => Promise<void> | void,
) {
  const gateway = useDialogRequest<
    Request,
    string | boolean | CheckoutDestination
  >(`${connectionKey}:${targetKey}`);
  const latest = useRef(connectionKey);
  latest.current = connectionKey;
  const close = () => gateway.answer(null);
  const request = gateway.request;
  let element = null;
  if (request)
    switch (request.kind) {
      case "checkout":
        element = (
          <CheckoutChangelistDialog
            changes={request.changes}
            count={request.count}
            recursive={request.recursive}
            source={request.source}
            client={client}
            zh={zh}
            onClose={gateway.answer}
          />
        );
        break;
      case "sync":
        element = (
          <SyncDialog
            request={request}
            connectionKey={connectionKey}
            demo={demo}
            zh={zh}
            onDismiss={close}
            onRefresh={() =>
              void invalidateData(commandActions.getLatest.effects, {
                connectionKey,
              }).catch(() => undefined)
            }
          />
        );
        break;
      case "rename":
        element = (
          <RenameDialog
            node={request.node}
            source={request.source}
            zh={zh}
            onDismiss={close}
            onRefresh={() =>
              void invalidateData(commandActions.rename.effects, {
                connectionKey,
                affectedPaths: [
                  request.node.depotPath,
                  request.node.absolutePath,
                ].filter((path): path is string => !!path),
              }).catch(() => undefined)
            }
          />
        );
        break;
      case "fileLock":
        element = (
          <DirectFileLock
            nodes={request.nodes}
            operation={request.operation}
            connectionKey={connectionKey}
            onDismiss={close}
            onRefresh={() => {
              void invalidateData(["pending", "submitted"], {
                connectionKey,
                affectedPaths: request.nodes.flatMap((node) =>
                  [node.depotPath, node.absolutePath].filter(
                    (path): path is string => !!path,
                  ),
                ),
              }).catch(() => undefined);
              void refreshFileLockFacts(connectionKey).catch(() => undefined);
              void Promise.resolve(onFileLockRefresh?.(request.nodes)).catch(
                () => undefined,
              );
            }}
          />
        );
        break;
      case "resolve":
        element = (
          <ResolveDialog
            nodes={request.nodes}
            source={request.source}
            connectionKey={connectionKey}
            demo={demo}
            zh={zh}
            onDismiss={close}
          />
        );
        break;
      case "fileCl":
        element = (
          <FileClWorkflow
            nodes={request.nodes}
            mode={request.mode}
            source={request.source}
            client={client}
            connectionKey={connectionKey}
            demo={demo}
            zh={zh}
            onDismiss={close}
          />
        );
        break;
      case "revision":
        element = (
          <RevisionDialog
            request={request.value}
            zh={zh}
            onClose={gateway.answer}
          />
        );
        break;
      case "confirm":
        element = (
          <OperationConfirmDialog
            request={request.value}
            zh={zh}
            onClose={gateway.answer}
          />
        );
        break;
      case "submit":
        element = (
          <SubmitDialog
            changeId={request.id}
            count={request.count}
            client={client}
            connectionKey={connectionKey}
            zh={zh}
            source={request.source}
            onDismiss={close}
            loadSummary={async () => {
              if (latest.current !== connectionKey)
                throw new Error(zh ? "连接已改变" : "Connection changed");
              const changes = await queryAllPendingChanges();
              if (latest.current !== connectionKey)
                throw new Error(zh ? "连接已改变" : "Connection changed");
              return changes.find((change) => change.id === request.id);
            }}
            check={(changeId) => backend.preflightSubmit({ changeId })}
            submit={async (confirmation, connection) => {
              const refreshWorkspace = (affectedPaths?: readonly string[]) =>
                invalidateData(["pending", "workspaceStatus", "depot"], {
                  connectionKey,
                  affectedPaths,
                });
              const refreshSubmitted = () =>
                invalidateData(["submitted"]).catch(() => undefined);
              // Exactly one bounded refresh for this dispatch, driven by the
              // final (or recovered) result's advice; never a second one.
              const applyAdvice = async (result: SubmitResult) => {
                if (
                  result.refresh.pendingChanges ||
                  result.refresh.workspaceStatus
                )
                  await refreshWorkspace(result.refresh.depotPaths).catch(
                    () => undefined,
                  );
                if (result.refresh.submittedChanges) await refreshSubmitted();
              };
              /**
               * Same-operationId durable receipt recovery. A new id is never
               * created here: `settled` means persisted, not submitted.
               */
              const recover = async (
                operationId: string,
                changeId: number,
                depotPaths: readonly string[],
              ): Promise<SubmitResult> => {
                try {
                  const request = { operationId, connection };
                  const lookup = await lookupSubmitAction(request);
                  if (
                    lookup.kind === "found" &&
                    validSubmitReceipt(request, lookup.receipt) &&
                    lookup.receipt.state === "settled" &&
                    lookup.receipt.result
                  )
                    return lookup.receipt.result;
                } catch {
                  /* Receipt lookup never retries the write. */
                }
                return unknownSubmitResult(changeId, operationId, depotPaths);
              };
              let result: SubmitResult;
              try {
                result = await backend.confirmSubmit(confirmation);
              } catch {
                // The write may have reached the host. Refresh once from the
                // recovered result's advice (or the conservative default).
                result = await recover(
                  confirmation.operationId!,
                  confirmation.target.changeId,
                  [],
                );
                await applyAdvice(result);
                return result;
              }
              if (result.execution?.state === "unknown") {
                // Host persisted an uncertain result; query by identity once so
                // a settled authoritative result can replace the display.
                const recovered = await recover(
                  confirmation.operationId!,
                  result.changeId,
                  result.refresh.depotPaths,
                );
                if (recovered !== result) result = recovered;
              }
              await applyAdvice(result);
              return result;
            }}
          />
        );
        break;
    }
  return {
    element,
    pending: !!request,
    open: (request: PreviewRequest) => {
      void gateway.ask(request);
    },
    getRevision: async (value: RevisionRequest) => {
      const answer = await gateway.ask({ kind: "revision", value });
      return typeof answer === "string" ? answer : null;
    },
    confirm: async (value: OperationConfirmation) =>
      (await gateway.ask({ kind: "confirm", value })) === true,
    checkout: async (
      value: Omit<Extract<Request, { kind: "checkout" }>, "kind">,
    ) => {
      const answer = await gateway.ask({ kind: "checkout", ...value });
      return typeof answer === "object" ? answer : null;
    },
  };
}
