import { useRef } from "react";
import type {
  PendingChange,
  WorkspaceNode,
} from "../../shared/contracts/types";
import {
  CheckoutChangelistDialog,
  type CheckoutDestination,
} from "../../features/files/components/CheckoutChangelistDialog";
import { backend } from "../../infrastructure/backend";
import { queryAllPendingChanges } from "../../features/changelists/pendingQueries";
import { SubmitDialog } from "../../features/changelists/components/SubmitDialog";
import { FileClWorkflow } from "../../features/changelists/components/FileClWorkflow";
import { RenameDialog } from "../../features/files/components/RenameDialog";
import { FileLockDialog } from "../../features/files/components/FileLockDialog";
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
import { commandActions } from "../actions/actionCatalog";

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
          <FileLockDialog
            nodes={request.nodes}
            operation={request.operation}
            source={request.source}
            connectionKey={connectionKey}
            zh={zh}
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
            submit={async (confirmation) => {
              const refreshWorkspace = (affectedPaths?: readonly string[]) =>
                invalidateData(["pending", "workspaceStatus", "depot"], {
                  connectionKey,
                  affectedPaths,
                });
              let result;
              try {
                result = await backend.confirmSubmit(confirmation);
              } catch (cause) {
                void refreshWorkspace().catch(() => undefined);
                throw cause;
              }
              if (
                result.refresh.pendingChanges ||
                result.refresh.workspaceStatus
              ) {
                void refreshWorkspace(result.refresh.depotPaths).catch(
                  () => undefined,
                );
              }
              if (result.refresh.submittedChanges)
                void invalidateData(["submitted"]).catch(() => undefined);
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
