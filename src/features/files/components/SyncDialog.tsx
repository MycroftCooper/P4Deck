import { tFor } from "../../../shared/i18n";
import type { MsgKey } from "../../../shared/i18n";
import { useEffect, useMemo, useRef, useState } from "react";
import { Dialog, DialogNotice } from "../../../app/dialogs/Dialog";
import { TargetList } from "../../../app/dialogs/TargetList";
import { backend } from "../../../infrastructure/backend";
import type {
  Locale,
  OperationEvent,
  SyncIssue,
  SyncIssueCode,
  SyncPreviewPlan,
  SyncResult,
  SyncRevisionSpec,
  WorkspaceNode,
} from "../../../shared/contracts";
import { useOperationSession } from "../../../shared/operationSession";
import { compactTargets, selectionRequest } from "../selectionCommands";
import {
  beginLocalIoProjection,
  lifecycleOf,
  settleLocalIoProjection,
  unwrapLocalIoLegacy,
  withdrawLocalIoProjection,
} from "../../actions/localIoLifecycle";

type Stage = "review" | "confirming" | "result";

/**
 * What the silent count produced for the review page. It is the same one-shot
 * host plan the confirmation consumes, so the dialog both states the impact up
 * front and avoids a second `p4 sync -n` when the user confirms.
 */
type Stats =
  | { kind: "counting" }
  | { kind: "ready"; plan: SyncPreviewPlan; key: string }
  | { kind: "failed" };

export interface SyncDialogRequest {
  nodes: WorkspaceNode[];
  /** `change` pins every path to its revision as of the given changelist. */
  revisionMode: "head" | "choose" | "change";
  fixedRevision?: number;
  fixedChange?: number;
  /** Explicit depot paths instead of deriving them from `nodes` (submitted CL). */
  paths?: string[];
  scopeLabel?: string;
  source: HTMLElement | null;
}

/**
 * Risk-confirmation dialog for Get Revision and force re-sync.
 *
 * Opening it asks the host for a plan with `skipPreflight: true`: the opened-file
 * inspection/blocker preflight is skipped, but one count-only `p4 sync -n` still
 * runs, so the dialog can state the affected-file count and the host's risk
 * warnings while the user reviews the target. That plan's one-shot token is
 * reused by the confirmation (no second count), is re-counted when the target
 * options change or the token expired, and the real `p4 sync` runs only after the
 * user confirms. There is no separate preview step.
 */
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
  const [snapshot] = useState(() => ({
    ...request,
    nodes: compactTargets(request.nodes).map((node) => ({ ...node })),
  }));
  const [kind, setKind] = useState<SyncRevisionSpec["kind"]>(
    request.revisionMode === "change"
      ? "change"
      : request.fixedRevision === undefined
        ? "head"
        : "revision",
  );
  const [value, setValue] = useState(
    request.revisionMode === "change"
      ? String(request.fixedChange ?? "")
      : request.fixedRevision === undefined
        ? ""
        : String(request.fixedRevision),
  );
  const [force, setForce] = useState(false);
  const [stage, setStage] = useState<Stage>("review");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [stats, setStats] = useState<Stats>({ kind: "counting" });
  const [result, setResult] = useState<SyncResult>();
  const [progress, setProgress] = useState<{
    lines: number;
    current?: number;
    total?: number;
    percent?: number;
  }>({ lines: 0 });
  const [clock, setClock] = useState(() => Date.now());
  const dispatchStarted = useRef<number | undefined>(undefined);
  const session = useOperationSession();
  const operation = useRef<string | undefined>(undefined);
  const revision = useMemo(() => {
    if (snapshot.revisionMode === "change")
      return snapshot.fixedChange === undefined
        ? undefined
        : {
            kind: "change" as const,
            value: String(snapshot.fixedChange),
          };
    return revisionSpec(kind, value, snapshot.fixedRevision);
  }, [
    kind,
    value,
    snapshot.fixedRevision,
    snapshot.revisionMode,
    snapshot.fixedChange,
  ]);
  const paths = useMemo(
    () => snapshot.paths ?? selectionRequest("getLatest", snapshot.nodes).paths,
    [snapshot],
  );
  // Everything the host binds to the plan (and its one-shot token). When any of
  // it changes the cached plan is worthless and the dialog counts again.
  const previewKey = useMemo(
    () => (revision ? JSON.stringify([paths, revision, force]) : ""),
    [paths, revision, force],
  );
  const counting = useRef<
    { key: string; promise: Promise<SyncPreviewPlan | undefined> } | undefined
  >(undefined);

  /**
   * Run (or join) the silent count-only preview for the current target options.
   * Resolves with the host plan, or `undefined` when it cannot be counted; the
   * review page then says so without blocking the confirmation.
   */
  async function countPreview(): Promise<SyncPreviewPlan | undefined> {
    const target = revision;
    if (!previewKey || !target) return undefined;
    const inFlight = counting.current;
    if (inFlight?.key === previewKey) return inFlight.promise;
    const lease = session.start("preflight");
    setStats({ kind: "counting" });
    const promise = (async () => {
      try {
        const plan = await backend.previewSync({
          paths: [...paths],
          revision: target,
          force,
          operationId: lease.operationId,
          skipPreflight: true,
        });
        if (!session.isCurrent(lease)) return undefined;
        session.finish(lease);
        setStats({ kind: "ready", plan, key: previewKey });
        return plan;
      } catch {
        if (!session.isCurrent(lease)) return undefined;
        session.finish(lease);
        setStats({ kind: "failed" });
        return undefined;
      }
    })();
    counting.current = { key: previewKey, promise };
    try {
      return await promise;
    } finally {
      if (counting.current?.promise === promise) counting.current = undefined;
    }
  }

  useEffect(() => {
    session.invalidate("preflight");
    session.invalidate("dispatch");
  }, [connectionKey, session]);

  // Count as soon as the review page opens (and again after the target options
  // change). It is a background read: the dialog stays usable while it runs.
  useEffect(() => {
    if (stage !== "review" || !previewKey) return;
    void countPreview();
  }, [stage, previewKey]);

  // A successful sync closes itself: the task panel keeps the receipt, so the
  // dialog should not require another click. Failures stay for the error text.
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;
  useEffect(() => {
    if (stage !== "result" || result?.outcome !== "succeeded") return;
    const timer = window.setTimeout(() => dismiss.current(), 1200);
    return () => window.clearTimeout(timer);
  }, [stage, result?.outcome]);

  // Live progress while the real sync runs. The host streams one stdout record
  // per processed file and takes the total from the count-only preview, so the
  // bar shows a real "x of y" (indeterminate only when nothing needs syncing).
  useEffect(() => {
    if (stage !== "confirming") return;
    let active = true;
    let dispose: (() => void) | undefined;
    const handler = (event: OperationEvent) => {
      if (!active || event.operationId !== operation.current) return;
      setProgress((previous) => {
        if (event.type === "stdout")
          return { ...previous, lines: previous.lines + 1 };
        if (event.type !== "progress") return previous;
        return {
          lines: previous.lines,
          current: Number.isFinite(event.progressCurrent)
            ? event.progressCurrent
            : previous.current,
          total: Number.isFinite(event.progressTotal)
            ? event.progressTotal
            : previous.total,
          percent: Number.isFinite(event.progress)
            ? event.progress
            : previous.percent,
        };
      });
    };
    void backend
      .subscribeOperationEvents(handler)
      .then((unsubscribe) => {
        if (active) dispose = unsubscribe;
        else unsubscribe();
      })
      .catch(() => undefined);
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => {
      active = false;
      dispose?.();
      window.clearInterval(timer);
    };
  }, [stage]);

  /**
   * A cached plan can be confirmed only while its one-shot token is still valid
   * and it was counted for the current target options; otherwise count again so
   * a stale plan never dead-ends the confirmation.
   */
  async function reusablePlan(): Promise<SyncPreviewPlan | undefined> {
    if (stats.kind === "ready" && stats.key === previewKey) {
      const cached = stats.plan;
      if (cached.ready && cached.token && cached.expiresAt > Date.now())
        return cached;
    }
    return countPreview();
  }

  async function execute() {
    if (!revision || !paths.length || busy) return;
    setBusy(true);
    setError("");
    try {
      const plan = await reusablePlan();
      // Nothing was counted, so no ticket exists: the click must say why instead
      // of silently doing nothing. The review page stays usable for a retry.
      if (!plan) {
        setError(tFor(locale, "files.sync.confirm.unavailable"));
        return;
      }
      if (!plan.ready || !plan.token) {
        setError(
          plan.blockers.map((item) => item.message).join(" ") ||
            tFor(zh ? "zh-CN" : "en-US", "files.sync.target.invalid"),
        );
        return;
      }
      await dispatch(plan);
    } finally {
      setBusy(false);
    }
  }

  async function dispatch(plan: SyncPreviewPlan) {
    const target = revision;
    if (!target) return;
    const lease = session.start("dispatch");
    const operationId = lease.operationId;
    operation.current = operationId;
    dispatchStarted.current = Date.now();
    setClock(Date.now());
    setProgress({ lines: 0 });
    // change/date/label cannot be proven by the host recheck -> intent/progress only, no projection.
    if (target.kind === "head" || target.kind === "revision")
      beginLocalIoProjection({
        operationId,
        kind: "syncRevision",
        paths,
        targetState: "controlled",
      });
    setStage("confirming");
    const confirm = (current: SyncPreviewPlan) =>
      backend.confirmSync({
        token: current.token!,
        target: current.target,
        acknowledgeForce: false,
        operationId,
      });
    try {
      let raw: unknown = await confirm(plan);
      if (!session.isCurrent(lease)) return;
      // The plan token is one-shot and short-lived, so a slow review is not a
      // failure: count once more and retry the same confirmation. A repeated
      // rejection falls through to the normal error/result handling.
      if (staleToken(raw)) {
        const refreshed = await countPreview();
        if (!session.isCurrent(lease)) return;
        if (refreshed?.ready && refreshed.token) {
          raw = await confirm(refreshed);
          if (!session.isCurrent(lease)) return;
        }
      }
      const lifecycle = lifecycleOf(raw);
      if (!lifecycle) {
        // Older/mocked payload: legacy shape only, no new lifecycle facts.
        withdrawLocalIoProjection(operationId);
        const legacy = raw as SyncResult;
        setResult(legacy);
        setStage("result");
        void Promise.resolve(onRefresh(legacy)).catch(() => undefined);
        return;
      }
      if (
        lifecycle.state === "unknown" ||
        lifecycle.state === "rejected" ||
        lifecycle.state === "legacy"
      ) {
        // change/date/label selectors cannot be proven per file by fstat, so the
        // host wraps a clean command as state=unknown. When the legacy command
        // result is succeeded, the sync itself completed; report it instead of
        // showing a false error for a selector that is simply unprovable.
        const legacy = unwrapLocalIoLegacy<SyncResult>(raw);
        const unprovableSelector =
          target.kind === "change" ||
          target.kind === "date" ||
          target.kind === "label";
        if (
          unprovableSelector &&
          (legacy?.outcome === "succeeded" || legacy?.outcome === "partial")
        ) {
          withdrawLocalIoProjection(operationId);
          setResult(legacy);
          setStage("result");
          void Promise.resolve(onRefresh(legacy)).catch(() => undefined);
          return;
        }
        settleLocalIoProjection(operationId, lifecycle, false);
        setError(lifecycle.message);
        setStage("result");
        void Promise.resolve(onRefresh()).catch(() => undefined);
        return;
      }
      settleLocalIoProjection(operationId, lifecycle, false);
      const legacy = unwrapLocalIoLegacy<SyncResult>(raw);
      setResult(legacy);
      setStage("result");
      void Promise.resolve(onRefresh(legacy))
        .then(() => settleLocalIoProjection(operationId, lifecycle, true))
        .catch(() => undefined);
    } catch (cause) {
      if (!session.isCurrent(lease)) return;
      withdrawLocalIoProjection(operationId);
      setError(String(cause));
      setStage("result");
      void Promise.resolve(onRefresh()).catch(() => undefined);
    } finally {
      if (session.isCurrent(lease)) setBusy(false);
      if (operation.current === operationId) operation.current = undefined;
      session.finish(lease);
    }
  }

  async function cancelCurrent() {
    const id = operation.current;
    if (id) await backend.cancelOperation(id);
  }

  function reset() {
    session.invalidate("preflight");
    session.invalidate("dispatch");
    operation.current = undefined;
    setBusy(false);
    setError("");
    setResult(undefined);
    setStats({ kind: "counting" });
    setStage("review");
  }

  const simulated = demo
    ? tFor(zh ? "zh-CN" : "en-US", "files.browser.mock.preview.and.result.are")
    : undefined;
  const locale = zh ? "zh-CN" : "en-US";
  const elapsed = Math.max(
    0,
    Math.floor((clock - (dispatchStarted.current ?? clock)) / 1000),
  );
  const total = progress.total;
  const current =
    progress.current ??
    (total !== undefined ? Math.min(progress.lines, total) : undefined);
  const percent =
    progress.percent ??
    (current !== undefined && (total ?? 0) > 0
      ? Math.min(100, (current / total!) * 100)
      : undefined);
  const countLabel =
    total !== undefined && total > 0 && current !== undefined
      ? tFor(locale, "files.sync.progress.copying", {
          p1: current,
          p2: total,
        })
      : tFor(locale, "files.sync.progress.starting");
  // A count for older target options is not shown at all: after a revision or
  // force change the review page says "counting" until the new plan arrives,
  // instead of briefly presenting the previous target's numbers as this one's.
  const staleCount = stats.kind === "ready" && stats.key !== previewKey;
  const awaitingCount = stats.kind === "counting" || staleCount;
  // Only a plan the user could actually confirm is worth summarising: a blocked
  // or uncountable target states the unknown impact instead of "0 files".
  const previewed =
    stats.kind === "ready" &&
    !staleCount &&
    stats.plan.ready &&
    stats.plan.token
      ? stats.plan
      : undefined;
  // A count-only preview that failed on the host still hands back a plan: zero
  // counts plus a `previewFailed` advisory. The impact is unknown, so the review
  // page must not claim "0 files"; that plan's token still confirms.
  const failedWarning = previewed?.warnings.find(
    (issue) => issue.code === "previewFailed",
  );
  const countFailed =
    !awaitingCount &&
    (stats.kind === "failed" ||
      (stats.kind === "ready" &&
        (previewed === undefined || failedWarning !== undefined)));
  // "The sync still runs after you confirm" only holds for the host plan that
  // carries a ticket; a transport failure has none, so it says so.
  const countFailureText = failedWarning
    ? warningText(locale, failedWarning)
    : tFor(locale, "files.sync.stats.failed");
  const impactWarnings = previewed
    ? previewed.warnings.filter((issue) => issue !== failedWarning)
    : [];
  const affected = previewed
    ? previewed.counts.added +
      previewed.counts.updated +
      previewed.counts.deleted
    : 0;
  const countItems = previewed
    ? (
        [
          ["files.sync.stats.updated", previewed.counts.updated],
          ["files.sync.stats.added", previewed.counts.added],
          ["files.sync.stats.deleted", previewed.counts.deleted],
        ] as const
      ).filter(([, count]) => count > 0)
    : [];

  return (
    <Dialog
      title={tFor(
        zh ? "zh-CN" : "en-US",
        stage === "confirming"
          ? "files.sync.progress.title"
          : "files.safe.sync",
      )}
      source={snapshot.source}
      zh={zh}
      hideClose={stage === "confirming"}
      onRequestClose={() => {
        if (busy) void cancelCurrent();
        else onDismiss();
      }}
      footer={
        <>
          {stage === "review" && (
            <>
              <button onClick={onDismiss}>
                {tFor(zh ? "zh-CN" : "en-US", "files.cancel")}
              </button>
              <button
                className={force ? "danger" : "primary"}
                data-dialog-autofocus
                disabled={busy || !revision || !paths.length}
                onClick={() => void execute()}
              >
                {tFor(zh ? "zh-CN" : "en-US", "files.confirm.and.sync")}
              </button>
            </>
          )}
          {stage === "confirming" && (
            <button className="danger" onClick={() => void cancelCurrent()}>
              {tFor(zh ? "zh-CN" : "en-US", "files.sync.progress.stop")}
            </button>
          )}
          {stage === "result" && (
            <>
              <button onClick={onDismiss}>
                {tFor(zh ? "zh-CN" : "en-US", "files.close")}
              </button>
              {result?.outcome !== "succeeded" && (
                <button className="primary" onClick={reset}>
                  {tFor(zh ? "zh-CN" : "en-US", "files.retry")}
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
        {paths.length} {tFor(zh ? "zh-CN" : "en-US", "files.targets")}
      </div>
      {stage === "review" && (
        <>
          <TargetList
            paths={paths}
            label={tFor(zh ? "zh-CN" : "en-US", "files.sync.scope.2")}
          />
          <label>
            {tFor(zh ? "zh-CN" : "en-US", "files.target.revision")}
            <select
              value={kind}
              disabled={
                snapshot.fixedRevision !== undefined ||
                snapshot.revisionMode === "change"
              }
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
                readOnly={
                  snapshot.fixedRevision !== undefined ||
                  snapshot.revisionMode === "change"
                }
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
          {/* No valid revision means nothing can be counted; the input itself
              already explains why the confirmation is unavailable. */}
          {revision && (
            <section
              className="sync-stats"
              aria-live="polite"
              aria-busy={awaitingCount}
            >
              {awaitingCount && (
                <p className="sync-stats-line">
                  {tFor(locale, "files.sync.stats.counting")}
                </p>
              )}
              {countFailed && <DialogNotice>{countFailureText}</DialogNotice>}
              {previewed && !countFailed && (
                <>
                  <p className="sync-stats-line">
                    {affected > 0
                      ? tFor(locale, "files.sync.stats.total", {
                          count: affected,
                        })
                      : tFor(locale, "files.sync.stats.nothing")}
                  </p>
                  {affected > 0 && (
                    <div className="sync-counts">
                      {countItems.map(([key, count]) => (
                        <span key={key}>{tFor(locale, key, { count })}</span>
                      ))}
                    </div>
                  )}
                </>
              )}
            </section>
          )}
          {impactWarnings.map((issue, index) => (
            <DialogNotice key={`${issue.code}-${index}`}>
              {warningText(locale, issue)}
            </DialogNotice>
          ))}
          {snapshot.revisionMode === "change" && (
            <DialogNotice>
              {tFor(zh ? "zh-CN" : "en-US", "files.sync.change.risk", {
                p1: String(snapshot.fixedChange ?? ""),
              })}
            </DialogNotice>
          )}
          {revision &&
            revision.kind !== "head" &&
            snapshot.revisionMode !== "change" && (
              <DialogNotice>
                {tFor(zh ? "zh-CN" : "en-US", "files.revision.pinning.risk", {
                  p1: revisionLabel(revision),
                })}
              </DialogNotice>
            )}
          {error && <DialogNotice error>{error}</DialogNotice>}
        </>
      )}
      {stage === "confirming" && (
        <section className="sync-progress" aria-live="polite" aria-busy="true">
          <p className="sync-progress-count">{countLabel}</p>
          <div className="sync-progress-bar">
            <progress
              aria-label={tFor(locale, "shell.p4.operation.progress")}
              max={100}
              value={percent}
            />
            <strong className="sync-progress-percent">
              {percent !== undefined ? `${Math.round(percent)}%` : ""}
            </strong>
          </div>
          <p className="sync-progress-meta">
            {tFor(locale, "shell.sync.files.processed", {
              count: progress.lines,
            })}
            {" · "}
            {tFor(locale, "shell.task.elapsed.seconds", { seconds: elapsed })}
          </p>
        </section>
      )}
      {stage === "result" && (
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
  fixedRevision?: number,
): SyncRevisionSpec | undefined {
  if (fixedRevision !== undefined)
    return { kind: "revision", value: String(fixedRevision) };
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

/**
 * Advisory sync risk codes the host can return with a plan. Each one is
 * translated here so a Chinese dialog never renders the host's English message;
 * only a code this build does not know falls back to that message.
 */
const SYNC_WARNING_KEYS = {
  invalidTarget: "files.sync.warning.invalidTarget",
  notInClient: "files.sync.warning.notInClient",
  writableClobber: "files.sync.warning.writableClobber",
  openedFile: "files.sync.warning.openedFile",
  unresolvedFile: "files.sync.warning.unresolvedFile",
  permissionDenied: "files.sync.warning.permissionDenied",
  diskSpace: "files.sync.warning.diskSpace",
  offline: "files.sync.warning.offline",
  serverUnreachable: "files.sync.warning.serverUnreachable",
  authExpired: "files.sync.warning.authExpired",
  forceOverwrite: "files.sync.warning.forceOverwrite",
  previewFailed: "files.sync.warning.previewFailed",
  inspectionUnknown: "files.sync.warning.inspectionUnknown",
} as const satisfies Record<SyncIssueCode, MsgKey>;

function warningText(locale: Locale, issue: SyncIssue): string {
  const key = (SYNC_WARNING_KEYS as Record<string, MsgKey | undefined>)[
    issue.code
  ];
  return key ? tFor(locale, key) : issue.message;
}

/** Failures that only mean the host plan went stale, never that work was done. */
const STALE_TOKEN_FAILURES: ReadonlySet<string> = new Set([
  "tokenExpired",
  "previewChanged",
  "contextChanged",
]);

function staleToken(value: unknown) {
  const result = unwrapLocalIoLegacy<SyncResult>(value);
  return (
    result?.failure !== undefined && STALE_TOKEN_FAILURES.has(result.failure)
  );
}
