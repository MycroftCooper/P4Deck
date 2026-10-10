import { useEffect, useRef, useState } from "react";
import { Dialog, DialogNotice } from "../../../app/dialogs/Dialog";
import { PreflightStatus } from "../../../app/dialogs/PreflightStatus";
import { backend } from "../../../infrastructure/backend";
import type {
  ForceUnlockConfirmation,
  ForceUnlockOriginMode,
  ForceUnlockPreflight,
  ForceUnlockPreflightRequest,
  ForceUnlockResult,
  WorkspaceNode,
} from "../../../shared/contracts/types";
import {
  exactForceUnlockPaths,
  forceUnlockOrigin,
  forceUnlockOriginInputReason,
  isVerifiedForceUnlockSuccess,
} from "../forceUnlockModel";

type Phase = "setup" | "checking" | "review" | "running" | "result";

export function ForceUnlockDialog({
  nodes,
  source,
  connectionKey,
  zh,
  simulated,
  onDismiss,
  onRefresh,
  check = (request) => backend.preflightForceUnlock(request),
  execute = (confirmation) => backend.confirmForceUnlock(confirmation),
  cancelOperation,
}: {
  nodes: WorkspaceNode[];
  source: HTMLElement | null;
  connectionKey: string;
  zh: boolean;
  simulated: boolean;
  onDismiss(): void;
  onRefresh?(): Promise<void> | void;
  check?(request: ForceUnlockPreflightRequest): Promise<ForceUnlockPreflight>;
  execute?(confirmation: ForceUnlockConfirmation): Promise<ForceUnlockResult>;
  cancelOperation?(operationId: string): Promise<unknown>;
}) {
  const tr = (cn: string, en: string) => (zh ? cn : en);
  const [{ paths, reason }] = useState(() =>
    exactForceUnlockPaths(nodes.map((node) => ({ ...node }))),
  );
  const [mode, setMode] = useState<ForceUnlockOriginMode>("openedChangelist");
  const [change, setChange] = useState("");
  const [phase, setPhase] = useState<Phase>("setup");
  const [preflight, setPreflight] = useState<ForceUnlockPreflight>();
  const [result, setResult] = useState<ForceUnlockResult>();
  const [acknowledgement, setAcknowledgement] = useState("");
  const [error, setError] = useState("");
  const sequence = useRef(0);
  const activeOperation = useRef<string | undefined>(undefined);
  const mounted = useRef(true);
  const connection = useRef(connectionKey);
  connection.current = connectionKey;
  const cancel = cancelOperation ?? backend.cancelOperation;
  const busy = phase === "checking" || phase === "running";
  const changeReason = forceUnlockOriginInputReason(mode, change);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      sequence.current += 1;
      if (activeOperation.current)
        void cancel(activeOperation.current).catch(() => undefined);
    };
  }, [cancel]);

  useEffect(() => {
    sequence.current += 1;
    if (activeOperation.current)
      void cancel(activeOperation.current).catch(() => undefined);
    activeOperation.current = undefined;
    setPreflight(undefined);
    setResult(undefined);
    setAcknowledgement("");
    setError("");
    setPhase("setup");
  }, [connectionKey, cancel]);

  useEffect(() => {
    if (phase !== "review" || !preflight?.token) return;
    const timeout = window.setTimeout(
      () => {
        setPreflight(undefined);
        setAcknowledgement("");
        setError(
          tr(
            "一次性确认已过期；必须重新预检。",
            "The one-use review expired; preflight again.",
          ),
        );
        setPhase("setup");
      },
      Math.min(2147483647, Math.max(0, preflight.expiresAt - Date.now())),
    );
    return () => window.clearTimeout(timeout);
  }, [phase, preflight, zh]);

  async function runPreflight() {
    if (busy || reason || changeReason || !paths.length) return;
    const seq = ++sequence.current;
    const expectedConnection = connectionKey;
    const operationId = crypto.randomUUID();
    activeOperation.current = operationId;
    setError("");
    setResult(undefined);
    setPreflight(undefined);
    setAcknowledgement("");
    setPhase("checking");
    try {
      const value = await check({
        paths,
        origin: forceUnlockOrigin(mode, change),
        operationId,
      });
      if (
        !mounted.current ||
        seq !== sequence.current ||
        connection.current !== expectedConnection
      )
        return;
      setPreflight(value);
      setPhase("review");
    } catch (cause) {
      if (mounted.current && seq === sequence.current) {
        setError(String(cause));
        setPhase("setup");
      }
    } finally {
      if (seq === sequence.current) activeOperation.current = undefined;
    }
  }

  async function confirm() {
    if (
      phase !== "review" ||
      !preflight?.ready ||
      !preflight.token ||
      !preflight.targetSnapshot ||
      !preflight.expectedAcknowledgement ||
      preflight.expiresAt <= Date.now() ||
      acknowledgement !== preflight.expectedAcknowledgement
    )
      return;
    const seq = ++sequence.current;
    const expectedConnection = connectionKey;
    const operationId = crypto.randomUUID();
    activeOperation.current = operationId;
    setError("");
    setPhase("running");
    try {
      const value = await execute({
        token: preflight.token,
        target: preflight.targetSnapshot,
        stateDigest: preflight.stateDigest,
        acknowledgement,
        operationId,
      });
      if (
        !mounted.current ||
        seq !== sequence.current ||
        connection.current !== expectedConnection
      )
        return;
      setResult(value);
      setPhase("result");
    } catch (cause) {
      if (mounted.current && seq === sequence.current) {
        setError(String(cause));
        setPhase("result");
      }
    } finally {
      if (
        mounted.current &&
        seq === sequence.current &&
        connection.current === expectedConnection
      )
        await onRefresh?.();
      if (seq === sequence.current) activeOperation.current = undefined;
    }
  }

  function reset() {
    sequence.current += 1;
    if (activeOperation.current)
      void cancel(activeOperation.current).catch(() => undefined);
    activeOperation.current = undefined;
    setPreflight(undefined);
    setResult(undefined);
    setAcknowledgement("");
    setError("");
    setPhase("setup");
  }

  function cancelActive() {
    const operationId = activeOperation.current;
    sequence.current += 1;
    activeOperation.current = undefined;
    if (operationId) void cancel(operationId).catch(() => undefined);
    setError(tr("操作已取消。", "Operation cancelled."));
    setPhase("setup");
  }

  const verified = isVerifiedForceUnlockSuccess(result?.outcome, result?.files);
  const status = busy
    ? ({ kind: "checking" } as const)
    : error
      ? ({ kind: "failed", message: error } as const)
      : preflight
        ? ({
            kind: preflight.ready ? "ready" : "blocked",
            blockers: preflight.blockers.map(
              (issue) => `${issue.code}: ${issue.message}`,
            ),
            warnings: preflight.warnings.map(
              (issue) => `${issue.code}: ${issue.message}`,
            ),
          } as const)
        : ({ kind: "idle" } as const);

  return (
    <Dialog
      title={tr("管理员强制解锁", "Administrator force unlock")}
      description={tr(
        "独立高危流程：只会移除其他用户的锁，不会 revert、open 或修改文件，但会影响锁所有者的协作。",
        "Separate high-risk workflow: removes another user's lock without reverting, opening, or modifying files, but can disrupt the lock owner's work.",
      )}
      source={source}
      zh={zh}
      danger
      busy={busy}
      onRequestClose={onDismiss}
      footer={
        phase === "checking" || phase === "running" ? (
          <button className="danger" onClick={cancelActive}>
            {phase === "checking"
              ? tr("取消预检", "Cancel preflight")
              : tr("取消剩余强制解锁", "Cancel remaining force unlock")}
          </button>
        ) : phase === "review" ? (
          <>
            <button onClick={reset}>{tr("返回", "Back")}</button>
            <button
              className="danger"
              disabled={
                !preflight?.ready ||
                !preflight.token ||
                !preflight.targetSnapshot ||
                !preflight.expectedAcknowledgement ||
                preflight.expiresAt <= Date.now() ||
                acknowledgement !== preflight.expectedAcknowledgement
              }
              onClick={() => void confirm()}
            >
              {tr("确认管理员强制解锁", "Confirm administrator force unlock")}
            </button>
          </>
        ) : phase === "result" ? (
          <>
            <button onClick={onDismiss}>{tr("关闭", "Close")}</button>
            {!verified && (
              <button className="primary" onClick={reset}>
                {tr("重新预检", "Preflight again")}
              </button>
            )}
          </>
        ) : (
          <>
            <button onClick={onDismiss}>{tr("取消", "Cancel")}</button>
            <button
              className="danger"
              data-dialog-autofocus
              disabled={Boolean(reason || changeReason || !paths.length)}
              onClick={() => void runPreflight()}
            >
              {tr("高危预检并审阅", "High-risk preflight and review")}
            </button>
          </>
        )
      }
    >
      {simulated && (
        <DialogNotice>
          {tr(
            "Browser Mock：管理员权限、锁与执行结果均为模拟，不访问真实 P4 Server。",
            "Browser Mock: administrator permission, locks, and results are simulated; no real P4 Server is accessed.",
          )}
        </DialogNotice>
      )}
      <DialogNotice error>
        <strong>{tr("危险操作", "Dangerous operation")}</strong>
        <br />
        {tr(
          "P4Deck 不会自动通知锁所有者，也不提供忽略 blocker、Terminal 或通用 run_p4 旁路。",
          "P4Deck does not notify the lock owner and provides no blocker override, Terminal shortcut, or generic run_p4 bypass.",
        )}
      </DialogNotice>
      <div className="workflow-context">
        <strong>{paths.length} files</strong>
        <span>{paths.join(" · ") || reason}</span>
      </div>
      <PreflightStatus zh={zh} state={status} />

      {phase === "setup" && (
        <fieldset className="force-unlock-origin">
          <legend>{tr("锁来源", "Lock origin")}</legend>
          <label>
            <span>{tr("来源类型", "Origin type")}</span>
            <select
              aria-label={tr("强制解锁来源类型", "Force unlock origin type")}
              value={mode}
              onChange={(event) => {
                setMode(event.target.value as ForceUnlockOriginMode);
                setError("");
              }}
            >
              <option value="openedChangelist">
                {tr("编号 opened changelist", "Numbered opened changelist")}
              </option>
              <option value="shelvedChangelist">
                {tr(
                  "中止提交的 shelf (-s，当前阻断)",
                  "Aborted-submit shelf (-s, currently blocked)",
                )}
              </option>
              <option value="orphanDistributed">
                {tr(
                  "分布式孤儿锁 (-x，当前阻断)",
                  "Distributed orphan lock (-x, currently blocked)",
                )}
              </option>
            </select>
          </label>
          {mode !== "orphanDistributed" && (
            <label>
              <span>{tr("编号 CL", "Numbered changelist")}</span>
              <input
                aria-label={tr("来源 CL", "Origin changelist")}
                value={change}
                inputMode="numeric"
                aria-invalid={Boolean(changeReason)}
                aria-describedby="force-unlock-change-hint"
                onChange={(event) => setChange(event.target.value)}
                placeholder="31821"
              />
              <span
                id="force-unlock-change-hint"
                className="workflow-field-hint"
              >
                {changeReason ||
                  tr(
                    "可输入 default 取得明确 blocker；只有正数 numbered CL 可执行。",
                    "Enter default to inspect its explicit blocker; only a positive numbered CL can execute.",
                  )}
              </span>
            </label>
          )}
          {reason && <DialogNotice error>{reason}</DialogNotice>}
        </fieldset>
      )}

      {preflight && (
        <section
          className="force-unlock-review"
          aria-label="Force unlock review"
        >
          {preflight.targetSnapshot && (
            <dl className="stream-switch-summary">
              <div>
                <dt>Server / Profile</dt>
                <dd>
                  {preflight.targetSnapshot.context.server} /{" "}
                  {preflight.targetSnapshot.activeProfileId ?? "—"}
                </dd>
              </div>
              <div>
                <dt>User / Client</dt>
                <dd>
                  {preflight.targetSnapshot.context.user} /{" "}
                  {preflight.targetSnapshot.context.client}
                </dd>
              </div>
              <div>
                <dt>Origin</dt>
                <dd>
                  {preflight.origin.mode} / CL{" "}
                  {preflight.origin.changeId ?? "—"}
                </dd>
              </div>
              <div>
                <dt>{tr("一次性令牌", "One-use token")}</dt>
                <dd>
                  {Math.max(
                    0,
                    Math.ceil((preflight.expiresAt - Date.now()) / 1000),
                  )}
                  s
                </dd>
              </div>
            </dl>
          )}
          <div className="workflow-mapping-scroll">
            <table className="workflow-mapping-table">
              <thead>
                <tr>
                  <th>{tr("精确 Depot 文件", "Exact depot file")}</th>
                  <th>{tr("锁 owner / client", "Lock owner / client")}</th>
                  <th>{tr("CL / action", "CL / action")}</th>
                  <th>{tr("权限证明", "Permission proof")}</th>
                  <th>{tr("来源证明", "Origin proof")}</th>
                </tr>
              </thead>
              <tbody>
                {preflight.locks.map((lock) => (
                  <tr key={lock.depotPath}>
                    <td>{lock.depotPath}</td>
                    <td>
                      {lock.lockOwner ?? lock.lockUser ?? "unknown"} /{" "}
                      {lock.lockClient ?? "unknown"}
                    </td>
                    <td>
                      {lock.changeId ?? "—"} / {lock.openedAction ?? "—"}
                    </td>
                    <td>{lock.permission}</td>
                    <td>{lock.originProven ? "proven" : "unproven"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!!preflight.blockers.length && (
            <ul className="force-unlock-issues" aria-label="Blocking issues">
              {preflight.blockers.map((issue, index) => (
                <li key={`${issue.code}:${index}`}>
                  <strong>{issue.code}</strong>: {issue.message}
                  {issue.paths.length ? ` — ${issue.paths.join(", ")}` : ""}
                </li>
              ))}
            </ul>
          )}
          {!!preflight.warnings.length && (
            <ul className="force-unlock-issues" aria-label="Warnings">
              {preflight.warnings.map((issue, index) => (
                <li key={`${issue.code}:${index}`}>
                  <strong>{issue.code}</strong>: {issue.message}
                  {issue.paths.length ? ` — ${issue.paths.join(", ")}` : ""}
                </li>
              ))}
            </ul>
          )}
          {phase === "review" && preflight.ready && (
            <label className="force-unlock-acknowledgement">
              <span>
                {tr(
                  "精确输入或粘贴后端确认短语",
                  "Type or paste the exact backend acknowledgement",
                )}
              </span>
              <code>{preflight.expectedAcknowledgement}</code>
              <input
                aria-label={tr(
                  "强制解锁确认短语",
                  "Force unlock acknowledgement",
                )}
                value={acknowledgement}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => setAcknowledgement(event.target.value)}
              />
            </label>
          )}
        </section>
      )}

      {phase === "running" && (
        <DialogNotice>
          {tr(
            "正在同一 mutation lane 内复核 owner、来源、权限与代次，然后逐文件执行并验证。",
            "Rechecking owner, origin, permission, and generation in the same mutation lane, then executing and verifying each file.",
          )}
        </DialogNotice>
      )}

      {phase === "result" && (
        <section className="workflow-result" role="status">
          <DialogNotice error={!verified}>
            <strong>
              {verified
                ? tr("已完整验证解锁", "Force unlock completely verified")
                : tr("未验证为完整成功", "Not verified as complete success")}
            </strong>
            <br />
            {error || result?.message || tr("结果未知", "Unknown outcome")}
            {result?.failure ? ` (${result.failure})` : ""}
          </DialogNotice>
          {result?.files.length ? (
            <ul className="force-unlock-results" aria-label="Per-file results">
              {result.files.map((file) => (
                <li key={file.depotPath}>
                  <strong>{file.outcome}</strong> · {file.depotPath}
                  {file.previousOwner ? ` · before ${file.previousOwner}` : ""}
                  {file.observedOwner ? ` · after ${file.observedOwner}` : ""}
                  {file.message ? ` · ${file.message}` : ""}
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      )}
    </Dialog>
  );
}
