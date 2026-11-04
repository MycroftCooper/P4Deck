import { t } from "../../../shared/i18n";
import { useEffect, useId, useRef, useState } from "react";
import { useUnsavedEditor } from "../../../app/closeGuard";
import { Dialog, DialogNotice } from "../../../app/dialogs/Dialog";

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
  const generation = useRef(0);
  useEffect(() => {
    return () => {
      generation.current += 1;
    };
  }, []);
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
      setError(
        t("pending.a.numbered.changelist.is.required"),
      );
      return;
    }
    const draft = {
      description: description.trim(),
      jobs: mode === "edit" ? [...(initial?.jobs ?? [])] : [],
    };
    if (!onSubmit) {
      setNotice(
        tr(
          "表单检查通过。这是界面预览，尚未创建或保存 CL。",
          "Form checked. UI preview only: no changelist was created or saved.",
        ),
      );
      return;
    }
    running.current = true;
    const requestGeneration = generation.current;
    setBusy(true);
    try {
      await onSubmit(draft);
      if (generation.current === requestGeneration) {
        clearUnsaved();
        onDismiss();
      }
    } catch (cause) {
      if (generation.current === requestGeneration) setError(String(cause));
    } finally {
      running.current = false;
      if (generation.current === requestGeneration) setBusy(false);
    }
  }
  return (
    <Dialog
      title={
        mode === "create"
          ? t("pending.new.changelist.2")
          : tr(`编辑 CL ${changeId ?? ""}`, `Edit CL ${changeId ?? ""}`)
      }
      description={tr(
        "描述这组变更；新建 CL 不会自动移动文件或提交。",
        "Describe the changes. Creating a CL does not move or submit files.",
      )}
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
      {!onSubmit && (
        <DialogNotice>
          {tr(
            "界面预览 · 未连接 CL 写入流程，不会访问 P4 服务器。",
            "UI preview · CL writing is not connected. No P4 server requests.",
          )}
        </DialogNotice>
      )}
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
          <p>
            {tr(
              "关闭将丢弃此次输入，是否继续？",
              "Closing discards this draft. Continue?",
            )}
          </p>
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
