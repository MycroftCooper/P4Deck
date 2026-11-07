//! R9: the single source of truth for how long a workspace command may run.
//!
//! Before this module the limits were hard-coded in three unrelated places: the
//! runner defaulted to 120 s and clamped at 600 s, each call site passed its own
//! `timeout_ms` literal (300 s here, 660 s there, 120 s elsewhere), and the
//! frontend watchdog kept its own copy of 660 s / 60 s / 180 s. A command could
//! therefore be abandoned by the UI while the host still considered it alive, or
//! hold the toolbar long after the host had killed it.
//!
//! Now a command names an [`IoBound`] family, the runner enforces that family's
//! limit, and `src/shared/operationBounds.generated.ts` is generated from the
//! constants below by `scripts/generate-io-bounds.mjs`, so the UI reads the same
//! numbers instead of keeping copies. `npm run test:web` (and therefore CI) runs
//! that generator with `--check`, so the host and the UI cannot drift apart again
//! without failing the build.
//!
//! Only the *interpretation* stays side-specific: the host measures from process
//! spawn, while the UI budgets an extra [`IO_DEADLINE_HEADROOM_MS`] for IPC and
//! result reporting so a host timeout still reports its own failure first.
#![allow(dead_code)] // Not every family is referenced on every build; the
                     // generator and the tests read them all.

/// How long one `p4` process may run, measured from spawn until it exits.
///
/// The serialized value is the generated TS key (`workspaceRead`, ...). Requests
/// also cross the IPC boundary, so a caller that omits the field falls back to
/// the safe `Other` family instead of failing to deserialize.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum IoBound {
    /// Short read that must not block the caller: a bounded mapping/metadata probe.
    Read,
    /// Longer read: status snapshots, history, diffs, graph and search paging.
    ReadLong,
    /// A mutating workspace command (edit, add, delete, revert, submit, lock...).
    /// The widest interactive bound because a server-side operation may wait on a
    /// lock or on another user.
    Command,
    /// `p4 sync` / Get Latest, the only command allowed to pull large payloads.
    Sync,
    /// Connector check before an interactive read; short so a dead server is
    /// reported instead of spinning.
    Preview,
    /// Discovery at connect time.
    Bootstrap,
    /// Anything else: short local I/O and small remote queries.
    ///
    /// This is the runner fallback, so it is the limit most commands actually
    /// get. Raising it changes behaviour everywhere; give a command a family of
    /// its own instead when it needs more.
    #[default]
    Other,
}

impl IoBound {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Read => "workspaceRead",
            Self::ReadLong => "workspaceReadLong",
            Self::Command => "workspaceCommand",
            Self::Sync => "workspaceSync",
            Self::Preview => "workspacePreview",
            Self::Bootstrap => "workspaceBootstrap",
            Self::Other => "workspaceOther",
        }
    }

    pub const fn limit_ms(self) -> u64 {
        match self {
            Self::Read => WORKSPACE_READ_MS,
            Self::ReadLong => WORKSPACE_READ_LONG_MS,
            Self::Command => WORKSPACE_COMMAND_MS,
            Self::Sync => WORKSPACE_SYNC_MS,
            Self::Preview => WORKSPACE_PREVIEW_MS,
            Self::Bootstrap => WORKSPACE_BOOTSTRAP_MS,
            Self::Other => WORKSPACE_OTHER_MS,
        }
    }

    /// The limit a caller may ask for explicitly. A request can only narrow its
    /// family, never widen it, so a leftover literal cannot outlive the bound.
    pub fn limit_for_request(self, requested_ms: Option<u64>) -> u64 {
        requested_ms
            .map(|requested| requested.min(self.limit_ms()))
            .unwrap_or_else(|| self.limit_ms())
    }
}

/// Family of a short read that must not block the caller for long.
pub const WORKSPACE_READ_MS: u64 = 30_000; // generated: workspaceRead
/// Family of a long read (status, history, diff, graph, search).
pub const WORKSPACE_READ_LONG_MS: u64 = 300_000; // generated: workspaceReadLong
/// Family of a mutating workspace command.
pub const WORKSPACE_COMMAND_MS: u64 = 660_000; // generated: workspaceCommand
/// Family of a `p4 sync`/Get Latest transfer.
pub const WORKSPACE_SYNC_MS: u64 = 600_000; // generated: workspaceSync
/// Family of the connector check that precedes an interactive read.
pub const WORKSPACE_PREVIEW_MS: u64 = 60_000; // generated: workspacePreview
/// Family of connect-time discovery.
pub const WORKSPACE_BOOTSTRAP_MS: u64 = 10_000; // generated: workspaceBootstrap
/// Family of everything else, and the runner fallback.
pub const WORKSPACE_OTHER_MS: u64 = 180_000; // generated: workspaceOther

/// Inherited by *every* `p4` process, interactive or background: a stale child
/// must not outlive the command that started it, whatever family bound applies.
pub const P4_PROCESS_HARD_CAP_MS: u64 = WORKSPACE_COMMAND_MS; // generated: P4_PROCESS_HARD_CAP_MS

/// Slack the UI adds to a host limit for IPC and result reporting. The host does
/// not add it: a command that finished inside its limit is always reported before
/// the UI gives up waiting for it.
pub const IO_DEADLINE_HEADROOM_MS: u64 = 15_000; // generated: IO_DEADLINE_HEADROOM_MS

/// `sync` can change the workspace after the UI treats the result as unknown, so
/// this is the window the host keeps before declaring a timed-out `sync` safe to
/// abandon. Reserved: the runner does not yet wait after a timeout, it kills the
/// child immediately and reports `RunnerError::Timeout`.
pub const SYNC_LATE_RESULT_GRACE_MS: u64 = IO_DEADLINE_HEADROOM_MS; // generated: SYNC_LATE_RESULT_GRACE_MS

/// The watch interval of the frontend watchdog, in milliseconds.
pub const WATCHDOG_TICK_MS: u64 = 5_000; // generated: WATCHDOG_TICK_MS

// The UI watchdog is NOT listed here on purpose. A watchdog limit is always
// `family limit + IO_DEADLINE_HEADROOM_MS`, which is a rule, not data: keeping a
// second enum of pre-summed values would be a second copy of the same facts and
// would drift from the table above. The frontend derives it from
// `WORKSPACE_BOUNDS_MS` (see `src/app/shell/useOperationWatchdog.ts`).

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_family_stays_within_the_hard_cap() {
        for bound in [
            IoBound::Read,
            IoBound::ReadLong,
            IoBound::Command,
            IoBound::Sync,
            IoBound::Preview,
            IoBound::Bootstrap,
            IoBound::Other,
        ] {
            assert!(
                bound.limit_ms() <= P4_PROCESS_HARD_CAP_MS,
                "{} must not exceed the inherited hard cap",
                bound.as_str()
            );
        }
    }

    #[test]
    fn hard_cap_is_the_widest_limit_any_command_receives() {
        assert_eq!(P4_PROCESS_HARD_CAP_MS, 660_000);
        assert_eq!(IoBound::Command.limit_ms(), P4_PROCESS_HARD_CAP_MS);
        assert!(IoBound::Sync.limit_ms() <= P4_PROCESS_HARD_CAP_MS);
    }

    #[test]
    fn requests_are_clamped_to_their_family_never_widened() {
        assert_eq!(IoBound::Sync.limit_for_request(None), WORKSPACE_SYNC_MS);
        // The historical 600 s literal is now implied by the family.
        assert_eq!(IoBound::Sync.limit_for_request(Some(600_000)), 600_000);
        // A caller cannot outlive its family.
        assert_eq!(IoBound::Read.limit_for_request(Some(600_000)), 30_000);
        assert_eq!(IoBound::Other.limit_for_request(Some(10)), 10);
    }

    #[test]
    fn the_default_family_is_the_safe_fallback() {
        assert_eq!(IoBound::default(), IoBound::Other);
        assert_eq!(IoBound::Other.limit_for_request(None), WORKSPACE_OTHER_MS);
    }

    #[test]
    fn watchdog_headroom_and_tick_are_consistent() {
        assert_eq!(IO_DEADLINE_HEADROOM_MS, 15_000);
        // The tick must be much finer than the headroom, otherwise the watchdog
        // could overshoot by a whole tick and still be inside its slack budget.
        const { assert!(WATCHDOG_TICK_MS < IO_DEADLINE_HEADROOM_MS / 2) };
        assert_eq!(SYNC_LATE_RESULT_GRACE_MS, IO_DEADLINE_HEADROOM_MS);
    }
}
