use crate::{
    app::{
        confirmation::{ConfirmationStore, ExpiringConfirmation},
        status_cache::{InvalidationReason, StatusCache, StatusQueryKind},
    },
    domain::*,
    p4::{
        context::ContextStore,
        locks::{LockInspection, LockRepository},
    },
};
use sha2::{Digest, Sha256};
use std::sync::Arc;
use tauri::AppHandle;
use tokio::sync::Mutex as AsyncMutex;
use uuid::Uuid;

const DEFAULT_TOKEN_TTL_MS: u64 = 120_000;

#[derive(Clone)]
struct TokenRecord {
    target: FileLockTargetSnapshot,
    state_digest: String,
    expires_at: i64,
}
impl ExpiringConfirmation for TokenRecord {
    fn expires_at(&self) -> i64 {
        self.expires_at
    }
}

pub struct FileLockService {
    repository: LockRepository,
    contexts: Arc<ContextStore>,
    status_cache: Arc<StatusCache>,
    tokens: ConfirmationStore<TokenRecord>,
    confirmation_gate: AsyncMutex<()>,
    ttl_ms: u64,
}

impl FileLockService {
    pub fn new(
        repository: LockRepository,
        contexts: Arc<ContextStore>,
        status_cache: Arc<StatusCache>,
    ) -> Self {
        Self::with_ttl(repository, contexts, status_cache, DEFAULT_TOKEN_TTL_MS)
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
            tokens: ConfirmationStore::default(),
            confirmation_gate: AsyncMutex::new(()),
            ttl_ms: ttl_ms.max(1),
        }
    }

    pub fn clear_confirmations(&self) {
        self.tokens.clear();
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
        let expires_at = now_ms().saturating_add(self.ttl_ms as i64);
        let token = if ready {
            target.clone().map(|target| {
                self.tokens.issue(
                    TokenRecord {
                        target,
                        state_digest: state_digest.clone(),
                        expires_at,
                    },
                    now_ms(),
                )
            })
        } else {
            None
        };
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
            ttl_ms: self.ttl_ms,
            log_reference: operation_ids.first().cloned(),
            operation_ids,
        }
    }

    pub async fn confirm(
        &self,
        confirmation: FileLockConfirmation,
        app: Option<&AppHandle>,
    ) -> FileLockResult {
        let _gate = self.confirmation_gate.lock().await;
        let Some(record) = self.tokens.consume(&confirmation.token) else {
            return rejected(
                FileLockFailureCode::TokenUnknown,
                "The lock confirmation token is unknown or was already used.",
                Some(&confirmation.target),
            );
        };
        if record.expires_at <= now_ms() {
            return rejected(
                FileLockFailureCode::TokenExpired,
                "The lock preflight expired. Check the files again.",
                Some(&record.target),
            );
        }
        if record.target != confirmation.target || record.state_digest != confirmation.state_digest
        {
            return rejected(
                FileLockFailureCode::TargetMismatch,
                "The confirmation does not match the reviewed file set and state.",
                Some(&record.target),
            );
        }
        let (context, generation) = self.contexts.snapshot();
        if !context_matches(
            &record.target,
            &context,
            generation,
            self.contexts.active_profile_id(),
        ) {
            return rejected(FileLockFailureCode::ContextChanged, "The connection, profile, workspace, or runtime generation changed after preflight.", Some(&record.target));
        }

        let operation_id = confirmation
            .operation_id
            .filter(|value| valid_operation_id(value))
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        let group = self.repository.begin_group(operation_id.clone());
        if group.ensure_active().is_err() {
            return rejected_with_operation(
                FileLockFailureCode::Cancelled,
                "The lock operation was cancelled before execution.",
                &record.target,
                operation_id,
            );
        }
        let guard = self.repository.lock_mutations(&context.server).await;
        let paths = record
            .target
            .files
            .iter()
            .map(|file| file.input_path.clone())
            .collect::<Vec<_>>();
        let reinspection = self
            .repository
            .inspect(
                &context,
                record.target.operation,
                &paths,
                &format!("{operation_id}:recheck"),
                app,
            )
            .await;
        let Ok(reinspection) = reinspection else {
            return rejected_with_operation(
                FileLockFailureCode::PreflightBlocked,
                "The selected files could not be revalidated safely.",
                &record.target,
                operation_id,
            );
        };
        let (reblockers, _) = issues(record.target.operation, &reinspection.files);
        let rechecked = FileLockTargetSnapshot {
            files: reinspection.files,
            ..record.target.clone()
        };
        if !reblockers.is_empty()
            || rechecked != record.target
            || digest(Some(&rechecked)) != record.state_digest
        {
            return rejected_with_operation(FileLockFailureCode::StateChanged, "File mapping, opened action, changelist, filetype, permission, or lock ownership changed after review.", &record.target, operation_id);
        }
        let (latest_context, latest_generation) = self.contexts.snapshot();
        if !context_matches(
            &record.target,
            &latest_context,
            latest_generation,
            self.contexts.active_profile_id(),
        ) {
            return rejected_with_operation(
                FileLockFailureCode::ContextChanged,
                "The runtime context changed while confirmation was waiting.",
                &record.target,
                operation_id,
            );
        }
        if record.expires_at <= now_ms() {
            return rejected_with_operation(
                FileLockFailureCode::TokenExpired,
                "The lock preflight expired while confirmation was waiting.",
                &record.target,
                operation_id,
            );
        }

        let mut results = record
            .target
            .files
            .iter()
            .filter(|file| already_satisfied(record.target.operation, file))
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
        for (index, file) in record
            .target
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
                .repository
                .mutate(
                    &context,
                    record.target.operation,
                    &file.depot_path,
                    child_id.clone(),
                    &guard,
                    app,
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

        let verification = if group.ensure_active().is_ok() {
            self.repository
                .inspect(
                    &context,
                    record.target.operation,
                    &paths,
                    &format!("{operation_id}:verify"),
                    app,
                )
                .await
                .ok()
        } else {
            None
        };
        verify_results(record.target.operation, &mut results, verification.as_ref());
        self.invalidate(&context, &record.target);
        result_from_files(operation_id, &record.target, results)
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

fn already_satisfied(operation: FileLockOperation, file: &FileLockFileSnapshot) -> bool {
    matches!(
        (operation, file.ownership),
        (FileLockOperation::Lock, FileLockOwnership::Ours)
            | (FileLockOperation::Unlock, FileLockOwnership::Unlocked)
    )
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
    FileLockResult { outcome, failure: match outcome { FileLockOutcome::Succeeded | FileLockOutcome::Partial => None, FileLockOutcome::Cancelled => Some(FileLockFailureCode::Cancelled), FileLockOutcome::Unknown => Some(FileLockFailureCode::UncertainOutcome), _ => Some(FileLockFailureCode::CommandFailure) }, message: format!("Lock operation finished: {succeeded} satisfied, {failed} failed, {cancelled} cancelled, {unknown} unknown. Successful files were not rolled back."), files, operation_id: Some(operation_id.clone()), log_reference: Some(operation_id), refresh: refresh(target, "Lock state changed or may have changed; refresh workspace, Pending, search and review caches.") }
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
fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
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
}
