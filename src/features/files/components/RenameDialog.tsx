import { t, tFor, type MsgKey } from "../../../shared/i18n";
import { useEffect, useRef, useState } from "react";
import { useUnsavedEditor } from "../../../app/closeGuard";
import { Dialog, DialogNotice } from "../../../app/dialogs/Dialog";
import { backend } from "../../../infrastructure/backend";
import type {
  RenameMoveConfirmation,
  RenameMovePreflight,
  RenameMovePreflightRequest,
  RenameMoveResult,
  WorkspaceNode,
} from "../../../shared/contracts";
import { checkRenamePath, type RenamePathError } from "../renamePath";
import {
  beginLocalIoProjection,
  clearLocalIoProjection,
  lifecycleOf,
  unwrapLocalIoLegacy,
  withdrawLocalIoProjection,
} from "../../actions/localIoLifecycle";

const reasons: Record<RenamePathError, string> = {
  empty: "files.empty",
  absolute: t("files.use.an.absolute.path.of.the"),
  characters: t("files.control.characters.and.p4.filespec.metacharacters"),
  segments: t("files.a.root.path.empty.segments.and"),
  same: "files.same",
  descendant: t("files.a.folder.cannot.move.into.its"),
};

type Phase = "preview" | "checking" | "review" | "confirming" | "result";

export function RenameDialog({
  node,
  source,
  zh,
  onDismiss: dismissCallback,
  onRefresh,
  check = (request) => backend.preflightRenameMove(request),
  execute = (confirmation) => backend.confirmRenameMove(confirmation),
}: {
  node: WorkspaceNode;
  source: HTMLElement | null;
  zh: boolean;
  onDismiss(): void;
  onRefresh?(): Promise<void> | void;
  check?(request: RenameMovePreflightRequest): Promise<RenameMovePreflight>;
  execute?(
    confirmation: RenameMoveConfirmation,
  ): Promise<RenameMoveResult | unknown>;
}) {
  const [snapshot] = useState(() => ({ ...node }));
  const from = snapshot.absolutePath || snapshot.depotPath || "";
  const [target, setTarget] = useState(from);
  const [targetChangeId, setTargetChangeId] = useState(
    snapshot.changelistId ?? 0,
  );
  const [phase, setPhase] = useState<Phase>("preview");
  const [preflight, setPreflight] = useState<RenameMovePreflight>();
  const [result, setResult] = useState<RenameMoveResult>();
  const clearUnsaved = useUnsavedEditor(
    result?.outcome === "succeeded"
      ? "clean"
      : target !== from || targetChangeId !== (snapshot.changelistId ?? 0)
        ? "dirty"
        : "clean",
  );
  const onDismiss = () => {
    clearUnsaved();
    dismissCallback();
  };
  const [failure, setFailure] = useState("");
  const [discard, setDiscard] = useState(false);
  const generation = useRef(0);
  const activeOperation = useRef<string | undefined>(undefined);
  const error = checkRenamePath(
    from,
    target,
    snapshot.kind === "directory",
    !snapshot.absolutePath,
  );
  const blockedInput = snapshot.kind !== "file" || !snapshot.absolutePath;

  useEffect(
    () => () => {
      generation.current += 1;
      if (activeOperation.current)
        void backend
          .cancelOperation(activeOperation.current)
          .catch(() => undefined);
    },
    [],
  );

  function invalidatePreview() {
    generation.current += 1;
    setPreflight(undefined);
    setResult(undefined);
    setFailure("");
    setPhase("preview");
  }

  const dismiss = () =>
    phase === "confirming"
      ? undefined
      : target !== from || phase !== "preview"
        ? setDiscard(true)
        : onDismiss();

  async function preview() {
    if (error || blockedInput || phase === "checking") return;
    const epoch = ++generation.current;
    setFailure("");
    setPreflight(undefined);
    setResult(undefined);
    setPhase("checking");
    try {
      const value = await check({
        sourcePath: from,
        targetPath: target,
        targetChangeId,
        operationId: crypto.randomUUID(),
      });
      if (epoch !== generation.current) return;
      setPreflight(value);
      setPhase("review");
    } catch (cause) {
      if (epoch !== generation.current) return;
      setFailure(String(cause));
      setPhase("preview");
    }
  }

  async function confirm() {
    if (
      phase !== "review" ||
      !preflight?.ready ||
      !preflight.token ||
      !preflight.targetSnapshot
    )
      return;
    const epoch = generation.current;
    const operationId = crypto.randomUUID();
    activeOperation.current = operationId;
    beginLocalIoProjection({
      operationId,
      kind: "renameMove",
      fromPath: from,
      toPath: target,
    });
    setFailure("");
    setPhase("confirming");
    try {
      const value = await execute({
        token: preflight.token,
        target: preflight.targetSnapshot,
        previewDigest: preflight.previewDigest,
        operationId,
      });
      if (epoch !== generation.current) return;
      const lifecycle = lifecycleOf(value);
      if (lifecycle && lifecycle.state === "unknown") {
        withdrawLocalIoProjection(operationId);
        setFailure(t("files.outcome.is.unconfirmed.rows.were.corrected"));
        setPhase("result");
        void Promise.resolve(onRefresh?.()).catch(() => undefined);
        return;
      }
      const legacy = unwrapLocalIoLegacy<RenameMoveResult>(value);
      if (!legacy) {
        withdrawLocalIoProjection(operationId);
        setFailure(t("files.no.recognizable.result.was.returned"));
        setPhase("result");
        void Promise.resolve(onRefresh?.()).catch(() => undefined);
        return;
      }
      setResult(legacy);
      setPhase("result");
      if (lifecycle?.state === "committed") {
        void Promise.resolve(onRefresh?.())
          .then(() => clearLocalIoProjection(operationId))
          .catch(() => undefined);
      } else {
        withdrawLocalIoProjection(operationId);
        if (legacy.refresh.workspaceStatus || legacy.refresh.pendingChanges)
          void Promise.resolve(onRefresh?.()).catch(() => undefined);
      }
    } catch (cause) {
      if (epoch !== generation.current) return;
      withdrawLocalIoProjection(operationId);
      setFailure(String(cause));
      setPhase("result");
      void Promise.resolve(onRefresh?.()).catch(() => undefined);
    } finally {
      if (activeOperation.current === operationId)
        activeOperation.current = undefined;
    }
  }

  const footer =
    phase === "confirming" ? (
      <>
        <button
          onClick={() => {
            const operationId = activeOperation.current;
            if (operationId) void backend.cancelOperation(operationId);
          }}
        >
          {t("files.cancel.operation")}
        </button>
        <button disabled>{t("files.confirming")}</button>
      </>
    ) : phase === "result" ? (
      <button className="primary" onClick={onDismiss}>
        {t("files.close")}
      </button>
    ) : phase === "review" ? (
      <>
        <button onClick={dismiss}>{t("files.cancel")}</button>
        <button onClick={() => void preview()}>{t("files.run.again")}</button>
        <button
          className="primary"
          disabled={
            !preflight?.ready || !preflight.token || !preflight.targetSnapshot
          }
          onClick={() => void confirm()}
        >
          {t("files.confirm.rename.move")}
        </button>
      </>
    ) : (
      <>
        <button onClick={dismiss}>{t("files.cancel")}</button>
        <button
          className="primary"
          disabled={!!error || blockedInput || phase === "checking"}
          onClick={() => void preview()}
        >
          {phase === "checking"
            ? t("files.checking")
            : t("files.preview.and.review")}
        </button>
      </>
    );

  return (
    <Dialog
      title={t("files.rename.move")}
      description={t("files.safe.single.file.flow.preview.mapping")}
      zh={zh}
      source={source}
      onRequestClose={dismiss}
      footer={footer}
    >
      <div className="workflow-context">
        {t("files.phase")} · {phase}
      </div>
      <label>
        {t("files.source.path")}
        <input readOnly value={from} />
      </label>
      <label>
        {t("files.destination.path")}
        <input
          data-dialog-autofocus
          value={target}
          disabled={phase === "confirming" || phase === "result"}
          onChange={(event) => {
            setTarget(event.target.value);
            invalidatePreview();
          }}
          aria-invalid={target !== from && !!error}
        />
      </label>
      <label>
        {t("files.target.changelist.0.default")}
        <input
          type="number"
          min={0}
          value={targetChangeId}
          disabled={phase === "confirming" || phase === "result"}
          onChange={(event) => {
            setTargetChangeId(Math.max(0, Number(event.target.value) || 0));
            invalidatePreview();
          }}
        />
      </label>
      {blockedInput && (
        <DialogNotice error>
          {t("files.this.release.supports.one.local.file")}
        </DialogNotice>
      )}
      {target !== from && error && (
        <DialogNotice error>
          {tFor(zh ? "zh-CN" : "en-US", reasons[error] as MsgKey)}
        </DialogNotice>
      )}
      {phase === "checking" && (
        <DialogNotice>{t("files.reading.the.p4.snapshot")}</DialogNotice>
      )}
      {preflight && (
        <section
          className="workflow-review"
          aria-label={t("files.preflight.result")}
        >
          <h3>{t("files.mapping.and.state")}</h3>
          <dl>
            <dt>{t("files.source.depot")}</dt>
            <dd>{preflight.source?.depotPath ?? "—"}</dd>
            <dt>{t("files.source.local")}</dt>
            <dd>{preflight.source?.localPath ?? "—"}</dd>
            <dt>{t("files.target.depot")}</dt>
            <dd>{preflight.target?.depotPath ?? "—"}</dd>
            <dt>{t("files.target.local")}</dt>
            <dd>{preflight.target?.localPath ?? "—"}</dd>
            <dt>{t("files.opened.action.cl")}</dt>
            <dd>
              {preflight.sourceState
                ? `${preflight.sourceState.action} / ${preflight.sourceState.changeId || "Default"}`
                : "—"}
            </dd>
            <dt>{t("files.target.cl")}</dt>
            <dd>
              {preflight.targetChangeId || "Default"} ·{" "}
              {preflight.targetChangeValid
                ? t("files.valid")
                : t("files.invalid")}
            </dd>
            <dt>{t("files.target.exists")}</dt>
            <dd>{preflight.targetExists ? t("files.yes") : t("files.no")}</dd>
            <dt>{t("files.case.only.risk")}</dt>
            <dd>
              {preflight.caseOnlyRisk ? t("files.blocked.2") : t("files.none")}
            </dd>
          </dl>
          {preflight.blockers.map((item) => (
            <DialogNotice error key={`${item.code}:${item.message}`}>
              {item.message}
            </DialogNotice>
          ))}
          {preflight.warnings.map((item) => (
            <DialogNotice key={`${item.code}:${item.message}`}>
              {item.message}
            </DialogNotice>
          ))}
          {preflight.ready && (
            <DialogNotice>
              {t("files.preflight.passed.the.token.is.one")}
            </DialogNotice>
          )}
        </section>
      )}
      {phase === "confirming" && (
        <DialogNotice>
          {t("files.revalidating.and.executing.closing.the.view")}
        </DialogNotice>
      )}
      {result && (
        <section className="workflow-result" role="status">
          <h3>{result.outcome}</h3>
          <p>{result.message}</p>
          {result.failure && <p>{result.failure}</p>}
          {result.operationId && (
            <p>
              {t("files.operation")} {result.operationId}
            </p>
          )}
          <p>{result.refresh.reason}</p>
        </section>
      )}
      {failure && <DialogNotice error>{failure}</DialogNotice>}
      {discard && (
        <section className="workflow-discard" role="alert">
          <p>{t("files.closing.discards.the.current.preview.and")}</p>
          <button onClick={() => setDiscard(false)}>
            {t("files.keep.editing")}
          </button>
          <button className="danger" onClick={onDismiss}>
            {t("files.discard.and.close")}
          </button>
        </section>
      )}
    </Dialog>
  );
}
