import { t } from "../../shared/i18n";
import { useState } from "react";
import type { WorkspaceNode } from "../../shared/contracts";
import { compactTargets } from "../../features/files/selectionCommands";
import { Dialog, DialogNotice } from "./Dialog";
import { TargetList } from "./TargetList";

export interface OperationConfirmation {
  operation: "getLatest" | "checkout" | "add" | "delete" | "revert";
  nodes: WorkspaceNode[];
  scopeLabel?: string;
  source: HTMLElement | null;
}
export function OperationConfirmDialog({
  request,
  zh,
  onClose,
}: {
  request: OperationConfirmation;
  zh: boolean;
  onClose(confirmed: boolean | null): void;
}) {
  const [snapshot] = useState(() => ({
    ...request,
    nodes: compactTargets(request.nodes).map((node) => ({ ...node })),
    count: request.nodes.length,
  }));
  const [ack, setAck] = useState(false);
  const needsAcknowledgement = snapshot.operation !== "revert";
  const names = {
    getLatest: t("dialogs.get.latest"),
    checkout: t("dialogs.check.out"),
    add: t("dialogs.add.to.p4"),
    delete: t("dialogs.mark.for.delete"),
    revert: t("dialogs.revert"),
  };
  const danger = ["delete", "revert"].includes(snapshot.operation);
  const folders = snapshot.nodes.filter(
    (node) => node.kind === "directory",
  ).length;
  return (
    <Dialog
      title={t("dialogs.confirm") + names[snapshot.operation]}
      description={
        snapshot.operation === "revert"
          ? t("dialogs.revert.the.following.files")
          : t("shell.this.scope.is.frozen.and.does")
      }
      zh={zh}
      source={snapshot.source}
      danger={danger}
      onRequestClose={() => onClose(null)}
      footer={
        <>
          <button data-dialog-autofocus onClick={() => onClose(null)}>
            {t("dialogs.cancel")}
          </button>
          <button
            className={danger ? "danger" : "primary"}
            disabled={!snapshot.nodes.length || (needsAcknowledgement && !ack)}
            onClick={() => onClose(true)}
          >
            {t("dialogs.confirm.operation")}
          </button>
        </>
      }
    >
      <div className="workflow-context">
        {snapshot.scopeLabel} {snapshot.nodes.length} {t("dialogs.targets")} ·{" "}
        {folders} {t("dialogs.folders")}
      </div>
      {danger && (
        <DialogNotice error>
          {snapshot.operation === "revert"
            ? t("shell.revert.may.discard.unsubmitted.changes.this")
            : t("shell.marks.applicable.controlled.files.in.scope")}
        </DialogNotice>
      )}
      {!!folders && (
        <DialogNotice>
          {t("shell.folder.operations.include.all.descendants.recursively")}
        </DialogNotice>
      )}
      {snapshot.count > snapshot.nodes.length && (
        <DialogNotice>
          {t("shell.duplicates.and.descendants.covered.by.selected")}
        </DialogNotice>
      )}
      <TargetList
        paths={snapshot.nodes.map(
          (node) =>
            `${node.absolutePath || node.depotPath}${node.kind === "directory" ? " /…" : ""}`,
        )}
        label={t("dialogs.full.target.scope")}
      />
      {needsAcknowledgement && (
        <DialogNotice>
          {t("shell.execution.can.partially.succeed.cancellation.requests")}
        </DialogNotice>
      )}
      {needsAcknowledgement && (
        <label className="workflow-checkbox">
          <input
            type="checkbox"
            checked={ack}
            onChange={(event) => setAck(event.target.checked)}
          />
          {t("shell.i.have.reviewed.the.scope.and")}
        </label>
      )}
    </Dialog>
  );
}
