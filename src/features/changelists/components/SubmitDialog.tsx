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
  const generation = useRef(0);
  const running = useRef(false);
  const operationId = useRef<string | undefined>(undefined);
  const staleConnection = origin.connectionKey !== props.connectionKey;
  const latestConnection = useRef(props.connectionKey);
  latestConnection.current = props.connectionKey;
  const loadSummary = useRef(props.loadSummary);
  useEffect(() => {
    if (origin.connectionKey !== props.connectionKey) {
      generation.current++;
      running.current = false;
      setPhase("stale");
      setAcknowledged(false);
    }
  }, [origin.connectionKey, props.connectionKey]);
  useEffect(() => {
    const epoch = ++generation.current;
    void loadSummary
      .current()
      .then((change) => {
        if (epoch !== generation.current) return;
        if (change?.id !== origin.id)
          throw new Error(
            t("pending.changelist.summary.unavailable.refresh.and.retry"),
          );
        setSummary(change);
        setPhase("unchecked");
      })
      .catch((error) => {
        if (epoch === generation.current) {
          setMessage(String(error));
          setPhase("failed");
        }
      });
    return () => {
      generation.current++;
    };
  }, [origin]);
  useEffect(() => {
    if (!check || phase !== "ready") return;
    const timer = setTimeout(
      () => {
        setPhase("stale");
        setAcknowledged(false);
      },
      Math.min(2147483647, Math.max(0, check.expiresAt - Date.now())),
    );
    return () => clearTimeout(timer);
  }, [check, phase]);
  async function inspect() {
    if (
      !props.check ||
      running.current ||
      staleConnection ||
      phase === "summary"
    )
      return;
    running.current = true;
    const epoch = generation.current;
    setPhase("checking");
    setMessage("");
    setCheck(undefined);
    setSubmitResult(undefined);
    setLifecycle(undefined);
    operationId.current = undefined;
    setAcknowledged(false);
    try {
      const result = await props.check(origin.id);
      if (
        epoch !== generation.current ||
        latestConnection.current !== origin.connectionKey
      )
        return;
      if (
        (result.change !== undefined && result.change.id !== origin.id) ||
        result.target.changeId !== origin.id ||
        result.target.client !== origin.client ||
        (result.ready && (!result.change || !result.token)) ||
        !Number.isFinite(result.expiresAt)
      )
        throw new Error(t("pending.preflight.result.does.not.match.the"));
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
      setPhase(
        !result.ready ||
          result.blockers.length ||
          !checkedChange ||
          !checkedChange.files.length ||
          !checkedChange.description.trim()
          ? "blocked"
          : result.expiresAt <= Date.now()
            ? "stale"
            : "ready",
      );
    } catch (error) {
      if (epoch === generation.current) {
        setMessage(String(error));
        setPhase("failed");
      }
    } finally {
      running.current = false;
    }
  }
  async function confirm() {
    if (
      !props.submit ||
      !check ||
      phase !== "ready" ||
      running.current ||
      !acknowledged ||
      staleConnection
    )
      return;
    if (check.expiresAt <= Date.now()) {
      setPhase("stale");
      return;
    }
    const epoch = generation.current;
    running.current = true;
    setPhase("submitting");
    setMessage("");
    setSubmitResult(undefined);
    setLifecycle(undefined);
    // One UUID for this dispatch; a receipt lookup must reuse it and a new
    // user-initiated submit gets a new one only after an explicit new preflight.
    const id = crypto.randomUUID();
    operationId.current = id;
    try {
      const dispatching = await (
        props.connection ?? (() => backend.companySubmitConnectionSnapshot())
      )();
      if (
        epoch !== generation.current ||
        latestConnection.current !== origin.connectionKey
      )
        return;
      if (!submitConnectionMatchesTarget(check.target, dispatching))
        throw new Error(
          t("pending.connection.identity.changed.nothing.was.submitted"),
        );
      const result = await props.submit(
        { token: check.token!, target: check.target, operationId: id },
        dispatching,
      );
      if (
        epoch !== generation.current ||
        latestConnection.current !== origin.connectionKey
      )
        return;
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
    } catch (error) {
      if (epoch === generation.current) {
        setMessage(String(error));
        setPhase("failed");
        setCheck(undefined);
        setAcknowledged(false);
      }
    } finally {
      running.current = false;
    }
  }
  /** Cancellation uses the existing IPC with the SAME operationId (never a new id). */
  async function cancel() {
    const id = operationId.current;
    if (!id || !running.current) return;
    await backend.cancelOperation(id).catch(() => undefined);
  }
  const busy = phase === "checking" || phase === "submitting";
  return (
    <Dialog
      title={tFor(zh ? "zh-CN" : "en-US", "pending.submit.entire.cl", {
        p1: origin.id,
      })}
      description={t("pending.submission.always.covers.every.file.in")}
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
              !acknowledged
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
        <DialogNotice>
          {t("pending.ui.preview.preflight.execution.is.not")}
        </DialogNotice>
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
