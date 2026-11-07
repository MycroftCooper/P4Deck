import { t } from "../../../shared/i18n";
import { useId, useRef, useState } from "react";
import { useUnsavedEditor } from "../../../app/closeGuard";
import { Dialog, DialogNotice } from "../../../app/dialogs/Dialog";
import { useOperationSession } from "../../../shared/operationSession";

/** The submission channel: one lease per submitted draft. */
const FORM = "changelist-form";

export interface ChangelistDraft {
  description: string;
  jobs: string[];
}
interface Props {
  mode: "create" | "edit";
  changeId?: number;
  initial?: ChangelistDraft;
  client: string;
  zh: boolean;
  source?: HTMLElement | null;
  onDismiss(): void;
  /** Absent until an approved application workflow is connected. Never simulate success. */
  onSubmit?(draft: ChangelistDraft): Promise<void>;
}
export function ChangelistFormDialog({
  mode,
  changeId,
  initial,
  client,
  zh,
  source,
  onDismiss,
  onSubmit,
}: Props) {
  const tr = (cn: string, en: string) => (zh ? cn : en);
  const initialDescription =
    initial?.description ??
    (mode === "create" ? t("pending.new.changelist") : "");
  const [description, setDescription] = useState(initialDescription);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [discard, setDiscard] = useState(false);
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  /**
   * Closing the dialog retires the submission: the owner cancels the channel on
   * unmount, so a late answer can neither dismiss the dialog again nor clear a
   * busy state nobody is looking at.
   */
  const session = useOperationSession();
  const formId = useId(),
    errorId = useId();
  const dirty = description !== initialDescription;
  const clearUnsaved = useUnsavedEditor(
    dirty ? "dirty" : "clean",
    "",
    "changelistDescription",
  );
  const dismiss = () => {
    if (!busy) dirty ? setDiscard(true) : onDismiss();
  };
  async function submit() {
    if (running.current) return;
    setError("");
    setNotice("");
    if (!description.trim()) {
      setError(t("pending.enter.a.changelist.description"));
      return;
    }
    if (mode === "edit" && (!changeId || changeId < 1)) {
      setError(t("pending.a.numbered.changelist.is.required"));
      return;
    }
    const draft = {
      description: description.trim(),
      jobs: mode === "edit" ? [...(initial?.jobs ?? [])] : [],
    };
    if (!onSubmit) {
      setNotice(t("pending.form.preview.only"));
      return;
    }
    running.current = true;
    // One lease per submission. It stays current until this attempt settles;
    // closing the dialog supersedes it through the owner, so a late answer can
    // neither dismiss the dialog again nor revive a closed form.
    const submission = session.start(FORM, { cancelBackend: false });
    setBusy(true);
    try {
      await onSubmit(draft);
      if (session.isCurrent(submission)) {
        clearUnsaved();
        onDismiss();
      }
    } catch (cause) {
      if (session.isCurrent(submission)) setError(String(cause));
    } finally {
      running.current = false;
      // Clear busy before retiring: a finished lease is no longer current.
      if (session.isCurrent(submission)) {
        setBusy(false);
        session.finish(submission);
      }
    }
  }
  return (
    <Dialog
      title={
        mode === "create"
          ? t("pending.new.changelist.2")
          : tr(`编辑 CL ${changeId ?? ""}`, `Edit CL ${changeId ?? ""}`)
      }
      description={t("pending.describe.the.changes.creating.a.cl")}
      source={source}
      busy={busy}
      zh={zh}
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
            disabled={busy}
          >
            {busy
              ? mode === "create"
                ? t("pending.creating")
                : t("pending.saving")
              : !onSubmit
                ? t("pending.check.form.no.submission")
                : mode === "create"
                  ? t("pending.create")
                  : t("pending.save")}
          </button>
        </>
      }
    >
      <div className="workflow-context">
        {t("pending.workspace")} <strong>{client || "—"}</strong>
      </div>
      {!onSubmit && <DialogNotice>{t("pending.ui.cl.writing")}</DialogNotice>}
      <form
        id={formId}
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <fieldset disabled={busy}>
          <label>
            {t("pending.description.required")}
            <textarea
              autoFocus
              data-dialog-autofocus
              rows={6}
              value={description}
              aria-invalid={!!error && !description.trim()}
              aria-describedby={error ? errorId : undefined}
              onChange={(event) => {
                setDescription(event.target.value);
                setError("");
                setNotice("");
              }}
            />
          </label>
        </fieldset>
      </form>
      {error && (
        <div id={errorId}>
          <DialogNotice error>{error}</DialogNotice>
        </div>
      )}
      {notice && <DialogNotice>{notice}</DialogNotice>}
      {discard && (
        <section
          className="workflow-discard"
          role="alert"
          aria-label={t("pending.unsaved.changes")}
        >
          <p>{t("pending.closing.discards.this.draft.continue")}</p>
          <button type="button" onClick={() => setDiscard(false)}>
            {t("pending.keep.editing")}
          </button>
          <button
            type="button"
            className="danger"
            onClick={() => {
              clearUnsaved();
              onDismiss();
            }}
          >
            {t("pending.discard.and.close")}
          </button>
        </section>
      )}
    </Dialog>
  );
}
