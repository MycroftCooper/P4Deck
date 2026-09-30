import { useState } from "react";
import { Dialog, DialogNotice } from "../../../app/dialogs/Dialog";
import type { WorkspaceNode } from "../../../shared/contracts/types";
import { checkRenamePath, type RenamePathError } from "../renamePath";

const reasons: Record<RenamePathError, [string, string]> = {
  empty: ["请填写目标路径。", "Enter a destination path."],
  absolute: [
    "请输入与源路径同类型的绝对路径。",
    "Use an absolute path of the same type as the source.",
  ],
  characters: [
    "路径不能包含控制字符或通配符。",
    "Control characters and wildcards are not allowed.",
  ],
  segments: [
    "路径不能是根目录，或包含空段、.、..。",
    "A root path, empty segments, . and .. are not allowed.",
  ],
  same: ["目标与源路径相同。", "Source and destination are the same."],
  descendant: [
    "不能把目录移动到它自己的子目录中。",
    "A folder cannot move into its own descendant.",
  ],
};
export function RenameDialog({
  node,
  source,
  zh,
  onDismiss,
}: {
  node: WorkspaceNode;
  source: HTMLElement | null;
  zh: boolean;
  onDismiss(): void;
}) {
  const tr = (cn: string, en: string) => (zh ? cn : en);
  const [snapshot] = useState(() => ({ ...node }));
  const from = snapshot.absolutePath || snapshot.depotPath || "";
  const [target, setTarget] = useState(from);
  const [checked, setChecked] = useState(false);
  const [discard, setDiscard] = useState(false);
  const error = checkRenamePath(
    from,
    target,
    snapshot.kind === "directory",
    !snapshot.absolutePath,
  );
  const dismiss = () => (target !== from ? setDiscard(true) : onDismiss());
  return (
    <Dialog
      title={tr("重命名 / 移动", "Rename / move")}
      description={tr(
        "填写完整目标路径。此界面只检查输入，不执行磁盘或 P4 操作。",
        "Enter the full destination path. This view checks input only; no disk or P4 operations are executed.",
      )}
      zh={zh}
      source={source}
      onRequestClose={dismiss}
      footer={
        <>
          <button onClick={dismiss}>{tr("取消", "Cancel")}</button>
          <button
            className="primary"
            disabled={!!error}
            onClick={() => setChecked(true)}
          >
            {tr("检查路径（不执行）", "Check path (no execution)")}
          </button>
        </>
      }
    >
      <label>
        {tr("源路径", "Source path")}
        <input readOnly value={from} />
      </label>
      <label>
        {tr("目标路径", "Destination path")}
        <input
          data-dialog-autofocus
          value={target}
          onChange={(event) => {
            setTarget(event.target.value);
            setChecked(false);
          }}
          aria-invalid={target !== from && !!error}
        />
      </label>
      <div className="workflow-context">
        {snapshot.absolutePath
          ? tr("本地绝对路径", "Local absolute path")
          : "Depot"}{" "}
        ·{" "}
        {snapshot.kind === "directory"
          ? tr("整个目录（递归）", "Entire folder (recursive)")
          : tr("单个文件", "Single file")}
      </div>
      {snapshot.kind === "directory" && (
        <DialogNotice>
          {tr(
            "目录内全部子文件均可能受影响；实际文件范围尚未扫描。",
            "All descendants may be affected. The actual file scope has not been scanned.",
          )}
        </DialogNotice>
      )}
      <DialogNotice>
        {tr(
          "尚未验证：工作区映射、目标是否存在、覆盖风险、权限、签出状态及仅大小写改名。不会自动创建父目录或覆盖已有文件。",
          "Not verified: workspace mapping, target existence, overwrite risk, permissions, opened state or case-only renames. No parent folders are created and no existing files are overwritten.",
        )}
      </DialogNotice>
      {target !== from && error && (
        <DialogNotice error>{reasons[error][zh ? 0 : 1]}</DialogNotice>
      )}
      {checked && (
        <DialogNotice>
          {tr(
            "路径格式检查通过，不代表可以安全执行。尚未移动或重命名任何文件。",
            "Path syntax checked; this does not establish execution safety. No files were moved or renamed.",
          )}
        </DialogNotice>
      )}
      {discard && (
        <section className="workflow-discard" role="alert">
          <p>
            {tr(
              "关闭将丢弃当前目标路径。",
              "Closing discards the entered destination.",
            )}
          </p>
          <button onClick={() => setDiscard(false)}>
            {tr("继续编辑", "Keep editing")}
          </button>
          <button className="danger" onClick={onDismiss}>
            {tr("放弃修改并关闭", "Discard and close")}
          </button>
        </section>
      )}
    </Dialog>
  );
}
