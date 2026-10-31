import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

export interface DialogProps {
  title: string;
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
  description,
  children,
  footer,
  hideFooter = false,
  onRequestClose,
  source,
  busy = false,
  zh,
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
          <h2 id={titleId}>{title}</h2>
          {description && <p id={descriptionId}>{description}</p>}
        </div>
        <button
          type="button"
          className="workflow-dialog-close"
          disabled={busy}
          onClick={onRequestClose}
          aria-label={zh ? "关闭对话框" : "Close dialog"}
        >
          <X size={18} />
        </button>
      </header>
      <div
        className="workflow-dialog-body"
        tabIndex={0}
        aria-label={zh ? "对话框内容" : "Dialog content"}
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
  return (
    <p
      className={`workflow-notice ${error ? "is-error" : ""}`}
      role={error ? "alert" : "status"}
    >
      {children}
    </p>
  );
}
