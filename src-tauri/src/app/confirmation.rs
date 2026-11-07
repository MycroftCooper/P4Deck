//! The single preflight/confirm state machine shared by every mutating domain.
//!
//! Every guarded write in P4Deck (sync, submit, shelf/unshelve/resolve/move,
//! branch mapping, stream switch, rename/move, lock/unlock, connection spec
//! creation) used to spell out the same five steps by hand:
//!
//! 1. **preflight** reads a fresh server snapshot and turns it into structured
//!    blockers/warnings plus a target snapshot and a preview digest;
//! 2. a **one-time token** binds that snapshot (and its digest) with a 120 s TTL;
//! 3. **confirm** applies the same decisions in the same order and refuses
//!    with the same vocabulary;
//! 4. the write runs inside the **mutation lane** for the target server, after
//!    the state has been re-checked, so a stale review cannot authorise a write;
//! 5. the outcome is a **structured result** (`outcome` + `failure` code), never
//!    a bare error string.
//!
//! [`ConfirmationTicket`] is that state machine written once. A service keeps
//! its own inspection and execution code and hands the five steps to the
//! ticket through [`ReviewSpec`].
//!
//! ## When a token is burned
//!
//! The domains differ in one detail and the ticket makes it explicit instead of
//! hiding it: most take the record at the start of `confirm` (a wrong target or
//! missing acknowledgement then costs the reviewer a new preflight), while
//! connection setup takes it only after every request-shape check passed (so
//! the UI can resubmit a corrected request against the same review). Both
//! orders apply the same decision sequence; [`Consumption`] selects the one the
//! domain already had.
//!
//! ## Wire compatibility
//!
//! Refusals carry a domain failure code, not the shared
//! [`ConfirmationRefusalCode`]. Every domain keeps its own `*FailureCode` enum
//! (already part of the TypeScript contract), and [`ReviewSpec`] translates the
//! shared decision into it, so the JSON the frontend receives does not change.

use parking_lot::Mutex;
use std::{
    collections::HashMap,
    future::Future,
    pin::Pin,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
};
use tokio::sync::Mutex as AsyncMutex;
use uuid::Uuid;

/// Default lifetime of a review before its confirmation must be produced again.
pub const DEFAULT_CONFIRMATION_TTL_MS: u64 = 120_000;

/// Wall-clock milliseconds since the Unix epoch.
///
/// Domains used to each carry a private copy of this helper; one clock keeps
/// TTL reasoning comparable everywhere.
pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

/// What a stored confirmation record has to expose to the store.
pub trait ExpiringConfirmation {
    fn expires_at(&self) -> i64;
}

/// The shared decision vocabulary.
///
/// This is the taxonomy the hand-written copies had drifted away from. It is
/// not serialised: each domain keeps its own failure enum for the wire and maps
/// these decisions onto it, so no frontend contract changes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConfirmationRefusalCode {
    /// No record exists for the token: never issued, already consumed, or
    /// dropped by expiry pruning.
    TokenUnknown,
    /// The record exists but its review window closed.
    TokenExpired,
    /// The confirmation names a different target or review digest than the
    /// issued record.
    TargetMismatch,
    /// A risky or destructive review was not acknowledged.
    AcknowledgementRequired,
    /// The active profile/connection/workspace/generation is no longer the one
    /// the review was made against.
    ContextChanged,
    /// The re-check now reports blockers the review did not have. Kept apart
    /// from [`Self::RecheckChanged`]: domains report it as a "no longer passes
    /// preflight" refusal, not a "the plan moved" one.
    RecheckBlocked,
    /// The re-check ran and disagrees with the reviewed snapshot.
    RecheckChanged,
    /// The re-check could not produce a trustworthy snapshot.
    RecheckUnavailable,
    /// The write lane closed before the mutation ran.
    Cancelled,
}

/// Acknowledgement flags a confirmation may require.
///
/// A flag required for the review must also be present on the confirmation,
/// otherwise the ticket refuses with
/// [`ConfirmationRefusalCode::AcknowledgementRequired`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Acknowledgement {
    /// Forced, destructive, or otherwise escalated behaviour accepted.
    pub danger: bool,
    /// Reviewed warnings accepted.
    pub warnings: bool,
}

impl Acknowledgement {
    /// Nothing needs to be accepted.
    pub const NONE: Self = Self {
        danger: false,
        warnings: false,
    };

    /// The flags a review requires, given the reviewer's booleans.
    pub const fn required(danger: bool, warnings: bool) -> Self {
        Self { danger, warnings }
    }

    /// Whether every required flag is present.
    pub const fn covered_by(self, acknowledged: Self) -> bool {
        (!self.danger || acknowledged.danger) && (!self.warnings || acknowledged.warnings)
    }
}

/// The confirmation request a domain hands to [`ConfirmationTicket::confirm`].
#[derive(Debug, Clone, Copy)]
pub struct ConfirmationRequest<'a, T, D> {
    pub token: &'a str,
    /// Target snapshot echoed back by the caller; must equal the reviewed one.
    pub target: &'a T,
    /// Preview/state digest echoed back by the caller.
    pub digest: Option<&'a D>,
    /// Flags the confirmation itself asserts.
    pub acknowledged: Acknowledgement,
}

impl<'a, T, D> ConfirmationRequest<'a, T, D> {
    /// A request binding only the target snapshot.
    pub fn new(token: &'a str, target: &'a T) -> Self {
        Self {
            token,
            target,
            digest: None,
            acknowledged: Acknowledgement::NONE,
        }
    }

    /// Also bind the preview/state digest the caller reviewed.
    pub fn with_digest(mut self, digest: &'a D) -> Self {
        self.digest = Some(digest);
        self
    }
}

/// Why [`ConfirmationTicket::confirm`] stopped before the mutation ran.
#[derive(Debug, Clone)]
#[allow(dead_code)] // `shared` is the taxonomy name; callers map by `code`.
pub enum ConfirmRefusal<R> {
    /// Refused with the domain's own failure code; nothing was executed.
    Refused {
        shared: ConfirmationRefusalCode,
        code: R,
        message: String,
        /// Set when the refusal was decided after the re-check ran; the domain
        /// uses it to fill in refreshed paths/counts or the re-check's
        /// operation ids, exactly as its hand-written code did.
        recheck: Option<Box<RecheckedDetail>>,
    },
    /// The write lane closed (the operation was cancelled) before the mutation.
    Cancelled,
}

/// Recheck detail captured for a refusal decided after the re-check.
#[derive(Debug, Clone, Default)]
pub struct RecheckedDetail {
    /// Operation ids produced by the re-check, when the domain reports them.
    pub operation_ids: Vec<String>,
}

impl RecheckedDetail {
    pub fn with_operation_ids(operation_ids: Vec<String>) -> Self {
        Self { operation_ids }
    }
}

impl<R: Copy> ConfirmRefusal<R> {
    /// The domain failure code to report.
    pub fn code(&self) -> Option<R> {
        match self {
            Self::Refused { code, .. } => Some(*code),
            Self::Cancelled => None,
        }
    }

    pub fn message(&self) -> Option<&str> {
        match self {
            Self::Refused { message, .. } => Some(message),
            Self::Cancelled => None,
        }
    }

    /// Operation ids of the re-check, when the refusal happened after it.
    #[allow(dead_code)] // surfaced for domains that report re-check log ids
    pub fn recheck_operation_ids(&self) -> &[String] {
        match self {
            Self::Refused {
                recheck: Some(detail),
                ..
            } => &detail.operation_ids,
            _ => &[],
        }
    }

    /// Re-attach the service-specific operation ids of the re-check, so the
    /// reported refusal points at the same log entries it always did.
    pub fn with_recheck_operation_ids(mut self, operation_ids: Vec<String>) -> Self {
        if let Self::Refused { recheck, .. } = &mut self {
            *recheck = Some(Box::new(RecheckedDetail::with_operation_ids(operation_ids)));
        }
        self
    }

    pub fn is_cancelled(&self) -> bool {
        matches!(self, Self::Cancelled)
    }

    /// Whether the refusal was decided after the re-check ran.
    pub fn after_recheck(&self) -> bool {
        matches!(
            self,
            Self::Refused {
                recheck: Some(_),
                ..
            }
        )
    }

    /// Mark a refusal as decided after the re-check ran.
    fn after_recheck_run(mut self) -> Self {
        if let Self::Refused { recheck, .. } = &mut self {
            recheck.get_or_insert_with(|| Box::new(RecheckedDetail::default()));
        }
        self
    }
}

/// Where a re-check stands relative to the reviewed snapshot.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RecheckVerdict {
    /// Still identical: the reviewed plan is still valid.
    Unchanged,
    /// The re-check now reports blockers the review did not have. The domain
    /// decides which code this is (sync: `PreflightBlocked`, stream: the
    /// "workspace risks now block" arm), so it must not be folded into
    /// [`Self::Changed`].
    Blocked,
    /// The server view moved since the review.
    Changed,
}

/// What the review needs from its domain.
///
/// The ticket calls these in a fixed order, so every domain refuses for the
/// same reason at the same step. A domain only supplies the decisions that are
/// genuinely its own.
pub trait ReviewSpec {
    /// Snapshot echoed by the caller and stored with the token.
    type Target;
    /// Preview/state digest echoed by the caller and stored with the token.
    type Digest;
    /// The snapshot produced by re-checking the server.
    type Recheck;
    /// What the mutation produced.
    type Output;
    /// The domain failure code that represents a shared refusal.
    type RefusalCode: Copy + Send;
    /// The domain's confirm error: a refusal, or anything the domain needs to
    /// report after (or instead of) executing.
    type Error: From<ConfirmRefusal<Self::RefusalCode>> + Send;

    /// Lift the domain error back into the shared refusal vocabulary.
    fn unwrap_error(error: Self::Error) -> ConfirmRefusal<Self::RefusalCode>;

    /// Domain code for a shared refusal. Domains whose enum does not name a
    /// decision separately return the code they already used for it.
    fn refusal_code(&self, shared: ConfirmationRefusalCode) -> Self::RefusalCode;

    /// Message shown for a shared refusal.
    fn refusal_message(&self, shared: ConfirmationRefusalCode) -> &'static str;

    /// Flags the review requires, read from the consumed record: whatever the
    /// review found risky is stored with the token, so a caller cannot clear
    /// the requirement by omitting a field on the wire.
    fn required_acknowledgement(
        &self,
        _reviewed: &IssuedConfirmation<Self::Target, Self::Digest>,
    ) -> Acknowledgement {
        Acknowledgement::NONE
    }

    /// Whether the active profile/connection/workspace/generation is still the
    /// reviewed one. Default: the domain has no separate context concept.
    fn context_current(&self) -> bool {
        true
    }

    /// Hand the consumed record to the domain before the re-check, so the
    /// domain can build its per-file plan from the reviewed snapshot instead of
    /// the request echo (file lock, rename, connection setup all did this).
    fn on_reviewed(&mut self, _reviewed: &IssuedConfirmation<Self::Target, Self::Digest>) {}

    /// Take the server write lane for `(server, operation_id)`.
    ///
    /// Called once the review proved current, before the re-check, and held
    /// until the mutation returns — the same window the hand-written flows
    /// held it for. `admitted` is the guard a caller took before calling
    /// `confirm` (production IPC does); the default returns `None`, meaning the
    /// domain acquires the lane itself inside `recheck`/`execute`.
    fn lane(&mut self, _operation_id: &str) -> BoxFuture<'_, Option<MutationLane>> {
        Box::pin(async { None })
    }

    /// Re-read the server state the review was built from.
    fn recheck(&mut self) -> BoxFuture<'_, Result<Self::Recheck, String>>;

    /// Compare the re-check with the reviewed snapshot.
    fn recheck_verdict(&self, recheck: &Self::Recheck) -> RecheckVerdict;

    /// Whether the domain aborted while waiting for the write lane.
    fn lane_closed(&self) -> bool {
        false
    }

    /// The mutex the domain already serialises confirmations of this family on.
    ///
    /// There is deliberately **no default**: a fresh mutex per call would
    /// serialise nothing, and would also not be the mutex the domain's
    /// `clear_confirmations`/context-switch path locks. Every spec must return
    /// the domain's own field (or the shared [`confirmation_gate`] it was
    /// constructed with).
    fn gate(&self) -> Arc<AsyncMutex<()>>;

    /// Run the mutation and map it to the domain result. Boxed so the trait
    /// stays object-free while domains keep concrete `async fn` bodies.
    fn execute<'a>(
        &'a mut self,
        recheck: Self::Recheck,
        operation_id: String,
    ) -> BoxFuture<'a, Result<Self::Output, Self::Error>>;
}

/// A held write-lane guard handed back by [`ReviewSpec::lane`].
pub type MutationLane = Box<dyn std::any::Any + Send>;

/// A boxed, `Send` future returned by [`ReviewSpec`].
pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// The reviewed state a token binds.
#[derive(Debug, Clone)]
pub struct IssuedConfirmation<T, D> {
    pub target: T,
    pub digest: D,
    pub expires_at: i64,
}

impl<T, D> IssuedConfirmation<T, D> {
    pub fn new(target: T, digest: D, expires_at: i64) -> Self {
        Self {
            target,
            digest,
            expires_at,
        }
    }
}

impl<T, D> ExpiringConfirmation for IssuedConfirmation<T, D> {
    fn expires_at(&self) -> i64 {
        self.expires_at
    }
}

/// One-time, expiring storage for reviewed confirmations.
pub struct ConfirmationStore<R> {
    records: Mutex<HashMap<String, R>>,
}

impl<R: ExpiringConfirmation> Default for ConfirmationStore<R> {
    fn default() -> Self {
        Self {
            records: Mutex::new(HashMap::new()),
        }
    }
}

impl<R: ExpiringConfirmation> ConfirmationStore<R> {
    /// Store a record and return the opaque token that unlocks it.
    pub fn issue(&self, record: R, now_ms: i64) -> String {
        let token = Uuid::new_v4().to_string();
        let mut records = self.records.lock();
        records.retain(|_, item| item.expires_at() > now_ms);
        records.insert(token.clone(), record);
        token
    }

    /// Take the record for `token`; it cannot be consumed twice.
    pub fn consume(&self, token: &str) -> Option<R> {
        self.records.lock().remove(token)
    }

    /// Drop every outstanding confirmation (context switch, shutdown).
    pub fn clear(&self) {
        self.records.lock().clear();
    }

    /// Number of outstanding confirmations; used by tests and diagnostics.
    pub fn outstanding(&self) -> usize {
        self.records.lock().len()
    }
}

/// The shared preflight → token → recheck → lane → execute state machine.
pub struct ConfirmationTicket<T, D> {
    store: ConfirmationStore<IssuedConfirmation<T, D>>,
    /// Serialises confirmations of this family so a double click cannot race
    /// two consumers for the same token. Domains that already own a
    /// confirmation mutex hand it over with [`ConfirmationTicket::with_gate`]
    /// so their pre-existing `clear`/context-switch code keeps serialising
    /// against the same mutex.
    gate: Arc<AsyncMutex<()>>,
    /// Number of confirmations currently holding the gate.
    gate_depth: AtomicU64,
    ttl_ms: u64,
}

impl<T, D> Default for ConfirmationTicket<T, D> {
    fn default() -> Self {
        Self::new(DEFAULT_CONFIRMATION_TTL_MS)
    }
}

impl<T, D> ConfirmationTicket<T, D> {
    pub fn new(ttl_ms: u64) -> Self {
        Self::with_gate(ttl_ms, None)
    }

    /// Build a ticket on an existing confirmation mutex (see [`Self::gate`]).
    pub fn with_gate(ttl_ms: u64, gate: Option<Arc<AsyncMutex<()>>>) -> Self {
        Self {
            store: ConfirmationStore::default(),
            gate: gate.unwrap_or_else(|| Arc::new(AsyncMutex::new(()))),
            gate_depth: AtomicU64::new(0),
            ttl_ms: ttl_ms.max(1),
        }
    }

    pub fn ttl_ms(&self) -> u64 {
        self.ttl_ms
    }

    /// The gate every confirmation of this family holds. Services that also
    /// serialise a re-check performed outside `confirm` use this so the two
    /// cannot interleave.
    #[allow(dead_code)] // domains that also serialise an out-of-ticket re-check
    pub fn gate(&self) -> Arc<AsyncMutex<()>> {
        self.gate.clone()
    }

    /// How many confirmations currently hold the gate; used by the mutation
    /// lane to assert that it is held while it is held.
    #[allow(dead_code)] // diagnostics and tests
    pub fn gate_depth(&self) -> u64 {
        self.gate_depth.load(Ordering::Acquire)
    }

    /// Start the review window and return `(expires_at, token)` when ready.
    ///
    /// A review that is not ready issues no token at all, so the UI can never
    /// confirm something it was told is blocked.
    pub fn issue(&self, ready: bool, target: T, digest: D) -> Option<(i64, String)> {
        let now = now_ms();
        let expires_at = now.saturating_add(self.ttl_ms as i64);
        if !ready {
            return None;
        }
        let token = self
            .store
            .issue(IssuedConfirmation::new(target, digest, expires_at), now);
        Some((expires_at, token))
    }

    /// Expiry stamped on a review that did not issue a token, so the UI can
    /// still show when a blocked review would have to be retaken.
    pub fn planned_expires_at(&self) -> i64 {
        now_ms().saturating_add(self.ttl_ms as i64)
    }

    /// Drop every outstanding confirmation for this family.
    ///
    /// Takes the family gate first, so a context switch cannot drop a token
    /// that an in-flight confirmation has already taken: the clear waits for
    /// that confirmation to finish, and a confirmation started after the clear
    /// finds no record. Callers must await this (it is the only way to make
    /// "changing context invalidates outstanding reviews" true).
    pub async fn clear(&self) {
        let _gate = self.gate.lock().await;
        self.store.clear();
    }

    #[allow(dead_code)] // diagnostics and tests
    pub fn outstanding(&self) -> usize {
        self.store.outstanding()
    }

    /// Take the reviewed record for `token` without running the ticket's
    /// decision sequence.
    ///
    /// Reserved for a domain whose combined request-shape check must stay in one
    /// place: connection setup refuses kind/expiry/context/generation/digest
    /// with a single `ConnectionChanged` at the same step, and can only do that
    /// while holding the record. The token is still one-use and the caller
    /// still enforces the TTL with [`now_ms`]. A domain that can use
    /// [`Self::confirm`] must use it instead.
    pub fn take(&self, token: &str) -> Option<IssuedConfirmation<T, D>> {
        self.store.consume(token)
    }

    /// Store an already-built review and return its token.
    ///
    /// For a domain that owns several families on one ticket (the workflow
    /// families ride their family and validated request in the digest slot), so
    /// the store, TTL, pruning and one-time guarantee stay the ticket's while
    /// the record is built by the caller.
    pub fn issue_review(&self, review: IssuedConfirmation<T, D>) -> String {
        self.store.issue(review, now_ms())
    }

    /// A stable operation id for this confirmation attempt, derived from the
    /// token so a duplicate dispatch keeps one journal identity.
    pub fn operation_id(&self, token: &str) -> String {
        format!("confirm-{token}")
    }

    /// Run the shared decision sequence and, if every step passes, the
    /// mutation:
    ///
    /// 1. token known and unexpired,
    /// 2. target and digest equal the reviewed ones,
    /// 3. required acknowledgements present,
    /// 4. context still the reviewed one,
    /// 5. write lane taken, then the state the review was built from is
    ///    re-checked and must still agree,
    /// 6. context and expiry still valid after the re-check,
    /// 7. lane still open, then execute.
    ///
    /// The gate is held for the whole call, so two confirmations of one family
    /// cannot interleave. Refusals decided after the re-check are flagged with
    /// [`ConfirmRefusal::after_recheck`] so the domain can attach the re-check's
    /// operation ids.
    pub async fn confirm<S>(
        &self,
        request: ConfirmationRequest<'_, T, D>,
        spec: &mut S,
    ) -> Result<S::Output, ConfirmRefusal<S::RefusalCode>>
    where
        T: PartialEq,
        D: PartialEq,
        S: ReviewSpec<Target = T, Digest = D>,
    {
        // Every confirmation of this family, and every holder waiting for it,
        // is counted BEFORE the wait so `gate_depth()` reports in-flight work
        // even while parked on the gate.
        let depth = GateDepth(&self.gate_depth);
        depth.enter();
        let _gate = spec.gate().lock_owned().await;

        // 1–4. Take the record first, then decide, exactly like the
        // hand-written flows did (a wrong target burns the token).
        let record = match self.store.consume(request.token) {
            Some(record) => record,
            None => return Err(refuse(ConfirmationRefusalCode::TokenUnknown, spec)),
        };
        check_record(&record, &request, spec)?;
        spec.on_reviewed(&record);

        // 5. Hold the server lane from the re-check through the write.
        let operation_id = self.operation_id(request.token);
        let lane = spec.lane(&operation_id).await;

        let recheck = match spec.recheck().await {
            Ok(recheck) => recheck,
            Err(_) => {
                return Err(
                    refuse(ConfirmationRefusalCode::RecheckUnavailable, spec).after_recheck_run()
                )
            }
        };
        match spec.recheck_verdict(&recheck) {
            RecheckVerdict::Unchanged => {}
            RecheckVerdict::Blocked => {
                return Err(
                    refuse(ConfirmationRefusalCode::RecheckBlocked, spec).after_recheck_run()
                )
            }
            RecheckVerdict::Changed => {
                return Err(
                    refuse(ConfirmationRefusalCode::RecheckChanged, spec).after_recheck_run()
                )
            }
        }

        // 6. The clock and the context kept moving while the re-check ran.
        if !spec.context_current() {
            return Err(refuse(ConfirmationRefusalCode::ContextChanged, spec).after_recheck_run());
        }
        if record.expires_at <= now_ms() {
            return Err(refuse(ConfirmationRefusalCode::TokenExpired, spec).after_recheck_run());
        }
        if spec.lane_closed() {
            return Err(ConfirmRefusal::Cancelled);
        }

        // 7. Execute while the lane guard is alive.
        let _lane = lane;
        let outcome = spec.execute(recheck, operation_id).await;
        outcome.map_err(S::unwrap_error)
    }
}

/// Steps 2–4 for a record that was already taken from the store.
fn check_record<S, T, D>(
    record: &IssuedConfirmation<T, D>,
    request: &ConfirmationRequest<'_, T, D>,
    spec: &S,
) -> Result<(), ConfirmRefusal<S::RefusalCode>>
where
    T: PartialEq,
    D: PartialEq,
    S: ReviewSpec<Target = T, Digest = D>,
{
    if record.expires_at <= now_ms() {
        return Err(refuse(ConfirmationRefusalCode::TokenExpired, spec));
    }
    if record.target != *request.target
        || request
            .digest
            .is_some_and(|digest| record.digest != *digest)
    {
        return Err(refuse(ConfirmationRefusalCode::TargetMismatch, spec));
    }
    if !spec
        .required_acknowledgement(record)
        .covered_by(request.acknowledged)
    {
        return Err(refuse(
            ConfirmationRefusalCode::AcknowledgementRequired,
            spec,
        ));
    }
    if !spec.context_current() {
        return Err(refuse(ConfirmationRefusalCode::ContextChanged, spec));
    }
    Ok(())
}

fn refuse<S>(shared: ConfirmationRefusalCode, spec: &S) -> ConfirmRefusal<S::RefusalCode>
where
    S: ReviewSpec,
{
    ConfirmRefusal::Refused {
        shared,
        code: spec.refusal_code(shared),
        message: spec.refusal_message(shared).to_string(),
        recheck: None,
    }
}

struct GateDepth<'a>(&'a AtomicU64);

impl GateDepth<'_> {
    fn enter(&self) {
        self.0.fetch_add(1, Ordering::AcqRel);
    }
}

impl Drop for GateDepth<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}

#[cfg(test)]
mod ticket_tests {
    //! Unit tests for the shared confirmation state machine.
    //!
    //! The fake below is a *plain struct target* plus a `ReviewSpec` with
    //! counters, so every branch of `ConfirmationTicket::confirm` is exercised
    //! without a p4 server. The only clock-dependent assertions use a 1 ms TTL
    //! plus a few-millisecond sleep; everything else is deterministic.

    use super::*;
    use std::sync::atomic::AtomicU32;

    /// Stand-in for a domain failure enum: `RefusalCode = u8` keeps the test
    /// independent of any service.
    const CODE_TOKEN_UNKNOWN: u8 = 1;
    const CODE_TOKEN_EXPIRED: u8 = 2;
    const CODE_TARGET_MISMATCH: u8 = 3;
    const CODE_ACK_REQUIRED: u8 = 4;
    const CODE_CONTEXT_CHANGED: u8 = 5;
    const CODE_RECHECK_BLOCKED: u8 = 9;
    const CODE_RECHECK_CHANGED: u8 = 6;
    const CODE_RECHECK_UNAVAILABLE: u8 = 7;
    const CODE_CANCELLED: u8 = 8;

    fn code_message(shared: ConfirmationRefusalCode) -> &'static str {
        match shared {
            ConfirmationRefusalCode::TokenUnknown => "unknown token",
            ConfirmationRefusalCode::TokenExpired => "expired token",
            ConfirmationRefusalCode::TargetMismatch => "target mismatch",
            ConfirmationRefusalCode::AcknowledgementRequired => "acknowledgement required",
            ConfirmationRefusalCode::ContextChanged => "context changed",
            ConfirmationRefusalCode::RecheckBlocked => "recheck blocked",
            ConfirmationRefusalCode::RecheckChanged => "recheck changed",
            ConfirmationRefusalCode::RecheckUnavailable => "recheck unavailable",
            ConfirmationRefusalCode::Cancelled => "cancelled",
        }
    }

    fn code_for(shared: ConfirmationRefusalCode) -> u8 {
        match shared {
            ConfirmationRefusalCode::TokenUnknown => CODE_TOKEN_UNKNOWN,
            ConfirmationRefusalCode::TokenExpired => CODE_TOKEN_EXPIRED,
            ConfirmationRefusalCode::TargetMismatch => CODE_TARGET_MISMATCH,
            ConfirmationRefusalCode::AcknowledgementRequired => CODE_ACK_REQUIRED,
            ConfirmationRefusalCode::ContextChanged => CODE_CONTEXT_CHANGED,
            ConfirmationRefusalCode::RecheckBlocked => CODE_RECHECK_BLOCKED,
            ConfirmationRefusalCode::RecheckChanged => CODE_RECHECK_CHANGED,
            ConfirmationRefusalCode::RecheckUnavailable => CODE_RECHECK_UNAVAILABLE,
            ConfirmationRefusalCode::Cancelled => CODE_CANCELLED,
        }
    }

    /// The reviewed snapshot. Plain data, no server.
    #[derive(Debug, Clone, PartialEq, Eq)]
    struct FakeTarget {
        server: String,
        revision: u32,
    }

    impl FakeTarget {
        fn new(revision: u32) -> Self {
            Self {
                server: "server:1666".into(),
                revision,
            }
        }
    }

    /// Counters proving which steps ran (and in which order for the ones that
    /// must not run).
    #[derive(Default)]
    struct Counters {
        rechecks: AtomicU32,
        executes: AtomicU32,
        reviewed: AtomicU32,
        lanes: AtomicU32,
    }

    impl Counters {
        fn get(counter: &AtomicU32) -> u32 {
            counter.load(Ordering::SeqCst)
        }
        fn bump(counter: &AtomicU32) {
            counter.fetch_add(1, Ordering::SeqCst);
        }
    }

    struct FakeSpec<'a> {
        counters: &'a Counters,
        /// Whether the re-check can produce a snapshot at all.
        recheck_available: bool,
        /// What the re-check reports.
        recheck_verdict: RecheckVerdict,
        /// Whether the runtime context still matches the review.
        context_current: bool,
        /// Flags the review requires (normally read from the stored record).
        required_acknowledgement: Acknowledgement,
        /// Whether the write lane closed while waiting for it.
        lane_closed: bool,
        /// Sleep between "lane taken" and "re-check", used for the
        /// expiry-while-waiting test.
        recheck_delay: Option<std::time::Duration>,
    }

    impl Default for FakeSpec<'_> {
        fn default() -> Self {
            Self {
                counters: &EMPTY_COUNTERS,
                recheck_available: true,
                recheck_verdict: RecheckVerdict::Unchanged,
                context_current: true,
                required_acknowledgement: Acknowledgement::NONE,
                lane_closed: false,
                recheck_delay: None,
            }
        }
    }
    /// The family gate the fake specs use: real domains return their own
    /// confirmation mutex here, so a fake that returned a fresh one per call
    /// would test nothing.
    fn fake_gate() -> Arc<AsyncMutex<()>> {
        static FAKE_GATE: std::sync::OnceLock<Arc<AsyncMutex<()>>> = std::sync::OnceLock::new();
        FAKE_GATE
            .get_or_init(|| Arc::new(AsyncMutex::new(())))
            .clone()
    }

    static EMPTY_COUNTERS: Counters = Counters {
        rechecks: AtomicU32::new(0),
        executes: AtomicU32::new(0),
        reviewed: AtomicU32::new(0),
        lanes: AtomicU32::new(0),
    };

    /// What the mutation "did": the target it saw and the operation id it was
    /// handed, so tests can prove the reviewed snapshot (not the request echo)
    /// reaches execution.
    #[derive(Debug, PartialEq, Eq)]
    struct FakeOutput {
        target: FakeTarget,
        operation_id: String,
    }

    impl ReviewSpec for FakeSpec<'_> {
        type Target = FakeTarget;
        type Digest = String;
        type Recheck = FakeTarget;
        type Output = FakeOutput;
        type RefusalCode = u8;
        type Error = ConfirmRefusal<u8>;

        fn unwrap_error(error: Self::Error) -> ConfirmRefusal<u8> {
            error
        }

        fn refusal_code(&self, shared: ConfirmationRefusalCode) -> u8 {
            code_for(shared)
        }

        fn refusal_message(&self, shared: ConfirmationRefusalCode) -> &'static str {
            code_message(shared)
        }

        fn required_acknowledgement(
            &self,
            _reviewed: &IssuedConfirmation<FakeTarget, String>,
        ) -> Acknowledgement {
            self.required_acknowledgement
        }

        fn context_current(&self) -> bool {
            self.context_current
        }

        fn on_reviewed(&mut self, _reviewed: &IssuedConfirmation<FakeTarget, String>) {
            Counters::bump(&self.counters.reviewed);
        }

        fn lane(&mut self, _operation_id: &str) -> BoxFuture<'_, Option<MutationLane>> {
            Counters::bump(&self.counters.lanes);
            Box::pin(async { None })
        }

        fn recheck(&mut self) -> BoxFuture<'_, Result<FakeTarget, String>> {
            Counters::bump(&self.counters.rechecks);
            let available = self.recheck_available;
            let delay = self.recheck_delay;
            Box::pin(async move {
                // A slow server re-check: the review window keeps running while
                // it is in flight, which is exactly what the post-recheck TTL
                // check exists for.
                if let Some(delay) = delay {
                    tokio::time::sleep(delay).await;
                }
                if available {
                    Ok(FakeTarget::new(0))
                } else {
                    Err("server unavailable".into())
                }
            })
        }

        fn recheck_verdict(&self, _recheck: &FakeTarget) -> RecheckVerdict {
            self.recheck_verdict
        }

        fn lane_closed(&self) -> bool {
            self.lane_closed
        }

        fn gate(&self) -> Arc<AsyncMutex<()>> {
            fake_gate()
        }

        fn execute<'a>(
            &'a mut self,
            recheck: FakeTarget,
            operation_id: String,
        ) -> BoxFuture<'a, Result<FakeOutput, ConfirmRefusal<u8>>> {
            Counters::bump(&self.counters.executes);
            Box::pin(async move {
                Ok(FakeOutput {
                    target: recheck,
                    operation_id,
                })
            })
        }
    }

    fn ticket() -> ConfirmationTicket<FakeTarget, String> {
        ConfirmationTicket::default()
    }

    /// A review whose runtime context drifts while the re-check runs: the
    /// ticket asks `context_current` before the lane and again afterwards.
    struct ContextDriftSpec<'a> {
        counters: &'a Counters,
        current_on_first_ask: bool,
    }

    impl ReviewSpec for ContextDriftSpec<'_> {
        type Target = FakeTarget;
        type Digest = String;
        type Recheck = FakeTarget;
        type Output = FakeOutput;
        type RefusalCode = u8;
        type Error = ConfirmRefusal<u8>;

        fn unwrap_error(error: Self::Error) -> ConfirmRefusal<u8> {
            error
        }

        fn refusal_code(&self, shared: ConfirmationRefusalCode) -> u8 {
            code_for(shared)
        }

        fn refusal_message(&self, shared: ConfirmationRefusalCode) -> &'static str {
            code_message(shared)
        }

        fn context_current(&self) -> bool {
            // The ticket asks before the lane and again right after the
            // re-check; answer `true` only to the first question.
            let asked = CONTEXT_DRIFT_ASKED.with(|asked| {
                let first = !asked.get();
                asked.set(true);
                first
            });
            self.current_on_first_ask && asked
        }

        fn gate(&self) -> Arc<AsyncMutex<()>> {
            fake_gate()
        }

        fn recheck(&mut self) -> BoxFuture<'_, Result<FakeTarget, String>> {
            Counters::bump(&self.counters.rechecks);
            Box::pin(async { Ok(FakeTarget::new(0)) })
        }

        fn recheck_verdict(&self, _recheck: &FakeTarget) -> RecheckVerdict {
            RecheckVerdict::Unchanged
        }

        fn execute<'a>(
            &'a mut self,
            recheck: FakeTarget,
            operation_id: String,
        ) -> BoxFuture<'a, Result<FakeOutput, ConfirmRefusal<u8>>> {
            Counters::bump(&self.counters.executes);
            Box::pin(async move {
                Ok(FakeOutput {
                    target: recheck,
                    operation_id,
                })
            })
        }
    }

    thread_local! {
        /// Whether this ticket run already asked "is the context still
        /// current?" once.
        static CONTEXT_DRIFT_ASKED: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    }

    fn issued(ticket: &ConfirmationTicket<FakeTarget, String>, revision: u32) -> String {
        let (expires_at, token) = ticket
            .issue(
                true,
                FakeTarget::new(revision),
                format!("digest-{revision}"),
            )
            .expect("a ready review issues a token");
        assert!(expires_at > now_ms(), "the review window is in the future");
        token
    }

    #[tokio::test]
    async fn a_token_can_be_consumed_exactly_once_and_replay_is_refused() {
        let ticket = ticket();
        let token = issued(&ticket, 0);
        let target = FakeTarget::new(0);
        let digest = "digest-0".to_string();
        let counters = Counters::default();

        let mut spec = FakeSpec {
            counters: &counters,
            ..FakeSpec::default()
        };
        let first = ticket
            .confirm(
                ConfirmationRequest::new(&token, &target).with_digest(&digest),
                &mut spec,
            )
            .await
            .expect("a fresh review executes");
        assert_eq!(first.target, FakeTarget::new(0));
        assert_eq!(first.operation_id, format!("confirm-{token}"));
        assert_eq!(Counters::get(&counters.executes), 1);

        // Replaying the same token: gone from the store, nothing re-runs.
        let replay = ticket
            .confirm(
                ConfirmationRequest::new(&token, &target).with_digest(&digest),
                &mut spec,
            )
            .await;
        let replay = replay.expect_err("replay must be refused");
        assert!(!replay.is_cancelled());
        assert_eq!(replay.code(), Some(CODE_TOKEN_UNKNOWN));
        assert_eq!(replay.message(), Some("unknown token"));
        assert!(!replay.after_recheck());
        assert_eq!(Counters::get(&counters.executes), 1);
        // The refusal happens before the lane and the re-check: a duplicate
        // dispatch cannot reach the server at all.
        assert_eq!(Counters::get(&counters.rechecks), 1);
        assert_eq!(Counters::get(&counters.lanes), 1);
        assert_eq!(ticket.outstanding(), 0);
    }

    #[tokio::test]
    async fn a_blocked_review_issues_no_token_and_still_gets_a_planned_expiry() {
        let ticket = ConfirmationTicket::<FakeTarget, String>::new(60_000);
        assert!(ticket
            .issue(false, FakeTarget::new(0), "d".into())
            .is_none());
        assert_eq!(ticket.outstanding(), 0);
        let planned = ticket.planned_expires_at();
        assert!(planned > now_ms());
        assert!(planned <= now_ms() + 60_000);
        // Even "ready" cannot issue without a target to bind.
        assert_eq!(ticket.ttl_ms(), 60_000);
    }

    #[tokio::test]
    async fn an_expired_token_is_refused_before_the_notification_reaches_the_server() {
        let ticket = ConfirmationTicket::<FakeTarget, String>::new(1);
        let (expires_at, token) = ticket
            .issue(true, FakeTarget::new(0), "d".into())
            .expect("ready");
        // Burn the 1 ms window rather than sleeping sleeps worth of seconds.
        while now_ms() <= expires_at {
            tokio::task::yield_now().await;
        }
        let counters = Counters::default();
        let mut spec = FakeSpec {
            counters: &counters,
            ..FakeSpec::default()
        };
        let target = FakeTarget::new(0);
        let digest = "d".to_string();
        let refusal = ticket
            .confirm(
                ConfirmationRequest::new(&token, &target).with_digest(&digest),
                &mut spec,
            )
            .await
            .expect_err("an expired review cannot be confirmed");
        assert_eq!(refusal.code(), Some(CODE_TOKEN_EXPIRED));
        assert!(!refusal.is_cancelled());
        assert!(!refusal.after_recheck());
        assert_eq!(Counters::get(&counters.rechecks), 0);
        assert_eq!(Counters::get(&counters.executes), 0);
    }

    #[tokio::test]
    async fn a_review_that_expires_during_the_recheck_is_refused_after_it() {
        // The review window must be re-checked AFTER the server re-check, not
        // only before it: a slow re-check is exactly when a stale review could
        // otherwise authorise a write. The TTL is 120 ms and the fake re-check
        // sleeps on the real clock for 250 ms, so the window is guaranteed to
        // close between the two checks.
        let ticket = ConfirmationTicket::<FakeTarget, String>::new(120);
        let (_, token) = ticket
            .issue(true, FakeTarget::new(0), "d".into())
            .expect("ready");
        let counters = Counters::default();
        let mut spec = FakeSpec {
            counters: &counters,
            recheck_delay: Some(std::time::Duration::from_millis(250)),
            ..FakeSpec::default()
        };
        let target = FakeTarget::new(0);
        let digest = "d".to_string();
        let refusal = ticket
            .confirm(
                ConfirmationRequest::new(&token, &target).with_digest(&digest),
                &mut spec,
            )
            .await
            .expect_err("the window closed while the re-check was running");
        assert_eq!(refusal.code(), Some(CODE_TOKEN_EXPIRED));
        // The re-check ran (so the expiry was NOT caught by the pre-check),
        // was tagged as post-recheck, and the mutation did not happen.
        assert_eq!(
            Counters::get(&counters.rechecks),
            1,
            "the expiry must be detected AFTER the re-check, not before it"
        );
        assert_eq!(Counters::get(&counters.executes), 0);
        assert!(refusal.after_recheck());
    }
    #[tokio::test]
    async fn a_target_or_digest_mismatch_is_refused_and_burns_the_review() {
        // The established order: the record is taken before the shape is
        // checked, so a forged confirmation costs the reviewer a new preflight
        // and can never reach the lane, the re-check or the mutation.
        let ticket = ticket();
        let digest = "digest-0".to_string();
        let reviewed_target = FakeTarget::new(1);
        let (_, token) = ticket
            .issue(true, reviewed_target.clone(), digest.clone())
            .expect("ready");
        let counters = Counters::default();
        let mut spec = FakeSpec {
            counters: &counters,
            ..FakeSpec::default()
        };

        // 1. A different target than the reviewed one.
        let forged = FakeTarget::new(0);
        let refusal = ticket
            .confirm(
                ConfirmationRequest::new(&token, &forged).with_digest(&digest),
                &mut spec,
            )
            .await
            .expect_err("a different target must not execute");
        assert_eq!(refusal.code(), Some(CODE_TARGET_MISMATCH));
        assert_eq!(refusal.message(), Some("target mismatch"));
        assert_eq!(
            Counters::get(&counters.lanes),
            0,
            "the lane was never taken"
        );
        assert_eq!(Counters::get(&counters.rechecks), 0);
        assert_eq!(Counters::get(&counters.executes), 0);
        assert_eq!(ticket.outstanding(), 0, "the token was burned");

        // 2. The burned token cannot be reused with the correct request either.
        let replay = ticket
            .confirm(
                ConfirmationRequest::new(&token, &reviewed_target).with_digest(&digest),
                &mut spec,
            )
            .await
            .expect_err("a burned token is unknown");
        assert_eq!(replay.code(), Some(CODE_TOKEN_UNKNOWN));

        // 3. A stale digest on a fresh review behaves the same way.
        let (_, token) = ticket
            .issue(true, reviewed_target.clone(), digest.clone())
            .expect("ready");
        let stale = "stale-digest".to_string();
        let refusal = ticket
            .confirm(
                ConfirmationRequest::new(&token, &reviewed_target).with_digest(&stale),
                &mut spec,
            )
            .await
            .expect_err("a different digest must not execute");
        assert_eq!(refusal.code(), Some(CODE_TARGET_MISMATCH));
        assert_eq!(Counters::get(&counters.executes), 0);
        assert_eq!(ticket.outstanding(), 0);
    }

    #[tokio::test]
    async fn a_presentation_consumer_spends_the_token_on_a_mismatch() {
        // The other established order: the reviewer pays a fresh preflight.
        let ticket = ticket();
        let digest = "digest-0".to_string();
        let token = issued(&ticket, 0);
        let counters = Counters::default();
        let mut spec = FakeSpec {
            counters: &counters,
            ..FakeSpec::default()
        };
        let other = FakeTarget::new(1);
        let refusal = ticket
            .confirm(
                ConfirmationRequest::new(&token, &other).with_digest(&digest),
                &mut spec,
            )
            .await
            .expect_err("mismatch");
        assert_eq!(refusal.code(), Some(CODE_TARGET_MISMATCH));
        assert_eq!(ticket.outstanding(), 0);
        let target = FakeTarget::new(0);
        let refusal = ticket
            .confirm(
                ConfirmationRequest::new(&token, &target).with_digest(&digest),
                &mut spec,
            )
            .await
            .expect_err("the burned token cannot be reused");
        assert_eq!(refusal.code(), Some(CODE_TOKEN_UNKNOWN));
        assert_eq!(Counters::get(&counters.executes), 0);
    }

    #[tokio::test]
    async fn a_changed_context_is_refused_before_the_recheck() {
        let ticket = ticket();
        let digest = "digest-0".to_string();
        let token = issued(&ticket, 0);
        let counters = Counters::default();
        let mut spec = FakeSpec {
            counters: &counters,
            context_current: false,
            ..FakeSpec::default()
        };
        let target = FakeTarget::new(0);
        let refusal = ticket
            .confirm(
                ConfirmationRequest::new(&token, &target).with_digest(&digest),
                &mut spec,
            )
            .await
            .expect_err("a stale context must not run");
        assert_eq!(refusal.code(), Some(CODE_CONTEXT_CHANGED));
        assert_eq!(refusal.message(), Some("context changed"));
        // Refused before the lane and the re-check were even asked for.
        assert!(!refusal.after_recheck());
        assert_eq!(Counters::get(&counters.lanes), 0);
        assert_eq!(Counters::get(&counters.rechecks), 0);
        assert_eq!(Counters::get(&counters.executes), 0);
    }

    #[tokio::test]
    async fn a_context_that_changes_during_the_recheck_is_refused_after_it() {
        let counters = Counters::default();
        let ticket = ticket();
        let digest = "digest-0".to_string();
        let token = issued(&ticket, 0);
        let mut spec = ContextDriftSpec {
            counters: &counters,
            current_on_first_ask: true,
        };
        let target = FakeTarget::new(0);
        let refusal = ticket
            .confirm(
                ConfirmationRequest::new(&token, &target).with_digest(&digest),
                &mut spec,
            )
            .await
            .expect_err("the second context check sees the new context");
        assert_eq!(refusal.code(), Some(CODE_CONTEXT_CHANGED));
        assert!(refusal.after_recheck());
        assert_eq!(Counters::get(&counters.rechecks), 1);
        assert_eq!(Counters::get(&counters.executes), 0);
    }

    #[tokio::test]
    async fn recheck_unavailable_and_recheck_changed_are_distinct_refusals() {
        let digest = "digest-0".to_string();
        let ticket = ticket();
        let target = FakeTarget::new(0);
        let counters = Counters::default();

        // The re-check could not produce a trustworthy snapshot.
        let token = issued(&ticket, 0);
        let mut unavailable = FakeSpec {
            counters: &counters,
            recheck_available: false,
            ..FakeSpec::default()
        };
        let refusal = ticket
            .confirm(
                ConfirmationRequest::new(&token, &target).with_digest(&digest),
                &mut unavailable,
            )
            .await
            .expect_err("no snapshot means no write");
        assert_eq!(refusal.code(), Some(CODE_RECHECK_UNAVAILABLE));
        assert_eq!(refusal.message(), Some("recheck unavailable"));
        assert!(refusal.after_recheck());

        // The re-check ran and disagrees with the review.
        let token = issued(&ticket, 0);
        let mut changed = FakeSpec {
            counters: &counters,
            recheck_verdict: RecheckVerdict::Changed,
            ..FakeSpec::default()
        };
        let refusal = ticket
            .confirm(
                ConfirmationRequest::new(&token, &target).with_digest(&digest),
                &mut changed,
            )
            .await
            .expect_err("a changed snapshot means no write");
        assert_eq!(refusal.code(), Some(CODE_RECHECK_CHANGED));
        assert_eq!(refusal.message(), Some("recheck changed"));
        assert!(refusal.after_recheck());
        assert_eq!(Counters::get(&counters.rechecks), 2);
        assert_eq!(Counters::get(&counters.executes), 0);
    }

    #[tokio::test]
    async fn a_closed_lane_cancels_without_executing() {
        let digest = "digest-0".to_string();
        let ticket = ticket();
        let token = issued(&ticket, 0);
        let counters = Counters::default();
        let mut spec = FakeSpec {
            counters: &counters,
            lane_closed: true,
            ..FakeSpec::default()
        };
        let target = FakeTarget::new(0);
        let refusal = ticket
            .confirm(
                ConfirmationRequest::new(&token, &target).with_digest(&digest),
                &mut spec,
            )
            .await
            .expect_err("a closed lane cannot write");
        assert!(refusal.is_cancelled());
        assert_eq!(refusal.code(), None);
        assert_eq!(refusal.message(), None);
        assert!(!refusal.after_recheck());
        assert_eq!(Counters::get(&counters.rechecks), 1);
        assert_eq!(Counters::get(&counters.executes), 0);
    }

    #[tokio::test]
    async fn the_operation_id_is_derived_from_the_token_for_journal_traceability() {
        let digest = "d".to_string();
        let ticket = ticket();
        let (_, token) = ticket
            .issue(true, FakeTarget::new(0), "d".into())
            .expect("ready");
        assert_eq!(ticket.operation_id(&token), format!("confirm-{token}"));
        let counters = Counters::default();
        let mut spec = FakeSpec {
            counters: &counters,
            ..FakeSpec::default()
        };
        let target = FakeTarget::new(0);
        let output = ticket
            .confirm(
                ConfirmationRequest::new(&token, &target).with_digest(&digest),
                &mut spec,
            )
            .await
            .expect("executes");
        assert_eq!(output.operation_id, ticket.operation_id(&token));
    }

    #[tokio::test]
    async fn the_gate_is_held_only_while_a_confirmation_runs() {
        // The gate is what makes `recheck -> execute` atomic for one family.
        // Both future shapes are checked: a confirmation that is already
        // waiting on the gate, and one that acquires it, runs and releases it.
        let ticket = ConfirmationTicket::<FakeTarget, String>::new(60_000);
        assert_eq!(ticket.gate_depth(), 0);
        let target = FakeTarget::new(0);
        let digest = "d".to_string();
        let (_, token) = ticket
            .issue(true, FakeTarget::new(0), "d".into())
            .expect("ready");
        let counters = Counters::default();
        let mut spec = FakeSpec {
            counters: &counters,
            ..FakeSpec::default()
        };

        // A confirmation parked on a gate somebody else holds makes no
        // progress and takes no token until the gate is free.
        {
            let held = fake_gate().lock_owned().await;
            let mut parked = Box::pin(ticket.confirm(
                ConfirmationRequest::new(&token, &target).with_digest(&digest),
                &mut spec,
            ));
            assert!(
                tokio::time::timeout(std::time::Duration::from_millis(50), &mut parked)
                    .await
                    .is_err(),
                "a held gate keeps the next confirmation parked"
            );
            assert!(ticket.gate_depth() >= 1, "waiting counts as in flight");
            assert_eq!(Counters::get(&counters.executes), 0);
            assert_eq!(ticket.outstanding(), 1, "the token is still unused");
            drop(held);
            parked
                .await
                .expect("the released gate lets the parked confirmation run");
        }
        assert_eq!(Counters::get(&counters.executes), 1);
        assert_eq!(ticket.gate_depth(), 0, "the gate is released after the run");

        // The same holds for a second, independent review: with the gate free
        // it runs immediately and leaves the gate free again.
        let (_, token) = ticket
            .issue(true, FakeTarget::new(0), "d".into())
            .expect("ready");
        ticket
            .confirm(
                ConfirmationRequest::new(&token, &target).with_digest(&digest),
                &mut spec,
            )
            .await
            .expect("executes once the gate is free");
        assert_eq!(Counters::get(&counters.executes), 2);
        assert_eq!(ticket.gate_depth(), 0);
    }

    #[tokio::test]
    async fn a_completed_or_refused_confirmation_never_leaks_the_gate() {
        // The reviewed digest for revision 0 is what `issued` stores.
        let digest = "digest-0".to_string();
        let ticket = ConfirmationTicket::<FakeTarget, String>::new(60_000);
        let target = FakeTarget::new(0);
        let counters = Counters::default();
        let mut spec = FakeSpec {
            counters: &counters,
            ..FakeSpec::default()
        };

        // Success releases the gate and spends the token.
        let first = issued(&ticket, 0);
        ticket
            .confirm(
                ConfirmationRequest::new(&first, &target).with_digest(&digest),
                &mut spec,
            )
            .await
            .expect("executes");
        assert_eq!(Counters::get(&counters.executes), 1);
        assert_eq!(ticket.gate_depth(), 0);

        // A replay is refused, and the gate stays free.
        let replay = ticket
            .confirm(
                ConfirmationRequest::new(&first, &target).with_digest(&digest),
                &mut spec,
            )
            .await
            .expect_err("a one-use token cannot be replayed");
        assert_eq!(replay.code(), Some(CODE_TOKEN_UNKNOWN));
        assert_eq!(Counters::get(&counters.executes), 1);

        // A refusal decided before execution leaves the gate free as well.
        let second = issued(&ticket, 1);
        let wrong_digest = "other-digest".to_string();
        ticket
            .confirm(
                ConfirmationRequest::new(&second, &target).with_digest(&wrong_digest),
                &mut spec,
            )
            .await
            .expect_err("a stale digest is refused");
        assert_eq!(ticket.gate_depth(), 0, "refusals do not leak the gate");
    }

    #[test]
    fn store_pruning_drops_expired_records_and_keeps_live_ones() {
        let store: ConfirmationStore<IssuedConfirmation<FakeTarget, String>> =
            ConfirmationStore::default();
        // Records are stored directly so the test can pin "now" to 1000.
        let expired = store.issue(
            IssuedConfirmation::new(FakeTarget::new(0), "d0".into(), 900),
            1_000,
        );
        let live = store.issue(
            IssuedConfirmation::new(FakeTarget::new(1), "d1".into(), 2_000),
            1_000,
        );
        // A record that expired exactly at "now" is not usable.
        let boundary = store.issue(
            IssuedConfirmation::new(FakeTarget::new(2), "d2".into(), 1_000),
            500,
        );
        assert_eq!(store.outstanding(), 2);

        assert!(store.consume(&expired).is_none());
        assert!(store.consume(&boundary).is_some());
        assert!(store.consume(&live).is_some());
        assert_eq!(store.outstanding(), 0);

        // Issuing at a later clock prunes everything that has expired by then.
        let _old = store.issue(
            IssuedConfirmation::new(FakeTarget::new(3), "d3".into(), 1_500),
            1_000,
        );
        let survivor = store.issue(
            IssuedConfirmation::new(FakeTarget::new(4), "d4".into(), 5_000),
            1_000,
        );
        let _new = store.issue(
            IssuedConfirmation::new(FakeTarget::new(5), "d5".into(), 9_000),
            4_000,
        );
        assert_eq!(store.outstanding(), 2, "the expired record was pruned");
        assert!(store.consume(&survivor).is_some());
    }

    #[tokio::test]
    async fn clearing_a_ticket_drops_every_review_and_cannot_race_a_confirm() {
        let ticket = ticket();
        let first = issued(&ticket, 0);
        let _second = issued(&ticket, 1);
        assert_eq!(ticket.outstanding(), 2, "both reviews are usable");

        // A clear really drops them: a token from the cleared window is
        // unknown, so nothing stale can be confirmed after a context switch.
        ticket.clear().await;
        assert_eq!(ticket.outstanding(), 0);
        let target = FakeTarget::new(0);
        let digest = "digest-0".to_string();
        let counters = Counters::default();
        let mut spec = FakeSpec {
            counters: &counters,
            ..FakeSpec::default()
        };
        let refusal = ticket
            .confirm(
                ConfirmationRequest::new(&first, &target).with_digest(&digest),
                &mut spec,
            )
            .await
            .expect_err("a cleared review cannot be confirmed");
        assert_eq!(refusal.code(), Some(CODE_TOKEN_UNKNOWN));
        assert_eq!(Counters::get(&counters.executes), 0);

        // A clear that arrives while a confirmation holds the family gate
        // waits for it, so a context switch cannot interleave with a write.
        let (_, token) = ticket
            .issue(true, FakeTarget::new(0), "d".into())
            .expect("ready");
        let held = ticket.gate().lock_owned().await;
        let mut clear = Box::pin(ticket.clear());
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(50), &mut clear)
                .await
                .is_err(),
            "clear must wait for the in-flight confirmation"
        );
        drop(held);
        clear.await;
        assert!(ticket.take(&token).is_none(), "the clear then drops it");
    }
}
