import { t } from "../../../shared/i18n";
import { useId, useRef, useState } from "react";
import { Dialog, DialogNotice } from "../../../app/dialogs/Dialog";
import { useUnsavedEditor } from "../../../app/closeGuard";
import type { SelectedOpenedFile } from "../selectedFiles";

interface Props {
  files: readonly SelectedOpenedFile[];
  workspace: string;
  routeLabel: string;
  zh: boolean;
  source?: HTMLElement | null;
  busy?: boolean;
  error?: string;
  onDismiss(): void;
  /** UI draft callback only. Host request/result mapping belongs to the coordinator. */
  onConfirm(description: string): void;
}
export function SelectedFilesPreviewDialog({
  files,
  workspace,
  routeLabel,
  zh,
  source,
  busy = false,
  error,
  onDismiss,
  onConfirm,
}: Props) {
  const [description, setDescription] = useState("");
  const [invalid, setInvalid] = useState(false);
  const [discard, setDiscard] = useState(false);
  const submitted = useRef(false);
  const [confirmed, setConfirmed] = useState(false);
  const formId = useId();
  const clearUnsaved = useUnsavedEditor(
    description ? "dirty" : "clean",
    "",
    "changelistDescription",
  );
  const dismiss = () => {
    if (!busy) description ? setDiscard(true) : onDismiss();
  };
  return (
    <Dialog
      title={t("pending.submit.selected.files")}
      source={source}
      zh={zh}
      busy={busy}
      onRequestClose={dismiss}
      footer={
        <>
          <button type="button" disabled={busy} onClick={dismiss}>
            {t("pending.cancel")}
          </button>
          <button
            type="submit"
            form={formId}
            className="primary"
            disabled={busy || confirmed || !files.length}
          >
            {t("pending.create.move.continue")}
          </button>
        </>
      }
    >
      <div className="workflow-context">
        {t("pending.workspace")}: {workspace} · {files.length}{" "}
        {t("pending.files")} · {routeLabel}
      </div>
      <p>{t("pending.target.a.new.numbered.cl.cancelling")}</p>
      <ul
        style={{ maxHeight: "30vh", overflow: "auto" }}
        aria-label={t("pending.selected.files.and.original.cl")}
      >
        {files.map((file) => (
          <li key={file.depotPath} style={{ overflowWrap: "anywhere" }}>
            <strong>
              {file.originalChangeId === 0
                ? "Default"
                : `CL ${file.originalChangeId}`}
            </strong>{" "}
            — {file.depotPath}
          </li>
        ))}
      </ul>
      <form
        id={formId}
        onSubmit={(event) => {
          event.preventDefault();
          if (busy || submitted.current || !files.length) return;
          if (!description.trim()) {
            setInvalid(true);
            return;
          }
          submitted.current = true;
          setConfirmed(true);
          onConfirm(description.trim());
          clearUnsaved(); // The coordinator owns the captured draft, including failures.
        }}
      >
        <fieldset disabled={busy || confirmed}>
          <label>
            {t("pending.description.required")}
            <textarea
              rows={5}
              autoFocus
              data-dialog-autofocus
              value={description}
              aria-invalid={invalid}
              onChange={(event) => {
                setDescription(event.target.value);
                setInvalid(false);
              }}
            />
          </label>
        </fieldset>
      </form>
      {invalid && (
        <DialogNotice error>
          {t("pending.enter.a.changelist.description")}
        </DialogNotice>
      )}
      {error && <DialogNotice error>{error}</DialogNotice>}
      {discard && (
        <DialogNotice>
          <span>{t("pending.discard.the.description.no.files.have")}</span>
          <button
            type="button"
            onClick={() => {
              clearUnsaved();
              onDismiss();
            }}
          >
            {t("pending.discard.and.close.2")}
          </button>
          <button type="button" onClick={() => setDiscard(false)}>
            {t("pending.keep.editing")}
          </button>
        </DialogNotice>
      )}
    </Dialog>
  );
}
