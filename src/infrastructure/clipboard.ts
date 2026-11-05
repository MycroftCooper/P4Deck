import { t } from "../shared/i18n";
import { isTauri } from "@tauri-apps/api/core";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
// Read only after an explicit paste click. Never poll or log clipboard contents.
export async function readClipboardText(): Promise<string> {
  if (isTauri()) return readText();
  try {
    return await navigator.clipboard.readText();
  } catch {
    throw new Error(t("common.cmd.v"));
  }
}
export async function writeClipboardText(text: string): Promise<void> {
  if (isTauri()) return writeText(text);
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    throw new Error(t("common.select.the.address.and.copy.it"));
  }
}
