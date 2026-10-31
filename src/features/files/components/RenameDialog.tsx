import { useEffect, useRef, useState } from "react";
import { useUnsavedEditor } from "../../../app/closeGuard";
import { Dialog, DialogNotice } from "../../../app/dialogs/Dialog";
import { backend } from "../../../infrastructure/backend";
import type {
  RenameMoveConfirmation,
  RenameMovePreflight,
  RenameMovePreflightRequest,
  RenameMoveResult,
  WorkspaceNode,
} from "../../../shared/contracts";
import { checkRenamePath, type RenamePathError } from "../renamePath";
import {
  beginLocalIoProjection,
  clearLocalIoProjection,
  lifecycleOf,
  unwrapLocalIoLegacy,
  withdrawLocalIoProjection,
} from "../../actions/localIoLifecycle";

const reasons: Record<RenamePathError, [string, string]> = {
  empty: ["请填写目标路径。", "Enter a destination path."],
  absolute: [
    "请输入与源路径同类型的绝对路径。",
    "Use an absolute path of the same type as the source.",
  ],
  characters: [
    "路径不能包含控制字符或 P4 filespec 元字符。",
    "Control characters and P4 filespec metacharacters are not allowed.",
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

type Phase = "preview" | "checking" | "review" | "confirming" | "result";

export function RenameDialog({
  node,
  source,
  zh,
  onDismiss: dismissCallback,
  onRefresh,
  check = (request) => backend.preflightRenameMove(request),
  execute = (confirmation) => backend.confirmRenameMove(confirmation),
}: {
  node: WorkspaceNode;
  source: HTMLElement | null;
  zh: boolean;
  onDismiss(): void;
  onRefresh?(): Promise<void> | void;
  check?(request: RenameMovePreflightRequest): Promise<RenameMovePreflight>;
  execute?(
    confirmation: RenameMoveConfirmation,
  ): Promise<RenameMoveResult | unknown>;
}) {
  const tr = (cn: string, en: string) => (zh ? cn : en);
  const [snapshot] = useState(() => ({ ...node }));
  const from = snapshot.absolutePath || snapshot.depotPath || "";
  const [target, setTarget] = useState(from);
  const [targetChangeId, setTargetChangeId] = useState(
    snapshot.changelistId ?? 0,
  );
  const [phase, setPhase] = useState<Phase>("preview");
  const [preflight, setPreflight] = useState<RenameMovePreflight>();
  const [result, setResult] = useState<RenameMoveResult>();
  const clearUnsaved = useUnsavedEditor(
    result?.outcome === "succeeded"
      ? "clean"
      : target !== from || targetChangeId !== (snapshot.changelistId ?? 0)
        ? "dirty"
        : "clean",
  );
  const onDismiss = () => {
    clearUnsaved();
    dismissCallback();
  };
  const [failure, setFailure] = useState("");
  const [discard, setDiscard] = useState(false);
  const generation = useRef(0);
  const activeOperation = useRef<string | undefined>(undefined);
  const error = checkRenamePath(
    from,
    target,
    snapshot.kind === "directory",
    !snapshot.absolutePath,
  );
  const blockedInput = snapshot.kind !== "file" || !snapshot.absolutePath;

  useEffect(
    () => () => {
      generation.current += 1;
      if (activeOperation.current)
        void backend
          .cancelOperation(activeOperation.current)
          .catch(() => undefined);
    },
    [],
  );

  function invalidatePreview() {
    generation.current += 1;
    setPreflight(undefined);
    setResult(undefined);
    setFailure("");
    setPhase("preview");
  }

  const dismiss = () =>
    phase === "confirming"
      ? undefined
      : target !== from || phase !== "preview"
        ? setDiscard(true)
        : onDismiss();

  async function preview() {
    if (error || blockedInput || phase === "checking") return;
    const epoch = ++generation.current;
    setFailure("");
    setPreflight(undefined);
    setResult(undefined);
    setPhase("checking");
    try {
      const value = await check({
        sourcePath: from,
        targetPath: target,
        targetChangeId,
        operationId: crypto.randomUUID(),
      });
      if (epoch !== generation.current) return;
      setPreflight(value);
      setPhase("review");
    } catch (cause) {
      if (epoch !== generation.current) return;
      setFailure(String(cause));
      setPhase("preview");
    }
  }

  async function confirm() {
    if (
      phase !== "review" ||
      !preflight?.ready ||
      !preflight.token ||
      !preflight.targetSnapshot
    )
      return;
    const epoch = generation.current;
    const operationId = crypto.randomUUID();
    activeOperation.current = operationId;
    beginLocalIoProjection({
      operationId,
      kind: "renameMove",
      fromPath: from,
      toPath: target,
    });
    setFailure("");
    setPhase("confirming");
    try {
      const value = await execute({
        token: preflight.token,
        target: preflight.targetSnapshot,
        previewDigest: preflight.previewDigest,
        operationId,
      });
      if (epoch !== generation.current) return;
      const lifecycle = lifecycleOf(value);
      if (lifecycle && lifecycle.state === "unknown") {
        withdrawLocalIoProjection(operationId);
        setFailure(
          tr(
            "结果不确定；已按服务器真实状态刷新，请核对后再操作（不会自动重试）。",
            "Outcome is unconfirmed; rows were corrected from the server. Verify before retrying (no automatic retry).",
          ),
        );
        setPhase("result");
        void Promise.resolve(onRefresh?.()).catch(() => undefined);
        return;
      }
      const legacy = unwrapLocalIoLegacy<RenameMoveResult>(value);
      if (!legacy) {
        withdrawLocalIoProjection(operationId);
        setFailure(
          tr("未收到可识别的结果。", "No recognizable result was returned."),
        );
        setPhase("result");
        void Promise.resolve(onRefresh?.()).catch(() => undefined);
        return;
      }
      setResult(legacy);
      setPhase("result");
      if (lifecycle?.state === "committed") {
        void Promise.resolve(onRefresh?.())
          .then(() => clearLocalIoProjection(operationId))
          .catch(() => undefined);
      } else {
        withdrawLocalIoProjection(operationId);
        if (legacy.refresh.workspaceStatus || legacy.refresh.pendingChanges)
          void Promise.resolve(onRefresh?.()).catch(() => undefined);
      }
    } catch (cause) {
      if (epoch !== generation.current) return;
      withdrawLocalIoProjection(operationId);
      setFailure(String(cause));
      setPhase("result");
      void Promise.resolve(onRefresh?.()).catch(() => undefined);
    } finally {
      if (activeOperation.current === operationId)
        activeOperation.current = undefined;
    }
  }

  const footer =
    phase === "confirming" ? (
      <>
        <button
          onClick={() => {
            const operationId = activeOperation.current;
            if (operationId) void backend.cancelOperation(operationId);
          }}
        >
          {tr("取消操作", "Cancel operation")}
        </button>
        <button disabled>{tr("确认中…", "Confirming…")}</button>
      </>
    ) : phase === "result" ? (
      <button className="primary" onClick={onDismiss}>
        {tr("关闭", "Close")}
      </button>
    ) : phase === "review" ? (
      <>
        <button onClick={dismiss}>{tr("取消", "Cancel")}</button>
        <button onClick={() => void preview()}>
          {tr("重新预检", "Run again")}
        </button>
        <button
          className="primary"
          disabled={
            !preflight?.ready || !preflight.token || !preflight.targetSnapshot
          }
          onClick={() => void confirm()}
        >
          {tr("确认重命名 / 移动", "Confirm rename / move")}
        </button>
      </>
    ) : (
      <>
        <button onClick={dismiss}>{tr("取消", "Cancel")}</button>
        <button
          className="primary"
          disabled={!!error || blockedInput || phase === "checking"}
          onClick={() => void preview()}
        >
          {phase === "checking"
            ? tr("预检中…", "Checking…")
            : tr("开始预检", "Preview and review")}
        </button>
      </>
    );

  return (
    <Dialog
      title={tr("重命名 / 移动", "Rename / move")}
      description={tr(
        "单文件安全流程：先预检映射、打开状态、目标与 CL，再使用一次性令牌确认。",
        "Safe single-file flow: preview mapping, opened state, target and changelist, then confirm with a one-use token.",
      )}
      zh={zh}
      source={source}
      onRequestClose={dismiss}
      footer={footer}
    >
      <div className="workflow-context">
        {tr("阶段", "Phase")} · {phase}
      </div>
      <label>
        {tr("源路径", "Source path")}
        <input readOnly value={from} />
      </label>
      <label>
        {tr("目标路径", "Destination path")}
        <input
          data-dialog-autofocus
          value={target}
          disabled={phase === "confirming" || phase === "result"}
          onChange={(event) => {
            setTarget(event.target.value);
            invalidatePreview();
          }}
          aria-invalid={target !== from && !!error}
        />
      </label>
      <label>
        {tr(
          "目标 Changelist（0 = Default）",
          "Target changelist (0 = Default)",
        )}
        <input
          type="number"
          min={0}
          value={targetChangeId}
          disabled={phase === "confirming" || phase === "result"}
          onChange={(event) => {
            setTargetChangeId(Math.max(0, Number(event.target.value) || 0));
            invalidatePreview();
          }}
        />
      </label>
      {blockedInput && (
        <DialogNotice error>
          {tr(
            "本批只支持当前 workspace 内的单个本地文件；目录递归和 Depot-only 对象已阻止。",
            "This release supports one local file in the current workspace only; recursive folders and Depot-only objects are blocked.",
          )}
        </DialogNotice>
      )}
      {target !== from && error && (
        <DialogNotice error>{reasons[error][zh ? 0 : 1]}</DialogNotice>
      )}
      {phase === "checking" && (
        <DialogNotice>
          {tr("正在读取 P4 快照…", "Reading the P4 snapshot…")}
        </DialogNotice>
      )}
      {preflight && (
        <section
          className="workflow-review"
          aria-label={tr("预检结果", "Preflight result")}
        >
          <h3>{tr("映射与状态", "Mapping and state")}</h3>
          <dl>
            <dt>{tr("源 Depot", "Source depot")}</dt>
            <dd>{preflight.source?.depotPath ?? "—"}</dd>
            <dt>{tr("源本地", "Source local")}</dt>
            <dd>{preflight.source?.localPath ?? "—"}</dd>
            <dt>{tr("目标 Depot", "Target depot")}</dt>
            <dd>{preflight.target?.depotPath ?? "—"}</dd>
            <dt>{tr("目标本地", "Target local")}</dt>
            <dd>{preflight.target?.localPath ?? "—"}</dd>
            <dt>{tr("打开状态 / CL", "Opened action / CL")}</dt>
            <dd>
              {preflight.sourceState
                ? `${preflight.sourceState.action} / ${preflight.sourceState.changeId || "Default"}`
                : "—"}
            </dd>
            <dt>{tr("目标 CL", "Target CL")}</dt>
            <dd>
              {preflight.targetChangeId || "Default"} ·{" "}
              {preflight.targetChangeValid
                ? tr("有效", "valid")
                : tr("无效", "invalid")}
            </dd>
            <dt>{tr("目标存在", "Target exists")}</dt>
            <dd>{preflight.targetExists ? tr("是", "yes") : tr("否", "no")}</dd>
            <dt>{tr("仅大小写风险", "Case-only risk")}</dt>
            <dd>
              {preflight.caseOnlyRisk
                ? tr("已阻止", "blocked")
                : tr("无", "none")}
            </dd>
          </dl>
          {preflight.blockers.map((item) => (
            <DialogNotice error key={`${item.code}:${item.message}`}>
              {item.message}
            </DialogNotice>
          ))}
          {preflight.warnings.map((item) => (
            <DialogNotice key={`${item.code}:${item.message}`}>
              {item.message}
            </DialogNotice>
          ))}
          {preflight.ready && (
            <DialogNotice>
              {tr(
                "预检通过。令牌只能使用一次；确认时会在 mutation lane 内重新校验全部状态。",
                "Preflight passed. The token is one-use; confirmation revalidates all state inside the mutation lane.",
              )}
            </DialogNotice>
          )}
        </section>
      )}
      {phase === "confirming" && (
        <DialogNotice>
          {tr(
            "正在重新校验并执行。关闭界面不能撤销服务器已接受的操作。",
            "Revalidating and executing. Closing the view cannot undo work accepted by the server.",
          )}
        </DialogNotice>
      )}
      {result && (
        <section className="workflow-result" role="status">
          <h3>{result.outcome}</h3>
          <p>{result.message}</p>
          {result.failure && <p>{result.failure}</p>}
          {result.operationId && (
            <p>
              {tr("操作记录", "Operation")} {result.operationId}
            </p>
          )}
          <p>{result.refresh.reason}</p>
        </section>
      )}
      {failure && <DialogNotice error>{failure}</DialogNotice>}
      {discard && (
        <section className="workflow-discard" role="alert">
          <p>
            {tr(
              "关闭将丢弃当前预检与一次性令牌。",
              "Closing discards the current preview and one-use token.",
            )}
          </p>
          <button onClick={() => setDiscard(false)}>
            {tr("继续编辑", "Keep editing")}
          </button>
          <button className="danger" onClick={onDismiss}>
            {tr("放弃并关闭", "Discard and close")}
          </button>
        </section>
      )}
    </Dialog>
  );
}
