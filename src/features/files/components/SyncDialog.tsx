import { tFor } from "../../../shared/i18n";
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
        tFor(
          zh ? "zh-CN" : "en-US",
          "files.the.preview.expired.request.a.fresh",
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
    ? tFor(zh ? "zh-CN" : "en-US", "files.browser.mock.preview.and.result.are")
    : undefined;

  return (
    <Dialog
      title={tFor(zh ? "zh-CN" : "en-US", "files.safe.sync")}
      description={tFor(
        zh ? "zh-CN" : "en-US",
        "files.a.real.p4.sync.n.preview",
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
              <button onClick={onDismiss}>
                {tFor(zh ? "zh-CN" : "en-US", "files.cancel")}
              </button>
              <button
                className="primary"
                data-dialog-autofocus
                disabled={busy || !revision || !paths.length}
                onClick={() => void preview()}
              >
                {busy
                  ? tFor(zh ? "zh-CN" : "en-US", "files.previewing")
                  : tFor(zh ? "zh-CN" : "en-US", "files.preview")}
              </button>
            </>
          )}
          {phase === "review" && (
            <>
              <button onClick={resetPreview}>
                {tFor(zh ? "zh-CN" : "en-US", "files.back")}
              </button>
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
                {tFor(zh ? "zh-CN" : "en-US", "files.confirm.and.sync")}
              </button>
            </>
          )}
          {phase === "confirming" && (
            <button className="danger" onClick={() => void cancelCurrent()}>
              {tFor(zh ? "zh-CN" : "en-US", "files.cancel.sync")}
            </button>
          )}
          {phase === "result" && (
            <>
              <button onClick={onDismiss}>
                {tFor(zh ? "zh-CN" : "en-US", "files.close")}
              </button>
              {result?.outcome !== "succeeded" && (
                <button className="primary" onClick={resetPreview}>
                  {tFor(zh ? "zh-CN" : "en-US", "files.preview.again")}
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
        {snapshot.nodes.length} {tFor(zh ? "zh-CN" : "en-US", "files.targets")}
      </div>
      {phase === "preview" && (
        <>
          <TargetList
            paths={paths}
            label={tFor(zh ? "zh-CN" : "en-US", "files.sync.scope.2")}
          />
          <label>
            {tFor(zh ? "zh-CN" : "en-US", "files.target.revision")}
            <select
              value={kind}
              disabled={snapshot.fixedRevision !== undefined}
              onChange={(event) => {
                setKind(event.target.value as SyncRevisionSpec["kind"]);
                setValue("");
              }}
            >
              <option value="head">
                {tFor(zh ? "zh-CN" : "en-US", "files.latest.head.2")}
              </option>
              <option value="revision">
                {tFor(zh ? "zh-CN" : "en-US", "files.file.revision.2")}
              </option>
              <option value="change">
                {tFor(zh ? "zh-CN" : "en-US", "files.as.of.changelist.2")}
              </option>
              <option value="date">
                {tFor(zh ? "zh-CN" : "en-US", "files.as.of.date.2")}
              </option>
              <option value="label">
                {tFor(zh ? "zh-CN" : "en-US", "files.label")}
              </option>
            </select>
          </label>
          {kind !== "head" && (
            <label>
              {tFor(zh ? "zh-CN" : "en-US", "files.value")}
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
            {tFor(
              zh ? "zh-CN" : "en-US",
              "files.force.re.sync.high.risk.requires",
            )}
          </label>
          {force && (
            <DialogNotice error>
              {tFor(zh ? "zh-CN" : "en-US", "files.force.current.files")}
            </DialogNotice>
          )}
          <PreflightStatus state={previewState} zh={zh} />
        </>
      )}
      {phase === "review" && plan && (
        <>
          <PreflightStatus state={previewState} zh={zh} />
          <p className="workflow-context">
            {tFor(zh ? "zh-CN" : "en-US", "files.target")}:{" "}
            <code>{revisionLabel(plan.target.revision)}</code>
          </p>
          <div
            className="sync-counts"
            aria-label={tFor(zh ? "zh-CN" : "en-US", "files.change.counts")}
          >
            <span>
              {tFor(zh ? "zh-CN" : "en-US", "files.add")} {plan.counts.added}
            </span>
            <span>
              {tFor(zh ? "zh-CN" : "en-US", "files.update")}{" "}
              {plan.counts.updated}
            </span>
            <span>
              {tFor(zh ? "zh-CN" : "en-US", "files.delete")}{" "}
              {plan.counts.deleted}
            </span>
            <span>
              {tFor(zh ? "zh-CN" : "en-US", "files.up.to.date")}{" "}
              {plan.counts.upToDate}
            </span>
            <span>
              {tFor(zh ? "zh-CN" : "en-US", "files.warnings")}{" "}
              {plan.counts.warnings}
            </span>
            <span>
              {tFor(zh ? "zh-CN" : "en-US", "files.conflicts")}{" "}
              {plan.counts.conflicts}
            </span>
          </div>
          {(plan.partial || plan.truncated) && (
            <DialogNotice error={plan.partial}>
              {plan.partial
                ? tFor(zh ? "zh-CN" : "en-US", "files.preview.inspect.blockers")
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
            label={tFor(zh ? "zh-CN" : "en-US", "files.representative.files")}
          />
          {plan.target.force && (
            <label className="workflow-checkbox">
              <input
                type="checkbox"
                checked={forceAck}
                onChange={(event) => setForceAck(event.target.checked)}
              />
              {tFor(zh ? "zh-CN" : "en-US", "files.i.real.preview")}
            </label>
          )}
        </>
      )}
      {phase === "confirming" && (
        <section aria-live="polite" aria-busy="true">
          <DialogNotice>
            {tFor(
              zh ? "zh-CN" : "en-US",
              "files.executing.the.confirmed.sync.cancellation.does",
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
              {tFor(zh ? "zh-CN" : "en-US", "files.result")}: {result.outcome}
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
