import { isTauri } from "@tauri-apps/api/core";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
// Read only after an explicit paste click. Never poll or log clipboard contents.
export async function readClipboardText(): Promise<string> {
  if (isTauri()) return readText();
  try {
    return await navigator.clipboard.readText();
  } catch {
    throw new Error(
      "无法读取剪贴板，请在地址栏按 Ctrl/Cmd+V 粘贴 / Paste into the address bar with Ctrl/Cmd+V",
    );
  }
}
export async function writeClipboardText(text: string): Promise<void> {
  if (isTauri()) return writeText(text);
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    throw new Error(
      "无法写入剪贴板，请选中地址后复制 / Select the address and copy it manually",
    );
  }
}
