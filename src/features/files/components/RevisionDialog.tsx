import { t } from "../../../shared/i18n";
import { useState } from "react";
import { Dialog, DialogNotice } from "../../../app/dialogs/Dialog";
import { TargetList } from "../../../app/dialogs/TargetList";
import type { WorkspaceNode } from "../../../shared/contracts";
import { compactTargets } from "../selectionCommands";
import { revisionSelector, type RevisionMode } from "../revisionSelector";

export interface RevisionRequest {
  nodes: WorkspaceNode[];
  scopeLabel?: string;
  source: HTMLElement | null;
}
export function RevisionDialog({
  request,
  zh,
  onClose,
}: {
  request: RevisionRequest;
  zh: boolean;
  onClose(revision: string | null): void;
}) {
  const [snapshot] = useState(() => ({
    ...request,
    nodes: compactTargets(request.nodes).map((node) => ({ ...node })),
    count: request.nodes.length,
  }));
  const [mode, setMode] = useState<RevisionMode>("head");
  const [value, setValue] = useState("");
  const selector = revisionSelector(mode, value);
  const recursive = snapshot.nodes.some((node) => node.kind === "directory");
  return (
    <Dialog
      title={t("files.get.revision")}
      description={t("files.updates.the.corresponding.workspace.files.without")}
      source={snapshot.source}
      zh={zh}
      onRequestClose={() => onClose(null)}
      footer={
        <>
          <button onClick={() => onClose(null)}>{t("files.cancel")}</button>
          <button
            className="primary"
            disabled={!selector || !snapshot.nodes.length}
            onClick={() => selector && onClose(selector)}
          >
            {t("files.get.revision.2")}
          </button>
        </>
      }
    >
      <div className="workflow-context">
        {snapshot.scopeLabel ? `${snapshot.scopeLabel} · ` : ""}
        {snapshot.nodes.length} {t("files.targets")}
      </div>
      {snapshot.count > snapshot.nodes.length && (
        <DialogNotice>
          {t("files.duplicates.and.descendants.covered.by.selected")}
        </DialogNotice>
      )}
      {recursive && (
        <DialogNotice>
          {t("files.folders.included.all.descendants.are.in")}
        </DialogNotice>
      )}
      <TargetList
        paths={snapshot.nodes.map(
          (node) =>
            `${node.absolutePath || node.depotPath}${node.kind === "directory" ? " /…" : ""}`,
        )}
        label={t("files.sync.scope")}
      />
      <label>
        {t("files.revision.type")}
        <select
          data-dialog-autofocus
          value={mode}
          onChange={(event) => {
            setMode(event.target.value as RevisionMode);
            setValue("");
          }}
        >
          <option value="head">{t("files.latest.head")}</option>
          <option value="revision">{t("files.file.revision")}</option>
          <option value="change">{t("files.as.of.changelist")}</option>
          <option value="date">{t("files.as.of.date")}</option>
        </select>
      </label>
      {mode !== "head" && (
        <label>
          {mode === "date"
            ? t("files.date")
            : mode === "revision"
              ? t("files.file.revision.number")
              : t("files.changelist.number")}
          <input
            type={mode === "date" ? "date" : "text"}
            inputMode={mode === "date" ? undefined : "numeric"}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            aria-invalid={!!value && !selector}
          />
        </label>
      )}
      {mode === "revision" && (
        <DialogNotice>
          {t("files.the.same.per.file.revision.number")}
        </DialogNotice>
      )}
      {mode === "change" && (
        <DialogNotice>{t("files.syncs.versions.as.of.this.cl")}</DialogNotice>
      )}
      {mode === "date" && (
        <DialogNotice>{t("files.uses.00.00.00.on.that")}</DialogNotice>
      )}
      {!!value && !selector && (
        <DialogNotice error>
          {t("files.enter.a.valid.date.or.positive")}
        </DialogNotice>
      )}
      {selector && (
        <p className="workflow-context">
          {t("files.revision.selector")} <code>{selector}</code>
        </p>
      )}
    </Dialog>
  );
}
