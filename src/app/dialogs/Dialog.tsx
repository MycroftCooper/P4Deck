import { localizeBackendError } from "../../shared/localizeError";
import { t, useIsZh } from "../../shared/i18n";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

export interface DialogProps {
  title: string;
  /** Optional prominent marker beside the title (e.g. a colored status badge). */
  titleBadge?: ReactNode;
  description?: string;
  children: ReactNode;
  footer: ReactNode;
  /** Omit the footer bar entirely (e.g. a dialog that only has per-row actions). */
  hideFooter?: boolean;
  onRequestClose(): void;
  source?: HTMLElement | null;
  busy?: boolean;
  zh: boolean;
  danger?: boolean;
}

/** One accessible shell; workflow components own validation and execution state. */
export function Dialog({
  title,
  titleBadge,
  description,
  children,
  footer,
  hideFooter = false,
  onRequestClose,
  source,
  busy = false,
  zh: _zh,
  danger,
}: DialogProps) {
  const titleId = useId(),
    descriptionId = useId();
  const ref = useRef<HTMLDialogElement>(null);
  const [origin] = useState(() => {
    const owner = source?.ownerDocument ?? document;
    return { owner, focus: source ?? owner.activeElement };
  });
  useEffect(() => {
    const dialog = ref.current!;
    dialog.showModal();
    dialog.querySelector<HTMLElement>("[data-dialog-autofocus]")?.focus();
    return () => {
      dialog.close();
      if (origin.focus?.isConnected && "focus" in origin.focus)
        (origin.focus as HTMLElement).focus({ preventScroll: true });
    };
  }, [origin]);
  return createPortal(
    <dialog
      ref={ref}
      className={`workflow-dialog ${danger ? "is-danger" : ""}`}
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      aria-busy={busy}
      onKeyDownCapture={(event) => {
        if (event.key !== "Tab") return;
        const dialog = event.currentTarget;
        const controls = [
          ...dialog.querySelectorAll<HTMLElement>(
            'button,input,select,textarea,a[href],[tabindex]:not([tabindex="-1"])',
          ),
        ].filter(
          (element) =>
            !element.matches(":disabled") &&
            element.tabIndex >= 0 &&
            element.getClientRects().length > 0,
        );
        const first = controls[0],
          last = controls.at(-1);
        if (!first) {
          event.preventDefault();
          dialog.focus();
          return;
        }
        const active = dialog.ownerDocument.activeElement;
        if (event.shiftKey && (active === first || active === dialog)) {
          event.preventDefault();
          last!.focus();
        } else if (!event.shiftKey && (active === last || active === dialog)) {
          event.preventDefault();
          first.focus();
        }
      }}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onRequestClose();
      }}
    >
      <header className="workflow-dialog-heading">
        <div>
          <div className="workflow-dialog-title">
            <h2 id={titleId}>{title}</h2>
            {titleBadge}
          </div>
          {description && <p id={descriptionId}>{description}</p>}
        </div>
        <button
          type="button"
          className="workflow-dialog-close"
          disabled={busy}
          onClick={onRequestClose}
          aria-label={t("dialogs.close.dialog")}
        >
          <X size={18} />
        </button>
      </header>
      <div
        className="workflow-dialog-body"
        tabIndex={0}
        aria-label={t("dialogs.dialog.content")}
      >
        {children}
      </div>
      {hideFooter ? null : (
        <footer className="workflow-dialog-footer">{footer}</footer>
      )}
    </dialog>,
    origin.owner.body,
  );
}

export function DialogNotice({
  children,
  error = false,
}: {
  children: ReactNode;
  error?: boolean;
}) {
  const zh = useIsZh();
  // Backend errors arrive as English text from Rust, which has no locale. Route
  // a plain string through the known-message table so Chinese users see Chinese;
  // anything unrecognised passes through unchanged.
  const body =
    error && typeof children === "string"
      ? localizeBackendError(children, zh)
      : children;
  return (
    <p
      className={`workflow-notice ${error ? "is-error" : ""}`}
      role={error ? "alert" : "status"}
    >
      {body}
    </p>
  );
}
