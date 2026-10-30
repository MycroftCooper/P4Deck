import { isTauri } from "@tauri-apps/api/core";

/**
 * UI-15 native executable picker. Desktop-only: the dialog plugin is dynamically imported so the
 * browser bundle never needs it. Cancel (null), plugin/capability errors and non-Tauri windows all
 * resolve undefined; the caller simply leaves the field unchanged.
 */
export async function canPickExecutables(): Promise<boolean> {
  if (!isTauri()) return false;
  try {
    await import("@tauri-apps/plugin-dialog");
    return true;
  } catch {
    return false;
  }
}

export async function pickExecutablePath(): Promise<string | undefined> {
  if (!isTauri()) return undefined;
  try {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected = await open({
      multiple: false,
      directory: false,
      filters: [{ name: "Executable", extensions: ["exe"] }],
    });
    return typeof selected === "string" && selected.trim()
      ? selected
      : undefined;
  } catch {
    return undefined;
  }
}
