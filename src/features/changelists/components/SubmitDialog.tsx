import { t, tFor } from "../../../shared/i18n";
import { useEffect, useRef, useState } from "react";
import { Dialog, DialogNotice } from "../../../app/dialogs/Dialog";
import { TargetList } from "../../../app/dialogs/TargetList";
import { backend } from "../../../infrastructure/backend";
import type { ConnectionSnapshot } from "../../companySubmit/model";
import type {
  PendingChange,
  SubmitConfirmation,
  SubmitPreflight,
  SubmitResult,
} from "../../../shared/contracts";
import {
  submitConnectionMatchesTarget,
  submitLifecycle,
  type SubmitLifecycle,
} from "../submitLifecycle";
import { requestDesktopAttention } from "../../../app/notifications/notifications";
import {
  useConfirmationGuard,
  useTokenExpiry,
} from "../../../shared/confirmation";
import {
  useOperationSession,
  type OperationLease,
} from "../../../shared/operationSession";

export type SubmitCheck = SubmitPreflight;
interface Props {
  changeId: number;
  count: number;
  client: string;
  connectionKey: string;
  zh: boolean;
  source?: HTMLElement | null;
  onDismiss(): void;
  loadSummary(): Promise<PendingChange | undefined>;
  check?(id: number): Promise<SubmitCheck>;
  /**
   * Adapter must atomically revalidate token, connection and whole-CL scope,
   * and own the single bounded refresh/unknown-receipt recovery.
   */
  submit?(
    confirmation: SubmitConfirmation,
    connection: ConnectionSnapshot,
  ): Promise<SubmitResult>;
  /** Exact dispatching connection snapshot; captured once per confirm. */
  connection?(): Promise<ConnectionSnapshot>;
}
type Phase =
  | "summary"
  | "unchecked"
  | "checking"
  | "blocked"
  | "ready"
  | "stale"
  | "failed"
  | "submitting"
  | "unknown"
  | "submitted";

export function SubmitDialog(props: Props) {
  const { zh, onDismiss } = props;
  const [origin] = useState(() => ({
    id: props.changeId,
    count: props.count,
    client: props.client,
    connectionKey: props.connectionKey,
  }));
  const [phase, setPhase] = useState<Phase>("summary");
  const [summary, setSummary] = useState<PendingChange>();
  const [check, setCheck] = useState<SubmitCheck>();
  const [submitResult, setSubmitResult] = useState<SubmitResult>();
  const [lifecycle, setLifecycle] = useState<SubmitLifecycle>();
  const [message, setMessage] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const session = useOperationSession();
  // The dispatch claim is tracked without re-rendering the review surface:
  // `phase` already drives the visible busy state, and an extra render here
  // would reset in-progress focus/selection on every attempt.
  const running = useRef(false);
  /** The confirmed submission; Cancel reuses its exact operationId. */
  const dispatchLease = useRef<OperationLease | undefined>(undefined);
  const staleConnection = origin.connectionKey !== props.connectionKey;
  // One-use token, expiry, target drift and the in-flight claim live in the
  // shared confirmation guard; this dialog only owns its own review surface.
  const guard = useConfirmationGuard(origin.connectionKey, props.connectionKey);
  const loadSummary = useRef(props.loadSummary);
  useEffect(() => {
    if (origin.connectionKey !== props.connectionKey) {
      // A changed connection retires both lanes locally; a confirmed
      // submission is never cancelled on the host.
      session.invalidate("preflight");
      session.invalidate("dispatch");
      running.current = false;
      guard.settle();
      setPhase("stale");
      setAcknowledged(false);
    }
  }, [origin.connectionKey, props.connectionKey, session]);
  useEffect(() => {
    // The summary read shares the preflight lane, so a connection change
    // retires it; a read never asks the host to cancel an operation.
    const lease = session.start("preflight", { cancelBackend: false });
    void loadSummary
      .current()
      .then((change) => {
        if (!session.isCurrent(lease)) return;
        if (change?.id !== origin.id)
          throw new Error(
            t("pending.changelist.summary.unavailable.refresh.and.retry"),
          );
        setSummary(change);
        setPhase("unchecked");
      })
      .catch((error) => {
        if (session.isCurrent(lease)) {
          setMessage(String(error));
          setPhase("failed");
        }
      })
      .finally(() => session.finish(lease));
    return () => {
      session.abandon(lease);
    };
  }, [origin, session]);
  useTokenExpiry(phase === "ready" ? check?.expiresAt : undefined, () => {
    // Expiry is an outcome of the shared guard: settle with the expired
    // reason so the reviewed token is dropped, never merely hidden.
    guard.settle({ blocks: ["expired"] });
    setCheck(undefined);
    setPhase("stale");
    setAcknowledged(false);
  });
  async function inspect() {
    if (
      !props.check ||
      running.current ||
      staleConnection ||
      phase === "summary"
    )
      return;
    running.current = true;
    const lease = session.start("preflight");
    setPhase("checking");
    setMessage("");
    setCheck(undefined);
    setSubmitResult(undefined);
    setLifecycle(undefined);
    setAcknowledged(false);
    try {
      const result = await props.check(origin.id);
      if (!session.isCurrent(lease)) return;
      if (
        (result.change !== undefined && result.change.id !== origin.id) ||
        result.target.changeId !== origin.id ||
        result.target.client !== origin.client ||
        (result.ready && (!result.change || !result.token)) ||
        !Number.isFinite(result.expiresAt)
      )
        throw new Error(t("pending.preflight.not.match"));
      setCheck(result);
      setSummary(result.change);
      requestDesktopAttention({
        key: `submit-preflight:${origin.id}:${result.fileSummary.contentDigest}`,
        title: t("pending.submit.awaits.confirmation"),
        body: result.blockers.length
          ? tFor(zh ? "zh-CN" : "en-US", "pending.cl.has.blocker.s", {
              p1: origin.id,
              p2: result.blockers.length,
            })
          : tFor(zh ? "zh-CN" : "en-US", "pending.review.and.confirm.cl", {
              p1: origin.id,
            }),
        kind: "attention",
      });
      const checkedChange = result.change;
      const nextPhase =
        !result.ready ||
        result.blockers.length ||
        !checkedChange ||
        !checkedChange.files.length ||
        !checkedChange.description.trim()
          ? "blocked"
          : result.expiresAt <= Date.now()
            ? "stale"
            : "ready";
      // The reviewed token is held by the shared guard only while it can be
      // spent; an already-expired or blocked plan is never handed to confirm.
      guard.hold(
        nextPhase === "ready"
          ? {
              ready: result.ready,
              token: result.token,
              expiresAt: result.expiresAt,
            }
          : undefined,
      );
      setPhase(nextPhase);
    } catch (error) {
      guard.hold(undefined);
      if (session.isCurrent(lease)) {
        setMessage(String(error));
        setPhase("failed");
      }
    } finally {
      session.finish(lease);
      running.current = false;
    }
  }
  async function confirm() {
    if (
      !props.submit ||
      !check ||
      phase !== "ready" ||
      running.current ||
      staleConnection
    )
      return;
    // One gate for double-click, live token, expiry, acknowledgement and
    // connection drift; nothing below may dispatch without it.
    if (!guard.begin({ missingAcknowledgement: !acknowledged })) {
      if (!guard.checked({ missingAcknowledgement: !acknowledged }))
        setPhase("stale");
      return;
    }
    running.current = true;
    setPhase("submitting");
    setMessage("");
    setSubmitResult(undefined);
    setLifecycle(undefined);
    // One UUID for this dispatch; a receipt lookup must reuse it and a new
    // user-initiated submit gets a new one only after an explicit new preflight.
    const id = crypto.randomUUID();
    // A confirmed submission outlives the dialog, so the host is never asked to
    // cancel it; the local lease only stops late writes from this attempt.
    const lease = session.start("dispatch", {
      operationId: id,
      cancelBackend: false,
    });
    dispatchLease.current = lease;
    try {
      const dispatching = await (
        props.connection ?? (() => backend.companySubmitConnectionSnapshot())
      )();
      if (!session.isCurrent(lease)) return;
      if (!submitConnectionMatchesTarget(check.target, dispatching))
        throw new Error(
          t("pending.connection.identity.changed.nothing.was.submitted"),
        );
      const result = await props.submit(
        { token: check.token!, target: check.target, operationId: id },
        dispatching,
      );
      if (!session.isCurrent(lease)) return;
      const life = submitLifecycle(result, id);
      setSubmitResult(result);
      setLifecycle(life);
      setMessage(result.message);
      setPhase(
        life.state === "submitted"
          ? "submitted"
          : life.state === "unknown"
            ? "unknown"
            : "failed",
      );
      if (life.state !== "submitted") {
        requestDesktopAttention({
          key: `submit-result:${origin.id}:${life.operationId ?? life.state}`,
          title: t("pending.submit.needs.attention"),
          body: result.message,
          kind: "failure",
        });
        setCheck(undefined);
        setAcknowledged(false);
      }
      // The token was spent by this dispatch; only the host result is
      // authoritative from here on.
      guard.hold(undefined);
    } catch (error) {
      guard.hold(undefined);
      if (session.isCurrent(lease)) {
        setMessage(String(error));
        setPhase("failed");
        setCheck(undefined);
        setAcknowledged(false);
      }
    } finally {
      session.finish(lease);
      running.current = false;
      guard.settle();
    }
  }
  /** Cancellation uses the existing IPC with the SAME operationId (never a new id). */
  async function cancel() {
    const lease = dispatchLease.current;
    if (!lease || !running.current) return;
    await backend.cancelOperation(lease.operationId).catch(() => undefined);
  }
  const busy = phase === "checking" || phase === "submitting";
  return (
    <Dialog
      title={tFor(zh ? "zh-CN" : "en-US", "pending.submit.entire.cl", {
        p1: origin.id,
      })}
      description={t("pending.submission.every.file")}
      zh={zh}
      source={props.source}
      busy={busy}
      onRequestClose={onDismiss}
      footer={
        <>
          <button disabled={busy} onClick={onDismiss}>
            {t("pending.close")}
          </button>
          {phase === "submitting" && (
            <button onClick={() => void cancel()}>
              {t("pending.cancel.operation")}
            </button>
          )}
          <button
            disabled={
              !props.check ||
              busy ||
              staleConnection ||
              origin.id <= 0 ||
              phase === "summary" ||
              phase === "submitted"
            }
            onClick={() => void inspect()}
          >
            {t("pending.run.preflight.2")}
          </button>
          <button
            className="primary"
            disabled={
              !props.submit ||
              phase !== "ready" ||
              staleConnection ||
              !acknowledged ||
              !guard.checked({ missingAcknowledgement: !acknowledged })
            }
            onClick={() => void confirm()}
          >
            {t("pending.confirm.entire.cl.submission")}
          </button>
        </>
      }
    >
      <div className="workflow-context">
        {origin.client} · CL {origin.id} ·{" "}
        {summary?.files.length ?? origin.count} {t("pending.files.entire.cl")}
      </div>
      {(!props.check || !props.submit) && (
        <DialogNotice>{t("pending.ui.preflight.execution")}</DialogNotice>
      )}
      {staleConnection && (
        <DialogNotice error>
          {t("pending.connection.changed.close.and.reopen.previous")}
        </DialogNotice>
      )}
      {phase === "summary" && (
        <DialogNotice>{t("pending.loading.file.summary")}</DialogNotice>
      )}
      {summary && (
        <>
          <p className="workflow-summary-description">
            {summary.description || t("pending.no.description.2")}
          </p>
          <TargetList
            paths={summary.files.map((file) => file.depotPath)}
            label={t("pending.entire.cl.file.list")}
          />
          {!summary.files.length && (
            <DialogNotice error>
              {t("pending.an.empty.cl.cannot.be")}
            </DialogNotice>
          )}
        </>
      )}
      {phase === "unchecked" && (
        <DialogNotice>{t("pending.not.checked")}</DialogNotice>
      )}
      {phase === "checking" && (
        <DialogNotice>{t("pending.preflight.in.progress")}</DialogNotice>
      )}
      {phase === "submitting" && (
        <DialogNotice>
          {t("pending.submitting.closing.this.view.cannot.undo")}
        </DialogNotice>
      )}
      {phase === "blocked" && (
        <DialogNotice error>
          {t("pending.preflight.blocked.submission")}
        </DialogNotice>
      )}
      {phase === "stale" && (
        <DialogNotice error>
          {t("pending.preflight.expired.check.again")}
        </DialogNotice>
      )}
      {check?.blockers.map((item, index) => (
        <DialogNotice key={`b${item.code}-${index}`} error>
          {item.certainty === "unknown"
            ? t("pending.unknown.blocker")
            : t("pending.blocker")}
          {item.message}
        </DialogNotice>
      ))}
      {check?.warnings.map((item, index) => (
        <DialogNotice key={`w${item.code}-${index}`}>
          {item.certainty === "unknown"
            ? t("pending.unknown.5")
            : t("pending.warning")}
          {item.message}
        </DialogNotice>
      ))}
      {message && (
        <DialogNotice error={phase === "failed" || phase === "unknown"}>
          {message}
        </DialogNotice>
      )}
      {lifecycle?.state === "submitted" && (
        <DialogNotice>
          {t("pending.authoritative.submit.result")}
          CL {lifecycle.submittedChangeId}
          {lifecycle.submittedChangeId !== submitResult?.changeId
            ? ""
            : ` ${t("pending.same.change.id")}`}
          {!lifecycle.envelope
            ? t("pending.legacy.result.no.command.envelope")
            : ""}
        </DialogNotice>
      )}
      {phase === "unknown" && (
        <DialogNotice error>
          {t("pending.outcome.uncertain.the.submit.may.have")}
        </DialogNotice>
      )}
      {submitResult &&
        lifecycle?.state !== "submitted" &&
        lifecycle?.state !== "unknown" && (
          <DialogNotice error>
            {t("pending.outcome")}
            {submitResult.outcome}
            {submitResult.failure ? ` · ${submitResult.failure}` : ""}.{" "}
            {submitResult.refresh.reason}
          </DialogNotice>
        )}
      {(lifecycle?.operationId ?? submitResult?.operationId) && (
        <p className="workflow-context">
          {t("pending.operation.2")}{" "}
          {lifecycle?.operationId ?? submitResult?.operationId}
          {submitResult?.logReference
            ? ` · ${t("pending.log")} ${submitResult.logReference}`
            : ""}
        </p>
      )}
      {phase === "ready" && !staleConnection && (
        <label className="workflow-checkbox">
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={(event) => setAcknowledged(event.target.checked)}
          />
          {t("pending.confirm.the.entire.cl.and.acknowledge")}
        </label>
      )}
    </Dialog>
  );
}
