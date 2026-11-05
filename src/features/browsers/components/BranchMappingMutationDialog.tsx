import { t } from "../../../shared/i18n";
import { ResizeHeader } from "../../../app/context-menu/ResizeHeader";
import { useUnsavedEditor } from "../../../app/closeGuard";
import { useColumnWidths } from "../../../app/context-menu/useColumnWidths";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Dialog, DialogNotice } from "../../../app/dialogs/Dialog";
import { PreflightStatus } from "../../../app/dialogs/PreflightStatus";
import { backend } from "../../../infrastructure/backend";
import type { ConnectionSnapshot } from "../../companySubmit/model";
import {
  lookupBranchMappingAction,
  validBranchMappingReceipt,
  type BranchMappingActionLookup,
} from "../../actions/workflowReceipt";
import {
  branchConnectionMatchesTarget,
  branchObservedSummary,
  unknownBranchMutationResult,
} from "../mutationLifecycle";
import type {
  BranchMappingDetail,
  BranchMappingDraft,
  BranchMutationMode,
  BranchMutationPreflight,
  BranchMutationResult,
  BranchViewLine,
  RuntimeInfo,
} from "../../../shared/contracts";
import { validateBranchDraft, validateBranchView } from "../branchMappingModel";

type Phase = "edit" | "checking" | "review" | "running" | "result";

const blankLine = (): BranchViewLine => ({
  modifier: "map",
  source: "",
  target: "",
});

function initialDraft(
  mode: BranchMutationMode,
  detail: BranchMappingDetail | undefined,
  owner: string,
): BranchMappingDraft | undefined {
  if (mode === "delete") return undefined;
  if (mode === "edit" && detail)
    return {
      name: detail.name,
      owner: detail.owner,
      description: detail.description,
      locked: detail.locked,
      view: detail.view.map((line) => ({ ...line })),
    };
  return {
    name: "",
    owner,
    description: "",
    locked: false,
    view: [blankLine()],
  };
}

export function BranchMappingMutationDialog({
  mode,
  detail,
  runtime,
  connectionKey,
  source,
  zh,
  onDismiss: dismissCallback,
  onResult,
  connection: connectionProvider,
  lookup: lookupReceipt,
}: {
  mode: BranchMutationMode;
  detail?: BranchMappingDetail;
  runtime: RuntimeInfo;
  connectionKey: string;
  source: HTMLElement | null;
  zh: boolean;
  onDismiss(): void;
  onResult(result: BranchMutationResult, selectedName?: string): void;
  /** Exact dispatching connection snapshot; captured once per confirm. */
  connection?(): Promise<ConnectionSnapshot>;
  /** Durable receipt recovery by the SAME operationId. */
  lookup?(request: {
    operationId: string;
    connection: ConnectionSnapshot;
  }): Promise<BranchMappingActionLookup>;
}) {
  const tableColumns = useColumnWidths(
    [30, 92, 240, 240, 100],
    [30, 80, 150, 150, 90],
    { id: "branch-view-editor", gutter: 48 },
  );
  const [draft, setDraft] = useState(() =>
    initialDraft(mode, detail, runtime.context.user),
  );
  const [savedDraft, setSavedDraft] = useState(() => JSON.stringify(draft));
  const clearUnsaved = useUnsavedEditor(
    JSON.stringify(draft) !== savedDraft ? "dirty" : "clean",
    connectionKey,
  );
  const onDismiss = () => {
    clearUnsaved();
    dismissCallback();
  };
  const [phase, setPhase] = useState<Phase>("edit");
  const [preflight, setPreflight] = useState<BranchMutationPreflight>();
  const [result, setResult] = useState<BranchMutationResult>();
  const [error, setError] = useState("");
  const [acknowledgeDelete, setAcknowledgeDelete] = useState(false);
  const sequence = useRef(0);
  const activeOperation = useRef<string | undefined>(undefined);
  const mounted = useRef(true);
  const connection = useRef(connectionKey);
  connection.current = connectionKey;
  const name = mode === "create" ? (draft?.name ?? "") : (detail?.name ?? "");
  const draftIssues = useMemo(
    () => (draft ? validateBranchDraft(draft) : []),
    [draft],
  );
  const lineIssues = useMemo(
    () => (draft ? validateBranchView(draft.view) : []),
    [draft],
  );
  const lineIssueMap = useMemo(
    () => new Map(lineIssues.map((issue) => [issue.index, issue.messages])),
    [lineIssues],
  );
  const editingBlocked = mode === "edit" && detail?.editable !== true;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      sequence.current += 1;
      if (activeOperation.current)
        void backend.cancelOperation(activeOperation.current);
    };
  }, []);

  useEffect(() => {
    sequence.current += 1;
    if (activeOperation.current)
      void backend.cancelOperation(activeOperation.current);
    activeOperation.current = undefined;
    setError("");
    setPreflight(undefined);
    setResult(undefined);
    setPhase("edit");
  }, [connectionKey]);

  useEffect(() => {
    if (phase !== "review" || !preflight) return;
    const timeout = window.setTimeout(
      () => {
        setPreflight(undefined);
        setAcknowledgeDelete(false);
        setError(t("browse.the.preflight.expired.inspect.the.branch"));
        setPhase("edit");
      },
      Math.min(2147483647, Math.max(0, preflight.expiresAt - Date.now())),
    );
    return () => window.clearTimeout(timeout);
  }, [phase, preflight, zh]);

  const updateLine = (index: number, value: BranchViewLine) =>
    setDraft((current) =>
      current
        ? {
            ...current,
            view: current.view.map((line, row) =>
              row === index ? value : line,
            ),
          }
        : current,
    );

  const moveLine = (index: number, delta: -1 | 1) =>
    setDraft((current) => {
      if (!current) return current;
      const target = index + delta;
      if (target < 0 || target >= current.view.length) return current;
      const view = [...current.view];
      [view[index], view[target]] = [view[target], view[index]];
      return { ...current, view };
    });

  async function runPreflight() {
    if (
      phase === "checking" ||
      phase === "running" ||
      editingBlocked ||
      !name ||
      draftIssues.length ||
      lineIssues.length
    )
      return;
    const seq = ++sequence.current;
    const expectedConnection = connectionKey;
    const operationId = crypto.randomUUID();
    activeOperation.current = operationId;
    setPhase("checking");
    setError("");
    setResult(undefined);
    setPreflight(undefined);
    setAcknowledgeDelete(false);
    try {
      const value = await backend.preflightBranchMappingMutation({
        mode,
        name,
        desired: mode === "delete" ? undefined : draft,
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
        setPhase("edit");
      }
    } finally {
      if (seq === sequence.current) activeOperation.current = undefined;
    }
  }

  /** One same-operationId receipt lookup. Settled means persisted, never success. */
  async function recover(
    operationId: string,
    dispatching: ConnectionSnapshot,
  ): Promise<BranchMutationResult | undefined> {
    try {
      const request = { operationId, connection: dispatching };
      const lookup = await (lookupReceipt ?? lookupBranchMappingAction)(
        request,
      );
      if (
        lookup.kind === "found" &&
        validBranchMappingReceipt(request, lookup.receipt) &&
        lookup.receipt.state === "settled" &&
        lookup.receipt.result
      )
        return lookup.receipt.result;
    } catch {
      /* Lookup failure never retries the write. */
    }
    return undefined;
  }

  function commit(value: BranchMutationResult) {
    setResult(value);
    if (value.outcome === "succeeded") setSavedDraft(JSON.stringify(draft));
    setPhase("result");
    if (value.refreshBranchMappings || value.outcome === "succeeded")
      onResult(
        value,
        value.outcome === "succeeded" && mode !== "delete"
          ? preflight?.name
          : undefined,
      );
  }

  async function confirm() {
    if (
      phase !== "review" ||
      !preflight?.ready ||
      !preflight.token ||
      !preflight.target ||
      preflight.expiresAt <= Date.now() ||
      (mode === "delete" && !acknowledgeDelete)
    )
      return;
    const seq = ++sequence.current;
    const expectedConnection = connectionKey;
    const operationId = crypto.randomUUID();
    activeOperation.current = operationId;
    setPhase("running");
    setError("");
    let dispatching: ConnectionSnapshot | undefined;
    try {
      // The exact dispatching connection is captured once and reused by the
      // same-operationId receipt lookup; it is never a retry identity.
      dispatching = await (
        connectionProvider ?? (() => backend.companySubmitConnectionSnapshot())
      )();
      if (
        !mounted.current ||
        seq !== sequence.current ||
        connection.current !== expectedConnection
      )
        return;
      if (!branchConnectionMatchesTarget(preflight.target, dispatching))
        throw new Error(
          t("browse.connection.identity.changed.no.branch.mapping"),
        );
      let value = await backend.confirmBranchMappingMutation({
        token: preflight.token,
        target: preflight.target,
        previewDigest: preflight.previewDigest,
        acknowledgeDangerousDelete: mode === "delete" && acknowledgeDelete,
        operationId,
      });
      if (
        !mounted.current ||
        seq !== sequence.current ||
        connection.current !== expectedConnection
      )
        return;
      // Unknown may have applied: query the durable receipt once by identity.
      if (value.outcome === "unknown")
        value = (await recover(operationId, dispatching)) ?? value;
      if (!mounted.current || seq !== sequence.current) return;
      commit(value);
    } catch (cause) {
      if (!mounted.current || seq !== sequence.current) return;
      const recovered = dispatching
        ? await recover(operationId, dispatching)
        : undefined;
      if (!mounted.current || seq !== sequence.current) return;
      if (recovered) {
        commit(recovered);
        return;
      }
      // Transport failure is unknown, not "not applied"; refresh once and keep
      // the uncertainty explicit.
      const fallback = unknownBranchMutationResult(operationId, String(cause));
      setError(String(cause));
      setResult(fallback);
      setPhase("result");
      onResult(fallback);
    } finally {
      if (seq === sequence.current) activeOperation.current = undefined;
    }
  }

  function reset() {
    sequence.current += 1;
    if (activeOperation.current)
      void backend.cancelOperation(activeOperation.current);
    activeOperation.current = undefined;
    setPreflight(undefined);
    setResult(undefined);
    setError("");
    setAcknowledgeDelete(false);
    setPhase("edit");
  }

  const title =
    mode === "create"
      ? t("browse.create.branch.mapping")
      : mode === "edit"
        ? t("browse.edit.branch.mapping")
        : t("browse.delete.branch.mapping");
  const busy = phase === "checking" || phase === "running";
  const observed = branchObservedSummary(result?.observed);
  const preflightState = busy
    ? ({ kind: "checking" } as const)
    : error
      ? ({ kind: "failed", message: error } as const)
      : preflight
        ? ({
            kind: preflight.ready ? "ready" : "blocked",
            blockers: preflight.blockers.map((issue) => issue.message),
            warnings: preflight.warnings.map((issue) => issue.message),
          } as const)
        : ({ kind: "idle" } as const);

  return (
    <Dialog
      title={title}
      description={t("browse.every.write.uses.the.dedicated.preflight")}
      source={source}
      zh={zh}
      danger={mode === "delete"}
      busy={busy}
      onRequestClose={() => {
        if (busy && activeOperation.current)
          void backend.cancelOperation(activeOperation.current);
        else onDismiss();
      }}
      footer={
        <>
          {phase === "edit" && (
            <>
              <button onClick={onDismiss}>{t("browse.cancel")}</button>
              <button
                className={mode === "delete" ? "danger" : "primary"}
                data-dialog-autofocus
                disabled={
                  editingBlocked ||
                  !name ||
                  !!draftIssues.length ||
                  !!lineIssues.length
                }
                onClick={() => void runPreflight()}
              >
                {t("browse.run.preflight")}
              </button>
            </>
          )}
          {phase === "checking" && (
            <button
              onClick={() =>
                activeOperation.current &&
                backend.cancelOperation(activeOperation.current)
              }
            >
              {t("browse.cancel.preflight")}
            </button>
          )}
          {phase === "review" && (
            <>
              <button onClick={reset}>{t("browse.back.to.edit")}</button>
              <button
                className={mode === "delete" ? "danger" : "primary"}
                disabled={
                  !preflight?.ready ||
                  !preflight.token ||
                  !preflight.target ||
                  preflight.expiresAt <= Date.now() ||
                  (mode === "delete" && !acknowledgeDelete)
                }
                onClick={() => void confirm()}
              >
                {mode === "delete"
                  ? t("browse.confirm.permanent.delete")
                  : t("browse.confirm.save")}
              </button>
            </>
          )}
          {phase === "running" && (
            <button
              onClick={() =>
                activeOperation.current &&
                backend.cancelOperation(activeOperation.current)
              }
            >
              {t("browse.cancel.operation")}
            </button>
          )}
          {phase === "result" && (
            <>
              <button onClick={onDismiss}>{t("browse.close")}</button>
              {result?.outcome !== "succeeded" && (
                <button className="primary" onClick={reset}>
                  {t("browse.preflight.again")}
                </button>
              )}
            </>
          )}
        </>
      }
    >
      {runtime.mode === "mock" && (
        <DialogNotice>
          {t("browse.browser.mock.preflight.and.save.are")}
        </DialogNotice>
      )}
      <div className="workflow-context">
        <strong>{name || t("browse.new.mapping")}</strong>
        {" · "}
        {runtime.context.server} · {runtime.context.user}
      </div>
      <PreflightStatus zh={zh} state={preflightState} />

      {phase === "edit" && mode === "delete" && (
        <DialogNotice error>
          {t("browse.deletion.is.irreversible.preflight.re.reads")}
        </DialogNotice>
      )}
      {editingBlocked && (
        <DialogNotice error>
          {t("browse.this.mapping.contains.unknown.fields.comments")}
        </DialogNotice>
      )}

      {phase === "edit" && draft && (
        <div className="branch-mutation-editor">
          <div className="branch-mutation-fields">
            <label>
              <span>{t("browse.name")}</span>
              <input
                aria-label={t("browse.branch.mapping.name")}
                value={draft.name}
                disabled={mode === "edit"}
                maxLength={128}
                onChange={(event) =>
                  setDraft({ ...draft, name: event.target.value })
                }
              />
            </label>
            <label>
              <span>Owner</span>
              <input aria-label="Owner" value={draft.owner} readOnly />
            </label>
            <label className="branch-description-field">
              <span>Description</span>
              <textarea
                aria-label="Description"
                value={draft.description}
                maxLength={4096}
                onChange={(event) =>
                  setDraft({ ...draft, description: event.target.value })
                }
              />
            </label>
            <label className="workflow-checkbox">
              <input
                type="checkbox"
                checked={draft.locked}
                onChange={(event) =>
                  setDraft({ ...draft, locked: event.target.checked })
                }
              />
              {t("browse.lock.mapping")}
            </label>
          </div>
          {draftIssues.map((message) => (
            <DialogNotice key={message} error>
              {message}
            </DialogNotice>
          ))}
          <div className="branch-view-editor-header">
            <div>
              <strong>View</strong>
              <span>{draft.view.length} / 512</span>
            </div>
            <button
              disabled={draft.view.length >= 512}
              onClick={() =>
                setDraft({ ...draft, view: [...draft.view, blankLine()] })
              }
            >
              <Plus size={14} /> {t("browse.add.line")}
            </button>
          </div>
          <div style={{ overflowX: "auto" }}>
            <ResizeHeader
              columns={[
                "#",
                t("browse.mode"),
                t("browse.source"),
                t("browse.target"),
                t("browse.actions"),
              ]}
              resize={tableColumns}
            />
            <ol className="branch-view-editor" aria-label="Branch View editor">
              {draft.view.map((line, index) => (
                <li
                  key={index}
                  className={lineIssueMap.has(index) ? "invalid" : ""}
                  style={tableColumns.style}
                >
                  <span className="branch-view-index">{index + 1}</span>
                  <select
                    aria-label={`View line ${index + 1} modifier`}
                    value={line.modifier}
                    onChange={(event) =>
                      updateLine(index, {
                        modifier: event.target
                          .value as BranchViewLine["modifier"],
                        source: line.source,
                        target: line.target,
                      })
                    }
                  >
                    <option value="map">map</option>
                    <option value="exclude">exclude</option>
                    <option value="overlay">overlay</option>
                  </select>
                  <input
                    aria-label={`View line ${index + 1} source`}
                    placeholder="//source/..."
                    value={line.source ?? ""}
                    onChange={(event) =>
                      updateLine(index, { ...line, source: event.target.value })
                    }
                  />
                  <input
                    aria-label={`View line ${index + 1} target`}
                    placeholder="//target/..."
                    value={line.target ?? ""}
                    onChange={(event) =>
                      updateLine(index, { ...line, target: event.target.value })
                    }
                  />
                  <span className="branch-view-row-actions">
                    <button
                      aria-label={`Move View line ${index + 1} up`}
                      disabled={index === 0}
                      onClick={() => moveLine(index, -1)}
                    >
                      <ArrowUp size={13} />
                    </button>
                    <button
                      aria-label={`Move View line ${index + 1} down`}
                      disabled={index === draft.view.length - 1}
                      onClick={() => moveLine(index, 1)}
                    >
                      <ArrowDown size={13} />
                    </button>
                    <button
                      aria-label={`Delete View line ${index + 1}`}
                      disabled={draft.view.length === 1}
                      onClick={() =>
                        setDraft({
                          ...draft,
                          view: draft.view.filter((_, row) => row !== index),
                        })
                      }
                    >
                      <Trash2 size={13} />
                    </button>
                  </span>
                  {lineIssueMap.get(index)?.map((message) => (
                    <span className="branch-view-line-error" key={message}>
                      {message}
                    </span>
                  ))}
                </li>
              ))}
            </ol>
          </div>
        </div>
      )}

      {phase === "review" && preflight && (
        <div className="branch-preflight-review">
          <DialogNotice>
            {t("browse.one.use.token.remaining")} ·{" "}
            {Math.max(0, Math.ceil((preflight.expiresAt - Date.now()) / 1000))}s
          </DialogNotice>
          <dl>
            <div>
              <dt>Mode</dt>
              <dd>{preflight.mode}</dd>
            </div>
            <div>
              <dt>Name</dt>
              <dd>{preflight.name}</dd>
            </div>
            <div>
              <dt>Owner</dt>
              <dd>
                {preflight.desired?.owner ?? preflight.current?.owner ?? "—"}
              </dd>
            </div>
            <div>
              <dt>View lines</dt>
              <dd>
                {preflight.desired?.view.length ??
                  preflight.current?.view.length ??
                  0}
              </dd>
            </div>
          </dl>
          {mode === "delete" && (
            <label className="workflow-checkbox danger-check">
              <input
                type="checkbox"
                checked={acknowledgeDelete}
                onChange={(event) => setAcknowledgeDelete(event.target.checked)}
              />
              {t("browse.i.understand.this.permanently.deletes.the")}
            </label>
          )}
        </div>
      )}

      {phase === "result" && (
        <DialogNotice
          error={
            !result ||
            (result.outcome !== "succeeded" && result.outcome !== "unknown")
          }
        >
          <strong>
            {result?.outcome === "succeeded"
              ? t("browse.verified.by.server.readback")
              : result?.outcome === "unknown"
                ? t("browse.outcome.uncertain")
                : t("browse.operation.did.not.succeed")}
          </strong>
          <br />
          {error || result?.message || t("browse.unknown.result")}
          {result?.failure && (
            <>
              <br />
              <code>{result.failure}</code>
            </>
          )}
        </DialogNotice>
      )}
      {phase === "result" && result?.outcome === "unknown" && (
        <DialogNotice error>
          {t("browse.the.write.may.have.applied.the")}
        </DialogNotice>
      )}
      {phase === "result" && result?.outcome === "succeeded" && observed && (
        <DialogNotice>
          {t("browse.server.readback")}
          {observed.name} · {observed.viewLines} {t("browse.lines")} · Owner{" "}
          {observed.owner}
          {observed.locked ? t("browse.locked") : ""}
          {" · "}
          {t("browse.the.refreshed.list.detail.remains.authoritative")}
        </DialogNotice>
      )}
      {phase === "result" && result && (
        <p className="workflow-context">
          {t("browse.operation")} {result.operationIds.join(", ")}
        </p>
      )}
    </Dialog>
  );
}
