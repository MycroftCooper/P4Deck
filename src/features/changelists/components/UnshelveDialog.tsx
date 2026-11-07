import { t } from "../../../shared/i18n";
import { ResizableTable } from "../../../app/context-menu/ResizableTable";
import { useEffect, useReducer, useRef, useState } from "react";
import { backend } from "../../../infrastructure/backend";
import type {
  ClientWorkspace,
  PendingChange,
  PendingChangeMutationResult,
  UnshelvePreflight,
  UnshelvePreflightRequest,
  WorkflowConfirmation,
  WorkflowResult,
} from "../../../shared/contracts";
import { useTokenExpiry } from "../../../shared/confirmation";
import {
  useOperationSession,
  type OperationLease,
} from "../../../shared/operationSession";
import { Dialog, DialogNotice } from "../../../app/dialogs/Dialog";
import {
  PreflightStatus,
  type PreflightState,
} from "../../../app/dialogs/PreflightStatus";
import { TargetList } from "../../../app/dialogs/TargetList";
import type { ShelfRequest } from "./ShelfDialog";
import type { ConnectionSnapshot } from "../../companySubmit/model";
import {
  lookupWorkflowAction,
  type WorkflowActionLookup,
} from "../../actions/workflowReceipt";
import {
  authoritativeChangeId,
  lifecycleOf,
  unwrapPendingClLegacy,
} from "../../actions/pendingClLifecycle";
import {
  boundedRefresh,
  runShelfUnshelve,
  workflowConnectionMatchesTarget,
  type ShelfUnshelveLifecycle,
} from "../shelfUnshelveLifecycle";

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

/** Everything one review attempt publishes; see the reducer below. */
interface ReviewState {
  phase: Phase;
  preflight?: UnshelvePreflight;
  result?: WorkflowResult;
  lifecycle?: ShelfUnshelveLifecycle;
  refreshFailed: boolean;
  message: string;
  ack: boolean;
}

const INITIAL_REVIEW: ReviewState = {
  phase: "idle",
  preflight: undefined,
  result: undefined,
  lifecycle: undefined,
  refreshFailed: false,
  message: "",
  ack: false,
};

type ReviewEvent =
  | { type: "phase"; value: Phase }
  | { type: "preflight"; value: UnshelvePreflight | undefined }
  | { type: "ack"; value: boolean }
  | { type: "message"; value: string }
  | { type: "result"; value: WorkflowResult | undefined }
  | { type: "lifecycle"; value: ShelfUnshelveLifecycle | undefined }
  | { type: "refreshFailed"; value: boolean };

function reduceReview(state: ReviewState, event: ReviewEvent): ReviewState {
  return { ...state, [event.type]: event.value };
}

export function UnshelveDialog({
  request,
  changes,
  currentWorkspace,
  connectionKey,
  demo = false,
  zh,
  onDismiss,
  loadWorkspaces = () => backend.listUserWorkspaces(),
  check = (value) => backend.preflightUnshelve(value),
  execute = (value) => backend.confirmUnshelve(value),
  connection = () => backend.companySubmitConnectionSnapshot(),
  lookup = lookupWorkflowAction,
  newChangeDescription,
  createChange: createChangeOverride,
  deleteChange: deleteChangeOverride,
}: {
  request: ShelfRequest;
  changes: PendingChange[];
  currentWorkspace: string;
  connectionKey: string;
  demo?: boolean;
  zh: boolean;
  onDismiss(): void;
  loadWorkspaces?(): Promise<ClientWorkspace[]>;
  check?(request: UnshelvePreflightRequest): Promise<UnshelvePreflight>;
  execute?(confirmation: WorkflowConfirmation): Promise<WorkflowResult>;
  /** Exact dispatching connection snapshot; captured once per confirm. */
  connection?(): Promise<ConnectionSnapshot>;
  /** Durable receipt recovery by the SAME operationId. */
  lookup?(request: {
    operationId: string;
    connection: ConnectionSnapshot;
  }): Promise<WorkflowActionLookup>;
  /**
   * Create this CL description up front and unshelve into a brand-new numbered
   * CL instead of asking for a target number. The creation happens once, right
   * before the first preflight (never on re-check).
   */
  newChangeDescription?: string;
  /** Test/injected creation hook; defaults to `mutatePendingChange({type:"create"})`. */
  createChange?(description: string): Promise<number>;
  /** Best-effort cleanup of the empty CL when the dialog closes before confirm. */
  deleteChange?(changeId: number): Promise<void>;
}) {
  const tr = (cn: string, en: string) => (zh ? cn : en);
  const newChange = newChangeDescription !== undefined;
  const newChangeFailure = t(
    "pending.changelist.creation.outcome.is.unconfirmed.refresh",
  );
  /** Default creation reuses the pending-CL lifecycle rules (no auto retry, host readback only). */
  const createChange =
    createChangeOverride ??
    (async (description: string): Promise<number> => {
      const operationId = crypto.randomUUID();
      const raw: unknown = await backend.mutatePendingChange({
        type: "create",
        description,
        jobs: [],
        operationId,
      });
      const lifecycle = lifecycleOf(raw);
      const legacy = unwrapPendingClLegacy<PendingChangeMutationResult>(raw);
      // Envelope results may only hand out the host-readback id once committed;
      // a legacy payload (no lifecycle envelope) keeps its own createdChangeId.
      const created =
        lifecycle && lifecycle.state !== "legacy"
          ? authoritativeChangeId(lifecycle)
          : legacy?.createdChangeId;
      if (
        typeof created !== "number" ||
        !Number.isSafeInteger(created) ||
        created <= 0
      )
        throw new Error(newChangeFailure);
      return created;
    });
  const deleteChange =
    deleteChangeOverride ??
    (async (changeId: number): Promise<void> => {
      try {
        await backend.mutatePendingChange({
          type: "delete",
          changeId,
          operationId: crypto.randomUUID(),
        });
      } catch {
        // Best-effort cleanup of an empty CL only; never a surfaced write error.
      }
    });
  const [snapshot] = useState(() => ({
    ...request,
    paths: [...new Set(request.paths)].sort(),
    changes: changes.map((change) => ({
      id: change.id,
      description: change.description,
    })),
    connectionKey,
  }));
  const [workspaces, setWorkspaces] = useState<ClientWorkspace[]>([]);
  const [workspaceError, setWorkspaceError] = useState("");
  const [targetWorkspace, setTargetWorkspace] = useState(currentWorkspace);
  const [targetChange, setTargetChange] = useState("0");
  /** New-CL mode: id of the CL created right before the first preflight. */
  const [createdChangeId, setCreatedChangeId] = useState<number>();
  /**
   * The review's transient output lives in one reducer. These six fields always
   * move together at the start of an action, so the transitions below make the
   * "what is cleared when" rule explicit instead of repeating it per handler:
   * starting an attempt clears the previous attempt's result, a refusal clears
   * the acknowledgement, and a completed review keeps its acknowledgement.
   */
  const [review, dispatch] = useReducer(reduceReview, INITIAL_REVIEW);
  const session = useOperationSession();
  const running = useRef(false);
  /** The confirmed write; Cancel reuses its exact operationId. */
  const dispatchLease = useRef<OperationLease | undefined>(undefined);
  const loadWorkspacesRef = useRef(loadWorkspaces);
  /** Created CL kept across re-checks; only cleanup reads it on unmount. */
  const createdChangeIdRef = useRef<number | undefined>(undefined);
  /** Once confirm is dispatched the CL may hold opened files: never auto-delete it. */
  const confirmAttemptedRef = useRef(false);
  const unmountedRef = useRef(false);
  const deleteChangeRef = useRef(deleteChange);
  deleteChangeRef.current = deleteChange;
  /** Cleanup may only delete a CL created on the very same connection. */
  const connectionKeyRef = useRef(connectionKey);
  connectionKeyRef.current = connectionKey;
  const staleConnection = snapshot.connectionKey !== connectionKey;
  const { phase, preflight, result, lifecycle, refreshFailed, message, ack } =
    review;
  const setPhase = (value: Phase) => dispatch({ type: "phase", value });
  const setPreflight = (value: UnshelvePreflight | undefined) =>
    dispatch({ type: "preflight", value });
  const setAck = (value: boolean) => dispatch({ type: "ack", value });
  const setMessage = (value: string) => dispatch({ type: "message", value });
  const setResult = (value: WorkflowResult | undefined) =>
    dispatch({ type: "result", value });
  const setLifecycle = (value: ShelfUnshelveLifecycle | undefined) =>
    dispatch({ type: "lifecycle", value });
  const setRefreshFailed = (value: boolean) =>
    dispatch({ type: "refreshFailed", value });
  const sourceChanged =
    request.changeId !== snapshot.changeId ||
    JSON.stringify([...new Set(request.paths)].sort()) !==
      JSON.stringify(snapshot.paths);
  const invalidated = staleConnection || sourceChanged;
  const targetId = newChange ? (createdChangeId ?? 0) : Number(targetChange);
  const validTarget = newChange
    ? createdChangeId === undefined ||
      (Number.isSafeInteger(createdChangeId) && createdChangeId > 0)
    : Number.isInteger(targetId) && targetId >= 0;
  const busy = phase === "checking" || phase === "running";

  useEffect(() => {
    // A new CL lives in the current client; no workspace selection is needed.
    if (newChange) return;
    let live = true;
    void loadWorkspacesRef
      .current()
      .then((value) => {
        if (!live) return;
        const next = [...value];
        if (!next.some((item) => item.name === currentWorkspace))
          next.unshift({
            name: currentWorkspace,
            owner: "",
            host: "",
            root: "",
            stream: "",
            description: t("pending.current.workspace"),
            updated: null,
            accessed: null,
          });
        setWorkspaces(next);
      })
      .catch((cause) => live && setWorkspaceError(String(cause)));
    return () => {
      live = false;
    };
  }, [currentWorkspace, newChange]);
  useEffect(() => {
    if (!invalidated) return;
    // A changed source or connection retires both lanes locally; a confirmed
    // write is never cancelled on the host.
    session.invalidate("preflight");
    session.invalidate("dispatch");
    running.current = false;
    setPreflight(undefined);
    setAck(false);
    setPhase("stale");
  }, [invalidated, session]);
  useTokenExpiry(phase === "ready" ? preflight?.expiresAt : undefined, () => {
    setPhase("stale");
    setAck(false);
  });
  useEffect(
    () => () => {
      unmountedRef.current = true;
      const created = createdChangeIdRef.current;
      // Only an empty, never-confirmed CL created on this connection is removed;
      // a confirmed dispatch may already hold unshelved files, and a different
      // connection must never be asked to delete the same numeric id.
      if (
        created === undefined ||
        confirmAttemptedRef.current ||
        connectionKeyRef.current !== snapshot.connectionKey
      )
        return;
      void Promise.resolve(deleteChangeRef.current(created)).catch(
        () => undefined,
      );
    },
    [],
  );

  const targetChanged = () => {
    session.invalidate("preflight");
    // Parity with the old shared epoch: changing the reviewed inputs also
    // retires a dispatch result that started under the previous review.
    session.invalidate("dispatch");
    running.current = false;
    setPreflight(undefined);
    setResult(undefined);
    setLifecycle(undefined);
    setRefreshFailed(false);
    setMessage("");
    setAck(false);
    setPhase("idle");
  };

  async function inspect() {
    if (
      running.current ||
      invalidated ||
      !snapshot.paths.length ||
      !targetWorkspace ||
      (!newChange && !validTarget)
    )
      return;
    running.current = true;
    const lease = session.start("preflight");
    setPhase("checking");
    setMessage("");
    setResult(undefined);
    setLifecycle(undefined);
    setRefreshFailed(false);
    setAck(false);
    try {
      let targetChangeId = newChange
        ? createdChangeIdRef.current
        : Number(targetChange);
      if (targetChangeId === undefined) {
        // Exactly one creation per dialog; every re-check reuses this id.
        const created = await createChange(newChangeDescription!);
        if (!Number.isSafeInteger(created) || created <= 0)
          throw new Error(newChangeFailure);
        createdChangeIdRef.current = created;
        setCreatedChangeId(created);
        if (unmountedRef.current) {
          if (
            !confirmAttemptedRef.current &&
            connectionKeyRef.current === snapshot.connectionKey
          )
            void Promise.resolve(deleteChangeRef.current(created)).catch(
              () => undefined,
            );
          return;
        }
        targetChangeId = created;
      }
      const value = await check({
        sourceChangeId: snapshot.changeId,
        depotPaths: snapshot.paths,
        targetWorkspace,
        targetChangeId,
      });
      if (!session.isCurrent(lease)) return;
      const samePaths =
        JSON.stringify([...value.target.depotPaths].sort()) ===
        JSON.stringify(snapshot.paths);
      if (
        value.target.kind !== "unshelve" ||
        value.target.sourceChangeId !== snapshot.changeId ||
        value.target.targetChangeId !== targetChangeId ||
        value.target.client !== targetWorkspace ||
        !samePaths ||
        (value.ready && !value.token) ||
        !Number.isFinite(value.expiresAt)
      )
        throw new Error(t("pending.preflight.does.not.match.the.source"));
      setPreflight(value);
      setPhase(
        !value.ready || value.blockers.length
          ? "blocked"
          : value.expiresAt <= Date.now()
            ? "stale"
            : "ready",
      );
    } catch (cause) {
      if (session.isCurrent(lease)) {
        setMessage(String(cause));
        setPhase("failed");
      }
    } finally {
      session.finish(lease);
      running.current = false;
    }
  }

  async function confirm() {
    if (
      running.current ||
      invalidated ||
      phase !== "ready" ||
      !preflight?.token ||
      !ack
    )
      return;
    if (preflight.expiresAt <= Date.now()) {
      setPhase("stale");
      return;
    }
    if (
      newChange &&
      preflight.target.targetChangeId !== createdChangeIdRef.current
    ) {
      setMessage(t("pending.target.not.match"));
      setPhase("failed");
      setPreflight(undefined);
      setAck(false);
      return;
    }
    // Once confirm is dispatched the CL may hold unshelved files: never delete it.
    confirmAttemptedRef.current = true;
    running.current = true;
    setPhase("running");
    setMessage("");
    setResult(undefined);
    setLifecycle(undefined);
    setRefreshFailed(false);
    // One UUID for this dispatch; it is reused by receipt lookup, never by a retry.
    const id = crypto.randomUUID();
    // A confirmed write outlives the dialog, so the host is never asked to
    // cancel it; the local lease only stops late writes from this attempt.
    const lease = session.start("dispatch", {
      operationId: id,
      cancelBackend: false,
    });
    dispatchLease.current = lease;
    try {
      const dispatching = await connection();
      if (!session.isCurrent(lease)) return;
      if (
        !workflowConnectionMatchesTarget(
          preflight.target,
          dispatching,
          "unshelve",
        )
      )
        throw new Error(
          t("pending.source.connection.identity.changed.nothing.was"),
        );
      const run = await runShelfUnshelve(
        { token: preflight.token, target: preflight.target, operationId: id },
        "unshelve",
        {
          connection: dispatching,
          connectionKey,
          execute,
          lookup,
          refresh: (key, target, value) => boundedRefresh(key, target, value),
        },
      );
      if (!session.isCurrent(lease)) return;
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
      if (session.isCurrent(lease)) {
        setMessage(String(cause));
        setPhase("failed");
        setPreflight(undefined);
        setAck(false);
      }
    } finally {
      session.finish(lease);
      running.current = false;
    }
  }

  /** Cancellation is the existing IPC with the SAME operationId (never a new id). */
  async function cancel() {
    const lease = dispatchLease.current;
    if (!lease || !running.current) return;
    await backend.cancelOperation(lease.operationId).catch(() => undefined);
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
                    `${item.certainty === "unknown" ? t("pending.unknown.6") : ""}${item.message}`,
                ),
                warnings: preflight.warnings.map(
                  (item) =>
                    `${item.certainty === "unknown" ? t("pending.unknown.7") : ""}${item.message}`,
                ),
              }
            : { kind: "idle" };

  return (
    <Dialog
      title={t("pending.unshelve.to.workspace")}
      description={t("pending.apply.the.fixed.source.shelf.subset")}
      zh={zh}
      source={snapshot.source}
      busy={busy}
      onRequestClose={onDismiss}
      footer={
        <>
          <button disabled={busy} onClick={onDismiss}>
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
              !snapshot.paths.length ||
              !targetWorkspace ||
              !validTarget ||
              phase === "completed"
            }
            onClick={() => void inspect()}
          >
            {t("pending.run.preflight")}
          </button>
          <button
            className="primary"
            disabled={phase !== "ready" || !preflight?.token || !ack}
            onClick={() => void confirm()}
          >
            {t("pending.confirm.unshelve")}
          </button>
        </>
      }
    >
      <div className="workflow-context">
        {t("pending.source.shelf")} CL {snapshot.changeId} ·{" "}
        {snapshot.paths.length} {t("pending.files")}
      </div>
      {demo && <DialogNotice>{t("pending.browserMockSimulated")}</DialogNotice>}
      <TargetList
        paths={snapshot.paths.map((path) => `${path}@=${snapshot.changeId}`)}
        label={t("pending.fixed.source.files")}
      />
      <label>
        {t("pending.target.workspace")}
        {newChange ? (
          <input
            data-dialog-autofocus
            readOnly
            value={targetWorkspace}
            aria-readonly="true"
          />
        ) : (
          <select
            data-dialog-autofocus
            value={targetWorkspace}
            onChange={(event) => {
              setTargetWorkspace(event.target.value);
              targetChanged();
            }}
          >
            {!workspaces.some((item) => item.name === targetWorkspace) && (
              <option value={targetWorkspace}>{targetWorkspace}</option>
            )}
            {workspaces.map((item) => (
              <option key={item.name} value={item.name}>
                {item.name}
                {item.root ? ` · ${item.root}` : ""}
              </option>
            ))}
          </select>
        )}
      </label>
      {workspaceError && <DialogNotice error>{workspaceError}</DialogNotice>}
      <label>
        {newChange
          ? t("pending.target.cl")
          : t("pending.target.cl.0.means.default")}
        {newChange ? (
          <input
            readOnly
            aria-readonly="true"
            value={
              createdChangeId !== undefined
                ? `CL ${createdChangeId}`
                : tr(
                    `将新建 CL：${newChangeDescription}`,
                    `Will create CL: ${newChangeDescription}`,
                  )
            }
          />
        ) : (
          <input
            type="number"
            min={0}
            step={1}
            value={targetChange}
            onChange={(event) => {
              setTargetChange(event.target.value);
              targetChanged();
            }}
          />
        )}
      </label>
      {!validTarget && (
        <DialogNotice error>
          {t("pending.enter.default.0.or.a.valid")}
        </DialogNotice>
      )}
      <div className="workflow-context">
        CL {snapshot.changeId} → {targetWorkspace} ·{" "}
        {newChange
          ? createdChangeId !== undefined
            ? `CL ${createdChangeId}`
            : t("pending.new.cl.2")
          : targetId === 0
            ? "Default"
            : `CL ${targetId}`}
      </div>
      {newChange && createdChangeId !== undefined && (
        <DialogNotice>
          {t("pending.created.cl")} #{createdChangeId}
        </DialogNotice>
      )}
      <DialogNotice>
        {t("pending.preflight.verifies.mapping.local.overwrite.risk")}
      </DialogNotice>
      {preflight?.mappings.length ? (
        <div className="workflow-mapping-scroll">
          <ResizableTable
            tableId="unshelve-mappings"
            defaults={[240, 240, 180]}
            minimums={[120, 120, 100]}
            className="workflow-mapping-table"
          >
            <thead>
              <tr>
                <th>{t("pending.source")}</th>
                <th>{t("pending.target.mapping")}</th>
                <th>{t("pending.status")}</th>
              </tr>
            </thead>
            <tbody>
              {preflight.mappings.map((mapping) => (
                <tr key={mapping.depotPath}>
                  <td>{mapping.depotPath}</td>
                  <td>{mapping.targetPath ?? t("pending.unmapped")}</td>
                  <td>
                    {[
                      !mapping.mapped && t("pending.unmapped.2"),
                      mapping.locallyModified &&
                        t("pending.local.modification"),
                      mapping.locked && t("pending.locked"),
                      mapping.openedChangeId !== undefined &&
                        `${t("pending.openedIn")} CL ${mapping.openedChangeId}`,
                      mapping.resolveRisk !== "none" &&
                        `${t("pending.resolve.risk")}: ${mapping.resolveRisk}`,
                    ]
                      .filter(Boolean)
                      .join(" · ") || t("pending.no.risk.found")}
                  </td>
                </tr>
              ))}
            </tbody>
          </ResizableTable>
        </div>
      ) : null}
      {!result && <PreflightStatus state={status} zh={zh} />}
      {phase === "ready" && (
        <label className="workflow-checkbox">
          <input
            type="checkbox"
            checked={ack}
            onChange={(event) => setAck(event.target.checked)}
          />
          {t("pending.i.target.mappings")}
        </label>
      )}
      {phase === "running" && (
        <DialogNotice>
          {t("pending.unshelve.in.progress.closing.is.disabled")}
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
