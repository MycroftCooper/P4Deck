import { ResizableTable } from "../../../app/context-menu/ResizableTable";
import { useEffect, useMemo, useRef, useState } from "react";
import { Dialog, DialogNotice } from "../../../app/dialogs/Dialog";
import { PreflightStatus } from "../../../app/dialogs/PreflightStatus";
import { backend } from "../../../infrastructure/backend";
import type {
  FileLockConfirmation,
  FileLockOperation,
  FileLockPreflight,
  FileLockPreflightRequest,
  FileLockResult,
  WorkspaceNode,
} from "../../../shared/contracts";

type Phase = "idle" | "checking" | "review" | "running" | "result";
import {
  beginFileLockProjection,
  settleFileLockProjection,
  withdrawFileLockProjection,
} from "../../actions/fileLockProjection";

export function FileLockDialog({
  nodes,
  operation,
  source,
  connectionKey,
  zh,
  onDismiss,
  onRefresh,
  check = (request) => backend.preflightFileLock(request),
  execute = (confirmation) => backend.confirmFileLock(confirmation),
}: {
  nodes: WorkspaceNode[];
  operation: FileLockOperation;
  source: HTMLElement | null;
  connectionKey: string;
  zh: boolean;
  onDismiss(): void;
  onRefresh?(): Promise<void> | void;
  check?(request: FileLockPreflightRequest): Promise<FileLockPreflight>;
  execute?(confirmation: FileLockConfirmation): Promise<FileLockResult>;
}) {
  const tr = (cn: string, en: string) => (zh ? cn : en);
  const [snapshot] = useState(() => nodes.map((node) => ({ ...node })));
  const paths = useMemo(
    () =>
      [...new Set(snapshot.map((node) => node.depotPath || node.absolutePath))]
        .filter(Boolean)
        .sort(),
    [snapshot],
  );
  const [phase, setPhase] = useState<Phase>("idle");
  const [preflight, setPreflight] = useState<FileLockPreflight>();
  const [result, setResult] = useState<FileLockResult>();
  const pendingOperation = useRef<string | undefined>(undefined);
  const [error, setError] = useState("");
  const [progress, setProgress] = useState<number>();
  const generation = useRef(0);
  const activeOperation = useRef<string | undefined>(undefined);
  const connection = useRef(connectionKey);
  connection.current = connectionKey;

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
  useEffect(() => {
    generation.current += 1;
    setPreflight(undefined);
    setResult(undefined);
    setError("");
    setPhase("idle");
  }, [connectionKey]);
  useEffect(() => {
    let dispose: (() => void) | undefined;
    void backend
      .subscribeOperationEvents((event) => {
        if (
          activeOperation.current &&
          (event.operationId === activeOperation.current ||
            event.operationId.startsWith(`${activeOperation.current}:`)) &&
          event.progress != null
        )
          setProgress(event.progress);
      })
      .then((value) => (dispose = value));
    return () => dispose?.();
  }, []);

  async function runPreflight() {
    if (!paths.length || phase === "checking" || phase === "running") return;
    const epoch = ++generation.current;
    const expectedConnection = connectionKey;
    setPhase("checking");
    setError("");
    setResult(undefined);
    try {
      const value = await check({
        operation,
        paths,
        operationId: (pendingOperation.current ??= crypto.randomUUID()),
      });
      if (
        epoch !== generation.current ||
        connection.current !== expectedConnection
      )
        return;
      setPreflight(value);
      setPhase("review");
    } catch (cause) {
      if (epoch !== generation.current) return;
      setError(String(cause));
      setPhase("idle");
    }
  }

  async function confirm() {
    if (!preflight?.ready || !preflight.token || !preflight.targetSnapshot)
      return;
    const epoch = generation.current;
    const expectedConnection = connectionKey;
    const operationId = pendingOperation.current ?? crypto.randomUUID();
    activeOperation.current = operationId;
    beginFileLockProjection(operationId, operation, paths, connectionKey);
    setProgress(0);
    setError("");
    setPhase("running");
    try {
      const value = await execute({
        token: preflight.token,
        target: preflight.targetSnapshot,
        stateDigest: preflight.stateDigest,
        operationId,
      });
      if (
        epoch !== generation.current ||
        connection.current !== expectedConnection
      )
        return;
      settleFileLockProjection(operationId, value, false);
      setResult(value);
      setPhase("result");
      void Promise.resolve(onRefresh?.())
        .then(() => settleFileLockProjection(operationId, value, true))
        .catch(() => undefined);
    } catch (cause) {
      if (epoch !== generation.current) return;
      withdrawFileLockProjection(operationId);
      setError(String(cause));
      setPhase("result");
      void Promise.resolve(onRefresh?.()).catch(() => undefined);
    } finally {
      if (activeOperation.current === operationId) {
        activeOperation.current = undefined;
        pendingOperation.current = undefined;
      }
    }
  }

  const title =
    operation === "lock"
      ? tr("锁定文件", "Lock files")
      : tr("解锁文件", "Unlock files");
  const retry = () => {
    generation.current += 1;
    setPreflight(undefined);
    setResult(undefined);
    setError("");
    setPhase("idle");
  };
  const footer =
    phase === "running" ? (
      <button
        onClick={() => {
          if (activeOperation.current)
            void backend.cancelOperation(activeOperation.current);
        }}
      >
        {tr("取消剩余操作", "Cancel remaining")}
      </button>
    ) : phase === "result" ? (
      <>
        <button onClick={retry}>{tr("人工重试", "Retry manually")}</button>
        <button className="primary" onClick={onDismiss}>
          {tr("关闭", "Close")}
        </button>
      </>
    ) : phase === "review" ? (
      <>
        <button onClick={onDismiss}>{tr("取消", "Cancel")}</button>
        <button onClick={() => void runPreflight()}>
          {tr("重新预检", "Check again")}
        </button>
        <button
          className="primary"
          disabled={
            !preflight?.ready || !preflight.token || !preflight.targetSnapshot
          }
          onClick={() => void confirm()}
        >
          {operation === "lock"
            ? tr("确认锁定", "Confirm lock")
            : tr("确认解锁", "Confirm unlock")}
        </button>
      </>
    ) : (
      <>
        <button onClick={onDismiss}>{tr("取消", "Cancel")}</button>
        <button
          className="primary"
          disabled={!paths.length || phase === "checking"}
          onClick={() => void runPreflight()}
        >
          {phase === "checking"
            ? tr("预检中…", "Checking…")
            : tr("开始预检", "Run preflight")}
        </button>
      </>
    );

  return (
    <Dialog
      title={title}
      description={tr(
        "完整文件集与连接代次会绑定到一次性令牌；批量结果逐文件报告，部分成功不会回滚。",
        "The complete file set and connection generation are bound to a one-use token. Batch results are per-file and partial success is not rolled back.",
      )}
      zh={zh}
      source={source}
      busy={phase === "running"}
      onRequestClose={onDismiss}
      footer={footer}
    >
      <div className="workflow-context">
        {title} · {paths.length} {tr("个文件", "files")}
      </div>
      <PreflightStatus
        zh={zh}
        state={
          phase === "checking"
            ? { kind: "checking" }
            : error
              ? { kind: "failed", message: error }
              : preflight
                ? {
                    kind: preflight.ready ? "ready" : "blocked",
                    blockers: preflight.blockers.map((item) => item.message),
                    warnings: preflight.warnings.map((item) => item.message),
                  }
                : { kind: "idle" }
        }
      />
      {preflight && (
        <>
          <DialogNotice>
            {tr("适用", "Applicable")} {preflight.counts.applicable} ·{" "}
            {tr("已满足", "already satisfied")}{" "}
            {preflight.counts.alreadySatisfied} · {tr("阻塞", "blocked")}{" "}
            {preflight.counts.blocked} · +l {preflight.counts.exclusive}
          </DialogNotice>
          {preflight.logReference && (
            <DialogNotice>
              {tr("预检日志", "Preflight log")} ·{" "}
              <code>{preflight.logReference}</code>
            </DialogNotice>
          )}
          <div className="workflow-mapping-scroll">
            <ResizableTable
              tableId="file-lock"
              defaults={[240, 130, 100, 160, 150]}
              minimums={[140, 90, 80, 100, 100]}
              className="workflow-mapping-table"
            >
              <thead>
                <tr>
                  <th>{tr("文件", "File")}</th>
                  <th>{tr("打开状态 / CL", "Opened / CL")}</th>
                  <th>{tr("类型", "Type")}</th>
                  <th>{tr("锁状态", "Lock")}</th>
                  <th>{tr("处理", "Decision")}</th>
                </tr>
              </thead>
              <tbody>
                {preflight.files.map((file) => (
                  <tr key={file.inputPath}>
                    <td>{file.depotPath || file.inputPath}</td>
                    <td>
                      {file.openedAction || "—"} /{" "}
                      {file.changelistId === 0 ? "Default" : file.changelistId}
                    </td>
                    <td>
                      {file.fileType || "—"}
                      {file.exclusive ? " · +l" : ""}
                    </td>
                    <td>
                      {file.ownership}
                      {file.lockOwner ? ` · ${file.lockOwner}` : ""}
                      {file.otherOpen.length
                        ? ` · ${file.otherOpen.join(", ")}`
                        : ""}
                    </td>
                    <td>
                      {file.applicable
                        ? tr("将执行", "will run")
                        : (file.reason ?? tr("不可用", "unavailable"))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </ResizableTable>
          </div>
        </>
      )}
      {phase === "running" && (
        <DialogNotice>
          {tr(
            "同一 mutation lane 内重验、执行并验证",
            "Revalidating, executing and verifying in one mutation lane",
          )}{" "}
          · {Math.round(progress ?? 0)}%
        </DialogNotice>
      )}
      {result && (
        <section className="workflow-result" role="status">
          <h3>{result.outcome}</h3>
          <p>{result.message}</p>
          {(result.operationId || result.logReference) && (
            <p>
              {tr("操作 / 日志", "Operation / log")} ·{" "}
              <code>{result.operationId ?? result.logReference}</code>
            </p>
          )}
          <ul>
            {result.files.map((file) => (
              <li key={file.depotPath}>
                <strong>{file.outcome}</strong> · {file.depotPath}
                {file.lockOwner ? ` · ${file.lockOwner}` : ""} · {file.message}
                {file.operationId ? ` · ${file.operationId}` : ""}
              </li>
            ))}
          </ul>
          <p>{result.refresh.reason}</p>
        </section>
      )}
      {phase === "result" && error && (
        <DialogNotice error>{error}</DialogNotice>
      )}
    </Dialog>
  );
}
