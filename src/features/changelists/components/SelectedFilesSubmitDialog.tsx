import { useUnsavedEditor } from "../../../app/closeGuard";
import { useEffect, useRef, useState } from "react";
import { backend } from "../../../infrastructure/backend";
import { Dialog, DialogNotice } from "../../../app/dialogs/Dialog";
import { SelectedFilesPreviewDialog } from "./SelectedFilesPreviewDialog";
import type { SelectedOpenedFile } from "../selectedFiles";
import {
  validSelectedSubmitGrant,
  type SelectedSubmitExpectation,
  type SelectedSubmitReceipt,
  type SelectedSubmitRequest,
} from "../selectedSubmit";

export function SelectedFilesSubmitDialog({
  files,
  expected,
  active = true,
  zh,
  onDismiss,
  onContinue,
}: {
  active?: boolean;
  files: readonly SelectedOpenedFile[];
  expected: SelectedSubmitExpectation;
  zh: boolean;
  onDismiss(): void;
  onContinue(
    id: number,
    count: number,
    expected: SelectedSubmitExpectation,
  ): void;
}) {
  const tr = (cn: string, en: string) => (zh ? cn : en);
  const activeRef = useRef(active);
  activeRef.current = active;
  const request = useRef<SelectedSubmitRequest | undefined>(undefined);
  const alive = useRef(true),
    locked = useRef(false),
    claimed = useRef(false);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [receipt, setReceipt] = useState<SelectedSubmitReceipt>();
  const [attempted, setAttempted] = useState(false),
    [handedOff, setHandedOff] = useState(false);
  const clearDraft = useUnsavedEditor(
    attempted && !receipt?.newChangeId ? "dirty" : "clean",
    "",
    "changelistDescription",
  );
  const dismiss = () => {
    clearDraft();
    onDismiss();
  };
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  async function perform(
    action: "prepare" | "status" | "claim",
    description?: string,
  ) {
    if (
      !activeRef.current ||
      locked.current ||
      (action === "claim" && claimed.current)
    )
      return;
    locked.current = true;
    setBusy(true);
    setError("");
    if (!request.current)
      request.current = {
        ...expected,
        connection: { ...expected.connection },
        operationId: crypto.randomUUID(),
        description: description!,
        files: files.map((f) => ({
          depotPath: f.depotPath,
          sourceChangeId: f.originalChangeId,
        })),
      };
    const frozen = request.current;
    const lookup = {
      operationId: frozen.operationId,
      connection: frozen.connection,
      customSubmitExecutablePath: frozen.customSubmitExecutablePath,
    };
    setAttempted(true);
    try {
      if (action === "claim") claimed.current = true;
      const result =
        action === "prepare"
          ? await backend.selectedSubmitPrepare(frozen)
          : action === "status"
            ? await backend.selectedSubmitStatus(lookup)
            : await backend.selectedSubmitClaim(lookup);
      if (!alive.current) return;
      if (!result || result.operationId !== frozen.operationId)
        throw new Error(
          tr(
            "结果未知；请检查状态，不要重复创建。",
            "Outcome unknown; check status without creating again.",
          ),
        );
      setReceipt(result);
      if (action === "claim") {
        if (!activeRef.current)
          throw new Error("Connection changed; continuation stopped");
        if (!validSelectedSubmitGrant(frozen, result))
          throw new Error(
            tr(
              "未获得提交许可，文件保留在新 CL。",
              "No submission permission; files remain in the new CL.",
            ),
          );
        setHandedOff(true);
        onContinue(result.newChangeId!, frozen.files.length, expected);
      }
    } catch (cause) {
      if (alive.current) setError(String(cause));
    } finally {
      locked.current = false;
      if (alive.current) setBusy(false);
    }
  }
  if (!active && !attempted)
    return (
      <Dialog
        title={tr("连接已改变", "Connection changed")}
        zh={zh}
        onRequestClose={dismiss}
        footer={<button onClick={dismiss}>{tr("关闭", "Close")}</button>}
      >
        <DialogNotice>
          {tr(
            "请重新选择文件并确认配置；尚未创建或移动。",
            "Select files and confirm configuration again; nothing was created or moved.",
          )}
        </DialogNotice>
      </Dialog>
    );
  if (!attempted)
    return (
      <SelectedFilesPreviewDialog
        files={files}
        workspace={expected.connection.client}
        routeLabel={
          expected.customSubmitExecutablePath.trim()
            ? tr("自定义提交工具", "Custom submit tool")
            : tr("原生提交确认", "Native submit confirmation")
        }
        zh={zh}
        onDismiss={dismiss}
        onConfirm={(description) => void perform("prepare", description)}
      />
    );
  return (
    <Dialog
      title={tr("提交选中文件", "Submit selected files")}
      zh={zh}
      busy={busy}
      onRequestClose={() => {
        if (!busy) dismiss();
      }}
      footer={
        <>
          <button
            disabled={busy || !active}
            onClick={() => void perform("status")}
          >
            {tr("检查状态", "Check status")}
          </button>
          <button
            className="primary"
            disabled={
              busy ||
              !active ||
              claimed.current ||
              receipt?.stage !== "readyForSubmit"
            }
            onClick={() => void perform("claim")}
          >
            {tr("继续提交", "Continue to submit")}
          </button>
          <button disabled={busy} onClick={dismiss}>
            {tr("关闭", "Close")}
          </button>
        </>
      }
    >
      <small>
        {tr("操作", "Operation")}: {request.current?.operationId}
      </small>
      {!active && (
        <DialogNotice error>
          {tr(
            "连接已改变，已停止后继操作。请保留此清单。",
            "Connection changed; further actions stopped. Keep this file list.",
          )}
        </DialogNotice>
      )}
      <p>
        {receipt?.newChangeId
          ? `CL ${receipt.newChangeId}`
          : tr("新 CL 状态未知", "New CL status unknown")}
      </p>
      <DialogNotice>
        {handedOff
          ? tr(
              "已打开提交流程；取消时文件留在新 CL。是否提交以提交结果为准。",
              "Submission flow opened. Cancelling leaves files in the new CL; consult its result for submission status.",
            )
          : tr(
              "尚未提交。部分移动或未知结果不会继续；关闭后保留新 CL 和已移动文件。",
              "Not submitted. Partial or unknown moves stop here. Closing preserves the new CL and moved files.",
            )}
      </DialogNotice>
      {receipt?.stage === "stopped" && (
        <DialogNotice error>
          {tr(
            "上一次进程已中断：准备过程不会自动恢复，也不会自动用新操作号重试；请核对已移动文件与新 CL 后再决定是否重新开始。",
            "The previous process was interrupted: the preparation is not resumed and is not retried with a new operation id. Inspect moved files and the new CL before starting again.",
          )}
        </DialogNotice>
      )}
      {error && <DialogNotice error>{error}</DialogNotice>}
      {!receipt && (
        <ul
          aria-label={tr(
            "结果未知的选中文件",
            "Selected files with unknown outcome",
          )}
        >
          {files.map((file) => (
            <li key={file.depotPath} style={{ overflowWrap: "anywhere" }}>
              {file.originalChangeId === 0
                ? "Default"
                : `CL ${file.originalChangeId}`}{" "}
              · {file.depotPath} · {tr("未知", "unknown")}
            </li>
          ))}
        </ul>
      )}
      {receipt && (
        <>
          <p>{receipt.message}</p>
          <ul style={{ maxHeight: "35vh", overflow: "auto" }}>
            {receipt.files.map((file) => (
              <li key={file.depotPath} style={{ overflowWrap: "anywhere" }}>
                {file.sourceChangeId === 0
                  ? "Default"
                  : `CL ${file.sourceChangeId}`}{" "}
                · {file.depotPath} ·{" "}
                {tr(
                  { moved: "已移动", notMoved: "未移动", unknown: "未知" }[
                    file.state
                  ],
                  file.state,
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </Dialog>
  );
}
