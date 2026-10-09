use crate::{
    app::{
        confirmation::{ConfirmationStore, ExpiringConfirmation},
        status_cache::{InvalidationReason, StatusCache, StatusQueryKind},
    },
    domain::*,
    p4::{
        connection::classify_connection_error,
        context::ContextStore,
        submit::{PermissionAssessment, SubmitInspection, SubmitRepository},
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
    target: SubmitTargetSnapshot,
    content_digest: String,
    depot_paths: Vec<String>,
    expires_at: i64,
}

impl ExpiringConfirmation for TokenRecord {
    fn expires_at(&self) -> i64 {
        self.expires_at
    }
}

struct Evaluation {
    change: Option<PendingChange>,
    blockers: Vec<SubmitIssue>,
    warnings: Vec<SubmitIssue>,
    summary: SubmitFileSummary,
    operation_ids: Vec<String>,
}

pub struct SubmitService {
    repository: SubmitRepository,
    contexts: Arc<ContextStore>,
    status_cache: Arc<StatusCache>,
    tokens: ConfirmationStore<TokenRecord>,
    confirmation_gate: AsyncMutex<()>,
    ttl_ms: u64,
}

impl SubmitService {
    pub fn new(
        repository: SubmitRepository,
        contexts: Arc<ContextStore>,
        status_cache: Arc<StatusCache>,
    ) -> Self {
        Self::with_ttl(repository, contexts, status_cache, DEFAULT_TOKEN_TTL_MS)
    }

    pub(crate) fn with_ttl(
        repository: SubmitRepository,
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
        request: SubmitPreflightRequest,
        app: Option<&AppHandle>,
    ) -> SubmitPreflight {
        let (context, generation) = self.contexts.snapshot();
        let target = target_snapshot(&context, generation, request.change_id);
        let inspection = self
            .repository
            .inspect(
                &context,
                request.change_id,
                &format!("submit-preflight-{}", Uuid::new_v4()),
                app,
            )
            .await;
        let mut evaluation = match inspection {
            Ok(inspection) => evaluate(inspection),
            Err(_) => Evaluation {
                change: None,
                blockers: vec![issue(
                    SubmitIssueCode::PreflightUnavailable,
                    SubmitIssueCertainty::Unknown,
                    "Submit preflight could not obtain a reliable server snapshot.",
                    Vec::new(),
                )],
                warnings: Vec::new(),
                summary: empty_summary(),
                operation_ids: Vec::new(),
            },
        };
        if request.change_id <= 0
            && !evaluation
                .blockers
                .iter()
                .any(|item| item.code == SubmitIssueCode::InvalidTarget)
        {
            evaluation.blockers.push(issue(
                SubmitIssueCode::InvalidTarget,
                SubmitIssueCertainty::Confirmed,
                "Submit requires a numbered pending changelist.",
                Vec::new(),
            ));
        }

        let ready = evaluation.blockers.is_empty();
        // Start the TTL after the server checks finish so a slow preflight does not hand the UI
        // an already-expired confirmation token.
        let expires_at = now_ms().saturating_add(self.ttl_ms as i64);
        let token = ready.then(|| {
            self.tokens.issue(
                TokenRecord {
                    target: target.clone(),
                    content_digest: evaluation.summary.content_digest.clone(),
                    depot_paths: evaluation.summary.depot_paths.clone(),
                    expires_at,
                },
                now_ms(),
            )
        });
        let log_reference = evaluation.operation_ids.first().cloned();
        SubmitPreflight {
            ready,
            change: evaluation.change,
            blockers: evaluation.blockers,
            warnings: evaluation.warnings,
            target,
            file_summary: evaluation.summary,
            token,
            expires_at,
            ttl_ms: self.ttl_ms,
            operation_ids: evaluation.operation_ids,
            log_reference,
            refresh_recommended: !ready,
        }
    }

    pub async fn confirm(
        &self,
        confirmation: SubmitConfirmation,
        app: Option<&AppHandle>,
    ) -> SubmitResult {
        let _gate = self.confirmation_gate.lock().await;
        let change_id = confirmation.target.change_id;
        let record = self.tokens.consume(&confirmation.token);
        let Some(record) = record else {
            return rejected(
                change_id,
                SubmitFailureCode::TokenUnknown,
                "The submit confirmation token is unknown or was already used.",
                Vec::new(),
            );
        };
        if record.expires_at <= now_ms() {
            return rejected(
                change_id,
                SubmitFailureCode::TokenExpired,
                "The submit preflight expired. Run preflight again.",
                record.depot_paths,
            );
        }
        if record.target != confirmation.target {
            return rejected(
                change_id,
                SubmitFailureCode::TargetMismatch,
                "The confirmation target does not match the checked snapshot.",
                record.depot_paths,
            );
        }

        let (context, generation) = self.contexts.snapshot();
        if target_snapshot(&context, generation, change_id) != record.target {
            return rejected(
                change_id,
                SubmitFailureCode::ContextChanged,
                "The connection or workspace changed after preflight.",
                record.depot_paths,
            );
        }

        // Hold the runner's server mutation lane from revalidation through submit. This prevents
        // any other GUI mutation from slipping between the checked snapshot and the command.
        let mutation_guard = self.repository.lock_mutations(&context.server).await;
        let reinspection = self
            .repository
            .inspect(
                &context,
                change_id,
                &format!("submit-recheck-{}", Uuid::new_v4()),
                app,
            )
            .await;
        let evaluation = match reinspection {
            Ok(inspection) => evaluate(inspection),
            Err(_) => {
                return rejected(
                    change_id,
                    SubmitFailureCode::PreflightBlocked,
                    "The server snapshot could not be revalidated safely.",
                    record.depot_paths,
                )
            }
        };
        if !evaluation.blockers.is_empty() {
            return rejected(
                change_id,
                SubmitFailureCode::PreflightBlocked,
                "The changelist no longer passes submit preflight.",
                evaluation.summary.depot_paths,
            );
        }
        if evaluation.summary.content_digest != record.content_digest {
            return rejected(
                change_id,
                SubmitFailureCode::ChangeChanged,
                "The changelist contents changed after preflight.",
                evaluation.summary.depot_paths,
            );
        }
        let (latest_context, latest_generation) = self.contexts.snapshot();
        if target_snapshot(&latest_context, latest_generation, change_id) != record.target {
            return rejected(
                change_id,
                SubmitFailureCode::ContextChanged,
                "The connection or workspace changed during confirmation.",
                evaluation.summary.depot_paths,
            );
        }

        let operation_id = confirmation
            .operation_id
            .filter(|value| !value.trim().is_empty() && value.len() <= 256)
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        let execution = self
            .repository
            .submit(
                &context,
                change_id,
                operation_id.clone(),
                evaluation.summary.file_count,
                &mutation_guard,
                app,
            )
            .await;
        self.status_cache.invalidate(
            &context.server,
            &context.user,
            &context.client,
            &[],
            &[
                StatusQueryKind::WorkspaceStatus,
                StatusQueryKind::Opened,
                StatusQueryKind::Reconcile,
            ],
            InvalidationReason::Submit,
        );

        match execution {
            Ok(execution) if execution.operation.exit_code == 0 => SubmitResult {
                outcome: SubmitOutcome::Submitted,
                change_id,
                submitted_change_id: execution.submitted_change_id.or(Some(change_id)),
                failure: None,
                message: format!("Changelist {change_id} was submitted."),
                operation_id: Some(operation_id.clone()),
                log_reference: Some(operation_id),
                refresh: refresh_advice(
                    evaluation.summary.depot_paths,
                    "Submit completed; refresh pending, submitted and workspace views.",
                ),
            },
            Ok(execution) => {
                let cancelled = execution
                    .operation
                    .events
                    .iter()
                    .any(|event| matches!(event.kind, EventKind::Cancelled));
                let failure = if cancelled {
                    SubmitFailureCode::Cancelled
                } else {
                    classify_failure(&execution.diagnostic_text)
                };
                SubmitResult {
                    outcome: if cancelled {
                        SubmitOutcome::Cancelled
                    } else {
                        SubmitOutcome::Failed
                    },
                    change_id,
                    submitted_change_id: None,
                    failure: Some(failure),
                    message: failure_message(failure).into(),
                    operation_id: Some(operation_id.clone()),
                    log_reference: Some(operation_id),
                    refresh: refresh_advice(
                        evaluation.summary.depot_paths,
                        "Submit did not complete cleanly; refresh before retrying because files or locks may have changed.",
                    ),
                }
            }
            Err(_) => SubmitResult {
                outcome: SubmitOutcome::Unknown,
                change_id,
                submitted_change_id: None,
                failure: Some(SubmitFailureCode::UncertainOutcome),
                message: failure_message(SubmitFailureCode::UncertainOutcome).into(),
                operation_id: Some(operation_id.clone()),
                log_reference: Some(operation_id),
                refresh: refresh_advice(
                    evaluation.summary.depot_paths,
                    "The command outcome is uncertain; refresh all related views before taking another action.",
                ),
            },
        }
    }
}

fn evaluate(mut inspection: SubmitInspection) -> Evaluation {
    inspection
        .facts
        .sort_by(|left, right| left.depot_path.cmp(&right.depot_path));
    inspection.missing_fact_paths.sort();
    let mut blockers = Vec::new();
    let mut warnings = Vec::new();
    let Some(mut change) = inspection.change else {
        blockers.push(issue(
            SubmitIssueCode::ChangeNotFound,
            SubmitIssueCertainty::Confirmed,
            "The numbered pending changelist was not found in the current user/workspace scope.",
            Vec::new(),
        ));
        return Evaluation {
            change: None,
            blockers,
            warnings,
            summary: empty_summary(),
            operation_ids: inspection.operation_ids,
        };
    };
    change
        .files
        .sort_by(|left, right| left.depot_path.cmp(&right.depot_path));
    change
        .shelved_files
        .sort_by(|left, right| left.depot_path.cmp(&right.depot_path));
    change.jobs.sort();
    let incomplete_facts = inspection
        .facts
        .iter()
        .filter(|fact| {
            fact.action.is_empty()
                || fact.file_type.is_empty()
                || (!matches!(fact.action.as_str(), "add" | "move/add" | "branch")
                    && (fact.have_revision.is_none() || fact.head_revision.is_none()))
        })
        .map(|fact| fact.depot_path.clone());
    inspection.missing_fact_paths.extend(incomplete_facts);
    inspection.missing_fact_paths.sort();
    inspection.missing_fact_paths.dedup();
    let paths = change
        .files
        .iter()
        .map(|file| file.depot_path.clone())
        .collect::<Vec<_>>();

    if change.description.trim().is_empty() {
        blockers.push(issue(
            SubmitIssueCode::EmptyDescription,
            SubmitIssueCertainty::Confirmed,
            "The changelist description is empty.",
            Vec::new(),
        ));
    }
    if paths.is_empty() {
        blockers.push(issue(
            SubmitIssueCode::EmptyChange,
            SubmitIssueCertainty::Confirmed,
            "The changelist contains no opened files.",
            Vec::new(),
        ));
    }
    let unresolved = inspection
        .facts
        .iter()
        .filter(|fact| fact.unresolved > 0)
        .map(|fact| fact.depot_path.clone())
        .collect::<Vec<_>>();
    if !unresolved.is_empty() {
        blockers.push(issue(
            SubmitIssueCode::UnresolvedFiles,
            SubmitIssueCertainty::Confirmed,
            "One or more files have unresolved integration records.",
            unresolved,
        ));
    }
    let out_of_date = inspection
        .facts
        .iter()
        .filter(|fact| {
            !matches!(fact.action.as_str(), "add" | "move/add" | "branch")
                && fact
                    .have_revision
                    .zip(fact.head_revision)
                    .is_some_and(|(have, head)| have < head)
        })
        .map(|fact| fact.depot_path.clone())
        .collect::<Vec<_>>();
    if !out_of_date.is_empty() {
        blockers.push(issue(
            SubmitIssueCode::OutOfDateFiles,
            SubmitIssueCertainty::Confirmed,
            "One or more files are not at the head revision.",
            out_of_date,
        ));
    }
    let locked = inspection
        .facts
        .iter()
        .filter(|fact| fact.other_lock > 0)
        .map(|fact| fact.depot_path.clone())
        .collect::<Vec<_>>();
    if !locked.is_empty() {
        blockers.push(issue(
            SubmitIssueCode::LockedFiles,
            SubmitIssueCertainty::Confirmed,
            "One or more files are locked by another workspace.",
            locked,
        ));
    }
    let exclusive = inspection
        .facts
        .iter()
        .filter(|fact| fact.file_type.contains("+l") && fact.other_open > 0)
        .map(|fact| fact.depot_path.clone())
        .collect::<Vec<_>>();
    if !exclusive.is_empty() {
        blockers.push(issue(
            SubmitIssueCode::ExclusiveOpenConflict,
            SubmitIssueCertainty::Confirmed,
            "An exclusive-open file is also open in another workspace.",
            exclusive,
        ));
    }
    match &inspection.permission {
        PermissionAssessment::Denied(paths) => blockers.push(issue(
            SubmitIssueCode::PermissionDenied,
            SubmitIssueCertainty::Confirmed,
            "The current user does not have write permission for every file.",
            paths.clone(),
        )),
        PermissionAssessment::Unknown if !paths.is_empty() => warnings.push(issue(
            SubmitIssueCode::PermissionUnknown,
            SubmitIssueCertainty::Unknown,
            "Write permission could not be verified reliably; the server remains authoritative.",
            paths.clone(),
        )),
        _ => {}
    }
    if inspection.file_check_unknown || !inspection.missing_fact_paths.is_empty() {
        warnings.push(issue(
            SubmitIssueCode::FileStateUnknown,
            SubmitIssueCertainty::Unknown,
            "Some file state could not be verified reliably.",
            inspection.missing_fact_paths.clone(),
        ));
    }
    if !change.shelved_files.is_empty() {
        warnings.push(issue(
            SubmitIssueCode::ShelvedFilesPresent,
            SubmitIssueCertainty::Confirmed,
            "The changelist also has shelved files; submit operates on the opened workspace files.",
            change
                .shelved_files
                .iter()
                .map(|file| file.depot_path.clone())
                .collect(),
        ));
    }
    if !inspection.missing_jobs.is_empty() {
        blockers.push(issue(
            SubmitIssueCode::JobMissing,
            SubmitIssueCertainty::Confirmed,
            "One or more linked jobs no longer exist.",
            Vec::new(),
        ));
    }
    if inspection.job_check_unknown || !change.jobs.is_empty() {
        warnings.push(issue(
            SubmitIssueCode::JobPolicyUnknown,
            SubmitIssueCertainty::Unknown,
            "Server-side job status and submit-trigger policy cannot be fully predicted by the client.",
            Vec::new(),
        ));
    }

    let permission_key = match &inspection.permission {
        PermissionAssessment::Allowed => "allowed",
        PermissionAssessment::Denied(_) => "denied",
        PermissionAssessment::Unknown => "unknown",
    };
    let digest_value = serde_json::json!({
        "change": &change,
        "facts": &inspection.facts,
        "missingFactPaths": &inspection.missing_fact_paths,
        "permission": permission_key,
        "missingJobs": &inspection.missing_jobs,
        "jobCheckUnknown": inspection.job_check_unknown,
        "fileCheckUnknown": inspection.file_check_unknown,
    });
    let content_digest = sha256_hex(
        &serde_json::to_vec(&digest_value).expect("submit digest input is serializable"),
    );
    let mut action_counts = std::collections::BTreeMap::new();
    for file in &change.files {
        *action_counts.entry(file.action.clone()).or_insert(0) += 1;
    }
    Evaluation {
        change: Some(change),
        blockers,
        warnings,
        summary: SubmitFileSummary {
            file_count: paths.len(),
            depot_paths: paths,
            action_counts,
            content_digest,
        },
        operation_ids: inspection.operation_ids,
    }
}

fn target_snapshot(context: &P4Context, generation: u64, change_id: i64) -> SubmitTargetSnapshot {
    SubmitTargetSnapshot {
        server: context.server.clone(),
        user: context.user.clone(),
        client: context.client.clone(),
        workspace: context.cwd.clone().unwrap_or_default(),
        change_id,
        context_generation: generation,
    }
}

fn issue(
    code: SubmitIssueCode,
    certainty: SubmitIssueCertainty,
    message: impl Into<String>,
    mut paths: Vec<String>,
) -> SubmitIssue {
    paths.sort();
    paths.dedup();
    SubmitIssue {
        code,
        certainty,
        message: message.into(),
        paths,
    }
}

fn empty_summary() -> SubmitFileSummary {
    SubmitFileSummary {
        file_count: 0,
        depot_paths: Vec::new(),
        action_counts: std::collections::BTreeMap::new(),
        content_digest: sha256_hex(&[]),
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn rejected(
    change_id: i64,
    failure: SubmitFailureCode,
    message: impl Into<String>,
    depot_paths: Vec<String>,
) -> SubmitResult {
    SubmitResult {
        outcome: SubmitOutcome::Rejected,
        change_id,
        submitted_change_id: None,
        failure: Some(failure),
        message: message.into(),
        operation_id: None,
        log_reference: None,
        refresh: SubmitRefreshAdvice {
            pending_changes: true,
            submitted_changes: false,
            workspace_status: true,
            depot_paths,
            reason: "Run a new preflight against the current connection and changelist snapshot."
                .into(),
        },
    }
}

fn refresh_advice(depot_paths: Vec<String>, reason: impl Into<String>) -> SubmitRefreshAdvice {
    SubmitRefreshAdvice {
        pending_changes: true,
        submitted_changes: true,
        workspace_status: true,
        depot_paths,
        reason: reason.into(),
    }
}

fn classify_failure(text: &str) -> SubmitFailureCode {
    match classify_connection_error(text) {
        ConnectionErrorCode::Disconnected => SubmitFailureCode::Offline,
        ConnectionErrorCode::NetworkError | ConnectionErrorCode::CliMissing => {
            SubmitFailureCode::ServerUnreachable
        }
        ConnectionErrorCode::AuthRequired | ConnectionErrorCode::TicketExpired => {
            SubmitFailureCode::AuthExpired
        }
        ConnectionErrorCode::PermissionDenied => SubmitFailureCode::PermissionDenied,
        _ => SubmitFailureCode::CommandFailure,
    }
}

fn failure_message(failure: SubmitFailureCode) -> &'static str {
    match failure {
        SubmitFailureCode::Offline => "The server is offline. Refresh after connectivity returns.",
        SubmitFailureCode::ServerUnreachable => {
            "The server could not be reached. Refresh before retrying."
        }
        SubmitFailureCode::AuthExpired => "Authentication expired. Sign in and run preflight again.",
        SubmitFailureCode::PermissionDenied => {
            "The server denied submit permission. Contact an administrator if this is unexpected."
        }
        SubmitFailureCode::Cancelled => {
            "Submit was cancelled. Refresh because transferred files or locks may remain."
        }
        SubmitFailureCode::UncertainOutcome => {
            "The submit outcome is uncertain. Refresh pending and submitted changes before retrying."
        }
        _ => "The server rejected the submit. Refresh the changelist before retrying.",
    }
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::p4::submit::parser::SubmitFileFact;

    fn change(description: &str, files: usize) -> PendingChange {
        PendingChange {
            id: 42,
            description: description.into(),
            user: "alice".into(),
            client: "workspace".into(),
            status: "pending".into(),
            updated_at: None,
            jobs: Vec::new(),
            files: (0..files)
                .map(|index| PendingFile {
                    depot_path: format!("//depot/{index}.txt"),
                    action: "edit".into(),
                    state: Some("openedEdit".into()),
                    client_path: None,
                    revision: Some(1),
                    file_type: Some("text".into()),
                })
                .collect(),
            shelved_files: Vec::new(),
        }
    }

    fn inspection(change: PendingChange) -> SubmitInspection {
        let facts = change
            .files
            .iter()
            .map(|file| SubmitFileFact {
                depot_path: file.depot_path.clone(),
                action: file.action.clone(),
                have_revision: Some(1),
                head_revision: Some(1),
                file_type: "text".into(),
                unresolved: 0,
                other_open: 0,
                other_lock: 0,
            })
            .collect();
        SubmitInspection {
            change: Some(change),
            facts,
            missing_fact_paths: Vec::new(),
            permission: PermissionAssessment::Allowed,
            missing_jobs: Vec::new(),
            job_check_unknown: false,
            file_check_unknown: false,
            operation_ids: Vec::new(),
        }
    }

    #[test]
    fn preflight_rules_are_structured_and_conservative() {
        let empty_description = evaluate(inspection(change("  ", 1)));
        assert!(empty_description
            .blockers
            .iter()
            .any(|issue| issue.code == SubmitIssueCode::EmptyDescription));
        let empty_change = evaluate(inspection(change("description", 0)));
        assert!(empty_change
            .blockers
            .iter()
            .any(|issue| issue.code == SubmitIssueCode::EmptyChange));

        let mut risky = inspection(change("description", 1));
        risky.facts[0].unresolved = 1;
        risky.facts[0].head_revision = Some(2);
        risky.facts[0].other_lock = 1;
        risky.facts[0].other_open = 1;
        risky.facts[0].file_type = "binary+l".into();
        risky.permission = PermissionAssessment::Denied(vec!["//depot/0.txt".into()]);
        let risky = evaluate(risky);
        for code in [
            SubmitIssueCode::UnresolvedFiles,
            SubmitIssueCode::OutOfDateFiles,
            SubmitIssueCode::LockedFiles,
            SubmitIssueCode::ExclusiveOpenConflict,
            SubmitIssueCode::PermissionDenied,
        ] {
            assert!(risky.blockers.iter().any(|issue| issue.code == code));
        }
    }

    #[test]
    fn unknown_checks_are_warnings_not_silent_successes() {
        let mut value = inspection(change("description", 1));
        value.permission = PermissionAssessment::Unknown;
        value.file_check_unknown = true;
        value.job_check_unknown = true;
        let evaluated = evaluate(value);
        for code in [
            SubmitIssueCode::PermissionUnknown,
            SubmitIssueCode::FileStateUnknown,
            SubmitIssueCode::JobPolicyUnknown,
        ] {
            assert!(evaluated.warnings.iter().any(|issue| issue.code == code));
        }

        let mut incomplete = inspection(change("description", 1));
        incomplete.facts[0].head_revision = None;
        let evaluated = evaluate(incomplete);
        assert!(evaluated
            .warnings
            .iter()
            .any(|issue| issue.code == SubmitIssueCode::FileStateUnknown));
    }
}
