// R9 shared I/O bound source of truth, generated from src-tauri/src/p4/bounds.rs.
// Do not hand-edit: run `node scripts/generate-io-bounds.mjs` after changing that
// file. `npm run test:web` runs the same script with --check and fails when the
// host and the UI drift apart.

/** Interval of the UI operation watchdog. A tick only re-checks elapsed time. */
export const WATCHDOG_TICK_MS = 5000;

/**
 * Enforced limit per host command family, in milliseconds, measured from process
 * spawn until the child exits. The runner clamps every request to its family, so
 * this is both the host's backstop and the widest limit a caller may ask for.
 */
export const WORKSPACE_BOUNDS_MS = {
  workspaceRead: 30000,
  workspaceReadLong: 300000,
  workspaceCommand: 660000,
  workspaceSync: 600000,
  workspacePreview: 60000,
  workspaceBootstrap: 10000,
  workspaceOther: 180000,
} as const;

export type WorkspaceBound = keyof typeof WORKSPACE_BOUNDS_MS;

/** Inherited by every P4 process; no family may exceed it. */
export const P4_PROCESS_HARD_CAP_MS = 660000;

/**
 * How long the UI waits for one toolbar operation family before it treats the
 * result as unknown: the host limit plus IO_DEADLINE_HEADROOM_MS, so a command
 * that times out on the host still reports its own failure first.
 */
export const WORKSPACE_WATCHDOG_MS = {
  sync: 615000,
  getLatest: 615000,
  getRevision: 615000,
  refresh: 75000,
  other: 675000,
} as const;

export type WorkspaceWatchdogKind = keyof typeof WORKSPACE_WATCHDOG_MS;

/**
 * Slack the UI adds to a host limit for IPC and result reporting. The host does
 * not add it; it only sizes the late-result grace for unknown sync outcomes.
 */
export const IO_DEADLINE_HEADROOM_MS = 15000;

/** Late-host grace after the UI stopped waiting for an unknown `sync`. */
export const SYNC_LATE_RESULT_GRACE_MS = 15000;

export function workspaceBoundMs(bound: WorkspaceBound): number {
  return WORKSPACE_BOUNDS_MS[bound];
}

export function watchdogLimitMs(kind: WorkspaceWatchdogKind): number {
  return WORKSPACE_WATCHDOG_MS[kind];
}
