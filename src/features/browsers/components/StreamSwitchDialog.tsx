import { useEffect, useMemo, useRef, useState } from "react";
import { Dialog, DialogNotice } from "../../../app/dialogs/Dialog";
import { PreflightStatus } from "../../../app/dialogs/PreflightStatus";
import { TargetList } from "../../../app/dialogs/TargetList";
import { backend } from "../../../infrastructure/backend";
import type { ConnectionSnapshot } from "../../companySubmit/model";
import {
  lookupStreamSwitchAction,
  validStreamSwitchReceipt,
  type StreamSwitchActionLookup,
} from "../../actions/workflowReceipt";
import {
  streamConnectionMatchesTarget,
  unknownStreamSwitchResult,
  verifiedStreamSwitch,
} from "../mutationLifecycle";
import type {
  RuntimeInfo,
  StreamSummary,
  StreamSwitchMode,
  StreamSwitchPreflight,
  StreamSwitchResult,
} from "../../../shared/contracts";

type Phase = "preflight" | "review" | "executing" | "result";

export function StreamSwitchDialog({
  stream,
  runtime,
  connectionKey,
  source,
  zh,
  onDismiss,
  onRuntime,
  onRefresh,
  connection: connectionProvider,
  lookup: lookupReceipt,
}: {
  stream: StreamSummary;
  runtime: RuntimeInfo;
  connectionKey: string;
  source: HTMLElement | null;
  zh: boolean;
  onDismiss(): void;
  onRuntime?(runtime: RuntimeInfo): void;
  onRefresh(result?: StreamSwitchResult): void;
  /** Exact dispatching connection snapshot; captured once per confirm. */
  connection?(): Promise<ConnectionSnapshot>;
  /** Durable receipt recovery by the SAME operationId. */
  lookup?(request: {
    operationId: string;
    connection: ConnectionSnapshot;
  }): Promise<StreamSwitchActionLookup>;
}) {
  const tr = (cn: string, en: string) => (zh ? cn : en);
  const [mode, setMode] = useState<StreamSwitchMode>("viewOnly");
  const [phase, setPhase] = useState<Phase>("preflight");
  const [plan, setPlan] = useState<StreamSwitchPreflight>();
  const [result, setResult] = useState<StreamSwitchResult>();
  const [acknowledge, setAcknowledge] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const sequence = useRef(0);
  const operation = useRef<string | undefined>(undefined);
  const pendingRuntime = useRef<RuntimeInfo | undefined>(undefined);
  const mounted = useRef(true);
  const snapshot = useMemo(
    () => ({
      stream: { ...stream },
      runtimeGeneration: runtime.contextGeneration,
    }),
    [],
  );

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      sequence.current++;
      if (operation.current) void backend.cancelOperation(operation.current);
    };
  }, [connectionKey]);

  useEffect(() => {
    if (!plan || phase !== "review") return;
    const timer = window.setTimeout(
      () => {
        setPlan(undefined);
        setAcknowledge(false);
        setError(
          tr(
            "预检已过期，请重新检查当前工作区。",
            "The preflight expired; inspect the current workspace again.",
          ),
        );
        setPhase("preflight");
      },
      Math.min(2147483647, Math.max(0, plan.expiresAt - Date.now())),
    );
    return () => window.clearTimeout(timer);
  }, [phase, plan, zh]);

  async function preflight(nextMode = mode) {
    if (busy) return;
    const seq = ++sequence.current;
    const operationId = crypto.randomUUID();
    operation.current = operationId;
    setBusy(true);
    setError("");
    setResult(undefined);
    setPlan(undefined);
    setAcknowledge(false);
    try {
      const next = await backend.preflightStreamSwitch({
        targetStream: snapshot.stream.stream,
        mode: nextMode,
        operationId,
      });
      if (!mounted.current || seq !== sequence.current) return;
      setPlan(next);
      setPhase("review");
    } catch (cause) {
      if (mounted.current && seq === sequence.current) setError(String(cause));
    } finally {
      if (seq === sequence.current) {
        operation.current = undefined;
        setBusy(false);
      }
    }
  }

  /** One same-operationId receipt lookup. `settled` is persisted, never success. */
  async function recover(
    operationId: string,
    dispatching: ConnectionSnapshot,
  ): Promise<StreamSwitchResult | undefined> {
    try {
      const request = { operationId, connection: dispatching };
      const lookup = await (lookupReceipt ?? lookupStreamSwitchAction)(request);
      if (
        lookup.kind === "found" &&
        validStreamSwitchReceipt(request, lookup.receipt) &&
        lookup.receipt.state === "settled" &&
        lookup.receipt.result
      )
        return lookup.receipt.result;
    } catch {
      /* Lookup failure never retries the write. */
    }
    return undefined;
  }

  async function confirm() {
    if (
      busy ||
      !plan?.ready ||
      !plan.token ||
      !plan.targetSnapshot ||
      plan.expiresAt <= Date.now() ||
      (plan.warnings.length > 0 && !acknowledge)
    )
      return;
    const seq = ++sequence.current;
    const operationId = crypto.randomUUID();
    operation.current = operationId;
    setBusy(true);
    setError("");
    setPhase("executing");
    let dispatching: ConnectionSnapshot | undefined;
    try {
      // Exact dispatching connection, reused by the same-id receipt lookup.
      dispatching = await (
        connectionProvider ?? (() => backend.companySubmitConnectionSnapshot())
      )();
      if (!mounted.current || seq !== sequence.current) return;
      if (!streamConnectionMatchesTarget(plan.targetSnapshot, dispatching))
        throw new Error(
          tr(
            "连接身份与预检目标不一致，未执行 Stream 切换。",
            "Connection identity changed; no stream switch was dispatched.",
          ),
        );
      let next = await backend.confirmStreamSwitch({
        token: plan.token,
        target: plan.targetSnapshot,
        previewDigest: plan.previewDigest,
        acknowledgeWarnings: acknowledge,
        operationId,
      });
      if (!mounted.current || seq !== sequence.current) return;
      // Unknown may have applied: query the durable receipt once by identity.
      if (next.outcome === "unknown")
        next = (await recover(operationId, dispatching)) ?? next;
      if (!mounted.current || seq !== sequence.current) return;
      setResult(next);
      setPhase("result");
      if (next.runtime) pendingRuntime.current = next.runtime;
    } catch (cause) {
      if (!mounted.current || seq !== sequence.current) return;
      const recovered = dispatching
        ? await recover(operationId, dispatching)
        : undefined;
      if (!mounted.current || seq !== sequence.current) return;
      if (recovered) {
        setResult(recovered);
        setPhase("result");
        if (recovered.runtime) pendingRuntime.current = recovered.runtime;
        return;
      }
      setError(String(cause));
      setResult(unknownStreamSwitchResult(operationId, String(cause)));
      setPhase("result");
    } finally {
      if (seq === sequence.current) {
        operation.current = undefined;
        setBusy(false);
      }
    }
  }

  function reset(nextMode = mode) {
    sequence.current++;
    if (operation.current) void backend.cancelOperation(operation.current);
    operation.current = undefined;
    setBusy(false);
    setPlan(undefined);
    setResult(undefined);
    setAcknowledge(false);
    setError("");
    setMode(nextMode);
    setPhase("preflight");
  }

  function finishAndClose() {
    if (pendingRuntime.current) onRuntime?.(pendingRuntime.current);
    onRefresh(result);
    onDismiss();
  }

  const preflightState = busy
    ? ({ kind: "checking" } as const)
    : error
      ? ({ kind: "failed", message: error } as const)
      : !plan
        ? ({ kind: "idle" } as const)
        : plan.ready
          ? ({
              kind: "ready",
              blockers: plan.blockers.map((item) => item.message),
              warnings: plan.warnings.map((item) => item.message),
            } as const)
          : ({
              kind: "blocked",
              blockers: plan.blockers.map((item) => item.message),
              warnings: plan.warnings.map((item) => item.message),
            } as const);
  const current = plan?.currentStream || tr("传统工作区", "Classic workspace");
  const verified = verifiedStreamSwitch(result);

  return (
    <Dialog
      title={tr("安全切换 Stream", "Safe stream switch")}
      description={tr(
        "检查 Client、Stream、权限和本地文件状态后，使用官方 client view switch；绝不强制切换或自动清理文件。",
        "Inspect the client, stream, permissions, and local state before the official client view switch. P4Deck never forces the switch or cleans files automatically.",
      )}
      source={source}
      zh={zh}
      danger={mode === "sync"}
      busy={busy}
      onRequestClose={() => {
        if (busy && operation.current)
          void backend.cancelOperation(operation.current);
        else if (phase === "result") finishAndClose();
        else onDismiss();
      }}
      footer={
        <>
          {phase === "preflight" && (
            <>
              <button onClick={onDismiss}>{tr("取消", "Cancel")}</button>
              <button
                className="primary"
                data-dialog-autofocus
                disabled={busy}
                onClick={() => void preflight()}
              >
                {busy
                  ? tr("检查中…", "Inspecting…")
                  : tr("运行预检", "Run preflight")}
              </button>
            </>
          )}
          {phase === "review" && (
            <>
              <button onClick={() => reset()}>{tr("重新选择", "Back")}</button>
              <button
                className={mode === "sync" ? "danger" : "primary"}
                disabled={
                  !plan?.ready ||
                  !plan.token ||
                  !plan.targetSnapshot ||
                  plan.expiresAt <= Date.now() ||
                  (plan.warnings.length > 0 && !acknowledge)
                }
                onClick={() => void confirm()}
              >
                {mode === "sync"
                  ? tr("确认切换并同步", "Confirm switch and sync")
                  : tr("确认仅切换视图", "Confirm view-only switch")}
              </button>
            </>
          )}
          {phase === "executing" && (
            <button
              className="danger"
              onClick={() =>
                operation.current && backend.cancelOperation(operation.current)
              }
            >
              {tr("取消操作", "Cancel operation")}
            </button>
          )}
          {phase === "result" && (
            <>
              <button onClick={finishAndClose}>{tr("关闭", "Close")}</button>
              {result?.streamChanged && !result.syncCompleted && (
                <button className="primary" onClick={() => reset("sync")}>
                  {tr("重新预检并完成同步", "Preflight recovery sync")}
                </button>
              )}
              {(!result || result.outcome !== "succeeded") &&
                !(result?.streamChanged && !result.syncCompleted) && (
                  <button className="primary" onClick={() => reset()}>
                    {tr("重新预检", "Run preflight again")}
                  </button>
                )}
            </>
          )}
        </>
      }
    >
      {runtime.mode === "mock" && (
        <DialogNotice>
          {tr(
            "Browser Mock：以下预检和执行均为模拟，不访问服务器或文件系统。",
            "Browser Mock: preflight and execution are simulated; no server or filesystem is accessed.",
          )}
        </DialogNotice>
      )}
      <div className="workflow-context">
        <strong>{runtime.context.client || "—"}</strong>
        {" · "}
        <code>{current}</code>
        {" → "}
        <code>{snapshot.stream.stream}</code>
      </div>
      {phase === "preflight" && (
        <>
          <fieldset className="workflow-choice-grid">
            <legend>{tr("文件处理方式", "Workspace file handling")}</legend>
            <label className="workflow-checkbox">
              <input
                type="radio"
                name="stream-switch-mode"
                checked={mode === "viewOnly"}
                onChange={() => setMode("viewOnly")}
              />
              {tr(
                "仅更新 Client 的 Stream；不改动工作区文件（默认）",
                "Update only the client Stream; leave workspace files untouched (default)",
              )}
            </label>
            <label className="workflow-checkbox">
              <input
                type="radio"
                name="stream-switch-mode"
                checked={mode === "sync"}
                onChange={() => setMode("sync")}
              />
              {tr(
                "切换后执行普通 sync 至 #head；本地风险会阻断",
                "Run a normal sync to #head after switching; local risks block execution",
              )}
            </label>
          </fieldset>
          <DialogNotice error={mode === "sync"}>
            {mode === "sync"
              ? tr(
                  "同步可能新增、更新或删除受控文件；不会使用 force、clean、revert 或自动回滚。",
                  "Sync may add, update, or remove controlled files. It never uses force, clean, revert, or automatic rollback.",
                )
              : tr(
                  "仅切换视图不会触碰文件；之后必须单独同步才能让内容匹配目标 Stream。",
                  "View-only switching does not touch files. Sync separately before treating content as matching the target stream.",
                )}
          </DialogNotice>
          <PreflightStatus state={preflightState} zh={zh} />
        </>
      )}
      {phase === "review" && plan && (
        <>
          <PreflightStatus state={preflightState} zh={zh} />
          <dl className="stream-switch-summary">
            <div>
              <dt>{tr("当前", "Current")}</dt>
              <dd>{current}</dd>
            </div>
            <div>
              <dt>{tr("目标", "Target")}</dt>
              <dd>{plan.targetStream}</dd>
            </div>
            <div>
              <dt>{tr("类型 / 父级", "Type / parent")}</dt>
              <dd>
                {plan.targetType || "—"} · {plan.targetParent || "—"}
              </dd>
            </div>
            <div>
              <dt>
                {tr(
                  "打开 / 未解决 / 本地变化",
                  "Opened / unresolved / local changes",
                )}
              </dt>
              <dd>
                {plan.risks.openedFiles} / {plan.risks.unresolvedFiles} /{" "}
                {plan.risks.reconcileFiles}
              </dd>
            </div>
            <div>
              <dt>{tr("目标规模", "Target size")}</dt>
              <dd>
                {plan.risks.targetFileCount ?? "?"} {tr("文件", "files")} ·{" "}
                {plan.risks.targetFileBytes == null
                  ? "?"
                  : formatBytes(plan.risks.targetFileBytes)}
              </dd>
            </div>
          </dl>
          <TargetList
            label={tr("风险涉及路径（最多 100 条）", "Risk paths (up to 100)")}
            paths={[...plan.blockers, ...plan.warnings].flatMap(
              (item) => item.paths,
            )}
          />
          {plan.warnings.length > 0 && (
            <label className="workflow-checkbox">
              <input
                type="checkbox"
                checked={acknowledge}
                onChange={(event) => setAcknowledge(event.target.checked)}
              />
              {tr(
                "我已核对全部警告，并确认所选文件处理方式。",
                "I reviewed every warning and confirm the selected file-handling mode.",
              )}
            </label>
          )}
        </>
      )}
      {phase === "executing" && (
        <section aria-live="polite" aria-busy="true">
          <DialogNotice>
            {mode === "sync"
              ? tr(
                  "正在重新验证、切换 Client Stream、同步并验证。取消不会回滚已完成步骤。",
                  "Revalidating, switching the client Stream, syncing, and verifying. Cancellation does not roll back completed steps.",
                )
              : tr(
                  "正在重新验证、切换 Client Stream 并确认服务器结果。",
                  "Revalidating, switching the client Stream, and verifying the server result.",
                )}
          </DialogNotice>
        </section>
      )}
      {phase === "result" && (
        <section aria-live="polite">
          <DialogNotice error={!result || result.outcome !== "succeeded"}>
            {result?.outcome === "succeeded"
              ? tr("已由服务器回读验证", "Verified by server readback")
              : result?.outcome === "unknown"
                ? tr("结果不确定", "Outcome uncertain")
                : ""}{" "}
            {result?.message || error}
          </DialogNotice>
          {result?.outcome === "unknown" && (
            <DialogNotice error>
              {tr(
                "切换可能已部分应用（无回滚）；已用同一操作号查询持久回执并刷新一次。请先核对 Client Stream/工作区身份，不要用新操作号重试。",
                "The switch may have partially applied (no rollback). The durable receipt was queried once with the same operation id and views were refreshed; verify the client stream/workspace identity before any retry with a new id.",
              )}
            </DialogNotice>
          )}
          {verified && (
            <DialogNotice>
              {tr("服务器回读身份：", "Verified server identity: ")}
              {verified.stream} · {verified.client} · generation{" "}
              {verified.contextGeneration}
              {" · "}
              {tr(
                "仍以刷新后的工作区/Stream 视图为准。",
                "Refreshed workspace/Stream views remain authoritative.",
              )}
            </DialogNotice>
          )}
          {result && (
            <dl className="stream-switch-summary">
              <div>
                <dt>{tr("结果", "Outcome")}</dt>
                <dd>{result.outcome}</dd>
              </div>
              <div>
                <dt>{tr("已验证 Stream", "Verified stream")}</dt>
                <dd>{result.verifiedStream || tr("未知", "Unknown")}</dd>
              </div>
              <div>
                <dt>{tr("同步", "Sync")}</dt>
                <dd>
                  {result.syncCompleted
                    ? tr("完成", "Completed")
                    : result.syncPerformed
                      ? tr("未完成", "Incomplete")
                      : tr("未执行", "Not run")}
                </dd>
              </div>
              <div>
                <dt>Operation</dt>
                <dd>{result.operationId || "—"}</dd>
              </div>
            </dl>
          )}
        </section>
      )}
    </Dialog>
  );
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  if (value < 1024 * 1024 * 1024)
    return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
  return `${(value / (1024 * 1024 * 1024)).toFixed(1)} GiB`;
}
