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
        rename::{RenameInspection, RenameRepository},
        runner::MutationGuard,
    },
};
use sha2::{Digest, Sha256};
use std::{
    path::{Component, Path},
    sync::Arc,
};
use tauri::AppHandle;
use uuid::Uuid;

struct Evaluation {
    blockers: Vec<RenameMoveIssue>,
    warnings: Vec<RenameMoveIssue>,
    target: Option<RenameMoveTargetSnapshot>,
    case_only_risk: bool,
}

pub struct RenameService {
    repository: RenameRepository,
    contexts: Arc<ContextStore>,
    status_cache: Arc<StatusCache>,
    /// preflight → one-time token → recheck → lane → execute (shared skeleton).
    tickets: ConfirmationTicket<RenameMoveTargetSnapshot, String>,
}

impl RenameService {
    pub fn new(
        repository: RenameRepository,
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
        repository: RenameRepository,
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
        request: RenameMovePreflightRequest,
        app: Option<&AppHandle>,
    ) -> RenameMovePreflight {
        let (context, generation) = self.contexts.snapshot();
        let profile_id = self.contexts.active_profile_id();
        let prefix = safe_operation_prefix(request.operation_id.as_deref(), "rename-preflight");
        let inspection = self
            .repository
            .inspect(&context, &request, &prefix, app)
            .await;
        let (inspection, evaluation) = match inspection {
            Ok(inspection) => {
                let evaluation = evaluate(
                    &context,
                    generation,
                    profile_id,
                    request.target_change_id,
                    &inspection,
                );
                (Some(inspection), evaluation)
            }
            Err(message) => (
                None,
                Evaluation {
                    blockers: vec![issue(
                        if message.starts_with("invalid rename/move path")
                            || message.contains("identical")
                            || message.contains("targetChangeId")
                        {
                            RenameMoveIssueCode::InvalidPath
                        } else {
                            RenameMoveIssueCode::InspectionUnavailable
                        },
                        format!("Rename/move preflight could not establish a reliable snapshot: {message}"),
                    )],
                    warnings: Vec::new(),
                    target: None,
                    case_only_risk: false,
                },
            ),
        };
        let preview_digest = digest_preview(
            evaluation.target.as_ref(),
            &evaluation.blockers,
            &evaluation.warnings,
        );
        let ready = evaluation.blockers.is_empty() && evaluation.target.is_some();
        // `ready` already implies a target; a blocked review issues no token.
        let (expires_at, token) = evaluation
            .target
            .clone()
            .and_then(|target| self.tickets.issue(ready, target, preview_digest.clone()))
            .map_or_else(
                || (self.tickets.planned_expires_at(), None),
                |(expires_at, token)| (expires_at, Some(token)),
            );
        let operation_ids = inspection
            .as_ref()
            .map(|value| value.operation_ids.clone())
            .unwrap_or_default();
        RenameMovePreflight {
            ready,
            source: inspection.as_ref().and_then(|value| value.source.clone()),
            target: inspection.as_ref().and_then(|value| value.target.clone()),
            source_state: inspection
                .as_ref()
                .and_then(|value| value.source_state.clone()),
            target_change_id: request.target_change_id,
            target_change_valid: inspection
                .as_ref()
                .is_some_and(|value| value.target_change_valid),
            target_exists: inspection.as_ref().is_some_and(|value| value.target_exists),
            case_only_risk: evaluation.case_only_risk,
            blockers: evaluation.blockers,
            warnings: evaluation.warnings,
            target_snapshot: evaluation.target,
            preview_digest,
            token,
            expires_at,
            ttl_ms: self.tickets.ttl_ms(),
            log_reference: operation_ids.first().cloned(),
            operation_ids,
        }
    }

    pub async fn confirm(
        &self,
        confirmation: RenameMoveConfirmation,
        app: Option<&AppHandle>,
    ) -> RenameMoveResult {
        let mut review = RenameReview {
            service: self,
            app,
            reviewed: confirmation.target.clone(),
            current_operation_id: confirmation
                .operation_id
                .clone()
                .filter(|value| valid_operation_id(value)),
            operation_id: None,
            evaluated: None,
            held_lane: None,
        };
        // The ticket takes the token, then decides in the established order:
        // expiry → target/digest → context, then the lane, the re-check,
        // context and expiry again, then the mutation.
        let request = ConfirmationRequest::new(&confirmation.token, &confirmation.target)
            .with_digest(&confirmation.preview_digest);
        match self.tickets.confirm(request, &mut review).await {
            Ok(result) => result,
            Err(refusal) => {
                let code = refusal.code().unwrap_or(RenameMoveFailureCode::Cancelled);
                let message = refusal
                    .message()
                    .unwrap_or("Rename/move was cancelled before execution.");
                rejected(code, message, Some(&review.reviewed))
            }
        }
    }
}

/// One rename/move confirmation as the shared ticket sees it.
///
/// The ticket owns the decision order; this type supplies only the decisions a
/// rename makes between the review and the mutation: the fresh inspection, the
/// blocker/`target_exists` distinction between "source changed" and "target
/// changed", and the execute call under the mutation lane.
struct RenameReview<'a> {
    service: &'a RenameService,
    app: Option<&'a AppHandle>,
    /// The reviewed snapshot (the caller's echo until the token is taken).
    reviewed: RenameMoveTargetSnapshot,
    current_operation_id: Option<String>,
    operation_id: Option<String>,
    /// Outcome of the last re-check: the candidate target and whether the
    /// destination already existed (which decides TargetChanged vs
    /// SourceChanged).
    evaluated: Option<(Option<RenameMoveTargetSnapshot>, bool)>,
    /// The server write lane taken in `lane()` (before the re-check) and held
    /// through `execute`.
    held_lane: Option<MutationGuard>,
}

impl ReviewSpec for RenameReview<'_> {
    type Target = RenameMoveTargetSnapshot;
    type Digest = String;
    type Recheck = ();
    type Output = RenameMoveResult;
    type RefusalCode = RenameMoveFailureCode;
    type Error = ConfirmRefusal<RenameMoveFailureCode>;

    fn unwrap_error(error: Self::Error) -> ConfirmRefusal<RenameMoveFailureCode> {
        error
    }

    fn refusal_code(&self, shared: ConfirmationRefusalCode) -> RenameMoveFailureCode {
        match shared {
            ConfirmationRefusalCode::TokenUnknown => RenameMoveFailureCode::TokenUnknown,
            ConfirmationRefusalCode::TokenExpired => RenameMoveFailureCode::TokenExpired,
            ConfirmationRefusalCode::TargetMismatch => RenameMoveFailureCode::TargetMismatch,
            // Rename/move never requires an acknowledgement.
            ConfirmationRefusalCode::AcknowledgementRequired => RenameMoveFailureCode::TokenUnknown,
            ConfirmationRefusalCode::ContextChanged => RenameMoveFailureCode::ContextChanged,
            // This domain has no separate "now blocked" outcome; it keeps reporting
            // a blocked re-check as a changed one.
            ConfirmationRefusalCode::RecheckBlocked | ConfirmationRefusalCode::RecheckChanged => {
                self.recheck_changed_code()
            }
            ConfirmationRefusalCode::RecheckUnavailable => RenameMoveFailureCode::PreflightBlocked,
            ConfirmationRefusalCode::Cancelled => RenameMoveFailureCode::Cancelled,
        }
    }

    fn refusal_message(&self, shared: ConfirmationRefusalCode) -> &'static str {
        match shared {
            ConfirmationRefusalCode::TokenUnknown => {
                "The rename/move confirmation token is unknown or was already used."
            }
            ConfirmationRefusalCode::TokenExpired => {
                "The rename/move preview expired. Run preflight again."
            }
            ConfirmationRefusalCode::TargetMismatch => {
                "The confirmation does not match the reviewed preview."
            }
            ConfirmationRefusalCode::AcknowledgementRequired => {
                "The rename/move confirmation token is unknown or was already used."
            }
            ConfirmationRefusalCode::ContextChanged => {
                "The connection, profile, workspace, or runtime generation changed after preview."
            }
            ConfirmationRefusalCode::RecheckBlocked | ConfirmationRefusalCode::RecheckChanged => {
                match self.recheck_changed_code() {
                    RenameMoveFailureCode::SourceChanged => {
                        "The mapped paths or opened source state changed after preview."
                    }
                    RenameMoveFailureCode::TargetChanged => {
                        "The source, target, or changelist changed after preview."
                    }
                    _ => "The source, target, or changelist changed after preview.",
                }
            }
            ConfirmationRefusalCode::RecheckUnavailable => {
                "The source and target could not be revalidated safely."
            }
            ConfirmationRefusalCode::Cancelled => "Rename/move was cancelled before execution.",
        }
    }

    fn context_current(&self) -> bool {
        let (context, generation) = self.service.contexts.snapshot();
        context_matches(
            &self.reviewed,
            &context,
            generation,
            self.service.contexts.active_profile_id(),
        )
    }

    fn on_reviewed(&mut self, reviewed: &IssuedConfirmation<Self::Target, Self::Digest>) {
        self.reviewed = reviewed.target.clone();
    }

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

    /// Re-inspect source and destination, then evaluate the result the same way
    /// preflight did. Evaluation problems are reported as the review's changed
    /// verdict, evaluated targets as the rechecked snapshot.
    fn recheck(
        &mut self,
    ) -> crate::app::confirmation::BoxFuture<'_, Result<Self::Recheck, String>> {
        Box::pin(async move {
            let (context, generation) = self.service.contexts.snapshot();
            let reviewed = self.reviewed.clone();
            let request = RenameMovePreflightRequest {
                source_path: reviewed.source.local_path.clone(),
                target_path: reviewed.target.local_path.clone(),
                target_change_id: reviewed.target_change_id,
                operation_id: None,
            };
            let inspection = self
                .service
                .repository
                .inspect(
                    &context,
                    &request,
                    &format!("rename-recheck-{}", Uuid::new_v4()),
                    self.app,
                )
                .await?;
            let evaluation = evaluate(
                &context,
                generation,
                self.service.contexts.active_profile_id(),
                reviewed.target_change_id,
                &inspection,
            );
            self.evaluated = Some((evaluation.target, inspection.target_exists));
            Ok(())
        })
    }

    fn recheck_verdict(&self, _recheck: &Self::Recheck) -> RecheckVerdict {
        match &self.evaluated {
            // The re-check found blockers, or no valid target at all.
            Some((None, _)) | None => RecheckVerdict::Changed,
            Some((Some(target), _)) => {
                let mapped_paths_changed = digest_preview(Some(target), &[], &[])
                    != digest_preview(Some(&self.reviewed), &[], &[]);
                if *target != self.reviewed || mapped_paths_changed {
                    RecheckVerdict::Changed
                } else {
                    RecheckVerdict::Unchanged
                }
            }
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
        _recheck: Self::Recheck,
        operation_id: String,
    ) -> crate::app::confirmation::BoxFuture<'a, Result<Self::Output, Self::Error>> {
        Box::pin(async move {
            let (context, _) = self.service.contexts.snapshot();
            let reviewed = self.reviewed.clone();
            let operation_id = self.operation_id.clone().unwrap_or(operation_id);
            // `lane()` took the guard before the re-check; if it is missing the
            // ticket never got that far, and taking a fresh one here keeps the
            // write serialised anyway.
            let owned_guard;
            let guard = match self.held_lane.as_ref() {
                Some(guard) => guard,
                None => {
                    owned_guard = self
                        .service
                        .repository
                        .lock_mutations(&context.server)
                        .await;
                    &owned_guard
                }
            };
            let execution = self
                .service
                .repository
                .execute(&context, &reviewed, operation_id.clone(), guard, self.app)
                .await;
            self.service.status_cache.invalidate(
                &context.server,
                &context.user,
                &context.client,
                &[
                    reviewed.source.local_path.clone(),
                    reviewed.target.local_path.clone(),
                ],
                &[
                    StatusQueryKind::WorkspaceStatus,
                    StatusQueryKind::Opened,
                    StatusQueryKind::Reconcile,
                ],
                InvalidationReason::FileMutation,
            );
            Ok(execution_result(&reviewed, operation_id, execution))
        })
    }
}

impl RenameReview<'_> {
    /// Which "changed" code the re-check produces.
    ///
    /// A new destination blocker (the target now exists) is TargetChanged, an
    /// unreachable evaluation target is PreflightBlocked, and everything else is
    /// a source/plan change.
    fn recheck_changed_code(&self) -> RenameMoveFailureCode {
        match self.evaluated {
            Some((None, target_exists)) if target_exists => RenameMoveFailureCode::TargetChanged,
            Some((None, _)) => RenameMoveFailureCode::PreflightBlocked,
            Some((Some(_), _)) => RenameMoveFailureCode::SourceChanged,
            None => RenameMoveFailureCode::PreflightBlocked,
        }
    }
}

fn execution_result(
    target: &RenameMoveTargetSnapshot,
    operation_id: String,
    execution: Result<OperationResult, String>,
) -> RenameMoveResult {
    match execution {
        Ok(operation) if operation.exit_code == 0 => RenameMoveResult {
            outcome: RenameMoveOutcome::Succeeded,
            failure: None,
            message: "The file was opened for move at the reviewed destination.".into(),
            operation_id: Some(operation_id.clone()),
            log_reference: Some(operation_id),
            refresh: refresh(
                target,
                "Rename/move completed; refresh workspace and pending changelists.",
            ),
        },
        Ok(operation) => {
            let cancelled = operation
                .events
                .iter()
                .any(|event| matches!(event.kind, EventKind::Cancelled));
            RenameMoveResult {
                    outcome: if cancelled {
                        RenameMoveOutcome::Cancelled
                    } else {
                        RenameMoveOutcome::Failed
                    },
                    failure: Some(if cancelled {
                        RenameMoveFailureCode::Cancelled
                    } else {
                        RenameMoveFailureCode::CommandFailure
                    }),
                    message: if cancelled {
                        "Rename/move was cancelled. Refresh before retrying."
                    } else {
                        "The server rejected rename/move. Refresh before retrying."
                    }
                    .into(),
                    operation_id: Some(operation_id.clone()),
                    log_reference: Some(operation_id),
                    refresh: refresh(
                        target,
                        "The command did not complete successfully; refresh both paths and pending changelists.",
                    ),
                }
        }
        Err(message) => {
            let cancelled = message.to_ascii_lowercase().contains("cancel");
            let uncertain = message.to_ascii_lowercase().contains("timed out");
            RenameMoveResult {
                outcome: if cancelled {
                    RenameMoveOutcome::Cancelled
                } else if uncertain {
                    RenameMoveOutcome::Unknown
                } else {
                    RenameMoveOutcome::Failed
                },
                failure: Some(if cancelled {
                    RenameMoveFailureCode::Cancelled
                } else if uncertain {
                    RenameMoveFailureCode::UncertainOutcome
                } else {
                    RenameMoveFailureCode::CommandFailure
                }),
                message: format!("Rename/move did not complete reliably: {message}"),
                operation_id: Some(operation_id.clone()),
                log_reference: Some(operation_id),
                refresh: refresh(
                    target,
                    "The command outcome requires a fresh workspace and changelist snapshot.",
                ),
            }
        }
    }
}

fn evaluate(
    context: &P4Context,
    generation: u64,
    active_profile_id: Option<String>,
    target_change_id: i64,
    inspection: &RenameInspection,
) -> Evaluation {
    let mut blockers = Vec::new();
    if !inspection.source_exists {
        blockers.push(issue(
            RenameMoveIssueCode::SourceMissing,
            "The source must be an existing controlled file in the current workspace.",
        ));
    }
    if inspection.source.is_none() {
        blockers.push(issue(
            RenameMoveIssueCode::SourceUnmapped,
            "The source is not mapped by the current workspace view.",
        ));
    }
    if inspection.target.is_none() {
        blockers.push(issue(
            RenameMoveIssueCode::TargetUnmapped,
            "The destination is not mapped by the current workspace view.",
        ));
    }
    if inspection.target_exists {
        blockers.push(issue(
            RenameMoveIssueCode::TargetExists,
            "The destination already exists locally or in the depot; overwrite is not allowed.",
        ));
    }
    if inspection.target.is_some() && !inspection.target_parent_exists {
        blockers.push(issue(
            RenameMoveIssueCode::InvalidPath,
            "The destination parent directory must already exist; it will not be created automatically.",
        ));
    }
    if !inspection
        .source_state
        .as_ref()
        .is_some_and(|state| matches!(state.action.as_str(), "edit" | "add"))
    {
        blockers.push(issue(
            RenameMoveIssueCode::SourceNotOpened,
            "The source must be opened for edit or add before it can be moved.",
        ));
    }
    if !inspection.target_change_valid {
        blockers.push(issue(
            RenameMoveIssueCode::InvalidChangelist,
            "The target changelist must be Default or an existing pending changelist owned by this user and workspace.",
        ));
    }
    let same_mapping = inspection
        .source
        .as_ref()
        .zip(inspection.target.as_ref())
        .is_some_and(|(source, target)| {
            mapped_to_context(context, source)
                && mapped_to_context(context, target)
                && client_root(&source.client_path) == client_root(&target.client_path)
        });
    if inspection.source.is_some() && inspection.target.is_some() && !same_mapping {
        blockers.push(issue(
            RenameMoveIssueCode::CrossWorkspace,
            "Source and destination must remain in the same current workspace mapping.",
        ));
    }
    let case_only_risk = inspection
        .source
        .as_ref()
        .zip(inspection.target.as_ref())
        .is_some_and(|(source, target)| case_only(&source.local_path, &target.local_path));
    if case_only_risk {
        blockers.push(issue(
            RenameMoveIssueCode::CaseOnlyRename,
            "Case-only rename is blocked on Windows because a safe temporary-name transaction and rollback are not implemented.",
        ));
    }
    let target = if blockers.is_empty() {
        Some(RenameMoveTargetSnapshot {
            server: context.server.clone(),
            user: context.user.clone(),
            client: context.client.clone(),
            workspace: context.cwd.clone().unwrap_or_default(),
            active_profile_id,
            context_generation: generation,
            source: inspection.source.clone().expect("validated source mapping"),
            target: inspection.target.clone().expect("validated target mapping"),
            source_state: inspection
                .source_state
                .clone()
                .expect("validated source state"),
            target_change_id,
        })
    } else {
        None
    };
    Evaluation {
        blockers,
        warnings: Vec::new(),
        target,
        case_only_risk,
    }
}

fn mapped_to_context(context: &P4Context, mapping: &RenameMoveMapping) -> bool {
    let expected_client = format!("//{}/", context.client);
    if !mapping.client_path.starts_with(&expected_client) {
        return false;
    }
    let Some(root) = context.cwd.as_deref() else {
        return false;
    };
    let root = Path::new(root);
    let local = Path::new(&mapping.local_path);
    local.is_absolute()
        && !local
            .components()
            .any(|component| matches!(component, Component::ParentDir | Component::CurDir))
        && path_starts_with(local, root)
}

fn path_starts_with(path: &Path, root: &Path) -> bool {
    if cfg!(windows) {
        if path
            .to_string_lossy()
            .split(['/', '\\'])
            .any(|part| part == ".." || part == ".")
        {
            return false;
        }
        let normalize = |path: &Path| {
            // canonicalize() returns verbatim Windows roots, while p4 where
            // returns ordinary DOS/UNC paths for the same workspace.
            crate::local_path::plain_path(path)
                .replace('/', "\\")
                .to_ascii_lowercase()
                .trim_end_matches('\\')
                .to_owned()
        };
        let path = normalize(path);
        let root = normalize(root);
        path == root || path.starts_with(&format!("{root}\\"))
    } else {
        path.starts_with(root)
    }
}

fn client_root(path: &str) -> Option<&str> {
    let remainder = path.strip_prefix("//")?;
    remainder.split('/').next()
}

fn case_only(source: &str, target: &str) -> bool {
    let source = source.replace('\\', "/");
    let target = target.replace('\\', "/");
    source != target && source.to_lowercase() == target.to_lowercase()
}

fn context_matches(
    target: &RenameMoveTargetSnapshot,
    context: &P4Context,
    generation: u64,
    active_profile_id: Option<String>,
) -> bool {
    target.server == context.server
        && target.user == context.user
        && target.client == context.client
        && target.workspace == context.cwd.clone().unwrap_or_default()
        && target.context_generation == generation
        && target.active_profile_id == active_profile_id
}

fn digest_preview(
    target: Option<&RenameMoveTargetSnapshot>,
    blockers: &[RenameMoveIssue],
    warnings: &[RenameMoveIssue],
) -> String {
    let bytes = serde_json::to_vec(&(target, blockers, warnings)).unwrap_or_default();
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn issue(code: RenameMoveIssueCode, message: impl Into<String>) -> RenameMoveIssue {
    RenameMoveIssue {
        code,
        message: message.into(),
    }
}

fn safe_operation_prefix(value: Option<&str>, fallback: &str) -> String {
    value
        .filter(|value| valid_operation_id(value))
        .map(str::to_owned)
        .unwrap_or_else(|| format!("{fallback}-{}", Uuid::new_v4()))
}

fn valid_operation_id(value: &str) -> bool {
    !value.trim().is_empty()
        && value.len() <= 128
        && value
            .chars()
            .all(|value| value.is_ascii_alphanumeric() || matches!(value, '-' | '_'))
}

fn rejected(
    failure: RenameMoveFailureCode,
    message: impl Into<String>,
    target: Option<&RenameMoveTargetSnapshot>,
) -> RenameMoveResult {
    RenameMoveResult {
        outcome: RenameMoveOutcome::Rejected,
        failure: Some(failure),
        message: message.into(),
        operation_id: None,
        log_reference: None,
        refresh: target.map_or_else(empty_refresh, |target| {
            refresh(
                target,
                "Run a new preflight against the current runtime context.",
            )
        }),
    }
}

fn empty_refresh() -> RenameMoveRefreshAdvice {
    RenameMoveRefreshAdvice {
        workspace_status: true,
        pending_changes: true,
        depot_paths: Vec::new(),
        local_paths: Vec::new(),
        reason: "Run a new preflight against the current runtime context.".into(),
    }
}

fn refresh(
    target: &RenameMoveTargetSnapshot,
    reason: impl Into<String>,
) -> RenameMoveRefreshAdvice {
    RenameMoveRefreshAdvice {
        workspace_status: true,
        pending_changes: true,
        depot_paths: vec![
            target.source.depot_path.clone(),
            target.target.depot_path.clone(),
        ],
        local_paths: vec![
            target.source.local_path.clone(),
            target.target.local_path.clone(),
        ],
        reason: reason.into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::confirmation::{ConfirmationStore, IssuedConfirmation};

    #[cfg(windows)]
    #[test]
    fn canonical_windows_roots_accept_p4_mapping_paths_without_weakening_boundaries() {
        let root = Path::new(r"\\?\C:\work");
        assert!(path_starts_with(Path::new("c:/work/sub/file.txt"), root));
        assert!(path_starts_with(
            Path::new(r"\\?\C:\work\sub\file.txt"),
            root
        ));
        assert!(!path_starts_with(
            Path::new(r"C:\work-other\file.txt"),
            root
        ));
        assert!(!path_starts_with(
            Path::new(r"\\?\C:\work\..\outside.txt"),
            root
        ));
        assert!(path_starts_with(
            Path::new(r"\\server\share\work\file.txt"),
            Path::new(r"\\?\UNC\server\share\work")
        ));
        assert!(!path_starts_with(
            Path::new(r"\\other\share\work\file.txt"),
            Path::new(r"\\?\UNC\server\share\work")
        ));
    }

    fn mapping(local: &str, depot: &str) -> RenameMoveMapping {
        RenameMoveMapping {
            depot_path: depot.into(),
            client_path: format!("//workspace/{}", depot.rsplit('/').next().unwrap()),
            local_path: local.into(),
        }
    }

    #[test]
    fn case_only_rename_is_an_explicit_blocker() {
        assert!(case_only(r"C:\work\Name.txt", r"c:\WORK\name.txt"));
        assert!(case_only(r"C:\work\Ä.txt", r"C:\work\ä.txt"));
        assert!(!case_only(r"C:\work\Name.txt", r"C:\work\other.txt"));
    }

    #[test]
    fn preview_digest_binds_source_state_target_change_and_mapping() {
        let mut target = RenameMoveTargetSnapshot {
            server: "server".into(),
            user: "alice".into(),
            client: "workspace".into(),
            workspace: r"C:\work".into(),
            active_profile_id: Some("profile".into()),
            context_generation: 7,
            source: mapping(r"C:\work\a.txt", "//depot/a.txt"),
            target: mapping(r"C:\work\b.txt", "//depot/b.txt"),
            source_state: RenameMoveSourceState {
                action: "edit".into(),
                change_id: 0,
                file_type: Some("text".into()),
                have_revision: Some(1),
                head_revision: Some(1),
            },
            target_change_id: 0,
        };
        let first = digest_preview(Some(&target), &[], &[]);
        target.target_change_id = 42;
        assert_ne!(first, digest_preview(Some(&target), &[], &[]));
        target.target_change_id = 0;
        target.source_state.action = "add".into();
        assert_ne!(first, digest_preview(Some(&target), &[], &[]));
    }

    #[test]
    fn confirmation_store_consumes_once_and_expires_old_records_on_issue() {
        let store = ConfirmationStore::default();
        let target = RenameMoveTargetSnapshot {
            server: "server".into(),
            user: "alice".into(),
            client: "workspace".into(),
            workspace: "work".into(),
            active_profile_id: None,
            context_generation: 1,
            source: mapping("/work/a", "//depot/a"),
            target: mapping("/work/b", "//depot/b"),
            source_state: RenameMoveSourceState {
                action: "edit".into(),
                change_id: 0,
                file_type: None,
                have_revision: None,
                head_revision: None,
            },
            target_change_id: 0,
        };
        let token = store.issue(
            IssuedConfirmation::new(target.clone(), "a".to_string(), 10),
            0,
        );
        assert!(store.consume(&token).is_some());
        assert!(store.consume(&token).is_none());
        let expired = store.issue(IssuedConfirmation::new(target, "b".to_string(), 1), 0);
        let _fresh = store.issue(
            IssuedConfirmation::new(mapping_target(), "c".to_string(), 20),
            2,
        );
        assert!(store.consume(&expired).is_none());
    }

    fn mapping_target() -> RenameMoveTargetSnapshot {
        RenameMoveTargetSnapshot {
            server: "server".into(),
            user: "alice".into(),
            client: "workspace".into(),
            workspace: "work".into(),
            active_profile_id: None,
            context_generation: 1,
            source: mapping("/work/a", "//depot/a"),
            target: mapping("/work/b", "//depot/b"),
            source_state: RenameMoveSourceState {
                action: "edit".into(),
                change_id: 0,
                file_type: None,
                have_revision: None,
                head_revision: None,
            },
            target_change_id: 0,
        }
    }

    #[test]
    fn runtime_generation_and_profile_are_part_of_context_identity() {
        let target = mapping_target();
        let context = P4Context {
            server: "server".into(),
            user: "alice".into(),
            client: "workspace".into(),
            cwd: Some("work".into()),
            ..Default::default()
        };
        assert!(context_matches(&target, &context, 1, None));
        assert!(!context_matches(&target, &context, 2, None));
        assert!(!context_matches(
            &target,
            &context,
            1,
            Some("profile".into())
        ));
    }

    #[test]
    fn command_failure_and_uncertain_result_always_request_full_refresh() {
        let failed = execution_result(
            &mapping_target(),
            "move-failed".into(),
            Ok(OperationResult {
                operation_id: "move-failed".into(),
                exit_code: 1,
                events: Vec::new(),
                duration_ms: 1,
            }),
        );
        assert_eq!(failed.outcome, RenameMoveOutcome::Failed);
        assert_eq!(failed.failure, Some(RenameMoveFailureCode::CommandFailure));
        assert!(failed.refresh.workspace_status && failed.refresh.pending_changes);
        assert_eq!(failed.refresh.depot_paths.len(), 2);
        assert_eq!(failed.refresh.local_paths.len(), 2);

        let uncertain = execution_result(
            &mapping_target(),
            "move-timeout".into(),
            Err("operation timed out".into()),
        );
        assert_eq!(uncertain.outcome, RenameMoveOutcome::Unknown);
        assert_eq!(
            uncertain.failure,
            Some(RenameMoveFailureCode::UncertainOutcome)
        );
        assert!(uncertain.refresh.workspace_status && uncertain.refresh.pending_changes);
    }
}
