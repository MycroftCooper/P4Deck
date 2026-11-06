use crate::{
    app::{
        confirmation::{
            ConfirmRefusal, ConfirmationRefusalCode, ConfirmationRequest, ConfirmationTicket,
            IssuedConfirmation, RecheckVerdict, ReviewSpec, DEFAULT_CONFIRMATION_TTL_MS,
        },
        status_cache::{InvalidationReason, StatusCache, StatusQueryKind},
    },
    domain::*,
    p4::{
        context::ContextStore,
        locks::{LockInspection, LockRepository},
        runner::{MutationGuard, OperationGroup},
    },
};
use sha2::{Digest, Sha256};
use std::sync::Arc;
use tauri::AppHandle;
use uuid::Uuid;

pub struct FileLockService {
    repository: LockRepository,
    contexts: Arc<ContextStore>,
    status_cache: Arc<StatusCache>,
    /// preflight → one-time token → recheck → lane → execute (shared skeleton).
    tickets: ConfirmationTicket<FileLockTargetSnapshot, String>,
}

impl FileLockService {
    pub fn new(
        repository: LockRepository,
        contexts: Arc<ContextStore>,
        status_cache: Arc<StatusCache>,
    ) -> Self {
        Self::with_ttl(
            repository,
            contexts,
            status_cache,
            DEFAULT_CONFIRMATION_TTL_MS,
        )
    }

    pub(crate) fn with_ttl(
        repository: LockRepository,
        contexts: Arc<ContextStore>,
        status_cache: Arc<StatusCache>,
        ttl_ms: u64,
    ) -> Self {
        Self {
            repository,
            contexts,
            status_cache,
            tickets: ConfirmationTicket::new(ttl_ms),
        }
    }

    pub async fn clear_confirmations(&self) {
        // Await the clear so a context switch serialises against any in-flight
        // confirmation of this family; blocking inside the async runtime would
        // stall the command that performs the switch.
        self.tickets.clear().await;
    }

    pub async fn preflight(
        &self,
        request: FileLockPreflightRequest,
        app: Option<&AppHandle>,
    ) -> FileLockPreflight {
        let (context, generation) = self.contexts.snapshot();
        let profile_id = self.contexts.active_profile_id();
        let prefix = safe_operation_prefix(request.operation_id.as_deref(), "lock-preflight");
        let inspected = self
            .repository
            .inspect(&context, request.operation, &request.paths, &prefix, app)
            .await;
        let (files, operation_ids, mut blockers, mut warnings) = match inspected {
            Ok(inspection) => {
                let (blockers, warnings) = issues(request.operation, &inspection.files);
                (
                    inspection.files,
                    inspection.operation_ids,
                    blockers,
                    warnings,
                )
            }
            Err(message) => {
                let (code, certainty) = if message.starts_with("lock operations") {
                    (
                        FileLockIssueCode::InvalidTarget,
                        FileLockIssueCertainty::Confirmed,
                    )
                } else {
                    let code = match crate::p4::connection::classify_connection_error(&message) {
                        ConnectionErrorCode::AuthRequired | ConnectionErrorCode::TicketExpired => {
                            FileLockIssueCode::AuthenticationRequired
                        }
                        _ => FileLockIssueCode::ConnectionUnavailable,
                    };
                    (code, FileLockIssueCertainty::Unknown)
                };
                (Vec::new(), Vec::new(), vec![issue(code, certainty, format!("Lock preflight could not establish a reliable server snapshot: {message}"), request.paths.clone())], Vec::new())
            }
        };
        let applicable = files.iter().filter(|file| file.applicable).count();
        let already_satisfied = files
            .iter()
            .filter(|file| already_satisfied(request.operation, file))
            .count();
        if blockers.is_empty() && applicable == 0 {
            blockers.push(issue(
                match request.operation {
                    FileLockOperation::Lock => FileLockIssueCode::AlreadyLocked,
                    FileLockOperation::Unlock => FileLockIssueCode::NotLocked,
                },
                FileLockIssueCertainty::Confirmed,
                "No selected file requires a lock state change.",
                files.iter().map(display_path).collect(),
            ));
        }
        if files
            .iter()
            .any(|file| file.permission == FileLockPermission::Unknown)
        {
            warnings.push(issue(FileLockIssueCode::PermissionUnknown, FileLockIssueCertainty::Unknown, "Server permission could not be proven for every file; execution remains server-authoritative.", files.iter().filter(|file| file.permission == FileLockPermission::Unknown).map(display_path).collect()));
        }
        let target = (!files.is_empty()).then(|| FileLockTargetSnapshot {
            server: context.server.clone(),
            user: context.user.clone(),
            client: context.client.clone(),
            workspace: context.cwd.clone().unwrap_or_default(),
            active_profile_id: profile_id,
            context_generation: generation,
            operation: request.operation,
            files: files.clone(),
        });
        let state_digest = digest(target.as_ref());
        let ready = blockers.is_empty() && target.is_some() && applicable > 0;
        // `ready` already implies a target; a blocked review issues no token.
        let (expires_at, token) = target
            .clone()
            .and_then(|target| self.tickets.issue(ready, target, state_digest.clone()))
            .map_or_else(
                || (self.tickets.planned_expires_at(), None),
                |(expires_at, token)| (expires_at, Some(token)),
            );
        let counts = FileLockCounts {
            requested: request.paths.len(),
            applicable,
            already_satisfied,
            blocked: files.len().saturating_sub(applicable + already_satisfied),
            exclusive: files.iter().filter(|file| file.exclusive).count(),
        };
        FileLockPreflight {
            ready,
            operation: request.operation,
            files,
            counts,
            blockers,
            warnings,
            target_snapshot: target,
            state_digest,
            token,
            expires_at,
            ttl_ms: self.tickets.ttl_ms(),
            log_reference: operation_ids.first().cloned(),
            operation_ids,
        }
    }

    /// Unified write lane entry for IPC: same-server writes serialize and a
    /// durable S1B WriteLease is attached until `MutationGuard::finish`.
    pub async fn lock_write_transaction(
        &self,
        context: &crate::domain::P4Context,
        operation_id: &str,
    ) -> Result<MutationGuard, String> {
        self.repository
            .lock_write_transaction(context, operation_id)
            .await
    }

    /// Compatibility entry used only by the feature-gated e2e harness:
    /// acquires the legacy in-memory mutation lane without a durable lease.
    /// Production IPC uses `confirm_admitted` with the unified write lane/lease.
    #[allow(dead_code)]
    pub async fn confirm(
        &self,
        confirmation: FileLockConfirmation,
        app: Option<&AppHandle>,
    ) -> FileLockResult {
        let (context, _) = self.contexts.snapshot();
        let guard = self.repository.lock_mutations(&context.server).await;
        self.confirm_admitted(confirmation, &guard, app).await
    }

    pub async fn confirm_admitted(
        &self,
        confirmation: FileLockConfirmation,
        guard: &MutationGuard,
        app: Option<&AppHandle>,
    ) -> FileLockResult {
        let mut review = LockReview {
            service: self,
            reviewed_echo: confirmation.target.clone(),
            current_operation_id: confirmation
                .operation_id
                .clone()
                .filter(|value| valid_operation_id(value)),
            operation_id: None,
            held_group: None,
            guard,
            app,
        };
        // The ticket takes the token, re-checks the server, re-verifies context
        // and expiry, then executes — all under the confirmation gate, while
        // the caller's write lane stays held.
        let request = ConfirmationRequest::new(&confirmation.token, &confirmation.target)
            .with_digest(&confirmation.state_digest);
        match self.tickets.confirm(request, &mut review).await {
            Ok(result) => result,
            Err(refusal) => {
                let code = refusal.code().unwrap_or(FileLockFailureCode::Cancelled);
                let message = refusal
                    .message()
                    .unwrap_or("The lock operation was cancelled before execution.");
                lock_refusal(
                    code,
                    message,
                    refusal.after_recheck(),
                    &review.reviewed_echo,
                    review.operation_id.as_deref(),
                )
            }
        }
    }

    fn invalidate(&self, context: &P4Context, target: &FileLockTargetSnapshot) {
        let paths = target
            .files
            .iter()
            .flat_map(|file| [Some(file.depot_path.clone()), file.local_path.clone()])
            .flatten()
            .collect::<Vec<_>>();
        self.status_cache.invalidate(
            &context.server,
            &context.user,
            &context.client,
            &paths,
            &[StatusQueryKind::WorkspaceStatus, StatusQueryKind::Opened],
            InvalidationReason::FileMutation,
        );
    }
}

/// Whether the requested lock state is already in place for this file, so the
/// review reports it as satisfied instead of mutating it.
fn already_satisfied(operation: FileLockOperation, file: &FileLockFileSnapshot) -> bool {
    matches!(
        (operation, file.ownership),
        (FileLockOperation::Lock, FileLockOwnership::Ours)
            | (FileLockOperation::Unlock, FileLockOwnership::Unlocked)
    )
}

fn issues(
    operation: FileLockOperation,
    files: &[FileLockFileSnapshot],
) -> (Vec<FileLockIssue>, Vec<FileLockIssue>) {
    let mut blockers = Vec::new();
    let mut warnings = Vec::new();
    for file in files {
        let path = vec![display_path(file)];
        if file.depot_path.is_empty() {
            blockers.push(issue(
                FileLockIssueCode::OutsideClientView,
                FileLockIssueCertainty::Confirmed,
                file.reason
                    .clone()
                    .unwrap_or_else(|| "Target is outside the client view.".into()),
                path,
            ));
            continue;
        }
        if file.ownership == FileLockOwnership::Other {
            blockers.push(issue(
                FileLockIssueCode::LockedByOther,
                FileLockIssueCertainty::Confirmed,
                file.reason
                    .clone()
                    .unwrap_or_else(|| "Another user owns the lock.".into()),
                path,
            ));
            continue;
        }
        if file.permission == FileLockPermission::Denied {
            blockers.push(issue(
                FileLockIssueCode::PermissionDenied,
                FileLockIssueCertainty::Confirmed,
                file.reason
                    .clone()
                    .unwrap_or_else(|| "Permission denied.".into()),
                path,
            ));
            continue;
        }
        if file.opened_action.is_empty() {
            blockers.push(issue(
                FileLockIssueCode::NotOpened,
                FileLockIssueCertainty::Confirmed,
                file.reason
                    .clone()
                    .unwrap_or_else(|| "File is not opened.".into()),
                path,
            ));
            continue;
        }
        if file.ownership == FileLockOwnership::Unknown {
            blockers.push(issue(
                FileLockIssueCode::StateUnknown,
                FileLockIssueCertainty::Unknown,
                file.reason
                    .clone()
                    .unwrap_or_else(|| "Lock state is unknown.".into()),
                path,
            ));
            continue;
        }
        if !file.applicable && !already_satisfied(operation, file) {
            blockers.push(issue(
                FileLockIssueCode::UnsupportedAction,
                FileLockIssueCertainty::Confirmed,
                file.reason
                    .clone()
                    .unwrap_or_else(|| "Opened action is unsupported.".into()),
                path.clone(),
            ));
        }
        if already_satisfied(operation, file) {
            warnings.push(issue(
                match operation {
                    FileLockOperation::Lock => FileLockIssueCode::AlreadyLocked,
                    FileLockOperation::Unlock => FileLockIssueCode::NotLocked,
                },
                FileLockIssueCertainty::Confirmed,
                file.reason
                    .clone()
                    .unwrap_or_else(|| "Requested state is already satisfied.".into()),
                path,
            ));
        }
    }
    (blockers, warnings)
}

/// Turn a ticket refusal into the lock result. Refusals decided after the
/// re-check keep the operation id of the opened group, exactly like the
/// hand-written flow reported it.
fn lock_refusal(
    code: FileLockFailureCode,
    message: &str,
    after_recheck: bool,
    target: &FileLockTargetSnapshot,
    operation_id: Option<&str>,
) -> FileLockResult {
    if after_recheck && code != FileLockFailureCode::TokenExpired {
        let operation_id = operation_id
            .map(str::to_owned)
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        return rejected_with_operation(code, message, target, operation_id);
    }
    rejected(code, message, Some(target))
}

/// One lock confirmation as the shared ticket sees it.
///
/// The ticket owns the decision order; this type supplies only the decisions
/// that are lock-specific: the fresh server snapshot, the lock issues that only
/// the re-check can produce, and the per-file mutation loop. The write lane
/// arrives already acquired (production IPC) or is taken by
/// [`FileLockService::confirm`], and stays held from the re-check through the
/// last server call.
struct LockReview<'a> {
    service: &'a FileLockService,
    /// Snapshot echoed by the caller; the refresh advice of a token refusal is
    /// built from it.
    reviewed_echo: FileLockTargetSnapshot,
    /// Caller-supplied operation id, used as the journal group root.
    current_operation_id: Option<String>,
    /// Group root chosen by the ticket.
    operation_id: Option<String>,
    /// Operation group opened by the re-check; the mutation loop reuses it so a
    /// cancelled group refuses at the first post-review step.
    held_group: Option<OperationGroup>,
    guard: &'a MutationGuard,
    app: Option<&'a AppHandle>,
}

impl LockReview<'_> {
    /// Run the mutation for an already re-checked snapshot.
    async fn run_lane(
        &mut self,
        target: FileLockTargetSnapshot,
        operation_id: String,
        group: OperationGroup,
    ) -> FileLockResult {
        let (context, _) = self.service.contexts.snapshot();
        let mut results = target
            .files
            .iter()
            .filter(|file| already_satisfied(target.operation, file))
            .map(|file| FileLockFileResult {
                depot_path: file.depot_path.clone(),
                outcome: FileLockFileOutcome::AlreadySatisfied,
                message: file
                    .reason
                    .clone()
                    .unwrap_or_else(|| "The requested state was already satisfied.".into()),
                ownership: file.ownership,
                lock_owner: file.lock_owner.clone(),
                operation_id: None,
            })
            .collect::<Vec<_>>();
        for (index, file) in target
            .files
            .iter()
            .filter(|file| file.applicable)
            .enumerate()
        {
            if group.ensure_active().is_err() {
                results.push(file_result(
                    file,
                    FileLockFileOutcome::Cancelled,
                    "Cancelled before this file was sent to the server.",
                    None,
                ));
                continue;
            }
            let child_id = format!("{operation_id}:file-{index}");
            match self
                .service
                .repository
                .mutate(
                    &context,
                    target.operation,
                    &file.depot_path,
                    child_id.clone(),
                    self.guard,
                    self.app,
                )
                .await
            {
                Ok(operation) if operation.exit_code == 0 => results.push(file_result(
                    file,
                    FileLockFileOutcome::Succeeded,
                    "Server accepted the requested lock state change; verification follows.",
                    Some(child_id),
                )),
                Ok(operation)
                    if operation
                        .events
                        .iter()
                        .any(|event| matches!(event.kind, EventKind::Cancelled)) =>
                {
                    results.push(file_result(
                        file,
                        FileLockFileOutcome::Cancelled,
                        "The file operation was cancelled; no rollback was attempted.",
                        Some(child_id),
                    ))
                }
                Ok(_) => results.push(file_result(
                    file,
                    FileLockFileOutcome::Failed,
                    "The server rejected this file; other successful files were not rolled back.",
                    Some(child_id),
                )),
                Err(message) if message.to_ascii_lowercase().contains("cancel") => {
                    results.push(file_result(
                        file,
                        FileLockFileOutcome::Cancelled,
                        "The file operation was cancelled; no rollback was attempted.",
                        Some(child_id),
                    ))
                }
                Err(message) if message.to_ascii_lowercase().contains("timed out") => {
                    results.push(file_result(
                        file,
                        FileLockFileOutcome::Unknown,
                        "The command outcome is uncertain; refresh before retrying.",
                        Some(child_id),
                    ))
                }
                Err(_) => results.push(file_result(
                    file,
                    FileLockFileOutcome::Failed,
                    "The file command failed before a reliable result was returned.",
                    Some(child_id),
                )),
            }
        }

        let paths = target
            .files
            .iter()
            .map(|file| file.input_path.clone())
            .collect::<Vec<_>>();
        let verification = if group.ensure_active().is_ok() {
            self.service
                .repository
                .inspect(
                    &context,
                    target.operation,
                    &paths,
                    &format!("{operation_id}:verify"),
                    self.app,
                )
                .await
                .ok()
        } else {
            None
        };
        verify_results(target.operation, &mut results, verification.as_ref());
        self.service.invalidate(&context, &target);
        result_from_files(operation_id, &target, results)
    }
}

impl ReviewSpec for LockReview<'_> {
    type Target = FileLockTargetSnapshot;
    type Digest = String;
    type Recheck = FileLockTargetSnapshot;
    type Output = FileLockResult;
    type RefusalCode = FileLockFailureCode;
    type Error = ConfirmRefusal<FileLockFailureCode>;

    fn refusal_code(&self, shared: ConfirmationRefusalCode) -> FileLockFailureCode {
        match shared {
            ConfirmationRefusalCode::TokenUnknown => FileLockFailureCode::TokenUnknown,
            ConfirmationRefusalCode::TokenExpired => FileLockFailureCode::TokenExpired,
            ConfirmationRefusalCode::TargetMismatch => FileLockFailureCode::TargetMismatch,
            // Lock reviews never require an acknowledgement.
            ConfirmationRefusalCode::AcknowledgementRequired => FileLockFailureCode::TokenUnknown,
            ConfirmationRefusalCode::ContextChanged => FileLockFailureCode::ContextChanged,
            // This domain has no separate "now blocked" outcome; it keeps reporting
            // a blocked re-check as a changed one.
            ConfirmationRefusalCode::RecheckBlocked | ConfirmationRefusalCode::RecheckChanged => {
                FileLockFailureCode::StateChanged
            }
            ConfirmationRefusalCode::RecheckUnavailable => FileLockFailureCode::PreflightBlocked,
            ConfirmationRefusalCode::Cancelled => FileLockFailureCode::Cancelled,
        }
    }

    fn refusal_message(&self, shared: ConfirmationRefusalCode) -> &'static str {
        match shared {
            ConfirmationRefusalCode::TokenUnknown => {
                "The lock confirmation token is unknown or was already used."
            }
            ConfirmationRefusalCode::TokenExpired => {
                "The lock preflight expired. Check the files again."
            }
            ConfirmationRefusalCode::TargetMismatch => {
                "The confirmation does not match the reviewed file set and state."
            }
            ConfirmationRefusalCode::AcknowledgementRequired => {
                "The lock confirmation token is unknown or was already used."
            }
            ConfirmationRefusalCode::ContextChanged => {
                "The connection, profile, workspace, or runtime generation changed after preflight."
            }
            ConfirmationRefusalCode::RecheckBlocked            | ConfirmationRefusalCode::RecheckChanged => {
                "File mapping, opened action, changelist, filetype, permission, or lock ownership changed after review."
            }
            ConfirmationRefusalCode::RecheckUnavailable => {
                "The selected files could not be revalidated safely."
            }
            ConfirmationRefusalCode::Cancelled => {
                "The lock operation was cancelled before execution."
            }
        }
    }

    fn context_current(&self) -> bool {
        let (context, generation) = self.service.contexts.snapshot();
        context_matches(
            &self.reviewed_echo,
            &context,
            generation,
            self.service.contexts.active_profile_id(),
        )
    }

    fn on_reviewed(&mut self, reviewed: &IssuedConfirmation<Self::Target, Self::Digest>) {
        self.reviewed_echo = reviewed.target.clone();
    }

    /// The ticket passes the token-derived operation id; a caller-supplied one
    /// that parses takes precedence, as before the refactor.
    fn lane(
        &mut self,
        operation_id: &str,
    ) -> crate::app::confirmation::BoxFuture<'_, Option<crate::app::confirmation::MutationLane>>
    {
        self.operation_id = Some(
            self.current_operation_id
                .clone()
                .unwrap_or_else(|| operation_id.to_string()),
        );
        Box::pin(async { None })
    }

    /// Open the operation group and re-inspect the reviewed paths. A cancelled
    /// group or an unavailable server surfaces here, before any write.
    fn recheck(
        &mut self,
    ) -> crate::app::confirmation::BoxFuture<'_, Result<Self::Recheck, String>> {
        Box::pin(async move {
            let operation_id = self
                .operation_id
                .clone()
                .unwrap_or_else(|| self.service.tickets.operation_id("unplanned"));
            let group = self.service.repository.begin_group(operation_id.clone());
            let active = group.ensure_active().is_ok();
            self.held_group = Some(group);
            if !active {
                return Err("the lock operation group is no longer active".into());
            }
            let target = self.reviewed_echo.clone();
            let (context, _) = self.service.contexts.snapshot();
            let paths = target
                .files
                .iter()
                .map(|file| file.input_path.clone())
                .collect::<Vec<_>>();
            let reinspection = self
                .service
                .repository
                .inspect(
                    &context,
                    target.operation,
                    &paths,
                    &format!("{operation_id}:recheck"),
                    self.app,
                )
                .await?;
            Ok(FileLockTargetSnapshot {
                files: reinspection.files,
                ..target
            })
        })
    }

    fn recheck_verdict(&self, recheck: &Self::Recheck) -> RecheckVerdict {
        let (reblockers, _) = issues(self.reviewed_echo.operation, &recheck.files);
        if !reblockers.is_empty()
            || *recheck != self.reviewed_echo
            || digest(Some(recheck)) != digest(Some(&self.reviewed_echo))
        {
            RecheckVerdict::Changed
        } else {
            RecheckVerdict::Unchanged
        }
    }

    /// The ticket's own mutex: this service keeps no separate confirmation
    /// gate, and `clear_confirmations` goes through the ticket too, so both
    /// sides serialise on the same lock.
    fn gate(&self) -> std::sync::Arc<tokio::sync::Mutex<()>> {
        self.service.tickets.gate()
    }
    fn execute<'a>(
        &'a mut self,
        recheck: Self::Recheck,
        operation_id: String,
    ) -> crate::app::confirmation::BoxFuture<'a, Result<Self::Output, Self::Error>> {
        Box::pin(async move {
            let group = self
                .held_group
                .take()
                .unwrap_or_else(|| self.service.repository.begin_group(operation_id.clone()));
            Ok(self.run_lane(recheck, operation_id, group).await)
        })
    }

    fn unwrap_error(error: Self::Error) -> ConfirmRefusal<FileLockFailureCode> {
        error
    }
}

fn verify_results(
    operation: FileLockOperation,
    results: &mut [FileLockFileResult],
    verification: Option<&LockInspection>,
) {
    for result in results
        .iter_mut()
        .filter(|result| result.outcome == FileLockFileOutcome::Succeeded)
    {
        let verified = verification.and_then(|inspection| {
            inspection
                .files
                .iter()
                .find(|file| file.depot_path == result.depot_path)
        });
        let expected = verified.is_some_and(|file| {
            matches!(
                (operation, file.ownership),
                (FileLockOperation::Lock, FileLockOwnership::Ours)
                    | (FileLockOperation::Unlock, FileLockOwnership::Unlocked)
            )
        });
        if let Some(file) = verified {
            result.ownership = file.ownership;
            result.lock_owner = file.lock_owner.clone();
        }
        if expected {
            result.message = "Verified the requested lock state from tagged fstat output.".into();
        } else {
            result.outcome = FileLockFileOutcome::Unknown;
            result.message = "The server command succeeded but final lock state could not be verified; refresh before retrying.".into();
        }
    }
}

fn result_from_files(
    operation_id: String,
    target: &FileLockTargetSnapshot,
    files: Vec<FileLockFileResult>,
) -> FileLockResult {
    let succeeded = files
        .iter()
        .filter(|file| {
            matches!(
                file.outcome,
                FileLockFileOutcome::Succeeded | FileLockFileOutcome::AlreadySatisfied
            )
        })
        .count();
    let cancelled = files
        .iter()
        .filter(|file| file.outcome == FileLockFileOutcome::Cancelled)
        .count();
    let unknown = files
        .iter()
        .filter(|file| file.outcome == FileLockFileOutcome::Unknown)
        .count();
    let failed = files
        .iter()
        .filter(|file| file.outcome == FileLockFileOutcome::Failed)
        .count();
    let outcome = if succeeded == files.len() {
        FileLockOutcome::Succeeded
    } else if succeeded > 0 {
        FileLockOutcome::Partial
    } else if cancelled == files.len() {
        FileLockOutcome::Cancelled
    } else if unknown > 0 {
        FileLockOutcome::Unknown
    } else {
        FileLockOutcome::Failed
    };
    let execution = execution_envelope(&operation_id, outcome, &files);
    FileLockResult {
        execution: Some(execution),
        outcome,
        failure: match outcome {
            FileLockOutcome::Succeeded | FileLockOutcome::Partial => None,
            FileLockOutcome::Cancelled => Some(FileLockFailureCode::Cancelled),
            FileLockOutcome::Unknown => Some(FileLockFailureCode::UncertainOutcome),
            _ => Some(FileLockFailureCode::CommandFailure),
        },
        message: format!("Lock operation finished: {succeeded} satisfied, {failed} failed, {cancelled} cancelled, {unknown} unknown. Successful files were not rolled back."),
        files,
        operation_id: Some(operation_id.clone()),
        log_reference: Some(operation_id),
        refresh: refresh(target, "Lock state changed or may have changed; refresh workspace, Pending, search and review caches."),
    }
}

fn file_result(
    file: &FileLockFileSnapshot,
    outcome: FileLockFileOutcome,
    message: &str,
    operation_id: Option<String>,
) -> FileLockFileResult {
    FileLockFileResult {
        depot_path: file.depot_path.clone(),
        outcome,
        message: message.into(),
        ownership: file.ownership,
        lock_owner: file.lock_owner.clone(),
        operation_id,
    }
}
fn issue(
    code: FileLockIssueCode,
    certainty: FileLockIssueCertainty,
    message: impl Into<String>,
    paths: Vec<String>,
) -> FileLockIssue {
    FileLockIssue {
        code,
        certainty,
        message: message.into(),
        paths,
    }
}
fn display_path(file: &FileLockFileSnapshot) -> String {
    if file.depot_path.is_empty() {
        file.input_path.clone()
    } else {
        file.depot_path.clone()
    }
}
fn digest(target: Option<&FileLockTargetSnapshot>) -> String {
    let bytes = serde_json::to_vec(&target).expect("lock target serializes");
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}
fn safe_operation_prefix(value: Option<&str>, fallback: &str) -> String {
    value
        .filter(|value| valid_operation_id(value))
        .map(str::to_owned)
        .unwrap_or_else(|| format!("{fallback}-{}", Uuid::new_v4()))
}
fn valid_operation_id(value: &str) -> bool {
    !value.trim().is_empty() && value.len() <= 128 && !value.chars().any(char::is_control)
}
fn context_matches(
    target: &FileLockTargetSnapshot,
    context: &P4Context,
    generation: u64,
    profile: Option<String>,
) -> bool {
    target.server == context.server
        && target.user == context.user
        && target.client == context.client
        && target.workspace == context.cwd.clone().unwrap_or_default()
        && target.context_generation == generation
        && target.active_profile_id == profile
}
fn refresh(target: &FileLockTargetSnapshot, reason: &str) -> FileLockRefreshAdvice {
    FileLockRefreshAdvice {
        workspace_status: true,
        pending_changes: true,
        search: true,
        review: true,
        depot_paths: target
            .files
            .iter()
            .map(|file| file.depot_path.clone())
            .filter(|path| !path.is_empty())
            .collect(),
        local_paths: target
            .files
            .iter()
            .filter_map(|file| file.local_path.clone())
            .collect(),
        reason: reason.into(),
    }
}
fn rejected(
    failure: FileLockFailureCode,
    message: &str,
    target: Option<&FileLockTargetSnapshot>,
) -> FileLockResult {
    FileLockResult {
        execution: None,
        outcome: FileLockOutcome::Rejected,
        failure: Some(failure),
        message: message.into(),
        files: Vec::new(),
        operation_id: None,
        log_reference: None,
        refresh: target
            .map(|target| refresh(target, "Preflight must be repeated before retrying."))
            .unwrap_or(FileLockRefreshAdvice {
                workspace_status: true,
                pending_changes: true,
                search: true,
                review: true,
                depot_paths: Vec::new(),
                local_paths: Vec::new(),
                reason: "Refresh current data and repeat preflight.".into(),
            }),
    }
}
fn rejected_with_operation(
    failure: FileLockFailureCode,
    message: &str,
    target: &FileLockTargetSnapshot,
    operation_id: String,
) -> FileLockResult {
    let mut result = rejected(failure, message, Some(target));
    result.operation_id = Some(operation_id.clone());
    result.log_reference = Some(operation_id);
    result
}

/// S3a-style execution envelope for the lock lifecycle. `commandCompleted`
/// only means a dispatched lifecycle produced known per-file facts; it never
/// claims per-file success, and the authoritative rows stay in `files[]`.
fn execution_envelope(
    operation_id: &str,
    outcome: FileLockOutcome,
    files: &[FileLockFileResult],
) -> FileActionExecution {
    let unknown = outcome == FileLockOutcome::Unknown
        || files
            .iter()
            .any(|file| file.outcome == FileLockFileOutcome::Unknown);
    FileActionExecution {
        operation_id: operation_id.to_string(),
        outcome: if unknown {
            "unknown"
        } else {
            "commandCompleted"
        }
        .into(),
        per_file_evidence: "notCollected".into(),
        files: None,
    }
}

/// A lock lifecycle is verified only when no per-file effect is unconfirmed.
/// Unknown/uncertain rows must keep a conservative durable fence.
pub(crate) fn verified_completion(result: &FileLockResult) -> bool {
    result.outcome != FileLockOutcome::Unknown
        && !result
            .files
            .iter()
            .any(|file| file.outcome == FileLockFileOutcome::Unknown)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn file(path: &str, ownership: FileLockOwnership, applicable: bool) -> FileLockFileSnapshot {
        FileLockFileSnapshot {
            input_path: path.into(),
            depot_path: path.into(),
            client_path: path.replace("depot", "client"),
            local_path: Some(path.replace("//depot", "C:/ws")),
            opened_action: "edit".into(),
            changelist_id: 0,
            file_type: "binary+l".into(),
            exclusive: true,
            ownership,
            lock_owner: None,
            other_open: Vec::new(),
            permission: FileLockPermission::Allowed,
            applicable,
            reason: None,
        }
    }
    #[test]
    fn digest_binds_ordered_complete_file_state() {
        let mut target = FileLockTargetSnapshot {
            server: "s".into(),
            user: "u".into(),
            client: "c".into(),
            workspace: "w".into(),
            active_profile_id: Some("p".into()),
            context_generation: 1,
            operation: FileLockOperation::Lock,
            files: vec![file("//depot/a", FileLockOwnership::Unlocked, true)],
        };
        let first = digest(Some(&target));
        target.files[0].file_type = "text".into();
        assert_ne!(first, digest(Some(&target)));
    }
    #[test]
    fn other_lock_blocks_and_already_owned_is_explicit() {
        let other = file("//depot/a", FileLockOwnership::Other, false);
        assert_eq!(
            issues(FileLockOperation::Lock, &[other]).0[0].code,
            FileLockIssueCode::LockedByOther
        );
        let ours = file("//depot/b", FileLockOwnership::Ours, false);
        assert!(already_satisfied(FileLockOperation::Lock, &ours));
        assert_eq!(
            issues(FileLockOperation::Lock, &[ours]).1[0].code,
            FileLockIssueCode::AlreadyLocked
        );
    }
    #[test]
    fn execution_envelope_marks_unknown_and_never_claims_per_file_success() {
        let id = "11111111-1111-4111-8111-111111111111";
        let row = |outcome| FileLockFileResult {
            depot_path: "//depot/a".into(),
            outcome,
            message: String::new(),
            ownership: FileLockOwnership::Ours,
            lock_owner: None,
            operation_id: None,
        };
        let known = execution_envelope(
            id,
            FileLockOutcome::Succeeded,
            &[row(FileLockFileOutcome::Succeeded)],
        );
        assert_eq!(known.outcome, "commandCompleted");
        assert_eq!(known.per_file_evidence, "notCollected");
        let unknown = execution_envelope(
            id,
            FileLockOutcome::Partial,
            &[row(FileLockFileOutcome::Unknown)],
        );
        assert_eq!(unknown.outcome, "unknown");
    }
    #[test]
    fn verified_completion_is_false_when_any_file_is_unknown() {
        let unknown = FileLockFileResult {
            depot_path: "//depot/a".into(),
            outcome: FileLockFileOutcome::Unknown,
            message: String::new(),
            ownership: FileLockOwnership::Unlocked,
            lock_owner: None,
            operation_id: None,
        };
        let target = FileLockTargetSnapshot {
            server: "s".into(),
            user: "u".into(),
            client: "c".into(),
            workspace: "w".into(),
            active_profile_id: None,
            context_generation: 1,
            operation: FileLockOperation::Lock,
            files: Vec::new(),
        };
        let result = FileLockResult {
            execution: None,
            outcome: FileLockOutcome::Partial,
            failure: None,
            message: String::new(),
            files: vec![unknown],
            operation_id: None,
            log_reference: None,
            refresh: refresh(&target, "test"),
        };
        assert!(!verified_completion(&result));
    }
}
