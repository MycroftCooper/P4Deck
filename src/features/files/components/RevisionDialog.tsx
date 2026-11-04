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
  const tr = (cn: string, en: string) => (zh ? cn : en);
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
      description={tr(
        "将更新工作区中的对应文件；不会强制覆盖已打开的本地修改。",
        "Updates the corresponding workspace files without forcing overwrites of opened local changes.",
      )}
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
          {tr(
            "已合并重复项及父目录覆盖的子项，避免重复操作。",
            "Duplicates and descendants covered by selected folders were consolidated.",
          )}
        </DialogNotice>
      )}
      {recursive && (
        <DialogNotice>
          {tr(
            "包含目录：操作将递归覆盖所选目录的全部子文件；目标数量不是实际文件数量。",
            "Folders included: all descendants are in scope. The target count is not the number of affected files.",
          )}
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
          <option value="head">
            {t("files.latest.head")}
          </option>
          <option value="revision">
            {t("files.file.revision")}
          </option>
          <option value="change">
            {t("files.as.of.changelist")}
          </option>
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
          {tr(
            "同一个修订号应用于每个文件，不代表某次共同提交；文件可能不存在该修订。",
            "The same per-file revision number applies to each file, not a shared submission. Some files may not have that revision.",
          )}
        </DialogNotice>
      )}
      {mode === "change" && (
        <DialogNotice>
          {tr(
            "获取截至该 CL 的版本，并非只获取该 CL 提交过的文件。",
            "Syncs versions as of this CL, not only the files submitted in it.",
          )}
        </DialogNotice>
      )}
      {mode === "date" && (
        <DialogNotice>
          {tr(
            "按 P4 服务器时区当天 00:00:00 计算，不是当天结束时间。",
            "Uses 00:00:00 on that date in the P4 server time zone, not the end of the day.",
          )}
        </DialogNotice>
      )}
      {!!value && !selector && (
        <DialogNotice error>
          {tr(
            "请输入有效日期或正整数编号，不要带 #、@ 或命令参数。",
            "Enter a valid date or positive integer without #, @ or command arguments.",
          )}
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
