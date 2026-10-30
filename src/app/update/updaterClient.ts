import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

/** Normalized download event; the plugin emits Started/Progress/Finished. */
export type UpdateProgressEvent =
  | { kind: "started"; contentLength?: number }
  | { kind: "progress"; chunkLength: number }
  | { kind: "finished" };

const downloadEvent = (event: {
  event: "Started" | "Progress" | "Finished";
  data?: { contentLength?: number; chunkLength?: number };
}): UpdateProgressEvent =>
  event.event === "Started"
    ? { kind: "started", contentLength: event.data?.contentLength }
    : event.event === "Progress"
      ? { kind: "progress", chunkLength: event.data?.chunkLength ?? 0 }
      : { kind: "finished" };

/** The announced update, holding the host-side resource from `check()`. */
export interface PendingUpdate {
  currentVersion: string;
  version: string;
  /** Release notes from the manifest (`body` in the plugin API). */
  notes?: string;
  /** Downloads the package only; installing waits for explicit confirmation. */
  download(onEvent: (event: UpdateProgressEvent) => void): Promise<void>;
  /**
   * Installs the downloaded package. Windows launches the NSIS installer and
   * exits the process (the installer relaunches the app); macOS/Linux resolve
   * and the caller relaunches. Never called without the user's confirmation.
   */
  install(): Promise<void>;
  close(): Promise<void>;
}

/**
 * The updater plugins are imported lazily: the browser build and hosts without
 * the updater configured must never fail at module load, they simply see no
 * update. This module is the only place that touches the plugin public API.
 */
export async function checkForUpdate(): Promise<PendingUpdate | null> {
  const { check } = await import("@tauri-apps/plugin-updater");
  const update = await check();
  if (!update) return null;
  return {
    currentVersion: update.currentVersion,
    version: update.version,
    notes: update.body,
    download: (onEvent) =>
      update.download((event) =>
        onEvent(
          downloadEvent(
            event as {
              event: "Started" | "Progress" | "Finished";
              data?: { contentLength?: number; chunkLength?: number };
            },
          ),
        ),
      ),
    // Windows only: let the passive NSIS installer relaunch the app (`/R`).
    install: () => update.install({ restartAfterInstall: true }),
    close: () => update.close(),
  };
}

export async function relaunchApp(): Promise<void> {
  const { relaunch } = await import("@tauri-apps/plugin-process");
  await relaunch();
}

/**
 * Windows install exits the app and the NSIS installer relaunches it, so the JS
 * side must not call `relaunch` there. Used for the confirmation button copy.
 */
export function isWindowsPlatform(): boolean {
  try {
    return /windows/i.test(navigator.userAgent);
  } catch {
    return false;
  }
}

/** Running bundle version; `undefined` outside Tauri or when the host refuses. */
export async function currentAppVersion(): Promise<string | undefined> {
  if (!isTauri()) return undefined;
  try {
    const { getVersion } = await import("@tauri-apps/api/app");
    return await getVersion();
  } catch {
    return undefined;
  }
}

/** Updates belong to the main window only; detached panels must not check. */
export function isMainWindow(): boolean {
  if (!isTauri()) return false;
  try {
    return getCurrentWindow().label === "main";
  } catch {
    return false;
  }
}
