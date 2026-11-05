import type { MsgKey } from "../../shared/i18n/catalog.zh";
import { tFor } from "../../shared/i18n";
import { notifyFailure, notifyUser } from "../../shared/notice";
import {
  checkForUpdate,
  currentAppVersion,
  isMainWindow,
  isWindowsPlatform,
  relaunchApp,
  type PendingUpdate,
} from "./updaterClient";
import {
  updateStore,
  type UpdateFailureScope,
  type UpdatePhase,
} from "./updateStore";

/** Startup check plus one check every six hours while the app stays open. */
export const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

let pending: PendingUpdate | null = null;
let timer: ReturnType<typeof setInterval> | undefined;
let watching = false;
/** Checks launched by the watcher that may still be in flight after `stop`. */
const inFlightChecks = new Set<Promise<void>>();

const launchCheck = (): void => {
  const launched = checkForUpdates();
  inFlightChecks.add(launched);
  const done = () => {
    inFlightChecks.delete(launched);
  };
  launched.then(done, done);
};

/**
 * Test/teardown helper: resolves once no watcher-launched check is in flight.
 * `stopUpdateWatcher` cannot cancel a check that already passed its guard (it
 * may be awaiting `currentAppVersion()`/the host), so callers that need a
 * quiescent counter (tests, `resetUpdateService`) await this.
 */
export async function settleUpdateWatcher(): Promise<void> {
  while (inFlightChecks.size) await Promise.allSettled([...inFlightChecks]);
}

const transitional: ReadonlySet<UpdatePhase> = new Set([
  "checking",
  "downloading",
  "installing",
  "restarting",
]);

const isTransitional = () => transitional.has(updateStore.getSnapshot().phase);

/** A downloaded update awaiting confirmation, or an already installed one. */
const hasUnfinishedUpdate = () => {
  const snapshot = updateStore.getSnapshot();
  return snapshot.applied || snapshot.phase === "ready";
};

function errorText(error: unknown): string {
  if (error instanceof Error)
    return error.message.trim() || error.name || "unknown error";
  if (typeof error === "string") return error.trim() || "unknown error";
  try {
    return JSON.stringify(error) ?? "unknown error";
  } catch {
    return "unknown error";
  }
}

/** Host failure categories; unknown details keep the generic fallback. */
const failureReasons: readonly [RegExp, string][] = [
  [
    /network|connect|timed? ?out|timeout|dns|offline|send request|econn|tls|certificate/i,
    "update.cannotReachServer",
  ],
  [
    /permission|denied|access is denied|elevat|privilege|not allowed/i,
    "update.installDenied",
  ],
  [/no space|disk|write failed|read-only/i, "update.writeFailed"],
];

/**
 * Signature/verification failures also happen during `check()` and download,
 * before any install started, so the copy must not claim "installation
 * cancelled" there.
 */
const verificationFailure =
  /signature|verif|integrity|checksum|malformed|invalid (?:update|manifest)/i;

/**
 * Localized reason for a failed check/download/install/restart. The raw host
 * message is kept separately in the panel, so the cause is never hidden behind
 * a generic "update failed".
 */
export function updateFailureText(
  error: string | undefined,
  scope: UpdateFailureScope,
  zh: boolean,
): string {
  if (scope === "restart")
    return tFor(zh ? "zh-CN" : "en-US", "update.the.update.is.installed.but");
  if (verificationFailure.test(error ?? ""))
    return scope === "install"
      ? tFor(
          zh ? "zh-CN" : "en-US",
          "update.the.update.package.failed.verification",
        )
      : tFor(
          zh ? "zh-CN" : "en-US",
          "update.the.update.package.failed.verification.2",
        );
  for (const [pattern, key] of failureReasons)
    if (pattern.test(error ?? ""))
      return tFor(zh ? "zh-CN" : "en-US", key as MsgKey);
  if (scope === "check")
    return tFor(zh ? "zh-CN" : "en-US", "update.the.update.check.failed");
  if (scope === "install")
    return tFor(zh ? "zh-CN" : "en-US", "update.installing.update.failed");
  return tFor(
    zh ? "zh-CN" : "en-US",
    "update.downloading.or.installing.the.update",
  );
}

function reportFailure(
  error: unknown,
  scope: UpdateFailureScope,
  phase: UpdatePhase,
  notify: boolean,
) {
  const detail = errorText(error);
  updateStore.patch({ phase, error: detail, errorScope: scope });
  if (!notify) return;
  notifyFailure(undefined, {
    zh: updateFailureText(detail, scope, true),
    en: updateFailureText(detail, scope, false),
  });
}

function releasePending() {
  const previous = pending;
  pending = null;
  if (previous) void previous.close().catch(() => {});
}

/**
 * Checks the configured endpoint. Automatic checks (startup and the six-hour
 * timer) stay silent when offline or not configured; manual checks report the
 * failure. A downloaded (or installed) update blocks new checks so the pending
 * confirmation can never be replaced. Outside the main Tauri window this is a
 * no-op.
 */
export async function checkForUpdates(
  options: { manual?: boolean; zh?: boolean } = {},
): Promise<void> {
  const { manual = false } = options;
  const zh = options.zh ?? true;
  if (!isMainWindow() || isTransitional() || hasUnfinishedUpdate()) return;
  updateStore.patch({
    phase: "checking",
    error: undefined,
    errorScope: undefined,
  });
  const version = await currentAppVersion();
  if (version) updateStore.patch({ currentVersion: version });
  let found: PendingUpdate | null;
  try {
    found = await checkForUpdate();
  } catch (error) {
    reportFailure(error, "check", manual ? "error" : "idle", manual);
    return;
  }
  if (!found) {
    releasePending();
    updateStore.patch({
      phase: "idle",
      version: undefined,
      notes: undefined,
      totalBytes: undefined,
      downloadedBytes: 0,
      applied: false,
      error: undefined,
      errorScope: undefined,
    });
    if (manual) {
      const current = updateStore.getSnapshot().currentVersion;
      notifyUser(
        current
          ? tFor(zh ? "zh-CN" : "en-US", "update.alreadyLatestVersion", {
              version: current,
            })
          : tFor(zh ? "zh-CN" : "en-US", "update.alreadyLatest"),
      );
    }
    return;
  }
  releasePending();
  pending = found;
  updateStore.patch({
    phase: "available",
    currentVersion: found.currentVersion,
    version: found.version,
    notes: found.notes,
    totalBytes: undefined,
    downloadedBytes: 0,
    applied: false,
    error: undefined,
    errorScope: undefined,
  });
}

/**
 * Downloads the announced update only. Installation is a separate, explicitly
 * confirmed step (`installAndRestart`) so Windows can show the confirmation
 * before the host closes the app.
 */
export async function downloadUpdate(): Promise<void> {
  const snapshot = updateStore.getSnapshot();
  if (snapshot.phase !== "available" || !pending) return;
  updateStore.patch({
    phase: "downloading",
    downloadedBytes: 0,
    totalBytes: undefined,
    applied: false,
    error: undefined,
    errorScope: undefined,
  });
  const update = pending;
  try {
    await update.download((event) => {
      const current = updateStore.getSnapshot();
      if (event.kind === "started") {
        if (event.contentLength && event.contentLength > 0)
          updateStore.patch({ totalBytes: event.contentLength });
      } else if (event.kind === "progress") {
        updateStore.patch({
          downloadedBytes: current.downloadedBytes + event.chunkLength,
        });
      } else {
        updateStore.patch({
          downloadedBytes: current.totalBytes ?? current.downloadedBytes,
        });
      }
    });
    const done = updateStore.getSnapshot();
    updateStore.patch({
      phase: "ready",
      downloadedBytes: done.totalBytes ?? done.downloadedBytes,
      error: undefined,
      errorScope: undefined,
    });
  } catch (error) {
    reportFailure(error, "download", "error", true);
  }
}

/**
 * Installs the downloaded update after the user's confirmation.
 *
 * Windows: the host launches the passive NSIS installer and exits the process;
 * the installer relaunches the app, so JS never calls `relaunch`.
 * macOS/Linux: `install()` resolves, then the app relaunches.
 */
export async function installAndRestart(): Promise<void> {
  const snapshot = updateStore.getSnapshot();
  if (snapshot.phase !== "ready" || snapshot.applied || !pending) return;
  const update = pending;
  updateStore.patch({
    phase: "installing",
    error: undefined,
    errorScope: undefined,
  });
  try {
    await update.install();
  } catch (error) {
    reportFailure(error, "install", "error", true);
    return;
  }
  updateStore.patch({ applied: true, phase: "restarting" });
  if (isWindowsPlatform()) return;
  try {
    await relaunchApp();
  } catch (error) {
    reportFailure(error, "restart", "error", true);
  }
}

/**
 * Starts the startup check and the six-hour interval. The returned cleanup is
 * safe to call from a React effect (including StrictMode double invocation).
 */
export function startUpdateWatcher(
  intervalMs = UPDATE_CHECK_INTERVAL_MS,
): () => void {
  if (!isMainWindow() || watching) return () => {};
  watching = true;
  launchCheck();
  timer = setInterval(() => {
    if (watching) launchCheck();
  }, intervalMs);
  return stopUpdateWatcher;
}

export function stopUpdateWatcher() {
  // Flip the flag first so a callback already queued behind a long task cannot
  // launch one more check after the interval is cleared.
  watching = false;
  if (timer !== undefined) clearInterval(timer);
  timer = undefined;
}

/** Test/teardown helper: cancels timers and releases the host update resource. */
export async function resetUpdateService(): Promise<void> {
  stopUpdateWatcher();
  await settleUpdateWatcher();
  const previous = pending;
  pending = null;
  updateStore.reset();
  await previous?.close().catch(() => {});
}
