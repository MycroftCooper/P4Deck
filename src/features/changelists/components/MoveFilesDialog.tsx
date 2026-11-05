import { t } from "../../../shared/i18n";
import { useEffect, useRef, useState } from "react";
import { Dialog, DialogNotice } from "../../../app/dialogs/Dialog";
import { backend } from "../../../infrastructure/backend";
import { useUnsavedEditor } from "../../../app/closeGuard";
import type { PendingChange } from "../../../shared/contracts";
import type { ConnectionSnapshot } from "../../companySubmit/model";
import {
  validMoveReceipt,
  type SelectedMoveRequest,
  type SelectedMoveReceipt,
} from "../selectedMove";
export interface MoveFilesRequest {
  from: number;
  origins?: Record<string, number>;
  paths: string[];
  target?: number;
  source: HTMLElement | null;
}
/** One explicit, immutable move attempt. Status never repeats a write or submits. */
export function MoveFilesDialog({
  request,
  changes,
  client,
  connectionKey,
  zh,
  onDismiss,
  onResult,
  onStart,
}: {
  request: MoveFilesRequest;
  changes: PendingChange[];
  client: string;
  connectionKey: string;
  zh: boolean;
  onStart?(request: SelectedMoveRequest): boolean;
  onDismiss(): void;
  onResult?(receipt: SelectedMoveReceipt): Promise<void> | void;
}) {
  const [snapshot] = useState(() => ({
    ...request,
    paths: [...new Set(request.paths)],
    origins: { ...request.origins },
    connectionKey,
    changes: changes.map((c) => ({
      id: c.id,
      description: c.description,
      status: c.status,
    })),
  }));
  const [connection, setConnection] = useState<ConnectionSnapshot>();
  const [retry, setRetry] = useState(0),
    [filter, setFilter] = useState("");
  const [target, setTarget] = useState<number | "new" | undefined>(
    snapshot.target,
  );
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false),
    [attempted, setAttempted] = useState(false),
    [error, setError] = useState("");
  const [receipt, setReceipt] = useState<SelectedMoveReceipt>();
  const operation = useRef<SelectedMoveRequest | undefined>(undefined);
  const lock = useRef(false),
    alive = useRef(true),
    binding = useRef(connectionKey);
  binding.current = connectionKey;
  const stale = snapshot.connectionKey !== connectionKey;
  const clearDraft = useUnsavedEditor(
    description && receipt?.targetChangeId == null ? "dirty" : "clean",
    "",
    "changelistDescription",
  );
  const dismiss = () => {
    if (!lock.current) {
      clearDraft();
      onDismiss();
    }
  };
  const name = (id: number) => (id === 0 ? "Default" : `CL ${id}`);
  const files = snapshot.paths.map((depotPath) => ({
    depotPath,
    sourceChangeId: snapshot.origins[depotPath] ?? snapshot.from,
  }));
  const invalidFiles =
    !files.length ||
    files.some(
      (f) =>
        !f.depotPath.startsWith("//") ||
        !Number.isSafeInteger(f.sourceChangeId) ||
        f.sourceChangeId < 0,
    );
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (lock.current && operation.current)
        void backend
          .cancelOperation(operation.current.operationId)
          .catch(() => {});
    };
  }, []);
  useEffect(() => {
    let live = true;
    if (stale) return;
    setConnection(undefined);
    setError("");
    void backend
      .companySubmitConnectionSnapshot()
      .then((value) => {
        if (!live || binding.current !== snapshot.connectionKey) return;
        if (
          !value.profileId ||
          !/^\d+$/.test(value.generation) ||
          ![value.server, value.user, value.client].every((v) => v.trim())
        )
          throw Error("invalidConnection");
        const { profileId, generation, server, user, client } = value;
        setConnection({ profileId, generation, server, user, client });
      })
      .catch((cause) => {
        if (live) setError(String(cause));
      });
    return () => {
      live = false;
    };
  }, [retry, stale, snapshot.connectionKey]);
  async function perform(status = false) {
    if (
      lock.current ||
      stale ||
      binding.current !== snapshot.connectionKey ||
      !connection ||
      (!status && operation.current)
    )
      return;
    if (!status) {
      if (
        invalidFiles ||
        target === undefined ||
        (target === "new" && !description.trim())
      )
        return;
      operation.current = {
        operationId: crypto.randomUUID(),
        connection: { ...connection },
        files,
        target:
          target === "new"
            ? { kind: "new", description: description.trim() }
            : { kind: "existing", changeId: target },
      };
    }
    const frozen = operation.current;
    if (!frozen) return;
    if (!status && onStart) {
      if (onStart(frozen)) {
        clearDraft();
        onDismiss();
      } else {
        operation.current = undefined;
        setError(t("pending.files.have.an.unresolved.move.or"));
      }
      return;
    }
    lock.current = true;
    setBusy(true);
    setAttempted(true);
    setError("");
    try {
      const result = status
        ? await backend.selectedMoveStatus({
            operationId: frozen.operationId,
            connection: frozen.connection,
          })
        : await backend.selectedMoveExecute(frozen);
      if (!alive.current) return;
      if (!result || !validMoveReceipt(frozen, result))
        throw Error(t("pending.outcome.unknown.check.this.attempt.without"));
      setReceipt(result);
      if (result.targetChangeId !== null) clearDraft();
      if (binding.current === snapshot.connectionKey)
        void Promise.resolve(onResult?.(result)).catch(() => {});
    } catch (cause) {
      if (alive.current) setError(String(cause));
    } finally {
      lock.current = false;
      if (alive.current) setBusy(false);
    }
  }
  const available = snapshot.changes.filter(
    (c) =>
      c.status === "pending" &&
      Number.isSafeInteger(c.id) &&
      c.id >= 0 &&
      `${name(c.id)} ${c.description}`
        .toLowerCase()
        .includes(filter.trim().toLowerCase()),
  );
  const stateLabel = (state: string) =>
    ({
      moved: t("pending.moved"),
      alreadyInTarget: t("pending.already.in.target"),
      notMoved: t("pending.not.moved"),
      unknown: t("pending.unknown"),
    })[state] ?? state;
  return (
    <Dialog
      title={t("pending.move.to.changelist")}
      description={t("pending.move.selected.files.only.never.submit")}
      source={snapshot.source}
      zh={zh}
      busy={busy}
      onRequestClose={dismiss}
      footer={null}
    >
      <div className="move-workflow">
        <div className="workflow-context">
          {client} · {snapshot.paths.length} {t("pending.files")}
        </div>
        {!attempted && (
          <>
            <button
              type="button"
              aria-pressed={target === "new"}
              disabled={stale || busy}
              onClick={() => setTarget("new")}
            >
              {t("pending.new.changelist.3")}
            </button>
            <label>
              {t("pending.filter.target.changelists")}
              <input
                autoFocus
                data-dialog-autofocus
                value={filter}
                disabled={stale || busy}
                onChange={(e) => setFilter(e.target.value)}
                placeholder={t("pending.number.or.description")}
              />
            </label>
            <div className="move-destinations">
              {available.map((c) => (
                <button
                  type="button"
                  key={c.id}
                  aria-pressed={target === c.id}
                  disabled={busy || stale}
                  onClick={() => setTarget(c.id)}
                >
                  <strong>{name(c.id)}</strong>
                  <span>{c.description}</span>
                </button>
              ))}
            </div>
            {!available.length && (
              <DialogNotice>
                {t("pending.no.matching.changelists")}
              </DialogNotice>
            )}
            {target === "new" && (
              <label>
                {t("pending.new.cl.description")}
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  disabled={busy || stale}
                  rows={3}
                />
              </label>
            )}
            {target !== undefined && (
              <>
                <strong>
                  {t("pending.target")}:{" "}
                  {target === "new"
                    ? t("pending.new.numbered.cl")
                    : name(target)}
                </strong>
                <ul className="move-file-preview">
                  {files.map((f) => (
                    <li key={f.depotPath}>
                      {name(f.sourceChangeId)} →{" "}
                      {target === "new" ? t("pending.new.cl") : name(target)} ·{" "}
                      {f.depotPath}
                      {target === f.sourceChangeId
                        ? ` · ${stateLabel("alreadyInTarget")}`
                        : ""}
                    </li>
                  ))}
                </ul>
                <button
                  className="primary"
                  type="button"
                  disabled={
                    busy ||
                    stale ||
                    !connection ||
                    invalidFiles ||
                    (target === "new" && !description.trim())
                  }
                  onClick={() => void perform()}
                >
                  {t("pending.confirm.move")}
                </button>
              </>
            )}
            {!connection && !stale && (
              <button type="button" onClick={() => setRetry((v) => v + 1)}>
                {t("pending.check.connection.again")}
              </button>
            )}
          </>
        )}
        {attempted && (
          <>
            <p>
              {t("pending.attempt")}: {operation.current?.operationId}
            </p>
            <p>
              {t("pending.target.cl")}:{" "}
              {receipt?.targetChangeId == null
                ? t("pending.not.confirmed")
                : name(receipt.targetChangeId)}
            </p>
            <DialogNotice>
              {receipt?.stage === "completed"
                ? t("pending.selected.files.move.completed")
                : t("pending.move.not.confirmed.complete.completed.moves")}
            </DialogNotice>
            {receipt?.message && <p>{receipt.message}</p>}
            <ul className="move-file-preview">
              {files.map((f) => (
                <li key={f.depotPath}>
                  {name(f.sourceChangeId)} · {f.depotPath} ·{" "}
                  {stateLabel(
                    receipt?.files.find((r) => r.depotPath === f.depotPath)
                      ?.state ?? "unknown",
                  )}
                </li>
              ))}
            </ul>
            <button
              type="button"
              disabled={busy || stale}
              onClick={() => void perform(true)}
            >
              {t("pending.check.this.attempt")}
            </button>
            <p>{t("pending.closing.this.dialog.does.not.undo")}</p>
          </>
        )}
        {busy && (
          <>
            <span role="status">{t("pending.moving.or.checking")}</span>
            <button
              type="button"
              onClick={() => {
                if (operation.current)
                  void backend
                    .cancelOperation(operation.current.operationId)
                    .catch((cause) => setError(String(cause)));
              }}
            >
              {t("pending.stop.remaining.operations")}
            </button>
          </>
        )}
        {stale && (
          <DialogNotice error>
            {t("pending.connection.changed.select.files.again.this")}
          </DialogNotice>
        )}
        {error && <DialogNotice error>{error}</DialogNotice>}
      </div>
    </Dialog>
  );
}
