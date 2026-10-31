import { useEffect, useRef, useState } from "react";
import { Dialog } from "../../../app/dialogs/Dialog";
import { backend } from "../../../infrastructure/backend";
import type { UndoTarget, UndoPreview } from "../../../shared/contracts";
import {
  beginLocalIoProjection,
  lifecycleOf,
  settleLocalIoProjection,
  unwrapLocalIoLegacy,
  withdrawLocalIoProjection,
} from "../../actions/localIoLifecycle";

export interface UndoDialogRequest extends UndoTarget {
  source: HTMLElement | null;
}
export function UndoDialog({
  request,
  zh,
  onDismiss,
  onRefresh,
}: {
  request: UndoDialogRequest;
  zh: boolean;
  onDismiss(): void;
  onRefresh(): void;
}) {
  const tr = (cn: string, en: string) => (zh ? cn : en);
  const [target] = useState<UndoTarget>(() => ({
    depotPath: request.depotPath,
    revision: request.revision,
    changelistId: request.changelistId,
  }));
  const [plan, setPlan] = useState<UndoPreview>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [finished, setFinished] = useState(false);
  const mounted = useRef(true);
  const inFlight = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const run = async (confirm: boolean) => {
    if (inFlight.current || (confirm && !plan)) return;
    inFlight.current = true;
    setBusy(true);
    setMessage("");
    const reviewed = plan;
    setPlan(undefined);
    try {
      if (!confirm) {
        const next = await backend.previewUndo(target);
        if (
          next.target.depotPath !== target.depotPath ||
          next.target.revision !== target.revision ||
          next.target.changelistId !== target.changelistId ||
          !next.token ||
          next.expiresAt <= Date.now()
        )
          throw new Error(
            tr("预览目标不一致或已过期", "Preview target differs or expired"),
          );
        if (mounted.current) setPlan(next);
      } else {
        const operationId = crypto.randomUUID();
        beginLocalIoProjection({
          operationId,
          kind: "undoChange",
          paths: [target.depotPath],
          targetState: "openedEdit",
          changelistId: target.changelistId,
        });
        const raw: unknown = await backend.confirmUndo({
          target,
          token: reviewed!.token,
          operationId,
        } as never);
        const lifecycle = lifecycleOf(raw);
        const legacy =
          unwrapLocalIoLegacy<
            import("../../../shared/contracts").OperationResult
          >(raw);
        if (!lifecycle || !legacy) {
          withdrawLocalIoProjection(operationId);
          onRefresh();
          if (mounted.current) {
            setFinished(true);
            setMessage(
              tr(
                "Undo 已执行（旧格式结果）；请检查工作区与操作日志。",
                "Undo executed (legacy result); inspect the workspace and operation log.",
              ),
            );
          }
          return;
        }
        if (
          lifecycle.state === "unknown" ||
          lifecycle.state === "rejected" ||
          lifecycle.state === "legacy"
        ) {
          settleLocalIoProjection(operationId, lifecycle, false);
          onRefresh();
          if (mounted.current) {
            setFinished(true);
            setMessage(
              tr(
                "Undo 结果不确定，已按真实状态刷新；不要直接重试。",
                "Undo outcome is unconfirmed; rows were corrected from the server. Do not retry blindly.",
              ),
            );
          }
          return;
        }
        settleLocalIoProjection(operationId, lifecycle, false);
        void Promise.resolve(onRefresh())
          .then(() => settleLocalIoProjection(operationId, lifecycle, true))
          .catch(() => undefined);
        if (mounted.current) {
          setFinished(true);
          setMessage(
            lifecycle.outcome === "succeeded"
              ? tr(
                  "Undo 已保存到默认待提交列表，尚未提交。请检查文件；如有后续修订，提交前需要同步并解决冲突。",
                  "Undo saved to the default pending changelist, not submitted. Review the file; later revisions may require sync and resolve before submission.",
                )
              : tr(
                  "Undo 未完整完成（partial/unknown）。请检查工作区与操作日志，不要直接重试。",
                  "Undo did not complete cleanly (partial/unknown). Inspect the workspace and operation log before retrying.",
                ),
          );
        }
      }
    } catch (error) {
      if (confirm) onRefresh();
      if (mounted.current) {
        setMessage(String(error));
        if (confirm) setFinished(true);
      }
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  return (
    <Dialog
      title={tr("撤销此修订", "Undo this revision")}
      zh={zh}
      danger
      busy={busy}
      source={request.source}
      onRequestClose={onDismiss}
      description={tr(
        "仅撤销右键行这个文件修订引入的更改；不扩大到整个 CL 或两条选中记录之间的区间。",
        "Undo only the changes introduced by the right-clicked file revision, not the entire CL or selected range.",
      )}
      footer={
        <>
          <button disabled={busy} onClick={onDismiss}>
            {tr("关闭", "Close")}
          </button>
          {!finished && (
            <button disabled={busy} onClick={() => void run(false)}>
              {tr("预览", "Preview")}
            </button>
          )}
          {plan && !finished && (
            <button disabled={busy} onClick={() => void run(true)}>
              {tr("确认 Undo", "Confirm Undo")}
            </button>
          )}
        </>
      }
    >
      <p style={{ overflowWrap: "anywhere" }}>
        {target.depotPath}#{target.revision} · CL {target.changelistId}
      </p>
      <p>
        {tr(
          "目标：默认待提交列表。不会自动提交。后续修订可能需要同步及 Resolve 后才能提交。",
          "Destination: default pending changelist. No automatic submit. Later revisions may require sync and resolve before submission.",
        )}
      </p>
      {plan && (
        <div>
          <p>
            {tr(
              "已核对单文件预览；确认时会重新检查。",
              "Single-file preview verified; confirmation rechecks the file.",
            )}
          </p>
          <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
            {plan.messages.join("\n")}
          </pre>
        </div>
      )}
      {message && <p role="status">{message}</p>}
    </Dialog>
  );
}
