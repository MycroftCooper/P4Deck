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
  const tr = (cn: string, en: string) => (zh ? cn : en);
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
          : tr(
              "下面是固定的操作范围，不会跟随外部选择变化。",
              "This scope is frozen and does not follow selection changes.",
            )
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
            ? tr(
                "还原可能丢失尚未保存到版本库的修改，不能依赖本界面恢复。",
                "Revert may discard unsubmitted changes. This view cannot restore them.",
              )
            : tr(
                "将范围内适用的受控文件标记为删除，不删除未跟踪文件。",
                "Marks applicable controlled files in scope for deletion, not untracked files.",
              )}
        </DialogNotice>
      )}
      {!!folders && (
        <DialogNotice>
          {tr(
            "目录操作包含全部子文件（递归）。实际匹配文件数量尚未统计。",
            "Folder operations include all descendants recursively. The actual matching file count has not been calculated.",
          )}
        </DialogNotice>
      )}
      {snapshot.count > snapshot.nodes.length && (
        <DialogNotice>
          {tr(
            "重复项及父目录覆盖的子项已合并。",
            "Duplicates and descendants covered by selected folders were consolidated.",
          )}
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
          {tr(
            "执行后可能部分成功。取消运行只能请求停止剩余工作，不能撤销已完成部分；请检查任务结果与日志。",
            "Execution can partially succeed. Cancellation requests stopping remaining work; it does not undo completed changes. Check task results and logs.",
          )}
        </DialogNotice>
      )}
      {needsAcknowledgement && (
        <label className="workflow-checkbox">
          <input
            type="checkbox"
            checked={ack}
            onChange={(event) => setAck(event.target.checked)}
          />
          {tr(
            "我已核对以上范围与风险。",
            "I have reviewed the scope and risks.",
          )}
        </label>
      )}
    </Dialog>
  );
}
