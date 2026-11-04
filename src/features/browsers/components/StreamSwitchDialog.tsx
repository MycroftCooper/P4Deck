import { t } from "../../../shared/i18n";
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
        setError(t("browse.the.preflight.expired.inspect.the.current"));
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
          t("browse.connection.identity.changed.no.stream.switch"),
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
  const current = plan?.currentStream || t("browse.classic.workspace");
  const verified = verifiedStreamSwitch(result);

  return (
    <Dialog
      title={t("browse.safe.stream.switch")}
      description={t("browse.inspect.the.client.stream.permissions.and")}
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
              <button onClick={onDismiss}>{t("browse.cancel")}</button>
              <button
                className="primary"
                data-dialog-autofocus
                disabled={busy}
                onClick={() => void preflight()}
              >
                {busy ? t("browse.inspecting") : t("browse.run.preflight.2")}
              </button>
            </>
          )}
          {phase === "review" && (
            <>
              <button onClick={() => reset()}>{t("browse.back")}</button>
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
                  ? t("browse.confirm.switch.and.sync")
                  : t("browse.confirm.view.only.switch")}
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
              {t("browse.cancel.operation")}
            </button>
          )}
          {phase === "result" && (
            <>
              <button onClick={finishAndClose}>{t("browse.close")}</button>
              {result?.streamChanged && !result.syncCompleted && (
                <button className="primary" onClick={() => reset("sync")}>
                  {t("browse.preflight.recovery.sync")}
                </button>
              )}
              {(!result || result.outcome !== "succeeded") &&
                !(result?.streamChanged && !result.syncCompleted) && (
                  <button className="primary" onClick={() => reset()}>
                    {t("browse.run.preflight.again")}
                  </button>
                )}
            </>
          )}
        </>
      }
    >
      {runtime.mode === "mock" && (
        <DialogNotice>
          {t("browse.browser.mock.preflight.and.execution.are")}
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
            <legend>{t("browse.workspace.file.handling")}</legend>
            <label className="workflow-checkbox">
              <input
                type="radio"
                name="stream-switch-mode"
                checked={mode === "viewOnly"}
                onChange={() => setMode("viewOnly")}
              />
              {t("browse.update.only.the.client.stream.leave")}
            </label>
            <label className="workflow-checkbox">
              <input
                type="radio"
                name="stream-switch-mode"
                checked={mode === "sync"}
                onChange={() => setMode("sync")}
              />
              {t("browse.run.a.normal.sync.to.head")}
            </label>
          </fieldset>
          <DialogNotice error={mode === "sync"}>
            {mode === "sync"
              ? t("browse.sync.may.add.update.or.remove")
              : t("browse.view.only.switching.does.not.touch")}
          </DialogNotice>
          <PreflightStatus state={preflightState} zh={zh} />
        </>
      )}
      {phase === "review" && plan && (
        <>
          <PreflightStatus state={preflightState} zh={zh} />
          <dl className="stream-switch-summary">
            <div>
              <dt>{t("browse.current")}</dt>
              <dd>{current}</dd>
            </div>
            <div>
              <dt>{t("browse.target")}</dt>
              <dd>{plan.targetStream}</dd>
            </div>
            <div>
              <dt>{t("browse.type.parent")}</dt>
              <dd>
                {plan.targetType || "—"} · {plan.targetParent || "—"}
              </dd>
            </div>
            <div>
              <dt>{t("browse.opened.unresolved.local.changes")}</dt>
              <dd>
                {plan.risks.openedFiles} / {plan.risks.unresolvedFiles} /{" "}
                {plan.risks.reconcileFiles}
              </dd>
            </div>
            <div>
              <dt>{t("browse.target.size")}</dt>
              <dd>
                {plan.risks.targetFileCount ?? "?"} {t("browse.files")} ·{" "}
                {plan.risks.targetFileBytes == null
                  ? "?"
                  : formatBytes(plan.risks.targetFileBytes)}
              </dd>
            </div>
          </dl>
          <TargetList
            label={t("browse.risk.paths.up.to.100")}
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
              {t("browse.i.reviewed.every.warning.and.confirm")}
            </label>
          )}
        </>
      )}
      {phase === "executing" && (
        <section aria-live="polite" aria-busy="true">
          <DialogNotice>
            {mode === "sync"
              ? t("browse.revalidating.switching.the.client.stream.syncing")
              : t("browse.revalidating.switching.the.client.stream.and")}
          </DialogNotice>
        </section>
      )}
      {phase === "result" && (
        <section aria-live="polite">
          <DialogNotice error={!result || result.outcome !== "succeeded"}>
            {result?.outcome === "succeeded"
              ? t("browse.verified.by.server.readback")
              : result?.outcome === "unknown"
                ? t("browse.outcome.uncertain")
                : ""}{" "}
            {result?.message || error}
          </DialogNotice>
          {result?.outcome === "unknown" && (
            <DialogNotice error>
              {t("browse.the.switch.may.have.partially.applied")}
            </DialogNotice>
          )}
          {verified && (
            <DialogNotice>
              {t("browse.verified.server.identity")}
              {verified.stream} · {verified.client} · generation{" "}
              {verified.contextGeneration}
              {" · "}
              {t(
                "browse.refreshed.workspace.stream.views.remain.authoritative",
              )}
            </DialogNotice>
          )}
          {result && (
            <dl className="stream-switch-summary">
              <div>
                <dt>{t("browse.outcome")}</dt>
                <dd>{result.outcome}</dd>
              </div>
              <div>
                <dt>{t("browse.verified.stream")}</dt>
                <dd>{result.verifiedStream || t("browse.unknown")}</dd>
              </div>
              <div>
                <dt>{t("browse.sync")}</dt>
                <dd>
                  {result.syncCompleted
                    ? t("browse.completed")
                    : result.syncPerformed
                      ? t("browse.incomplete")
                      : t("browse.not.run")}
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
