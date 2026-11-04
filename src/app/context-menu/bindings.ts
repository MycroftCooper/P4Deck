import { writeClipboardText } from "../../infrastructure/clipboard";
import type { MenuAction } from "./model";

export const action = (
  run: (source?: HTMLElement) => void | Promise<unknown>,
  reason?: string,
): MenuAction => ({ run, reason });
export const copy = (value?: string | number): MenuAction => ({
  run: () => writeClipboardText(String(value ?? "")),
  reason:
    value === undefined || value === ""
      ? "没有可复制的内容 / Nothing to copy"
      : undefined,
});
/**
 * Serialises only when the item is run: large derived payloads (e.g. a table
 * as TSV) must never be built just to open the menu.
 */
export const copyLazy = (read: () => string, reason?: string): MenuAction => ({
  run: () => writeClipboardText(read()),
  reason,
});
export const unavailable = (reason: string): MenuAction => ({ reason });
export function selectText(element: HTMLElement | null) {
  if (!element) return;
  const range = document.createRange();
  range.selectNodeContents(element);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}
