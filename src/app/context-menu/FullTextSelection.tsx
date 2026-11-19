import { t } from "../../shared/i18n";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/** Explicit full-text selection avoids pretending virtualized off-screen rows are selected. */
export function useFullTextSelection() {
  const surface = useRef<HTMLElement | null>(null);
  const [content, setContent] = useState<{
    text: string;
    owner: Document;
    focus: Element | null;
  }>();
  return {
    surfaceRef: (element: HTMLElement | null) => {
      surface.current = element;
    },
    selectedText: () => {
      const selection = surface.current?.ownerDocument.getSelection();
      return selection &&
        surface.current?.contains(selection.anchorNode) &&
        surface.current.contains(selection.focusNode)
        ? selection.toString()
        : "";
    },
    selectAll: (text: string) => {
      const owner = surface.current?.ownerDocument ?? document;
      setContent({ text, owner, focus: owner.activeElement });
    },
    dialog:
      content !== undefined ? (
        <TextDialog {...content} close={() => setContent(undefined)} />
      ) : null,
  };
}
function TextDialog({
  text,
  owner,
  focus,
  close,
}: {
  text: string;
  owner: Document;
  focus: Element | null;
  close(): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
    input.current?.select();
    return () => {
      if (focus?.isConnected && "focus" in focus)
        (focus as HTMLElement).focus({ preventScroll: true });
    };
  }, []);
  return createPortal(
    <dialog
      ref={dialog}
      className="menu-text-dialog"
      onCancel={close}
      aria-label={t("shell.select.full.text")}
    >
      <header>
        {t("shell.full.text.readonly")}
        <button onClick={close}>{t("common.close")}</button>
      </header>
      <textarea
        ref={input}
        readOnly
        value={text}
        aria-label={t("shell.full.text")}
      />
      <p>{t("shell.full.text.hint")}</p>
    </dialog>,
    owner.body,
  );
}
