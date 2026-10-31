import { lookupWorkflowAction } from "../../actions/workflowReceipt";
import { useContext, useRef, useState } from "react";
import { Dialog } from "../../../app/dialogs/Dialog";
import { TargetList } from "../../../app/dialogs/TargetList";
import { MenuEnvironment } from "../../../app/context-menu/environment";
import { backend } from "../../../infrastructure/backend";
import { shelfIdentity, startDeleteShelfDirect } from "../deleteShelfTask";
import type { ShelfRequest } from "./ShelfDialog";
import type {
  ShelfPreflight,
  ShelfPreflightRequest,
  WorkflowResult,
} from "../../../shared/contracts";
export function DeleteShelfDialog({
  request,
  connectionKey,
  zh,
  onDismiss,
  check: _check,
  execute = backend.deleteShelvedRevisions,
}: {
  request: ShelfRequest;
  connectionKey: string;
  zh: boolean;
  onDismiss(): void;
  check?(r: ShelfPreflightRequest): Promise<ShelfPreflight>;
  execute?(
    r: import("../../../shared/contracts").ShelfDeleteDirectRequest,
  ): Promise<WorkflowResult>;
}) {
  const env = useContext(MenuEnvironment);
  const once = useRef(false);
  const [snapshot] = useState(() => ({
    changeId: request.changeId,
    paths: [...new Set(request.paths)].sort(),
    connectionKey,
    ...(env
      ? shelfIdentity(env.runtime)
      : { server: "", user: "", client: "", workspace: "", generation: 0 }),
  }));
  const stale =
    connectionKey !== snapshot.connectionKey ||
    request.changeId !== snapshot.changeId ||
    JSON.stringify([...new Set(request.paths)].sort()) !==
      JSON.stringify(snapshot.paths);
  const confirm = () => {
    if (
      once.current ||
      stale ||
      !env?.getOperationContext ||
      !env.reportOperationError
    )
      return;
    once.current = true;
    try {
      startDeleteShelfDirect(snapshot, {
        current: () => env.getOperationContext!(),
        connection: backend.companySubmitConnectionSnapshot,
        lookup: lookupWorkflowAction,
        report: env.reportOperationError,
        execute,
      });
      void _check;
    } finally {
      // Confirmation ends the modal, including synchronous admission refusal.
      // The task reports the precise refusal once; never retry or show an alert.
      onDismiss();
    }
  };
  return (
    <Dialog
      title={zh ? "删除搁置内容" : "Delete shelved revisions"}
      description={
        zh
          ? "仅删除服务器搁置版本，不会同时删除工作区文件或整个 CL。"
          : "Delete only server shelf revisions; keep workspace files and the changelist."
      }
      source={request.source}
      zh={zh}
      danger
      onRequestClose={onDismiss}
      footer={
        <>
          <button data-dialog-autofocus onClick={onDismiss}>
            {zh ? "取消" : "Cancel"}
          </button>
          <button
            className="danger"
            disabled={
              stale ||
              !Number.isSafeInteger(snapshot.changeId) ||
              snapshot.changeId <= 0 ||
              snapshot.paths.some((path) => !path.startsWith("//")) ||
              !snapshot.paths.length ||
              !env?.getOperationContext ||
              !env.reportOperationError
            }
            onClick={confirm}
          >
            {zh ? "确认删除所选搁置版本" : "Delete selected shelf revisions"}
          </button>
        </>
      }
    >
      <div className="workflow-context">
        CL {snapshot.changeId} · {snapshot.paths.length}{" "}
        {zh ? "个文件" : "files"}
      </div>
      <TargetList
        paths={snapshot.paths}
        label={zh ? "明确的文件范围" : "Explicit file scope"}
      />
    </Dialog>
  );
}
