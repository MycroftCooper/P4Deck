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
 *
 * The UI watchdog derives its wait from this table:
 * `family limit + IO_DEADLINE_HEADROOM_MS`. That is a rule, so it is not
 * pre-computed here — a second table of summed values would be a second copy of
 * the same facts and would drift.
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

/** Inherited by every P4 process; no family may exceed it. Mirrors the host. */
export const P4_PROCESS_HARD_CAP_MS = 660000;

/**
 * Slack the UI adds to a host limit for IPC and result reporting. The host does
 * not add it; it only sizes the late-result grace for unknown sync outcomes.
 */
export const IO_DEADLINE_HEADROOM_MS = 15000;

/**
 * Grace the host must keep before declaring a timed-out `sync` safe to abandon.
 * Reserved: the runner currently kills the child immediately on timeout.
 */
export const SYNC_LATE_RESULT_GRACE_MS = 15000;
