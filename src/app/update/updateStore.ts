import { useSyncExternalStore } from "react";

/** One updater session: check, download/install, then restart. */
export type UpdatePhase =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "installing"
  | "ready"
  | "restarting"
  | "error";

export type UpdateFailureScope = "check" | "download" | "install" | "restart";

export interface UpdateSnapshot {
  phase: UpdatePhase;
  /** Version currently running; filled from the bundle or the update manifest. */
  currentVersion: string;
  /** Version announced by the update server when an update is available. */
  version?: string;
  /** Release notes from the update manifest, when the server provides them. */
  notes?: string;
  /** Installer size in bytes; known once the download starts. */
  totalBytes?: number;
  downloadedBytes: number;
  /** True once the confirmed `install()` ran; no later check may replace it. */
  applied: boolean;
  /** Raw host reason of the last failure; the panel shows it for diagnosis. */
  error?: string;
  errorScope?: UpdateFailureScope;
}

const initial: UpdateSnapshot = {
  phase: "idle",
  currentVersion: "",
  downloadedBytes: 0,
  applied: false,
};

let snapshot = initial;
const listeners = new Set<() => void>();
const emit = () => {
  for (const listener of listeners) listener();
};

/** Module store in the same style as the other projection stores in `src`. */
export const updateStore = {
  getSnapshot: () => snapshot,
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  /** Merge a single transition; the service owns phase ordering. */
  patch(next: Partial<UpdateSnapshot>) {
    snapshot = { ...snapshot, ...next };
    emit();
  },
  reset() {
    snapshot = initial;
    emit();
  },
};

export const useUpdateSnapshot = () =>
  useSyncExternalStore(
    updateStore.subscribe,
    updateStore.getSnapshot,
    () => initial,
  );

/** Entry states that must stay reachable from the titlebar until handled. */
const attention: ReadonlySet<UpdatePhase> = new Set([
  "available",
  "downloading",
  "installing",
  "ready",
  "error",
]);

export const updateNeedsAttention = (phase: UpdatePhase) =>
  attention.has(phase);

/** Download percentage, or `undefined` while the server has not sent a size. */
export function updateProgress(snapshot: UpdateSnapshot): number | undefined {
  const { totalBytes, downloadedBytes } = snapshot;
  if (!totalBytes || totalBytes <= 0) return undefined;
  return Math.min(100, Math.round((downloadedBytes / totalBytes) * 100));
}
