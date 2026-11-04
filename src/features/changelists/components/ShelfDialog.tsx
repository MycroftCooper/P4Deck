import { t } from "../../../shared/i18n";
import { invalidateShelfObservations } from "../../actions/shelfObservation";
import { useContext, useEffect, useRef, useState } from "react";
import { MenuEnvironment } from "../../../app/context-menu/environment";
import { DeleteShelfDialog } from "./DeleteShelfDialog";
import { shelfIdentity } from "../deleteShelfTask";
import { startShelveDirect } from "../shelveDirectTask";
import { backend } from "../../../infrastructure/backend";
import type {
  ShelfPreflight,
  ShelfPreflightRequest,
  WorkflowConfirmation,
  WorkflowResult,
} from "../../../shared/contracts";
import { Dialog, DialogNotice } from "../../../app/dialogs/Dialog";
import {
  PreflightStatus,
  type PreflightState,
} from "../../../app/dialogs/PreflightStatus";
import { TargetList } from "../../../app/dialogs/TargetList";
import type { ConnectionSnapshot } from "../../companySubmit/model";
import {
  lookupWorkflowAction,
  type WorkflowActionLookup,
} from "../../actions/workflowReceipt";
import {
  boundedRefresh,
  runShelfUnshelve,
  workflowConnectionMatchesTarget,
  type ShelfUnshelveLifecycle,
} from "../shelfUnshelveLifecycle";

export interface ShelfRequest {
  changeId: number;
  paths: string[];
  mode: "shelve" | "delete";
  hasShelf: boolean;
  source: HTMLElement | null;
}

type Phase =
  | "idle"
  | "checking"
  | "ready"
  | "blocked"
  | "stale"
  | "running"
  | "completed"
  | "unknown"
  | "failed";

export function ShelfDialog(props: Parameters<typeof ShelfWorkflowDialog>[0]) {
  if (props.request.mode === "delete")
    return (
      <DeleteShelfDialog
        request={props.request}
        connectionKey={props.connectionKey}
        zh={props.zh}
        onDismiss={props.onDismiss}
      />
    );
  // Nested/audited shelf flows (cross-CL group choice or an injected preflight
  // port) keep the explicit review dialog with "back to CL groups"; the plain
  // one-click entry from the Pending page keeps the direct shelf command.
  if (props.onBack || props.check) return <ShelfWorkflowDialog {...props} />;
  return <DirectShelve {...props} />;
}
/** Direct shelve: no dialog, no FE preflight; the host command owns its internal preflight. */
function DirectShelve({
  request,
  connectionKey,
  onDismiss,
}: Parameters<typeof ShelfWorkflowDialog>[0]) {
  const env = useContext(MenuEnvironment);
  const once = useRef(false);
  useEffect(() => {
    if (once.current) return;
    once.current = true;
    try {
      const context = env?.getOperationContext?.();
      if (!context || !env?.reportOperationError) return;
      startShelveDirect(
        {
          connectionKey,
          changeId: request.changeId,
          paths: [...new Set(request.paths)].sort(),
          ...shelfIdentity(context.runtime),
        },
        {
          current: () => env.getOperationContext!(),
          connection: backend.companySubmitConnectionSnapshot,
          lookup: lookupWorkflowAction,
          report: env.reportOperationError,
          execute: (directRequest) => backend.shelveFiles(directRequest),
        },
      );
    } finally {
      onDismiss();
    }
  }, [connectionKey, env, onDismiss, request.changeId, request.paths]);
  return null;
}
function ShelfWorkflowDialog({
  request,
  connectionKey,
  demo = false,
  zh,
  onDismiss,
  onBack,
  check = (value) => backend.preflightShelf(value),
  execute = (value) => backend.confirmShelf(value),
  connection = () => backend.companySubmitConnectionSnapshot(),
  lookup = lookupWorkflowAction,
}: {
  request: ShelfRequest;
  connectionKey: string;
  demo?: boolean;
  zh: boolean;
  onDismiss(): void;
  onBack?(): void;
  check?(request: ShelfPreflightRequest): Promise<ShelfPreflight>;
  execute?(confirmation: WorkflowConfirmation): Promise<WorkflowResult>;
  /** Exact dispatching connection snapshot; captured once per confirm. */
  connection?(): Promise<ConnectionSnapshot>;
  /** Durable receipt recovery by the SAME operationId. */
  lookup?(request: {
    operationId: string;
    connection: ConnectionSnapshot;
  }): Promise<WorkflowActionLookup>;
}) {
  const [snapshot] = useState(() => ({
    ...request,
    paths: [...new Set(request.paths)].sort(),
    connectionKey,
  }));
  const [replace, setReplace] = useState(false);
  const [ack, setAck] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [preflight, setPreflight] = useState<ShelfPreflight>();
  const [result, setResult] = useState<WorkflowResult>();
  const [lifecycle, setLifecycle] = useState<ShelfUnshelveLifecycle>();
  const [refreshFailed, setRefreshFailed] = useState(false);
  const [message, setMessage] = useState("");
  const generation = useRef(0);
  const running = useRef(false);
  const operationId = useRef<string | undefined>(undefined);
  const staleConnection = snapshot.connectionKey !== connectionKey;
  const sourceChanged =
    request.changeId !== snapshot.changeId ||
    request.mode !== snapshot.mode ||
    JSON.stringify([...new Set(request.paths)].sort()) !==
      JSON.stringify(snapshot.paths);
  const invalidated = staleConnection || sourceChanged;
  const deleting = snapshot.mode === "delete";
  const risky = deleting || replace;
  const busy = phase === "checking" || phase === "running";

  useEffect(() => {
    if (!invalidated) return;
    generation.current++;
    running.current = false;
    setPreflight(undefined);
    setAck(false);
    setPhase("stale");
  }, [invalidated]);
  useEffect(() => {
    if (!preflight || phase !== "ready") return;
    const timer = setTimeout(
      () => {
        setPhase("stale");
        setAck(false);
      },
      Math.min(2147483647, Math.max(0, preflight.expiresAt - Date.now())),
    );
    return () => clearTimeout(timer);
  }, [phase, preflight]);
  useEffect(() => () => void ++generation.current, []);

  const resetCheck = () => {
    generation.current++;
    running.current = false;
    setPreflight(undefined);
    setResult(undefined);
    setLifecycle(undefined);
    setRefreshFailed(false);
    operationId.current = undefined;
    setMessage("");
    setPhase("idle");
  };

  async function inspect() {
    if (
      running.current ||
      invalidated ||
      snapshot.changeId <= 0 ||
      !snapshot.paths.length
    )
      return;
    const epoch = ++generation.current;
    running.current = true;
    setPhase("checking");
    setMessage("");
    setResult(undefined);
    setLifecycle(undefined);
    setRefreshFailed(false);
    try {
      const value = await check({
        changeId: snapshot.changeId,
        depotPaths: snapshot.paths,
        mode: deleting ? "delete" : "createOrUpdate",
        replace: deleting ? undefined : replace,
      });
      if (epoch !== generation.current || invalidated) return;
      const samePaths =
        JSON.stringify([...value.target.depotPaths].sort()) ===
        JSON.stringify(snapshot.paths);
      if (
        value.target.kind !== "shelf" ||
        value.target.sourceChangeId !== snapshot.changeId ||
        !samePaths ||
        (value.ready && !value.token) ||
        !Number.isFinite(value.expiresAt)
      )
        throw new Error(t("pending.preflight.does.not.match.the.fixed"));
      setPreflight(value);
      setPhase(
        !value.ready || value.blockers.length
          ? "blocked"
          : value.expiresAt <= Date.now()
            ? "stale"
            : "ready",
      );
    } catch (cause) {
      if (epoch === generation.current) {
        setMessage(String(cause));
        setPhase("failed");
      }
    } finally {
      running.current = false;
    }
  }

  async function confirm() {
    if (
      running.current ||
      invalidated ||
      phase !== "ready" ||
      !preflight?.token ||
      (risky && !ack)
    )
      return;
    if (preflight.expiresAt <= Date.now()) {
      setPhase("stale");
      return;
    }
    const epoch = generation.current;
    running.current = true;
    setPhase("running");
    setMessage("");
    setResult(undefined);
    setLifecycle(undefined);
    setRefreshFailed(false);
    // One UUID for this dispatch; it is reused by receipt lookup, never by a retry.
    const id = crypto.randomUUID();
    operationId.current = id;
    try {
      const dispatching = await connection();
      if (epoch !== generation.current || invalidated) return;
      if (
        !workflowConnectionMatchesTarget(preflight.target, dispatching, "shelf")
      )
        throw new Error(
          t("pending.connection.identity.changed.nothing.was.shelved"),
        );
      // A newer explicit shelf action retires older visual shelf-delete claims.
      invalidateShelfObservations(connectionKey, request.paths);
      const run = await runShelfUnshelve(
        { token: preflight.token, target: preflight.target, operationId: id },
        "shelf",
        {
          connection: dispatching,
          connectionKey,
          execute,
          lookup,
          refresh: (key, target, value) => boundedRefresh(key, target, value),
        },
      );
      if (epoch !== generation.current || invalidated) return;
      setResult(run.result);
      setLifecycle(run.lifecycle);
      setRefreshFailed(!run.refreshSucceeded);
      if (run.lifecycle.state === "commandCompleted") setPhase("completed");
      else if (run.lifecycle.state === "legacy")
        setPhase(
          run.lifecycle.outcome === "succeeded"
            ? "completed"
            : run.lifecycle.outcome === "unknown"
              ? "unknown"
              : "failed",
        );
      else setPhase("unknown");
      if (run.lifecycle.state !== "commandCompleted") {
        setPreflight(undefined);
        setAck(false);
      }
    } catch (cause) {
      if (epoch === generation.current) {
        setMessage(String(cause));
        setPhase("failed");
        setPreflight(undefined);
        setAck(false);
      }
    } finally {
      running.current = false;
    }
  }

  /** Cancellation is the existing IPC with the SAME operationId (never a new id). */
  async function cancel() {
    const id = operationId.current;
    if (!id || !running.current) return;
    await backend.cancelOperation(id).catch(() => undefined);
  }

  const status: PreflightState = !snapshot.paths.length
    ? { kind: "empty" }
    : phase === "checking"
      ? { kind: "checking" }
      : phase === "stale"
        ? { kind: "stale" }
        : phase === "failed" && !result
          ? { kind: "failed", message }
          : preflight
            ? {
                kind:
                  phase === "ready" ||
                  phase === "running" ||
                  phase === "completed"
                    ? "ready"
                    : "blocked",
                blockers: preflight.blockers.map(
                  (item) =>
                    `${item.certainty === "unknown" ? t("pending.unknown.3") : ""}${item.message}`,
                ),
                warnings: preflight.warnings.map(
                  (item) =>
                    `${item.certainty === "unknown" ? t("pending.unknown.4") : ""}${item.message}`,
                ),
              }
            : { kind: "idle" };

  return (
    <Dialog
      title={
        deleting ? t("pending.delete.shelved.files") : t("pending.shelve.files")
      }
      description={t("pending.the.scope.is.exactly.the.files")}
      source={snapshot.source}
      zh={zh}
      danger={risky}
      busy={busy}
      onRequestClose={onDismiss}
      footer={
        <>
          {onBack && (
            <button disabled={busy} onClick={onBack}>
              {t("pending.back.to.cl.groups")}
            </button>
          )}
          <button data-dialog-autofocus disabled={busy} onClick={onDismiss}>
            {t("pending.close")}
          </button>
          {phase === "running" && (
            <button onClick={() => void cancel()}>
              {t("pending.cancel.operation")}
            </button>
          )}
          <button
            disabled={
              busy ||
              invalidated ||
              snapshot.changeId <= 0 ||
              !snapshot.paths.length ||
              phase === "completed"
            }
            onClick={() => void inspect()}
          >
            {t("pending.run.preflight")}
          </button>
          <button
            className={risky ? "danger" : "primary"}
            disabled={phase !== "ready" || !preflight?.token || (risky && !ack)}
            onClick={() => void confirm()}
          >
            {deleting
              ? t("pending.delete.selected.shelf.revisions")
              : t("pending.shelve.selected.files")}
          </button>
        </>
      }
    >
      <div className="workflow-context">
        {snapshot.changeId ? `CL ${snapshot.changeId}` : "Default"} ·{" "}
        {snapshot.paths.length} {t("pending.files")}
      </div>
      {demo && (
        <DialogNotice>
          {t("pending.browser.mock.simulates.the.result.and")}
        </DialogNotice>
      )}
      <TargetList
        paths={snapshot.paths}
        label={t("pending.explicit.file.scope")}
      />
      {snapshot.changeId <= 0 && (
        <DialogNotice error>
          {t("pending.create.a.numbered.cl.before.shelving")}
        </DialogNotice>
      )}
      {!deleting && snapshot.hasShelf && (
        <label>
          {t("pending.existing.shelf.handling")}
          <select
            value={replace ? "replace" : "preserve"}
            onChange={(event) => {
              setReplace(event.target.value === "replace");
              setAck(false);
              resetCheck();
            }}
          >
            <option value="preserve">
              {t("pending.preserve.existing.content")}
            </option>
            <option value="replace">
              {t("pending.replace.selected.shelf.revisions")}
            </option>
          </select>
        </label>
      )}
      {risky && (
        <>
          <DialogNotice error>
            {deleting
              ? t("pending.deleted.shelf.revisions.can.no.longer")
              : t(
                  "pending.replacement.overwrites.selected.shelf.revisions.unselected",
                )}
          </DialogNotice>
          <label className="workflow-checkbox">
            <input
              type="checkbox"
              checked={ack}
              onChange={(event) => setAck(event.target.checked)}
            />
            {t("pending.i.reviewed.the.scope.and.explicitly")}
          </label>
        </>
      )}
      {preflight && (
        <div className="workflow-context">
          {t("pending.create.2")} {preflight.scope.createPaths.length} ·{" "}
          {t("pending.replace")} {preflight.scope.replacePaths.length} ·{" "}
          {t("pending.delete")} {preflight.scope.deletePaths.length}
        </div>
      )}
      {!result && <PreflightStatus state={status} zh={zh} />}
      {phase === "running" && (
        <DialogNotice>
          {t("pending.operation.in.progress.closing.is.disabled")}
        </DialogNotice>
      )}
      {message && (
        <DialogNotice error={phase === "failed"}>{message}</DialogNotice>
      )}
      {lifecycle?.state === "commandCompleted" && (
        <DialogNotice>
          {t("pending.command.completed.command.level.lifecycle.only")}
        </DialogNotice>
      )}
      {lifecycle?.state === "unknown" && (
        <DialogNotice error>
          {t("pending.outcome.uncertain.the.command.may.have")}
        </DialogNotice>
      )}
      {lifecycle?.state === "legacy" && lifecycle.outcome !== "succeeded" && (
        <DialogNotice error>
          {t("pending.outcome")}
          {lifecycle.outcome}
          {result?.failure ? ` · ${result.failure}` : ""} ·{" "}
          {result?.refresh.reason}
        </DialogNotice>
      )}
      {lifecycle?.state === "legacy" && lifecycle.outcome === "partial" && (
        <DialogNotice>
          {t("pending.partial.only.the.succeeded.rows.below")}
        </DialogNotice>
      )}
      {(lifecycle?.state === "legacy"
        ? lifecycle.outcome === "partial"
          ? lifecycle.files.filter((file) => file.state === "succeeded")
          : lifecycle.files
        : (lifecycle?.files ?? [])
      ).map((file) => (
        <DialogNotice key={file.depotPath} error={file.state !== "succeeded"}>
          {file.state} · {file.depotPath} · {file.message}
        </DialogNotice>
      ))}
      {lifecycle?.state !== "legacy" && !!lifecycle?.files.length && (
        <p className="workflow-context">
          {t("pending.per.file.facts")} {lifecycle.files.length}
        </p>
      )}
      {lifecycle && result?.message && (
        <DialogNotice error={lifecycle.state === "unknown"}>
          {result.message}
        </DialogNotice>
      )}
      {refreshFailed && (
        <DialogNotice error>
          {t("pending.view.refresh.failed.the.display.may")}
        </DialogNotice>
      )}
      {(lifecycle?.operationId || result?.operationIds.length) && (
        <p className="workflow-context">
          {t("pending.operations")}{" "}
          {lifecycle?.operationId ?? result?.operationIds.join(", ")}
          {result?.logReference
            ? ` · ${t("pending.log")} ${result.logReference}`
            : ""}
        </p>
      )}
    </Dialog>
  );
}
