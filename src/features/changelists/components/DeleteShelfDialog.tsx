import { t } from "../../../shared/i18n";
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
      title={t("pending.delete.shelved.revisions")}
      description={t("pending.delete.only.server.shelf.revisions")}
      source={request.source}
      zh={zh}
      danger
      onRequestClose={onDismiss}
      footer={
        <>
          <button data-dialog-autofocus onClick={onDismiss}>
            {t("pending.cancel")}
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
            {t("pending.delete.selected.shelf.revisions")}
          </button>
        </>
      }
    >
      <div className="workflow-context">
        CL {snapshot.changeId} · {snapshot.paths.length} {t("pending.files")}
      </div>
      <TargetList
        paths={snapshot.paths}
        label={t("pending.explicit.file.scope")}
      />
    </Dialog>
  );
}
