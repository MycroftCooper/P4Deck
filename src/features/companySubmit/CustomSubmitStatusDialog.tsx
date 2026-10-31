import { Dialog } from "../../app/dialogs/Dialog";
import type { CustomSubmitView } from "./useCustomSubmit";

export function CustomSubmitStatusDialog({
  view,
  zh,
  onClose,
  onRefresh,
}: {
  view: CustomSubmitView;
  zh: boolean;
  onClose(): void;
  onRefresh(): void;
}) {
  const pending = view.phase === "checking" || view.phase === "starting";
  const session = view.phase === "session" ? view.session : undefined;
  const intent = view.phase === "session" ? view.intent : undefined;
  const message =
    view.phase === "checking"
      ? zh
        ? "正在读取生效配置…"
        : "Reading active configuration…"
      : view.phase === "starting"
        ? zh
          ? "正在启动…"
          : "Starting…"
        : view.phase === "error"
          ? view.uncertain
            ? zh
              ? "启动结果未知，请检查状态；不会自动重试。"
              : "Launch outcome unknown. Check status; no automatic retry."
            : zh
              ? "未启动，请检查配置和所选 CL。"
              : "Not started. Check the configuration and selected CL."
          : intent === "running"
            ? zh
              ? "外部工具已启动/运行中；这只表示启动意图，不代表提交成功，结果由工具与后续 submitted CL 回读确认。"
              : "External tool started/running. This is launch intent only, not a successful submission; confirm in the tool and later submitted-CL readback."
            : intent === "rejected"
              ? zh
                ? "host 正证据：工具未启动，因此未提交（这不代表成功，也不代表失败）。"
                : "Host positively reports the tool did not start, so nothing was submitted (neither success nor failure)."
              : zh
                ? "工具进程已退出或无法轮询：提交结果未知。退出码仅展示，绝不作为成功/失败依据；请检查工具并等待 submitted CL 回读。"
                : "Tool process exited or is not pollable: submission outcome unknown. Exit code is display-only and never success/failure evidence; check the tool and wait for submitted-CL readback.";
  return (
    <Dialog
      title={zh ? "自定义提交工具" : "Custom submit tool"}
      zh={zh}
      onRequestClose={onClose}
      footer={
        <>
          <button type="button" onClick={onRefresh} disabled={pending}>
            {zh ? "检查状态" : "Check status"}
          </button>
          <button type="button" onClick={onClose}>
            {zh ? "关闭" : "Close"}
          </button>
        </>
      }
    >
      <p role="status">{message}</p>
      {session && (
        <>
          <p>CL {session.changeId}</p>
          <p style={{ overflowWrap: "anywhere" }}>
            {zh ? "本次尝试路径：" : "Path used for this attempt: "}
            {session.executablePath}
          </p>
          <p>
            {zh
              ? "这是该次启动尝试的记录，不代表当前已保存配置；检查状态不会重新启动工具。"
              : "This records that launch attempt, not the current saved configuration. Checking status does not restart the tool."}
          </p>
          {session.exitCode !== null && (
            <p>
              {zh
                ? "退出码（仅展示，不构成成功/失败依据）："
                : "Exit code (display only; not success/failure evidence): "}
              {session.exitCode}
            </p>
          )}
        </>
      )}
      {(view.phase === "error" || session?.reason) && (
        <p role="alert">
          {view.phase === "error" ? view.message : session?.reason}
        </p>
      )}
      <p>
        {zh
          ? "不会回退到普通提交；关闭此窗口不会终止外部工具。取消操作不会终止外部工具，也不代表未提交。"
          : "No fallback to native submission. Closing this dialog does not stop the external tool; cancelling does not stop it either and does not mean nothing was submitted."}
      </p>
    </Dialog>
  );
}
