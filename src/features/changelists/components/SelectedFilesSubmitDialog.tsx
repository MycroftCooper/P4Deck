import { t } from "../../../shared/i18n";
import { useUnsavedEditor } from "../../../app/closeGuard";
import { useEffect, useRef, useState } from "react";
import { backend } from "../../../infrastructure/backend";
import { Dialog, DialogNotice } from "../../../app/dialogs/Dialog";
import { SelectedFilesPreviewDialog } from "./SelectedFilesPreviewDialog";
import type { SelectedOpenedFile } from "../selectedFiles";
import {
  validSelectedSubmitGrant,
  type SelectedSubmitExpectation,
  type SelectedSubmitReceipt,
  type SelectedSubmitRequest,
} from "../selectedSubmit";

export function SelectedFilesSubmitDialog({
  files,
  expected,
  active = true,
  zh,
  onDismiss,
  onContinue,
}: {
  active?: boolean;
  files: readonly SelectedOpenedFile[];
  expected: SelectedSubmitExpectation;
  zh: boolean;
  onDismiss(): void;
  onContinue(
    id: number,
    count: number,
    expected: SelectedSubmitExpectation,
  ): void;
}) {
  const tr = (cn: string, en: string) => (zh ? cn : en);
  const activeRef = useRef(active);
  activeRef.current = active;
  const request = useRef<SelectedSubmitRequest | undefined>(undefined);
  const alive = useRef(true),
    locked = useRef(false),
    claimed = useRef(false);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [receipt, setReceipt] = useState<SelectedSubmitReceipt>();
  const [attempted, setAttempted] = useState(false),
    [handedOff, setHandedOff] = useState(false);
  const clearDraft = useUnsavedEditor(
    attempted && !receipt?.newChangeId ? "dirty" : "clean",
    "",
    "changelistDescription",
  );
  const dismiss = () => {
    clearDraft();
    onDismiss();
  };
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  async function perform(
    action: "prepare" | "status" | "claim",
    description?: string,
  ) {
    if (
      !activeRef.current ||
      locked.current ||
      (action === "claim" && claimed.current)
    )
      return;
    locked.current = true;
    setBusy(true);
    setError("");
    if (!request.current)
      request.current = {
        ...expected,
        connection: { ...expected.connection },
        operationId: crypto.randomUUID(),
        description: description!,
        files: files.map((f) => ({
          depotPath: f.depotPath,
          sourceChangeId: f.originalChangeId,
        })),
      };
    const frozen = request.current;
    const lookup = {
      operationId: frozen.operationId,
      connection: frozen.connection,
      customSubmitExecutablePath: frozen.customSubmitExecutablePath,
    };
    setAttempted(true);
    try {
      if (action === "claim") claimed.current = true;
      const result =
        action === "prepare"
          ? await backend.selectedSubmitPrepare(frozen)
          : action === "status"
            ? await backend.selectedSubmitStatus(lookup)
            : await backend.selectedSubmitClaim(lookup);
      if (!alive.current) return;
      if (!result || result.operationId !== frozen.operationId)
        throw new Error(
          t("pending.outcome.unknown.check.status.without.creating"),
        );
      setReceipt(result);
      if (action === "claim") {
        if (!activeRef.current)
          throw new Error("Connection changed; continuation stopped");
        if (!validSelectedSubmitGrant(frozen, result))
          throw new Error(
            t("pending.no.submission.permission.files.remain.in"),
          );
        setHandedOff(true);
        onContinue(result.newChangeId!, frozen.files.length, expected);
      }
    } catch (cause) {
      if (alive.current) setError(String(cause));
    } finally {
      locked.current = false;
      if (alive.current) setBusy(false);
    }
  }
  if (!active && !attempted)
    return (
      <Dialog
        title={t("pending.connection.changed")}
        zh={zh}
        onRequestClose={dismiss}
        footer={<button onClick={dismiss}>{t("pending.close")}</button>}
      >
        <DialogNotice>
          {t("pending.select.files.and.confirm.configuration.again")}
        </DialogNotice>
      </Dialog>
    );
  if (!attempted)
    return (
      <SelectedFilesPreviewDialog
        files={files}
        workspace={expected.connection.client}
        routeLabel={
          expected.customSubmitExecutablePath.trim()
            ? t("pending.custom.submit.tool")
            : t("pending.native.submit.confirmation")
        }
        zh={zh}
        onDismiss={dismiss}
        onConfirm={(description) => void perform("prepare", description)}
      />
    );
  return (
    <Dialog
      title={t("pending.submit.selected.files")}
      zh={zh}
      busy={busy}
      onRequestClose={() => {
        if (!busy) dismiss();
      }}
      footer={
        <>
          <button
            disabled={busy || !active}
            onClick={() => void perform("status")}
          >
            {t("pending.check.status")}
          </button>
          <button
            className="primary"
            disabled={
              busy ||
              !active ||
              claimed.current ||
              receipt?.stage !== "readyForSubmit"
            }
            onClick={() => void perform("claim")}
          >
            {t("pending.continue.to.submit")}
          </button>
          <button disabled={busy} onClick={dismiss}>
            {t("pending.close")}
          </button>
        </>
      }
    >
      <small>
        {t("pending.operation")}: {request.current?.operationId}
      </small>
      {!active && (
        <DialogNotice error>
          {t("pending.connection.changed.further.actions.stopped.keep")}
        </DialogNotice>
      )}
      <p>
        {receipt?.newChangeId
          ? `CL ${receipt.newChangeId}`
          : t("pending.new.cl.status.unknown")}
      </p>
      <DialogNotice>
        {handedOff
          ? t("pending.submission.flow.opened.cancelling.leaves.files")
          : t("pending.not.submitted.partial.or.unknown.moves")}
      </DialogNotice>
      {receipt?.stage === "stopped" && (
        <DialogNotice error>
          {t("pending.the.previous.process.was.interrupted.the")}
        </DialogNotice>
      )}
      {error && <DialogNotice error>{error}</DialogNotice>}
      {!receipt && (
        <ul aria-label={t("pending.selected.files.with.unknown.outcome")}>
          {files.map((file) => (
            <li key={file.depotPath} style={{ overflowWrap: "anywhere" }}>
              {file.originalChangeId === 0
                ? "Default"
                : `CL ${file.originalChangeId}`}{" "}
              · {file.depotPath} · {t("pending.unknown.2")}
            </li>
          ))}
        </ul>
      )}
      {receipt && (
        <>
          <p>{receipt.message}</p>
          <ul style={{ maxHeight: "35vh", overflow: "auto" }}>
            {receipt.files.map((file) => (
              <li key={file.depotPath} style={{ overflowWrap: "anywhere" }}>
                {file.sourceChangeId === 0
                  ? "Default"
                  : `CL ${file.sourceChangeId}`}{" "}
                · {file.depotPath} ·{" "}
                {tr(
                  { moved: "已移动", notMoved: "未移动", unknown: "未知" }[
                    file.state
                  ],
                  file.state,
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </Dialog>
  );
}
