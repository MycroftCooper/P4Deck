import { useRef, useState } from "react";
import { Dialog, DialogNotice } from "../../../app/dialogs/Dialog";
import type { PendingChange } from "../../../shared/contracts/types";

export function DeleteChangelistDialog({
  change,
  zh,
  source,
  onDismiss,
  onDelete,
}: {
  change: PendingChange;
  zh: boolean;
  source?: HTMLElement | null;
  onDismiss(): void;
  onDelete(): Promise<void>;
}) {
  const tr = (cn: string, en: string) => (zh ? cn : en);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const running = useRef(false);
  const numbered = change.id > 0;
  const locallyEmpty =
    !change.files.length && !change.shelvedFiles.length && !change.jobs.length;
  const execute = () => {
    if (running.current || !numbered) return;
    running.current = true;
    setBusy(true);
    setError("");
    void onDelete()
      .then(onDismiss)
      .catch((cause) => setError(String(cause)))
      .finally(() => {
        running.current = false;
        setBusy(false);
      });
  };
  return (
    <Dialog
      title={tr(`删除 CL ${change.id}`, `Delete CL ${change.id}`)}
      description={tr(
        "只会删除空的编号 Pending CL；不会删除或回退工作区文件。",
        "Only an empty numbered pending changelist is deleted. Workspace files are not deleted or reverted.",
      )}
      source={source}
      zh={zh}
      danger
      busy={busy}
      onRequestClose={onDismiss}
      footer={
        <>
          <button disabled={busy} onClick={onDismiss}>
            {tr("取消", "Cancel")}
          </button>
          <button
            className="danger"
            disabled={busy || !numbered}
            onClick={execute}
          >
            {busy ? tr("正在删除…", "Deleting…") : tr("确认删除", "Delete")}
          </button>
        </>
      }
    >
      <div className="workflow-context">
        CL {change.id} · {change.files.length}{" "}
        {tr("个已打开文件", "opened files")} · {change.shelvedFiles.length}{" "}
        {tr("个 Shelf 文件", "shelved files")} · {change.jobs.length} Jobs
      </div>
      {!locallyEmpty && (
        <DialogNotice>
          {tr(
            "当前快照显示此 CL 非空。仍将由后端重新验证；如包含文件、Shelf 或 Jobs，删除会被拒绝并显示真实原因。",
            "This snapshot is not empty. The backend will revalidate it and reject deletion with the real reason if files, shelves, or Jobs remain.",
          )}
        </DialogNotice>
      )}
      {error && <DialogNotice error>{error}</DialogNotice>}
    </Dialog>
  );
}
