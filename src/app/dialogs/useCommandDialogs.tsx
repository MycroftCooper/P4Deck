import { useRef } from "react";
import type { WorkspaceNode } from "../../shared/contracts/types";
import { backend } from "../../infrastructure/backend";
import { queryAllPendingChanges } from "../../features/changelists/pendingQueries";
import { SubmitDialog } from "../../features/changelists/components/SubmitDialog";
import { FileClWorkflow } from "../../features/changelists/components/FileClWorkflow";
import { RenameDialog } from "../../features/files/components/RenameDialog";
import { FileLockDialog } from "../../features/files/components/FileLockDialog";
import { ForceUnlockDialog } from "../../features/files/components/ForceUnlockDialog";
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
  workspaceCache,
  workspaceQuery,
} from "../../features/files/workspaceQueries";

type Origin = { source: HTMLElement | null };
type PreviewRequest = Origin &
  (
    | { kind: "rename"; node: WorkspaceNode }
    | { kind: "fileLock"; nodes: WorkspaceNode[]; operation: "lock" | "unlock" }
    | { kind: "forceUnlock"; nodes: WorkspaceNode[] }
    | { kind: "resolve"; nodes: WorkspaceNode[] }
    | { kind: "fileCl"; nodes: WorkspaceNode[]; mode: "moveFiles" | "shelve" }
    | { kind: "submit"; id: number; count: number }
    | ({ kind: "sync" } & SyncDialogRequest)
  );
type Request =
  | PreviewRequest
  | { kind: "revision"; value: RevisionRequest }
  | { kind: "confirm"; value: OperationConfirmation };

/** Force unlock can change facts even when execution is partial or rejected. */
export async function refreshForceUnlockFacts(connectionKey: string) {
  const workspacePaths = workspaceCache
    .getQueryCache()
    .findAll({ queryKey: ["workspace-files", connectionKey] })
    .map((query) => {
      const path = String(query.queryKey[2] ?? "");
      return workspaceCache.fetchQuery({
        ...workspaceQuery(connectionKey, path || undefined, true),
        staleTime: 0,
      });
    });
  await Promise.allSettled([
    ...workspacePaths,
    workspaceCache.refetchQueries({
      queryKey: ["depot-files", connectionKey],
      type: "all",
    }),
  ]);
  await Promise.allSettled([
    workspaceCache.invalidateQueries({
      queryKey: ["global-search", connectionKey],
    }),
    workspaceCache.invalidateQueries({
      queryKey: ["file-review", connectionKey],
    }),
  ]);
}

/** One command modal at a time, across all documents hosted by this app instance. */
export function useCommandDialogs(
  connectionKey: string,
  client: string,
  zh: boolean,
  demo = false,
  targetKey = "",
  onForceUnlockRefresh?: (nodes: WorkspaceNode[]) => Promise<void> | void,
) {
  const gateway = useDialogRequest<Request, string | boolean>(
    `${connectionKey}:${targetKey}`,
  );
  const latest = useRef(connectionKey);
  latest.current = connectionKey;
  const close = () => gateway.answer(null);
  const request = gateway.request;
  let element = null;
  if (request)
    switch (request.kind) {
      case "sync":
        element = (
          <SyncDialog
            request={request}
            connectionKey={connectionKey}
            demo={demo}
            zh={zh}
            onDismiss={close}
            onRefresh={async () => {
              window.dispatchEvent(new Event("p4deck:pending-refresh"));
              await Promise.all([
                workspaceCache.invalidateQueries({
                  queryKey: ["workspace-files", connectionKey],
                }),
                workspaceCache.invalidateQueries({
                  queryKey: ["depot-files", connectionKey],
                }),
              ]);
            }}
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
            onRefresh={async () => {
              window.dispatchEvent(new Event("p4deck:pending-refresh"));
              await Promise.all([
                workspaceCache.invalidateQueries({
                  queryKey: ["workspace-files", connectionKey],
                }),
                workspaceCache.invalidateQueries({
                  queryKey: ["depot-files", connectionKey],
                }),
              ]);
            }}
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
            onRefresh={async () => {
              window.dispatchEvent(new Event("p4deck:pending-refresh"));
              window.dispatchEvent(new Event("p4deck:submitted-refresh"));
              await refreshForceUnlockFacts(connectionKey);
              await onForceUnlockRefresh?.(request.nodes);
            }}
          />
        );
        break;
      case "forceUnlock":
        element = (
          <ForceUnlockDialog
            nodes={request.nodes}
            source={request.source}
            connectionKey={connectionKey}
            zh={zh}
            simulated={demo}
            onDismiss={close}
            onRefresh={async () => {
              window.dispatchEvent(new Event("p4deck:pending-refresh"));
              window.dispatchEvent(new Event("p4deck:submitted-refresh"));
              await Promise.all([
                workspaceCache.invalidateQueries({
                  queryKey: ["workspace-files", connectionKey],
                }),
                workspaceCache.invalidateQueries({
                  queryKey: ["depot-files", connectionKey],
                }),
                workspaceCache.invalidateQueries({
                  queryKey: ["global-search", connectionKey],
                }),
                workspaceCache.invalidateQueries({
                  queryKey: ["file-review", connectionKey],
                }),
              ]);
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
              const refreshWorkspace = async () => {
                window.dispatchEvent(new Event("p4deck:pending-refresh"));
                await Promise.all([
                  workspaceCache.invalidateQueries({
                    queryKey: ["workspace-files", connectionKey],
                  }),
                  workspaceCache.invalidateQueries({
                    queryKey: ["depot-files", connectionKey],
                  }),
                ]);
              };
              let result;
              try {
                result = await backend.confirmSubmit(confirmation);
              } catch (cause) {
                await refreshWorkspace();
                throw cause;
              }
              if (
                result.refresh.pendingChanges ||
                result.refresh.workspaceStatus
              ) {
                await refreshWorkspace();
              }
              if (result.refresh.submittedChanges)
                window.dispatchEvent(new Event("p4deck:submitted-refresh"));
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
  };
}
