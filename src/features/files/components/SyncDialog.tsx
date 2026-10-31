import { useEffect, useMemo, useRef, useState } from "react";
import { Dialog, DialogNotice } from "../../../app/dialogs/Dialog";
import { PreflightStatus } from "../../../app/dialogs/PreflightStatus";
import { TargetList } from "../../../app/dialogs/TargetList";
import { backend } from "../../../infrastructure/backend";
import type {
  SyncPreviewPlan,
  SyncResult,
  SyncRevisionSpec,
  WorkspaceNode,
} from "../../../shared/contracts";
import { compactTargets, selectionRequest } from "../selectionCommands";
import {
  beginLocalIoProjection,
  lifecycleOf,
  settleLocalIoProjection,
  unwrapLocalIoLegacy,
  withdrawLocalIoProjection,
} from "../../actions/localIoLifecycle";

type Phase = "preview" | "review" | "confirming" | "result";

export interface SyncDialogRequest {
  nodes: WorkspaceNode[];
  revisionMode: "head" | "choose";
  fixedRevision?: number;
  scopeLabel?: string;
  source: HTMLElement | null;
}

export function SyncDialog({
  request,
  connectionKey,
  demo,
  zh,
  onDismiss,
  onRefresh,
}: {
  request: SyncDialogRequest;
  connectionKey: string;
  demo: boolean;
  zh: boolean;
  onDismiss(): void;
  onRefresh(result?: SyncResult): void | Promise<void>;
}) {
  const tr = (cn: string, en: string) => (zh ? cn : en);
  const [snapshot] = useState(() => ({
    ...request,
    nodes: compactTargets(request.nodes).map((node) => ({ ...node })),
  }));
  const [kind, setKind] = useState<SyncRevisionSpec["kind"]>(
    request.fixedRevision === undefined ? "head" : "revision",
  );
  const [value, setValue] = useState(
    request.fixedRevision === undefined ? "" : String(request.fixedRevision),
  );
  const [force, setForce] = useState(false);
  const [forceAck, setForceAck] = useState(false);
  const [phase, setPhase] = useState<Phase>("preview");
  const [plan, setPlan] = useState<SyncPreviewPlan>();
  const [result, setResult] = useState<SyncResult>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const sequence = useRef(0);
  const operation = useRef<string | undefined>(undefined);
  const mounted = useRef(true);
  const revision = useMemo(
    () =>
      snapshot.fixedRevision === undefined
        ? revisionSpec(kind, value)
        : revisionSpec("revision", String(snapshot.fixedRevision)),
    [kind, value, snapshot.fixedRevision],
  );
  const paths = useMemo(
    () => selectionRequest("getLatest", snapshot.nodes).paths,
    [snapshot.nodes],
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
    const delay = Math.min(
      2147483647,
      Math.max(0, plan.expiresAt - Date.now()),
    );
    const timer = window.setTimeout(() => {
      setPlan(undefined);
      setForceAck(false);
      setError(
        tr(
          "预览已过期，请重新从服务器获取。",
          "The preview expired; request a fresh server preview.",
        ),
      );
      setPhase("preview");
    }, delay);
    return () => window.clearTimeout(timer);
  }, [phase, plan, zh]);

  async function preview() {
    if (!revision || !paths.length || busy) return;
    const seq = ++sequence.current;
    const operationId = crypto.randomUUID();
    operation.current = operationId;
    setBusy(true);
    setError("");
    setPlan(undefined);
    setResult(undefined);
    setForceAck(false);
    try {
      const next = await backend.previewSync({
        paths,
        revision,
        force,
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

  async function confirm() {
    if (
      !plan?.ready ||
      !plan.token ||
      plan.expiresAt <= Date.now() ||
      (plan.target.force && !forceAck) ||
      busy
    )
      return;
    const seq = ++sequence.current;
    const operationId = crypto.randomUUID();
    operation.current = operationId;
    // change/date/label cannot be proven by the host recheck -> intent/progress only, no projection.
    if (revision && (revision.kind === "head" || revision.kind === "revision"))
      beginLocalIoProjection({
        operationId,
        kind: "syncRevision",
        paths,
        targetState: "controlled",
      });
    setBusy(true);
    setError("");
    setPhase("confirming");
    try {
      const raw: unknown = await backend.confirmSync({
        token: plan.token,
        target: plan.target,
        acknowledgeForce: forceAck,
        operationId,
      });
      if (!mounted.current || seq !== sequence.current) return;
      const lifecycle = lifecycleOf(raw);
      if (!lifecycle) {
        // Older/mocked payload: legacy shape only, no new lifecycle facts.
        withdrawLocalIoProjection(operationId);
        const legacy = raw as SyncResult;
        setResult(legacy);
        setPhase("result");
        void Promise.resolve(onRefresh(legacy)).catch(() => undefined);
        return;
      }
      if (
        lifecycle.state === "unknown" ||
        lifecycle.state === "rejected" ||
        lifecycle.state === "legacy"
      ) {
        settleLocalIoProjection(operationId, lifecycle, false);
        setError(lifecycle.message);
        setPhase("result");
        void Promise.resolve(onRefresh()).catch(() => undefined);
        return;
      }
      settleLocalIoProjection(operationId, lifecycle, false);
      const legacy = unwrapLocalIoLegacy<SyncResult>(raw);
      setResult(legacy);
      setPhase("result");
      void Promise.resolve(onRefresh(legacy))
        .then(() => settleLocalIoProjection(operationId, lifecycle, true))
        .catch(() => undefined);
    } catch (cause) {
      if (!mounted.current || seq !== sequence.current) return;
      withdrawLocalIoProjection(operationId);
      setError(String(cause));
      setPhase("result");
      void Promise.resolve(onRefresh()).catch(() => undefined);
    } finally {
      if (seq === sequence.current) {
        operation.current = undefined;
        setBusy(false);
      }
    }
  }

  async function cancelCurrent() {
    const id = operation.current;
    if (id) await backend.cancelOperation(id);
  }

  function resetPreview() {
    sequence.current++;
    if (operation.current) void backend.cancelOperation(operation.current);
    operation.current = undefined;
    setBusy(false);
    setPlan(undefined);
    setResult(undefined);
    setError("");
    setForceAck(false);
    setPhase("preview");
  }

  const previewState = busy
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
  const simulated = demo
    ? tr(
        "浏览器 Mock：以下预览和结果均为模拟，不访问服务器或文件。",
        "Browser Mock: preview and result are simulated; no server or files are accessed.",
      )
    : undefined;

  return (
    <Dialog
      title={tr("安全同步", "Safe sync")}
      description={tr(
        "先运行真实 p4 sync -n，核对服务器计划后才能执行。",
        "A real p4 sync -n preview must be reviewed before execution.",
      )}
      source={snapshot.source}
      zh={zh}
      onRequestClose={() => {
        if (busy) void cancelCurrent();
        else onDismiss();
      }}
      footer={
        <>
          {phase === "preview" && (
            <>
              <button onClick={onDismiss}>{tr("取消", "Cancel")}</button>
              <button
                className="primary"
                data-dialog-autofocus
                disabled={busy || !revision || !paths.length}
                onClick={() => void preview()}
              >
                {busy ? tr("正在预览…", "Previewing…") : tr("预览", "Preview")}
              </button>
            </>
          )}
          {phase === "review" && (
            <>
              <button onClick={resetPreview}>{tr("返回修改", "Back")}</button>
              <button
                className={plan?.target.force ? "danger" : "primary"}
                disabled={
                  !plan?.ready ||
                  !plan.token ||
                  plan.expiresAt <= Date.now() ||
                  (plan.target.force && !forceAck)
                }
                onClick={() => void confirm()}
              >
                {tr("确认并执行", "Confirm and sync")}
              </button>
            </>
          )}
          {phase === "confirming" && (
            <button className="danger" onClick={() => void cancelCurrent()}>
              {tr("取消同步", "Cancel sync")}
            </button>
          )}
          {phase === "result" && (
            <>
              <button onClick={onDismiss}>{tr("关闭", "Close")}</button>
              {result?.outcome !== "succeeded" && (
                <button className="primary" onClick={resetPreview}>
                  {tr("重新预览", "Preview again")}
                </button>
              )}
            </>
          )}
        </>
      }
    >
      {simulated && <DialogNotice>{simulated}</DialogNotice>}
      <div className="workflow-context">
        {snapshot.scopeLabel ? `${snapshot.scopeLabel} · ` : ""}
        {snapshot.nodes.length} {tr("个目标", "targets")}
      </div>
      {phase === "preview" && (
        <>
          <TargetList paths={paths} label={tr("同步范围", "Sync scope")} />
          <label>
            {tr("目标版本", "Target revision")}
            <select
              value={kind}
              disabled={snapshot.fixedRevision !== undefined}
              onChange={(event) => {
                setKind(event.target.value as SyncRevisionSpec["kind"]);
                setValue("");
              }}
            >
              <option value="head">{tr("最新版本", "Latest / head")}</option>
              <option value="revision">
                {tr("文件修订号", "File revision")}
              </option>
              <option value="change">
                {tr("截至 CL", "As of changelist")}
              </option>
              <option value="date">{tr("截至日期", "As of date")}</option>
              <option value="label">{tr("标签", "Label")}</option>
            </select>
          </label>
          {kind !== "head" && (
            <label>
              {tr("值", "Value")}
              <input
                type={kind === "date" ? "date" : "text"}
                inputMode={
                  kind === "revision" || kind === "change"
                    ? "numeric"
                    : undefined
                }
                value={value}
                readOnly={snapshot.fixedRevision !== undefined}
                aria-invalid={!!value && !revision}
                onChange={(event) => setValue(event.target.value)}
              />
            </label>
          )}
          <label className="workflow-checkbox">
            <input
              type="checkbox"
              checked={force}
              onChange={(event) => setForce(event.target.checked)}
            />
            {tr(
              "强制重新同步（高风险；预览后还需再次确认）",
              "Force re-sync (high risk; requires a second acknowledgement after preview)",
            )}
          </label>
          {force && (
            <DialogNotice error>
              {tr(
                "Force 会重新传输当前文件，并可能触发 writable/clobber 风险；不会默认启用。",
                "Force re-transfers current files and may expose writable/clobber risks. It is never enabled by default.",
              )}
            </DialogNotice>
          )}
          <PreflightStatus state={previewState} zh={zh} />
        </>
      )}
      {phase === "review" && plan && (
        <>
          <PreflightStatus state={previewState} zh={zh} />
          <p className="workflow-context">
            {tr("目标", "Target")}:{" "}
            <code>{revisionLabel(plan.target.revision)}</code>
          </p>
          <div
            className="sync-counts"
            aria-label={tr("变更计数", "Change counts")}
          >
            <span>
              {tr("新增", "Add")} {plan.counts.added}
            </span>
            <span>
              {tr("更新", "Update")} {plan.counts.updated}
            </span>
            <span>
              {tr("删除", "Delete")} {plan.counts.deleted}
            </span>
            <span>
              {tr("已最新", "Up to date")} {plan.counts.upToDate}
            </span>
            <span>
              {tr("警告", "Warnings")} {plan.counts.warnings}
            </span>
            <span>
              {tr("冲突", "Conflicts")} {plan.counts.conflicts}
            </span>
          </div>
          {(plan.partial || plan.truncated) && (
            <DialogNotice error={plan.partial}>
              {plan.partial
                ? tr(
                    "预览为 partial；请检查阻塞项与日志。",
                    "Preview is partial; inspect blockers and logs.",
                  )
                : tr(
                    `代表性列表已截断：显示 ${plan.entries.length}/${plan.totalEntries}。`,
                    `Representative list truncated: ${plan.entries.length}/${plan.totalEntries} shown.`,
                  )}
            </DialogNotice>
          )}
          <TargetList
            paths={plan.entries.map(
              (entry) =>
                `${entry.kind}: ${entry.depotPath ?? entry.clientPath ?? entry.message}`,
            )}
            label={tr("代表性文件", "Representative files")}
          />
          {plan.target.force && (
            <label className="workflow-checkbox">
              <input
                type="checkbox"
                checked={forceAck}
                onChange={(event) => setForceAck(event.target.checked)}
              />
              {tr(
                "我已核对真实预览，并再次确认执行 Force 同步。",
                "I reviewed the real preview and explicitly confirm forced sync again.",
              )}
            </label>
          )}
        </>
      )}
      {phase === "confirming" && (
        <section aria-live="polite" aria-busy="true">
          <DialogNotice>
            {tr(
              "正在执行已确认的同步。取消不会回滚已传输文件。",
              "Executing the confirmed sync. Cancellation does not roll back transferred files.",
            )}
          </DialogNotice>
        </section>
      )}
      {phase === "result" && (
        <section aria-live="polite">
          <DialogNotice error={!result || result.outcome !== "succeeded"}>
            {result?.message ?? error}
          </DialogNotice>
          {result && (
            <p className="workflow-context">
              {tr("结果", "Result")}: {result.outcome}
              {result.operationId ? ` · ${result.operationId}` : ""}
            </p>
          )}
        </section>
      )}
    </Dialog>
  );
}

function revisionSpec(
  kind: SyncRevisionSpec["kind"],
  input: string,
): SyncRevisionSpec | undefined {
  const value = input.trim();
  if (kind === "head") return { kind };
  if (kind === "revision" || kind === "change") {
    if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)))
      return;
    return { kind, value };
  }
  if (kind === "date") {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!match) return;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    if (
      year < 1000 ||
      month < 1 ||
      month > 12 ||
      day < 1 ||
      day > new Date(Date.UTC(year, month, 0)).getUTCDate()
    )
      return;
    return { kind, value: `${match[1]}/${match[2]}/${match[3]}` };
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value)) return;
  return { kind, value };
}

function revisionLabel(revision: SyncRevisionSpec) {
  if (revision.kind === "head") return "#head";
  return `${revision.kind === "revision" ? "#" : "@"}${revision.value}`;
}
