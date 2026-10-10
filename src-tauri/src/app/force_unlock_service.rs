use crate::{
    app::{
        confirmation::{ConfirmationStore, ExpiringConfirmation},
        status_cache::{InvalidationReason, StatusCache, StatusQueryKind},
    },
    domain::*,
    p4::{
        context::ContextStore,
        force_unlock::{ForceUnlockInspection, ForceUnlockRepository},
    },
};
use sha2::{Digest, Sha256};
use std::sync::Arc;
use tauri::AppHandle;
use tokio::sync::Mutex as AsyncMutex;
use uuid::Uuid;

const DEFAULT_TOKEN_TTL_MS: u64 = 90_000;

#[derive(Clone)]
struct TokenRecord {
    target: ForceUnlockTargetSnapshot,
    state_digest: String,
    expires_at: i64,
}

impl ExpiringConfirmation for TokenRecord {
    fn expires_at(&self) -> i64 {
        self.expires_at
    }
}

#[derive(Clone, Copy)]
enum ExecutionState {
    Accepted,
    Failed,
    Cancelled,
    Unknown,
}

pub struct ForceUnlockService {
    repository: ForceUnlockRepository,
    contexts: Arc<ContextStore>,
    status_cache: Arc<StatusCache>,
    tokens: ConfirmationStore<TokenRecord>,
    confirmation_gate: AsyncMutex<()>,
    ttl_ms: u64,
}

impl ForceUnlockService {
    pub fn new(
        repository: ForceUnlockRepository,
        contexts: Arc<ContextStore>,
        status_cache: Arc<StatusCache>,
    ) -> Self {
        Self::with_ttl(repository, contexts, status_cache, DEFAULT_TOKEN_TTL_MS)
    }

    pub(crate) fn with_ttl(
        repository: ForceUnlockRepository,
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
        request: ForceUnlockPreflightRequest,
        app: Option<&AppHandle>,
    ) -> ForceUnlockPreflight {
        let (context, generation) = self.contexts.snapshot();
        let profile = self.contexts.active_profile_id();
        let prefix = safe_operation_id(request.operation_id.as_deref(), "force-unlock-preflight");
        let inspection = self
            .repository
            .inspect(&context, &request.paths, &request.origin, &prefix, app)
            .await;
        let (locks, operation_ids, mut blockers, warnings) = match inspection {
            Ok(inspection) => {
                let (blockers, warnings) = issues(&inspection, &request.origin, &context);
                (
                    inspection.locks,
                    inspection.operation_ids,
                    blockers,
                    warnings,
                )
            }
            Err(message) => {
                let code = if message.starts_with("force unlock") {
                    ForceUnlockIssueCode::InvalidTarget
                } else {
                    match crate::p4::connection::classify_connection_error(&message) {
                        ConnectionErrorCode::AuthRequired | ConnectionErrorCode::TicketExpired => {
                            ForceUnlockIssueCode::AuthenticationRequired
                        }
                        _ => ForceUnlockIssueCode::ConnectionUnavailable,
                    }
                };
                (
                    Vec::new(),
                    Vec::new(),
                    vec![issue(
                        code,
                        "Force unlock preflight could not establish a reliable server snapshot.",
                        request.paths.clone(),
                    )],
                    Vec::new(),
                )
            }
        };
        if !same_context(&context, generation, profile.clone(), &self.contexts) {
            blockers.push(issue(
                ForceUnlockIssueCode::StateUnknown,
                "The active connection changed during force unlock preflight.",
                request.paths.clone(),
            ));
        }
        let acknowledgement = acknowledgement(&locks);
        let target = (!locks.is_empty()).then(|| ForceUnlockTargetSnapshot {
            context: context.clone(),
            active_profile_id: profile,
            context_generation: generation,
            paths: locks.iter().map(|lock| lock.depot_path.clone()).collect(),
            origin: request.origin.clone(),
            locks: locks.clone(),
            expected_acknowledgement: acknowledgement.clone(),
        });
        let state_digest = digest(target.as_ref());
        let ready = blockers.is_empty() && target.is_some();
        let expires_at = now_ms().saturating_add(self.ttl_ms as i64);
        let token = ready.then(|| {
            self.tokens.issue(
                TokenRecord {
                    target: target.clone().expect("ready target"),
                    state_digest: state_digest.clone(),
                    expires_at,
                },
                now_ms(),
            )
        });
        ForceUnlockPreflight {
            ready,
            origin: request.origin,
            locks,
            blockers,
            warnings,
            target_snapshot: target,
            state_digest,
            expected_acknowledgement: acknowledgement,
            token,
            expires_at,
            ttl_ms: self.ttl_ms,
            operation_ids,
            simulated: false,
        }
    }

    pub async fn confirm(
        &self,
        confirmation: ForceUnlockConfirmation,
        app: Option<&AppHandle>,
    ) -> ForceUnlockResult {
        let _gate = self.confirmation_gate.lock().await;
        let Some(record) = self.tokens.consume(&confirmation.token) else {
            return rejected(
                ForceUnlockFailureCode::TokenUnknown,
                "The force unlock token is unknown or already used.",
                Some(&confirmation.target),
            );
        };
        if record.expires_at <= now_ms() {
            return rejected(
                ForceUnlockFailureCode::TokenExpired,
                "The force unlock review expired.",
                Some(&record.target),
            );
        }
        if record.target != confirmation.target || record.state_digest != confirmation.state_digest
        {
            return rejected(
                ForceUnlockFailureCode::TargetMismatch,
                "The confirmation does not match the reviewed force unlock target.",
                Some(&record.target),
            );
        }
        if confirmation.acknowledgement != record.target.expected_acknowledgement {
            return rejected(
                ForceUnlockFailureCode::AcknowledgementMismatch,
                "The typed force unlock acknowledgement does not match.",
                Some(&record.target),
            );
        }
        if !target_context_matches(&record.target, &self.contexts) {
            return rejected(
                ForceUnlockFailureCode::ContextChanged,
                "The profile, connection, or generation changed after review.",
                Some(&record.target),
            );
        }
        let operation_id = safe_operation_id(confirmation.operation_id.as_deref(), "force-unlock");
        let group = self.repository.begin_group(operation_id.clone());
        if group.ensure_active().is_err() {
            return rejected_with_operation(
                ForceUnlockFailureCode::Cancelled,
                "The force unlock was cancelled before execution.",
                &record.target,
                operation_id,
            );
        }
        let guard = self
            .repository
            .lock_mutations(&record.target.context.server)
            .await;
        let reinspection = self
            .repository
            .inspect(
                &record.target.context,
                &record.target.paths,
                &record.target.origin,
                &format!("{operation_id}:recheck"),
                app,
            )
            .await;
        let Ok(reinspection) = reinspection else {
            return rejected_with_operation(
                ForceUnlockFailureCode::PreflightBlocked,
                "The lock facts could not be safely revalidated.",
                &record.target,
                operation_id,
            );
        };
        let (reblockers, _) = issues(&reinspection, &record.target.origin, &record.target.context);
        let mut rechecked = record.target.clone();
        rechecked.locks = reinspection.locks;
        if !reblockers.is_empty()
            || rechecked != record.target
            || digest(Some(&rechecked)) != record.state_digest
        {
            return rejected_with_operation(
                ForceUnlockFailureCode::StateChanged,
                "Lock owner, origin, changelist, permission, or server facts changed after review.",
                &record.target,
                operation_id,
            );
        }
        if !target_context_matches(&record.target, &self.contexts) || group.ensure_active().is_err()
        {
            return rejected_with_operation(
                ForceUnlockFailureCode::ContextChanged,
                "The force unlock context changed before execution.",
                &record.target,
                operation_id,
            );
        }
        if record.expires_at <= now_ms() {
            return rejected_with_operation(
                ForceUnlockFailureCode::TokenExpired,
                "The force unlock review expired while waiting for the mutation lane.",
                &record.target,
                operation_id,
            );
        }

        let mut executions = Vec::new();
        let mut operation_ids = reinspection.operation_ids;
        for (index, lock) in record.target.locks.iter().enumerate() {
            let child_id = format!("{operation_id}:file-{index}");
            if group.ensure_active().is_err() {
                executions.push((lock.clone(), ExecutionState::Cancelled, None));
                continue;
            }
            let execution = self
                .repository
                .mutate(
                    &record.target.context,
                    &record.target.origin,
                    &lock.depot_path,
                    child_id.clone(),
                    &guard,
                    app,
                )
                .await;
            let state = match execution {
                Ok(result) if result.exit_code == 0 => ExecutionState::Accepted,
                Ok(result)
                    if result
                        .events
                        .iter()
                        .any(|event| matches!(event.kind, EventKind::Cancelled)) =>
                {
                    ExecutionState::Cancelled
                }
                Ok(_) => ExecutionState::Failed,
                Err(message) if message.to_ascii_lowercase().contains("cancel") => {
                    ExecutionState::Cancelled
                }
                Err(message)
                    if message.to_ascii_lowercase().contains("timed out")
                        || message.to_ascii_lowercase().contains("timeout") =>
                {
                    ExecutionState::Unknown
                }
                Err(_) => ExecutionState::Failed,
            };
            operation_ids.push(child_id.clone());
            executions.push((lock.clone(), state, Some(child_id)));
        }

        let verification = if group.ensure_active().is_ok() {
            self.repository
                .inspect(
                    &record.target.context,
                    &record.target.paths,
                    &record.target.origin,
                    &format!("{operation_id}:verify"),
                    app,
                )
                .await
                .ok()
        } else {
            None
        };
        if let Some(verification) = &verification {
            operation_ids.extend(verification.operation_ids.clone());
        }
        let files = executions
            .into_iter()
            .map(|(before, execution, child)| {
                verified_file_result(&before, execution, child, verification.as_ref())
            })
            .collect::<Vec<_>>();
        self.invalidate(&record.target);
        result_from_files(operation_id, operation_ids, &record.target, files)
    }

    fn invalidate(&self, target: &ForceUnlockTargetSnapshot) {
        self.status_cache.invalidate(
            &target.context.server,
            &target.context.user,
            &target.context.client,
            &target.paths,
            &[StatusQueryKind::WorkspaceStatus, StatusQueryKind::Opened],
            InvalidationReason::FileMutation,
        );
    }
}

fn issues(
    inspection: &ForceUnlockInspection,
    origin: &ForceUnlockOrigin,
    context: &P4Context,
) -> (Vec<ForceUnlockIssue>, Vec<ForceUnlockIssue>) {
    let mut blockers = Vec::new();
    let mut warnings = Vec::new();
    if matches!(origin.mode, ForceUnlockOriginMode::OrphanDistributed) {
        let distributed = inspection
            .server_services
            .as_deref()
            .is_some_and(|services| {
                let services = services.to_ascii_lowercase();
                services.contains("edge") || services.contains("commit")
            });
        if !distributed {
            blockers.push(issue(
                ForceUnlockIssueCode::UnsupportedServerTopology,
                "Orphan distributed force unlock requires a proven edge/commit topology.",
                inspection
                    .locks
                    .iter()
                    .map(|lock| lock.depot_path.clone())
                    .collect(),
            ));
        }
    }
    if matches!(origin.mode, ForceUnlockOriginMode::ShelvedChangelist) {
        blockers.push(issue(
            ForceUnlockIssueCode::OriginUnproven,
            "The current server records do not prove that the lock came from an aborted shelved submit; -s is blocked.",
            inspection
                .locks
                .iter()
                .map(|lock| lock.depot_path.clone())
                .collect(),
        ));
    }
    for lock in &inspection.locks {
        let path = vec![lock.depot_path.clone()];
        if !lock.exists {
            blockers.push(issue(
                ForceUnlockIssueCode::StateUnknown,
                "The exact depot file was not returned by tagged fstat.",
                path,
            ));
        } else if !lock.locked {
            blockers.push(issue(
                ForceUnlockIssueCode::NotLocked,
                "The file is not currently locked.",
                path,
            ));
        } else if lock.lock_owner.is_none()
            || lock.lock_user.is_none()
            || lock.lock_client.is_none()
        {
            blockers.push(issue(
                ForceUnlockIssueCode::LockOwnerUnknown,
                "The server did not identify one unambiguous lock owner and client.",
                path,
            ));
        } else if lock.lock_user.as_deref() == Some(context.user.as_str())
            && lock.lock_client.as_deref() == Some(context.client.as_str())
        {
            blockers.push(issue(
                ForceUnlockIssueCode::OwnedByCurrentContext,
                "This lock belongs to the active user/client; use ordinary unlock.",
                path,
            ));
        } else if !lock.origin_proven {
            blockers.push(issue(
                ForceUnlockIssueCode::OriginMismatch,
                "The selected lock origin and changelist were not proven by server facts.",
                path,
            ));
        }
        if !matches!(
            lock.permission,
            ForceUnlockPermission::Admin | ForceUnlockPermission::Super
        ) {
            blockers.push(issue(
                ForceUnlockIssueCode::AdminPermissionRequired,
                "Admin or super permission is required for every affected depot file.",
                vec![lock.depot_path.clone()],
            ));
        }
    }
    if blockers.is_empty() {
        warnings.push(issue(
            ForceUnlockIssueCode::StateUnknown,
            "Force unlock removes another workspace's lock without changing its opened record or file content; there is no automatic rollback.",
            inspection
                .locks
                .iter()
                .map(|lock| lock.depot_path.clone())
                .collect(),
        ));
    }
    (blockers, warnings)
}

fn verified_file_result(
    before: &ForceUnlockLockFact,
    execution: ExecutionState,
    operation_id: Option<String>,
    verification: Option<&ForceUnlockInspection>,
) -> ForceUnlockFileResult {
    let observed = verification.and_then(|inspection| {
        inspection
            .locks
            .iter()
            .find(|lock| lock.depot_path == before.depot_path)
    });
    let (outcome, message) = match observed {
        Some(lock) if lock.exists && !lock.locked => (
            ForceUnlockFileOutcome::Unlocked,
            "Tagged fstat verified that the selected lock is gone.",
        ),
        Some(lock) if lock.exists && lock.locked => (
            ForceUnlockFileOutcome::StillLocked,
            "The selected path is still locked after the force command.",
        ),
        Some(_) => (
            ForceUnlockFileOutcome::Disappeared,
            "The file disappeared from the authoritative fstat result; success is not claimed.",
        ),
        None if matches!(execution, ExecutionState::Cancelled) => (
            ForceUnlockFileOutcome::Cancelled,
            "The operation was cancelled and final lock state was not verified.",
        ),
        None if matches!(execution, ExecutionState::Failed) => (
            ForceUnlockFileOutcome::Failed,
            "The force command failed and final lock state was not verified.",
        ),
        None => (
            ForceUnlockFileOutcome::Unverifiable,
            "The force command outcome is uncertain; refresh before any retry.",
        ),
    };
    ForceUnlockFileResult {
        depot_path: before.depot_path.clone(),
        outcome,
        previous_owner: before.lock_owner.clone(),
        observed_owner: observed.and_then(|lock| lock.lock_owner.clone()),
        message: message.into(),
        operation_id,
    }
}

fn result_from_files(
    operation_id: String,
    operation_ids: Vec<String>,
    target: &ForceUnlockTargetSnapshot,
    files: Vec<ForceUnlockFileResult>,
) -> ForceUnlockResult {
    let unlocked = files
        .iter()
        .filter(|file| file.outcome == ForceUnlockFileOutcome::Unlocked)
        .count();
    let cancelled = files
        .iter()
        .filter(|file| file.outcome == ForceUnlockFileOutcome::Cancelled)
        .count();
    let unknown = files.iter().any(|file| {
        matches!(
            file.outcome,
            ForceUnlockFileOutcome::Unverifiable | ForceUnlockFileOutcome::Disappeared
        )
    });
    let outcome = if unlocked == files.len() && !files.is_empty() {
        ForceUnlockOutcome::Succeeded
    } else if unlocked > 0 {
        ForceUnlockOutcome::Partial
    } else if cancelled == files.len() && !files.is_empty() {
        ForceUnlockOutcome::Cancelled
    } else if unknown {
        ForceUnlockOutcome::Unknown
    } else {
        ForceUnlockOutcome::Failed
    };
    ForceUnlockResult {
        outcome,
        failure: match outcome {
            ForceUnlockOutcome::Succeeded | ForceUnlockOutcome::Partial => None,
            ForceUnlockOutcome::Cancelled => Some(ForceUnlockFailureCode::Cancelled),
            ForceUnlockOutcome::Unknown => Some(ForceUnlockFailureCode::UncertainOutcome),
            _ => Some(ForceUnlockFailureCode::CommandFailure),
        },
        message: format!(
            "Force unlock verification finished: {unlocked}/{} targets are proven unlocked; no file content or opened record was changed by P4Deck.",
            files.len()
        ),
        files,
        operation_id: Some(operation_id),
        operation_ids,
        refresh: refresh(target, "Force unlock changed or may have changed server lock state."),
        simulated: false,
    }
}

fn acknowledgement(locks: &[ForceUnlockLockFact]) -> String {
    let mut owners = locks
        .iter()
        .filter_map(|lock| lock.lock_owner.clone())
        .collect::<Vec<_>>();
    owners.sort();
    owners.dedup();
    if owners.is_empty() {
        String::new()
    } else {
        format!(
            "FORCE UNLOCK {} FILES OWNED BY {}",
            locks.len(),
            owners.join(",")
        )
    }
}

fn digest(target: Option<&ForceUnlockTargetSnapshot>) -> String {
    let mut hasher = Sha256::new();
    hasher.update(serde_json::to_vec(&target).expect("force unlock target serializes"));
    format!("{:x}", hasher.finalize())
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn safe_operation_id(value: Option<&str>, fallback: &str) -> String {
    value
        .filter(|value| {
            !value.trim().is_empty() && value.len() <= 128 && !value.chars().any(char::is_control)
        })
        .map(str::to_owned)
        .unwrap_or_else(|| format!("{fallback}-{}", Uuid::new_v4()))
}

fn same_context(
    context: &P4Context,
    generation: u64,
    profile: Option<String>,
    contexts: &ContextStore,
) -> bool {
    let (current, current_generation) = contexts.snapshot();
    current == *context
        && current_generation == generation
        && contexts.active_profile_id() == profile
}

fn target_context_matches(target: &ForceUnlockTargetSnapshot, contexts: &ContextStore) -> bool {
    same_context(
        &target.context,
        target.context_generation,
        target.active_profile_id.clone(),
        contexts,
    )
}

fn issue(
    code: ForceUnlockIssueCode,
    message: impl Into<String>,
    paths: Vec<String>,
) -> ForceUnlockIssue {
    ForceUnlockIssue {
        code,
        message: message.into(),
        paths,
    }
}

fn refresh(target: &ForceUnlockTargetSnapshot, reason: &str) -> FileLockRefreshAdvice {
    FileLockRefreshAdvice {
        workspace_status: true,
        pending_changes: true,
        search: true,
        review: true,
        depot_paths: target.paths.clone(),
        local_paths: Vec::new(),
        reason: reason.into(),
    }
}

fn rejected(
    failure: ForceUnlockFailureCode,
    message: &str,
    target: Option<&ForceUnlockTargetSnapshot>,
) -> ForceUnlockResult {
    ForceUnlockResult {
        outcome: ForceUnlockOutcome::Rejected,
        failure: Some(failure),
        message: message.into(),
        files: Vec::new(),
        operation_id: None,
        operation_ids: Vec::new(),
        refresh: target.map_or(
            FileLockRefreshAdvice {
                workspace_status: true,
                pending_changes: true,
                search: true,
                review: true,
                depot_paths: Vec::new(),
                local_paths: Vec::new(),
                reason: "Repeat force unlock preflight before retrying.".into(),
            },
            |target| refresh(target, "Repeat force unlock preflight before retrying."),
        ),
        simulated: false,
    }
}

fn rejected_with_operation(
    failure: ForceUnlockFailureCode,
    message: &str,
    target: &ForceUnlockTargetSnapshot,
    operation_id: String,
) -> ForceUnlockResult {
    let mut result = rejected(failure, message, Some(target));
    result.operation_id = Some(operation_id.clone());
    result.operation_ids.push(operation_id);
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lock(owner: &str) -> ForceUnlockLockFact {
        let (user, client) = owner.split_once('@').unwrap();
        ForceUnlockLockFact {
            depot_path: "//depot/a.txt".into(),
            exists: true,
            locked: true,
            lock_owner: Some(owner.into()),
            lock_user: Some(user.into()),
            lock_client: Some(client.into()),
            change_id: Some(7),
            opened_action: Some("edit".into()),
            file_type: Some("text".into()),
            exclusive: false,
            origin: ForceUnlockOrigin {
                mode: ForceUnlockOriginMode::OpenedChangelist,
                change_id: Some(7),
            },
            origin_proven: true,
            permission: ForceUnlockPermission::Admin,
        }
    }

    #[test]
    fn acknowledgement_and_digest_bind_owner_context_origin_and_order() {
        let first = lock("bob@ws");
        assert_eq!(
            acknowledgement(std::slice::from_ref(&first)),
            "FORCE UNLOCK 1 FILES OWNED BY bob@ws"
        );
        let mut target = ForceUnlockTargetSnapshot {
            context: P4Context::default(),
            active_profile_id: Some("profile".into()),
            context_generation: 3,
            paths: vec![first.depot_path.clone()],
            origin: first.origin.clone(),
            locks: vec![first],
            expected_acknowledgement: "ack".into(),
        };
        let before = digest(Some(&target));
        target.locks[0].lock_owner = Some("eve@other".into());
        assert_ne!(before, digest(Some(&target)));
    }

    #[test]
    fn only_verified_unlocked_targets_can_complete_successfully() {
        let before = lock("bob@ws");
        let mut verified = before.clone();
        verified.locked = false;
        verified.lock_owner = None;
        let inspection = ForceUnlockInspection {
            server_services: Some("standard".into()),
            locks: vec![verified],
            operation_ids: Vec::new(),
        };
        assert_eq!(
            verified_file_result(&before, ExecutionState::Accepted, None, Some(&inspection))
                .outcome,
            ForceUnlockFileOutcome::Unlocked
        );
        assert_eq!(
            verified_file_result(&before, ExecutionState::Unknown, None, None).outcome,
            ForceUnlockFileOutcome::Unverifiable
        );
    }

    #[test]
    fn aggregate_preserves_partial_cancelled_and_uncertain_outcomes() {
        let first = lock("bob@ws");
        let mut second = lock("eve@other");
        second.depot_path = "//depot/b.txt".into();
        let target = ForceUnlockTargetSnapshot {
            context: P4Context::default(),
            active_profile_id: Some("profile".into()),
            context_generation: 3,
            paths: vec![first.depot_path.clone(), second.depot_path.clone()],
            origin: first.origin.clone(),
            locks: vec![first.clone(), second.clone()],
            expected_acknowledgement: "ack".into(),
        };
        let file = |lock: &ForceUnlockLockFact, outcome| ForceUnlockFileResult {
            depot_path: lock.depot_path.clone(),
            outcome,
            previous_owner: lock.lock_owner.clone(),
            observed_owner: None,
            message: String::new(),
            operation_id: None,
        };

        let partial = result_from_files(
            "partial".into(),
            Vec::new(),
            &target,
            vec![
                file(&first, ForceUnlockFileOutcome::Unlocked),
                file(&second, ForceUnlockFileOutcome::StillLocked),
            ],
        );
        assert_eq!(partial.outcome, ForceUnlockOutcome::Partial);
        assert_eq!(partial.failure, None);

        let uncertain = result_from_files(
            "uncertain".into(),
            Vec::new(),
            &target,
            vec![file(&first, ForceUnlockFileOutcome::Unverifiable)],
        );
        assert_eq!(uncertain.outcome, ForceUnlockOutcome::Unknown);
        assert_eq!(
            uncertain.failure,
            Some(ForceUnlockFailureCode::UncertainOutcome)
        );

        let cancelled = result_from_files(
            "cancelled".into(),
            Vec::new(),
            &target,
            vec![file(&first, ForceUnlockFileOutcome::Cancelled)],
        );
        assert_eq!(cancelled.outcome, ForceUnlockOutcome::Cancelled);
        assert_eq!(cancelled.failure, Some(ForceUnlockFailureCode::Cancelled));
    }
}
