use crate::{
    app::{
        confirmation::{ConfirmationStore, ExpiringConfirmation},
        status_cache::{InvalidationReason, StatusCache, StatusQueryKind},
    },
    domain::*,
    p4::{connection::classify_connection_error, context::ContextStore, runner::P4Runner},
};
use chrono::NaiveDate;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{collections::BTreeSet, path::Path, sync::Arc};
use tauri::AppHandle;
use tokio::sync::Mutex as AsyncMutex;
use uuid::Uuid;

const DEFAULT_TOKEN_TTL_MS: u64 = 120_000;
const MAX_REPRESENTATIVE_ENTRIES: usize = 200;
const INLINE_PATH_LIMIT: usize = 128;
const INLINE_ARGUMENT_BYTES: usize = 24 * 1024;
/// `p4 where` is a client-side mapping read, so a short bound is enough.
const WHERE_TIMEOUT_MS: u64 = 30_000;
/// Real p4 diagnostics are kept at the head of the result message.
const MAX_P4_DETAIL_CHARS: usize = 512;
/// A failed mapping preflight lists at most this many offending targets.
const MAX_REPORTED_UNMAPPED_PATHS: usize = 5;

#[derive(Clone)]
struct TokenRecord {
    target: SyncTargetSnapshot,
    content_digest: String,
    affected_paths: Vec<String>,
    counts: SyncPlanCounts,
    expires_at: i64,
}

impl ExpiringConfirmation for TokenRecord {
    fn expires_at(&self) -> i64 {
        self.expires_at
    }
}

struct Evaluation {
    entries: Vec<SyncPlanEntry>,
    counts: SyncPlanCounts,
    blockers: Vec<SyncIssue>,
    warnings: Vec<SyncIssue>,
    partial: bool,
    operation_ids: Vec<String>,
}

pub struct SyncService {
    runner: Arc<P4Runner>,
    contexts: Arc<ContextStore>,
    status_cache: Arc<StatusCache>,
    tokens: ConfirmationStore<TokenRecord>,
    confirmation_gate: AsyncMutex<()>,
    ttl_ms: u64,
}

impl SyncService {
    pub fn new(
        runner: Arc<P4Runner>,
        contexts: Arc<ContextStore>,
        status_cache: Arc<StatusCache>,
    ) -> Self {
        Self::with_ttl(runner, contexts, status_cache, DEFAULT_TOKEN_TTL_MS)
    }

    pub(crate) fn with_ttl(
        runner: Arc<P4Runner>,
        contexts: Arc<ContextStore>,
        status_cache: Arc<StatusCache>,
        ttl_ms: u64,
    ) -> Self {
        Self {
            runner,
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

    pub async fn preview(
        &self,
        request: SyncPreviewRequest,
        app: Option<&AppHandle>,
    ) -> SyncPreviewPlan {
        let (context, generation) = self.contexts.snapshot();
        let target = match target_snapshot(&context, generation, &request) {
            Ok(target) => target,
            Err(message) => {
                return blocked_plan(
                    fallback_target(&context, generation, request),
                    SyncIssueCode::InvalidTarget,
                    message,
                    self.ttl_ms,
                )
            }
        };
        let evaluation = self
            .inspect(&context, &target, request.operation_id, app)
            .await;
        self.plan_from_evaluation(target, evaluation)
    }

    pub async fn confirm(
        &self,
        confirmation: SyncConfirmRequest,
        app: Option<&AppHandle>,
    ) -> SyncResult {
        let _gate = self.confirmation_gate.lock().await;
        let Some(record) = self.tokens.consume(&confirmation.token) else {
            return rejected(
                SyncFailureCode::TokenUnknown,
                "The sync confirmation token is unknown or was already used.",
                Vec::new(),
                SyncPlanCounts::default(),
            );
        };
        if record.expires_at <= now_ms() {
            return rejected(
                SyncFailureCode::TokenExpired,
                "The sync preview expired. Run preview again.",
                record.affected_paths,
                record.counts,
            );
        }
        if record.target != confirmation.target {
            return rejected(
                SyncFailureCode::TargetMismatch,
                "The confirmation target does not match the previewed scope and options.",
                record.affected_paths,
                record.counts,
            );
        }
        if record.target.force && !confirmation.acknowledge_force {
            return rejected(
                SyncFailureCode::ForceAcknowledgementRequired,
                "Forced sync requires an explicit second acknowledgement.",
                record.affected_paths,
                record.counts,
            );
        }

        let (context, generation) = self.contexts.snapshot();
        if context_target(&context, generation, &record.target) != record.target {
            return rejected(
                SyncFailureCode::ContextChanged,
                "The connection or workspace changed after preview.",
                record.affected_paths,
                record.counts,
            );
        }

        // Freeze all GUI mutations from the last server recheck through the real sync.
        let mutation_guard = self.runner.lock_mutations(&context.server).await;
        let recheck = self.inspect(&context, &record.target, None, app).await;
        if !recheck.blockers.is_empty() {
            return rejected(
                SyncFailureCode::PreflightBlocked,
                "The sync scope no longer passes preview checks.",
                affected_paths(&recheck.entries),
                recheck.counts,
            );
        }
        let recheck_digest = digest(&record.target, &recheck);
        if recheck_digest != record.content_digest {
            return rejected(
                SyncFailureCode::PreviewChanged,
                "The sync preview changed before execution. Review a new preview.",
                affected_paths(&recheck.entries),
                recheck.counts,
            );
        }
        let (latest_context, latest_generation) = self.contexts.snapshot();
        if context_target(&latest_context, latest_generation, &record.target) != record.target {
            return rejected(
                SyncFailureCode::ContextChanged,
                "The connection or workspace changed during confirmation.",
                record.affected_paths,
                record.counts,
            );
        }

        let operation_id = valid_operation_id(confirmation.operation_id)
            .unwrap_or_else(|| format!("sync-{}", Uuid::new_v4()));
        let (args, input) = execution_arguments(&record.target);
        let execution = self
            .runner
            .run_with_mutation_guard_and_input(
                P4CommandRequest {
                    operation_id: Some(operation_id.clone()),
                    source: OperationSource::Gui,
                    command: "sync".into(),
                    args,
                    context: context.clone(),
                    output_mode: OutputMode::JsonLines,
                    timeout_ms: Some(600_000),
                    input: None,
                },
                app,
                Some(record.counts.added + record.counts.updated + record.counts.deleted),
                input,
                &mutation_guard,
            )
            .await;

        let paths = if record.affected_paths.is_empty() {
            record.target.paths.clone()
        } else {
            record.affected_paths.clone()
        };
        self.status_cache.invalidate(
            &context.server,
            &context.user,
            &context.client,
            &paths,
            &[
                StatusQueryKind::WorkspaceStatus,
                StatusQueryKind::Opened,
                StatusQueryKind::Reconcile,
            ],
            InvalidationReason::FileMutation,
        );

        match execution {
            Ok(operation) if operation.exit_code == 0 => {
                // p4 2023.1 can exit 0 while still emitting warning/error
                // records (severity >= 2); never report those as a clean sync.
                if let Some(detail) = sync_warning_detail(&operation) {
                    let failure = classify_failure(&detail);
                    return SyncResult {
                        outcome: SyncOutcome::Failed,
                        failure: Some(failure),
                        message: failure_message_with_detail(failure, &detail),
                        operation_id: Some(operation_id.clone()),
                        log_reference: Some(operation_id),
                        affected_paths: paths.clone(),
                        counts: record.counts.clone(),
                        refresh_workspace: true,
                        refresh_depot: true,
                    };
                }
                SyncResult {
                    outcome: SyncOutcome::Succeeded,
                    failure: None,
                    message: "Sync completed from the confirmed server preview.".into(),
                    operation_id: Some(operation_id.clone()),
                    log_reference: Some(operation_id),
                    affected_paths: paths,
                    counts: record.counts,
                    refresh_workspace: true,
                    refresh_depot: true,
                }
            }
            Ok(operation) => {
                let detail = p4_detail_text(&operation);
                let text = if detail.is_empty() {
                    event_text(&operation)
                } else {
                    detail
                };
                let cancelled = operation
                    .events
                    .iter()
                    .any(|event| matches!(event.kind, EventKind::Cancelled));
                let failure = if cancelled {
                    SyncFailureCode::Cancelled
                } else {
                    classify_failure(&text)
                };
                SyncResult {
                    outcome: if cancelled {
                        SyncOutcome::Cancelled
                    } else if operation.events.iter().any(|event| {
                        matches!(event.kind, EventKind::Stdout) && event.message.is_some()
                    }) {
                        SyncOutcome::Partial
                    } else {
                        SyncOutcome::Failed
                    },
                    failure: Some(failure),
                    message: failure_message_with_detail(failure, &text),
                    operation_id: Some(operation_id.clone()),
                    log_reference: Some(operation_id),
                    affected_paths: paths,
                    counts: record.counts,
                    refresh_workspace: true,
                    refresh_depot: true,
                }
            }
            Err(error) => {
                let text = error.to_string();
                let failure = classify_failure(&text);
                SyncResult {
                    outcome: if failure == SyncFailureCode::Cancelled {
                        SyncOutcome::Cancelled
                    } else {
                        SyncOutcome::Unknown
                    },
                    failure: Some(failure),
                    message: failure_message_with_detail(failure, &text),
                    operation_id: Some(operation_id.clone()),
                    log_reference: Some(operation_id),
                    affected_paths: paths,
                    counts: record.counts,
                    refresh_workspace: true,
                    refresh_depot: true,
                }
            }
        }
    }

    /// Direct Get Latest: no preview, no token, no server-side inspection.
    ///
    /// A bounded read-only `p4 where` preflight still verifies that every target
    /// maps into the current client view, so a mistyped/moved path fails before
    /// any transfer instead of only producing "not in client view" warnings.
    /// The command always targets `#head` without `-f`. P4 itself reports
    /// writable/opened conflicts (and may schedule a resolve), so the result is
    /// mapped from the real exit code/runner error and never faked as success.
    pub async fn sync_latest(
        &self,
        request: SyncPreviewRequest,
        app: Option<&AppHandle>,
    ) -> SyncResult {
        let (context, generation) = self.contexts.snapshot();
        let latest = SyncPreviewRequest {
            paths: request.paths.clone(),
            revision: SyncRevisionSpec {
                kind: SyncRevisionKind::Head,
                value: None,
            },
            force: false,
            parallel_threads: request.parallel_threads,
            operation_id: request.operation_id.clone(),
        };
        let target = match target_snapshot(&context, generation, &latest) {
            Ok(target) => target,
            Err(message) => {
                return SyncResult {
                    outcome: SyncOutcome::Failed,
                    failure: Some(SyncFailureCode::CommandFailure),
                    message: format!("Get Latest was rejected before running p4 sync: {message}"),
                    operation_id: None,
                    log_reference: None,
                    affected_paths: request.paths,
                    counts: SyncPlanCounts::default(),
                    refresh_workspace: true,
                    refresh_depot: true,
                };
            }
        };

        let operation_id = valid_operation_id(request.operation_id)
            .unwrap_or_else(|| format!("sync-latest-{}", Uuid::new_v4()));
        if let Err(failure) = self.where_preflight(&context, &target, app).await {
            return failure;
        }
        let (args, input) = execution_arguments(&target);
        let mutation_guard = self.runner.lock_mutations(&context.server).await;
        let execution = self
            .runner
            .run_with_mutation_guard_and_input(
                P4CommandRequest {
                    operation_id: Some(operation_id.clone()),
                    source: OperationSource::Gui,
                    command: "sync".into(),
                    args,
                    context: context.clone(),
                    output_mode: OutputMode::JsonLines,
                    timeout_ms: Some(600_000),
                    input: None,
                },
                app,
                None,
                input,
                &mutation_guard,
            )
            .await;

        let paths = target.paths.clone();
        self.status_cache.invalidate(
            &context.server,
            &context.user,
            &context.client,
            &paths,
            &[
                StatusQueryKind::WorkspaceStatus,
                StatusQueryKind::Opened,
                StatusQueryKind::Reconcile,
            ],
            InvalidationReason::FileMutation,
        );

        match execution {
            Ok(operation) if operation.exit_code == 0 => {
                // A zero exit code is not proof of a clean sync: p4 2023.1 can
                // emit warning/error records (severity >= 2) and still exit 0.
                if let Some(detail) = sync_warning_detail(&operation) {
                    let failure = classify_failure(&detail);
                    return SyncResult {
                        outcome: SyncOutcome::Failed,
                        failure: Some(failure),
                        message: failure_message_with_detail(failure, &detail),
                        operation_id: Some(operation_id.clone()),
                        log_reference: Some(operation_id),
                        affected_paths: paths.clone(),
                        counts: SyncPlanCounts::default(),
                        refresh_workspace: true,
                        refresh_depot: true,
                    };
                }
                SyncResult {
                    outcome: SyncOutcome::Succeeded,
                    failure: None,
                    message: "Get Latest completed.".into(),
                    operation_id: Some(operation_id.clone()),
                    log_reference: Some(operation_id),
                    affected_paths: paths,
                    counts: SyncPlanCounts::default(),
                    refresh_workspace: true,
                    refresh_depot: true,
                }
            }
            Ok(operation) => {
                let detail = p4_detail_text(&operation);
                let text = if detail.is_empty() {
                    event_text(&operation)
                } else {
                    detail
                };
                let cancelled = operation
                    .events
                    .iter()
                    .any(|event| matches!(event.kind, EventKind::Cancelled));
                let failure = if cancelled {
                    SyncFailureCode::Cancelled
                } else {
                    classify_failure(&text)
                };
                SyncResult {
                    outcome: if cancelled {
                        SyncOutcome::Cancelled
                    } else if operation.events.iter().any(|event| {
                        matches!(event.kind, EventKind::Stdout) && event.message.is_some()
                    }) {
                        SyncOutcome::Partial
                    } else {
                        SyncOutcome::Failed
                    },
                    failure: Some(failure),
                    message: failure_message_with_detail(failure, &text),
                    operation_id: Some(operation_id.clone()),
                    log_reference: Some(operation_id),
                    affected_paths: paths,
                    counts: SyncPlanCounts::default(),
                    refresh_workspace: true,
                    refresh_depot: true,
                }
            }
            Err(error) => {
                let text = error.to_string();
                let failure = classify_failure(&text);
                SyncResult {
                    outcome: if failure == SyncFailureCode::Cancelled {
                        SyncOutcome::Cancelled
                    } else {
                        SyncOutcome::Unknown
                    },
                    failure: Some(failure),
                    message: failure_message_with_detail(failure, &text),
                    operation_id: Some(operation_id.clone()),
                    log_reference: Some(operation_id),
                    affected_paths: paths,
                    counts: SyncPlanCounts::default(),
                    refresh_workspace: true,
                    refresh_depot: true,
                }
            }
        }
    }

    /// Read-only `p4 where` mapping preflight for the one-click Get Latest path.
    ///
    /// `confirm` previews server state instead, so only `sync_latest` needs this
    /// extra guard. A target that p4 cannot map into the current client view
    /// would otherwise only produce "not in client view" warnings after a real
    /// transfer. Transport failures fail the request instead of skipping the
    /// check, so an unreachable CLI never reaches `p4 sync`.
    async fn where_preflight(
        &self,
        context: &P4Context,
        target: &SyncTargetSnapshot,
        app: Option<&AppHandle>,
    ) -> Result<(), SyncResult> {
        let expected = target
            .paths
            .iter()
            .map(|path| strip_recursive_suffix(path).to_owned())
            .collect::<Vec<_>>();
        let operation_id = format!("sync-where-{}", Uuid::new_v4());
        let (args, input) = append_or_stream(Vec::new(), expected.clone());
        let execution = self
            .runner
            .run_with_progress(
                P4CommandRequest {
                    operation_id: Some(operation_id.clone()),
                    source: OperationSource::Gui,
                    command: "where".into(),
                    args,
                    context: context.clone(),
                    output_mode: OutputMode::JsonLines,
                    timeout_ms: Some(WHERE_TIMEOUT_MS),
                    input: None,
                },
                app,
                None,
                input,
            )
            .await;

        let operation = match execution {
            Ok(operation) => operation,
            Err(error) => {
                let text = error.to_string();
                let failure = classify_failure(&text);
                return Err(preflight_failure(
                    target,
                    failure,
                    operation_id,
                    format!(
                        "Get Latest was blocked before running p4 sync: p4 where could not run ({}). {}",
                        bounded_detail(&text),
                        failure_message(failure)
                    ),
                ));
            }
        };

        let unmapped = unmapped_where_targets(&operation, &expected);
        if unmapped.is_empty() && operation.exit_code == 0 {
            return Ok(());
        }
        let detail = p4_detail_text(&operation);
        let text = if detail.is_empty() {
            event_text(&operation)
        } else {
            detail
        };
        let bounded = bounded_detail(&text);
        let failure = if bounded.is_empty() {
            SyncFailureCode::CommandFailure
        } else {
            classify_failure(&text)
        };
        let mut message = if unmapped.is_empty() {
            format!(
                "Get Latest was blocked before running p4 sync: p4 where exited with code {} without confirming every target.",
                operation.exit_code
            )
        } else {
            format!(
                "Get Latest was blocked before running p4 sync: p4 where reported no mapping for {}.",
                summarize_paths(&unmapped)
            )
        };
        if !bounded.is_empty() {
            message.push_str(&format!(" p4 said: {bounded}."));
        }
        message.push(' ');
        message.push_str(failure_message(failure));
        Err(preflight_failure(target, failure, operation_id, message))
    }

    fn plan_from_evaluation(
        &self,
        target: SyncTargetSnapshot,
        evaluation: Evaluation,
    ) -> SyncPreviewPlan {
        let content_digest = digest(&target, &evaluation);
        let ready = evaluation.blockers.is_empty();
        let expires_at = now_ms().saturating_add(self.ttl_ms as i64);
        let affected = affected_paths(&evaluation.entries);
        let token = ready.then(|| {
            self.tokens.issue(
                TokenRecord {
                    target: target.clone(),
                    content_digest: content_digest.clone(),
                    affected_paths: affected,
                    counts: evaluation.counts.clone(),
                    expires_at,
                },
                now_ms(),
            )
        });
        let total_entries = evaluation.entries.len();
        let truncated = total_entries > MAX_REPRESENTATIVE_ENTRIES;
        let log_reference = evaluation.operation_ids.first().cloned();
        SyncPreviewPlan {
            ready,
            target,
            counts: evaluation.counts,
            entries: evaluation
                .entries
                .into_iter()
                .take(MAX_REPRESENTATIVE_ENTRIES)
                .collect(),
            total_entries,
            truncated,
            partial: evaluation.partial,
            blockers: evaluation.blockers,
            warnings: evaluation.warnings,
            content_digest,
            token,
            expires_at,
            ttl_ms: self.ttl_ms,
            operation_ids: evaluation.operation_ids,
            log_reference,
        }
    }

    async fn inspect(
        &self,
        context: &P4Context,
        target: &SyncTargetSnapshot,
        requested_operation_id: Option<String>,
        app: Option<&AppHandle>,
    ) -> Evaluation {
        let operation_id = valid_operation_id(requested_operation_id)
            .unwrap_or_else(|| format!("sync-preview-{}", Uuid::new_v4()));
        let (args, input) = preview_arguments(target);
        let result = self
            .runner
            .run_with_progress(
                P4CommandRequest {
                    operation_id: Some(operation_id.clone()),
                    source: OperationSource::Gui,
                    command: "sync".into(),
                    args,
                    context: context.clone(),
                    output_mode: OutputMode::JsonLines,
                    timeout_ms: Some(300_000),
                    input: None,
                },
                app,
                None,
                input,
            )
            .await;
        let mut evaluation = match result {
            Ok(result) => evaluate_preview(&result),
            Err(error) => evaluation_error(error.to_string()),
        };
        evaluation.operation_ids.push(operation_id);
        let inspection_id = format!("sync-inspect-{}", Uuid::new_v4());
        let (inspection_args, inspection_input) = inspection_arguments(target);
        if let Ok(inspection) = self
            .runner
            .run_with_progress(
                P4CommandRequest {
                    operation_id: Some(inspection_id.clone()),
                    source: OperationSource::Gui,
                    command: "fstat".into(),
                    args: inspection_args,
                    context: context.clone(),
                    output_mode: OutputMode::JsonLines,
                    timeout_ms: Some(300_000),
                    input: None,
                },
                app,
                None,
                inspection_input,
            )
            .await
        {
            apply_fstat_risks(&inspection, &mut evaluation);
            evaluation.operation_ids.push(inspection_id);
        } else {
            evaluation.partial = true;
            evaluation.warnings.push(issue(
                SyncIssueCode::InspectionUnknown,
                "Opened-file and unresolved-state inspection was unavailable.",
                target.paths.clone(),
            ));
            evaluation.counts.warnings += 1;
        }
        let writable = writable_change_paths(&evaluation.entries);
        if !writable.is_empty()
            && !evaluation
                .blockers
                .iter()
                .any(|item| item.code == SyncIssueCode::WritableClobber)
        {
            evaluation.blockers.push(issue(
                SyncIssueCode::WritableClobber,
                "Previewed files are writable locally. Sync is blocked to avoid clobbering untracked workspace edits.",
                writable,
            ));
            evaluation.counts.conflicts += 1;
        }
        if target.force {
            evaluation.warnings.push(issue(
                SyncIssueCode::ForceOverwrite,
                "Forced sync re-transfers files even when the have table is current and may expose writable-file/clobber risks.",
                target.paths.clone(),
            ));
            evaluation.counts.warnings += 1;
        }
        if evaluation.partial
            && !evaluation
                .blockers
                .iter()
                .any(|item| item.code == SyncIssueCode::InspectionUnknown)
        {
            evaluation.blockers.push(issue(
                SyncIssueCode::InspectionUnknown,
                "The server preview or safety inspection was partial; sync cannot be confirmed safely.",
                target.paths.clone(),
            ));
        }
        evaluation
    }
}

fn target_snapshot(
    context: &P4Context,
    generation: u64,
    request: &SyncPreviewRequest,
) -> Result<SyncTargetSnapshot, String> {
    if context.server.trim().is_empty()
        || context.user.trim().is_empty()
        || context.client.trim().is_empty()
        || context.cwd.as_deref().unwrap_or_default().trim().is_empty()
    {
        return Err("A connected server, user, client and workspace root are required.".into());
    }
    let mut paths = request
        .paths
        .iter()
        .map(|path| normalize_sync_path(context, path))
        .collect::<Result<Vec<_>, _>>()?;
    paths.sort();
    paths.dedup();
    if paths.is_empty() {
        return Err("At least one sync target is required.".into());
    }
    validate_revision(&request.revision)?;
    if let Some(threads) = request.parallel_threads {
        if !(2..=4).contains(&threads) {
            return Err("parallelThreads must be between 2 and 4.".into());
        }
    }
    Ok(SyncTargetSnapshot {
        server: context.server.clone(),
        user: context.user.clone(),
        client: context.client.clone(),
        workspace: context.cwd.clone().unwrap_or_default(),
        context_generation: generation,
        paths,
        revision: request.revision.clone(),
        force: request.force,
        parallel_threads: request.parallel_threads,
    })
}

fn fallback_target(
    context: &P4Context,
    generation: u64,
    request: SyncPreviewRequest,
) -> SyncTargetSnapshot {
    SyncTargetSnapshot {
        server: context.server.clone(),
        user: context.user.clone(),
        client: context.client.clone(),
        workspace: context.cwd.clone().unwrap_or_default(),
        context_generation: generation,
        paths: request.paths,
        revision: request.revision,
        force: request.force,
        parallel_threads: request.parallel_threads,
    }
}

fn context_target(
    context: &P4Context,
    generation: u64,
    target: &SyncTargetSnapshot,
) -> SyncTargetSnapshot {
    SyncTargetSnapshot {
        server: context.server.clone(),
        user: context.user.clone(),
        client: context.client.clone(),
        workspace: context.cwd.clone().unwrap_or_default(),
        context_generation: generation,
        paths: target.paths.clone(),
        revision: target.revision.clone(),
        force: target.force,
        parallel_threads: target.parallel_threads,
    }
}

fn normalize_sync_path(context: &P4Context, value: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty()
        || value.starts_with('-')
        || value.contains(['\0', '\r', '\n'])
        || value.contains('@')
        || value.contains('#')
        || value.contains('*')
    {
        return Err(format!("Invalid sync target: {value:?}"));
    }
    let recursive = value.ends_with("/...") || value.ends_with("\\...");
    let base = if recursive {
        &value[..value.len() - 4]
    } else {
        value
    };
    if base.trim_end_matches(['/', '\\']).is_empty() {
        return Err(
            "Sync target cannot be a depot or workspace root; choose a concrete path.".into(),
        );
    }
    if base.contains("...") {
        return Err("Only one trailing recursive /... selector is allowed.".into());
    }
    if base.starts_with("//") {
        if base.starts_with("///") || base.split('/').any(|part| part == "..") {
            return Err("Depot targets must be normalized absolute depot paths.".into());
        }
        return Ok(format!(
            "{}{}",
            base.trim_end_matches('/'),
            if recursive { "/..." } else { "" }
        ));
    }

    let root = Path::new(context.cwd.as_deref().unwrap_or_default())
        .canonicalize()
        .map_err(|error| format!("Workspace root is unavailable: {error}"))?;
    let raw = Path::new(base);
    let joined = if raw.is_absolute() {
        raw.to_path_buf()
    } else {
        root.join(raw)
    };
    let checked = if joined.exists() {
        joined.canonicalize().map_err(|error| error.to_string())?
    } else {
        let parent = joined
            .parent()
            .ok_or("Sync target has no parent directory.")?
            .canonicalize()
            .map_err(|error| error.to_string())?;
        parent.join(joined.file_name().ok_or("Sync target has no file name.")?)
    };
    if !checked.starts_with(&root) {
        return Err("Sync target escapes the current workspace root.".into());
    }
    let mut result = checked.to_string_lossy().to_string();
    if recursive {
        result.push_str("/...");
    }
    Ok(result)
}

/// `p4 where` takes files, not recursive selectors, so a trailing `/...` is
/// removed before the mapping preflight.
fn strip_recursive_suffix(path: &str) -> &str {
    path.strip_suffix("/...")
        .or_else(|| path.strip_suffix("\\..."))
        .unwrap_or(path)
}

fn summarize_paths(paths: &[String]) -> String {
    let mut listed = paths
        .iter()
        .take(MAX_REPORTED_UNMAPPED_PATHS)
        .map(|path| crate::security::redact_text(path))
        .collect::<Vec<_>>()
        .join(", ");
    if paths.len() > MAX_REPORTED_UNMAPPED_PATHS {
        listed.push_str(&format!(
            " (+{} more)",
            paths.len() - MAX_REPORTED_UNMAPPED_PATHS
        ));
    }
    listed
}

/// Returns the targets that `p4 where` did not map. A nonzero exit code is
/// never treated as a success, even if a stray mapping line was printed.
fn unmapped_where_targets(result: &OperationResult, expected: &[String]) -> Vec<String> {
    let mut mapped = Vec::new();
    for event in &result.events {
        if !matches!(event.kind, EventKind::Stdout | EventKind::Stderr) {
            continue;
        }
        let Some(message) = event.message.as_deref() else {
            continue;
        };
        let message = message.trim();
        if message.is_empty() {
            continue;
        }
        match serde_json::from_str::<Value>(message) {
            Ok(value) => {
                if record_is_failure(&value) {
                    continue;
                }
                for key in ["depotFile", "clientFile", "path"] {
                    if let Some(found) = string(&value, key) {
                        mapped.push(found);
                    }
                }
            }
            Err(_) => {
                if !contains_failure_text(message) {
                    mapped.push(message.to_owned());
                }
            }
        }
    }
    expected
        .iter()
        .filter(|expected| {
            !mapped
                .iter()
                .any(|candidate| path_is_within(candidate, expected))
        })
        .cloned()
        .collect()
}

/// A `p4 where` name covers a target when it is the same path or, for a wildcard
/// echo, a child of it. Comparison normalizes separators, case and the verbatim
/// Windows prefix produced by `canonicalize()`.
fn path_is_within(mapped: &str, expected: &str) -> bool {
    let mapped = compare_path(mapped);
    let expected = compare_path(expected);
    mapped == expected
        || mapped
            .strip_prefix(&expected)
            .is_some_and(|rest| rest.starts_with('/'))
}

fn compare_path(path: &str) -> String {
    let path = path.replace('\\', "/");
    let path = if let Some(unc) = path.strip_prefix("//?/UNC/") {
        format!("//{unc}")
    } else {
        path.strip_prefix("//?/").unwrap_or(&path).to_owned()
    };
    path.trim_end_matches('/').to_ascii_lowercase()
}

fn preflight_failure(
    target: &SyncTargetSnapshot,
    failure: SyncFailureCode,
    operation_id: String,
    message: String,
) -> SyncResult {
    SyncResult {
        outcome: SyncOutcome::Failed,
        failure: Some(failure),
        message,
        operation_id: Some(operation_id.clone()),
        log_reference: Some(operation_id),
        affected_paths: target.paths.clone(),
        counts: SyncPlanCounts::default(),
        refresh_workspace: true,
        refresh_depot: true,
    }
}

fn validate_revision(revision: &SyncRevisionSpec) -> Result<(), String> {
    let value = revision.value.as_deref().unwrap_or_default().trim();
    match revision.kind {
        SyncRevisionKind::Head if value.is_empty() => Ok(()),
        SyncRevisionKind::Revision | SyncRevisionKind::Change
            if !value.is_empty()
                && value.chars().all(|ch| ch.is_ascii_digit())
                && value.parse::<u64>().is_ok_and(|number| number > 0) =>
        {
            Ok(())
        }
        SyncRevisionKind::Date if NaiveDate::parse_from_str(value, "%Y/%m/%d").is_ok() => Ok(()),
        SyncRevisionKind::Label
            if !value.is_empty()
                && value.len() <= 128
                && !value.starts_with('-')
                && value
                    .chars()
                    .all(|ch| ch.is_ascii_alphanumeric() || "-_.".contains(ch)) =>
        {
            Ok(())
        }
        _ => Err("Invalid typed sync revision specification.".into()),
    }
}

fn revision_selector(revision: &SyncRevisionSpec) -> String {
    match revision.kind {
        SyncRevisionKind::Head => "#head".into(),
        SyncRevisionKind::Revision => format!("#{}", revision.value.as_deref().unwrap_or_default()),
        SyncRevisionKind::Change | SyncRevisionKind::Date | SyncRevisionKind::Label => {
            format!("@{}", revision.value.as_deref().unwrap_or_default())
        }
    }
}

fn target_filespecs(target: &SyncTargetSnapshot) -> Vec<String> {
    let selector = revision_selector(&target.revision);
    target
        .paths
        .iter()
        .map(|path| format!("{path}{selector}"))
        .collect()
}

fn preview_arguments(target: &SyncTargetSnapshot) -> (Vec<String>, Option<Vec<String>>) {
    let mut args = vec!["-n".into()];
    if target.force {
        args.push("-f".into());
    }
    append_or_stream(args, target_filespecs(target))
}

fn execution_arguments(target: &SyncTargetSnapshot) -> (Vec<String>, Option<Vec<String>>) {
    let mut args = Vec::new();
    if target.force {
        args.push("-f".into());
    }
    if let Some(threads) = target.parallel_threads {
        args.push(format!("--parallel=threads={threads},batch=8,min=9"));
    }
    append_or_stream(args, target_filespecs(target))
}

fn inspection_arguments(target: &SyncTargetSnapshot) -> (Vec<String>, Option<Vec<String>>) {
    append_or_stream(
        vec![
            "-Ol".into(),
            "-T".into(),
            "depotFile,clientFile,action,unresolved,haveRev,headRev".into(),
        ],
        target.paths.clone(),
    )
}

fn append_or_stream(
    mut args: Vec<String>,
    paths: Vec<String>,
) -> (Vec<String>, Option<Vec<String>>) {
    let stream = paths.len() > INLINE_PATH_LIMIT
        || paths.iter().map(|path| path.len() + 1).sum::<usize>() > INLINE_ARGUMENT_BYTES;
    if stream {
        (args, Some(paths))
    } else {
        args.extend(paths);
        (args, None)
    }
}

fn evaluate_preview(result: &OperationResult) -> Evaluation {
    let mut entries = Vec::new();
    let mut blockers = Vec::new();
    let mut warnings = Vec::new();
    let mut partial = false;
    for event in &result.events {
        if !matches!(event.kind, EventKind::Stdout | EventKind::Stderr) {
            continue;
        }
        let Some(message) = event.message.as_deref() else {
            continue;
        };
        match serde_json::from_str::<Value>(message) {
            Ok(value) => parse_value(&value, &mut entries, &mut blockers, &mut warnings),
            Err(_) => {
                if !parse_text(message, &mut entries, &mut blockers, &mut warnings) {
                    partial = true;
                }
            }
        }
    }
    if result.exit_code != 0 && blockers.is_empty() {
        blockers.push(issue(
            issue_code(&event_text(result)),
            "The server rejected the sync preview.",
            Vec::new(),
        ));
    }
    dedup_issues(&mut blockers);
    dedup_issues(&mut warnings);
    entries.sort_by(|left, right| {
        left.depot_path
            .cmp(&right.depot_path)
            .then(left.client_path.cmp(&right.client_path))
            .then(left.kind.cmp(&right.kind))
    });
    let counts = counts(&entries, &warnings);
    Evaluation {
        entries,
        counts,
        blockers,
        warnings,
        partial,
        operation_ids: Vec::new(),
    }
}

fn apply_fstat_risks(result: &OperationResult, evaluation: &mut Evaluation) {
    let mut opened = Vec::new();
    let mut unresolved = Vec::new();
    if result.exit_code != 0 {
        evaluation.partial = true;
        evaluation.warnings.push(issue(
            SyncIssueCode::InspectionUnknown,
            "Opened-file inspection returned a partial server result.",
            Vec::new(),
        ));
    }
    for event in &result.events {
        if !matches!(event.kind, EventKind::Stdout) {
            continue;
        }
        let Some(message) = event.message.as_deref() else {
            continue;
        };
        let Ok(value) = serde_json::from_str::<Value>(message) else {
            continue;
        };
        let path = string(&value, "depotFile")
            .or_else(|| string(&value, "clientFile"))
            .unwrap_or_default();
        if string(&value, "action").is_some() && !path.is_empty() {
            opened.push(path.clone());
        }
        if number(&value, "unresolved").unwrap_or(0) > 0 && !path.is_empty() {
            unresolved.push(path);
        }
    }
    if !opened.is_empty() {
        evaluation.warnings.push(issue(
            SyncIssueCode::OpenedFile,
            "Files in the sync scope are opened. Review them carefully; incoming revisions may require resolve.",
            opened,
        ));
    }
    if !unresolved.is_empty() {
        evaluation.blockers.push(issue(
            SyncIssueCode::UnresolvedFile,
            "Files in the sync scope have unresolved integration records.",
            unresolved,
        ));
        evaluation.counts.conflicts += 1;
    }
    dedup_issues(&mut evaluation.blockers);
    dedup_issues(&mut evaluation.warnings);
    evaluation.counts.warnings = evaluation
        .entries
        .iter()
        .filter(|entry| entry.kind == SyncChangeKind::Warning)
        .count()
        + evaluation.warnings.len();
}

fn parse_value(
    value: &Value,
    entries: &mut Vec<SyncPlanEntry>,
    blockers: &mut Vec<SyncIssue>,
    warnings: &mut Vec<SyncIssue>,
) {
    let depot_path = string(value, "depotFile");
    let client_path = string(value, "clientFile").or_else(|| string(value, "path"));
    let revision = number(value, "rev");
    let action = string(value, "action")
        .unwrap_or_default()
        .to_ascii_lowercase();
    let data = string(value, "data").unwrap_or_default();
    if !action.is_empty() || depot_path.is_some() || client_path.is_some() {
        let kind = match action.as_str() {
            "added" | "add" => SyncChangeKind::Added,
            "deleted" | "delete" | "removed" => SyncChangeKind::Deleted,
            "up-to-date" | "uptodate" => SyncChangeKind::UpToDate,
            _ => SyncChangeKind::Updated,
        };
        entries.push(SyncPlanEntry {
            kind,
            depot_path,
            client_path,
            revision,
            message: if data.is_empty() { action } else { data },
        });
        return;
    }
    if !data.is_empty() {
        parse_diagnostic(&data, blockers, warnings, entries);
    }
}

fn parse_text(
    message: &str,
    entries: &mut Vec<SyncPlanEntry>,
    blockers: &mut Vec<SyncIssue>,
    warnings: &mut Vec<SyncIssue>,
) -> bool {
    if message.trim().is_empty() {
        return true;
    }
    parse_diagnostic(message, blockers, warnings, entries)
}

fn parse_diagnostic(
    message: &str,
    blockers: &mut Vec<SyncIssue>,
    warnings: &mut Vec<SyncIssue>,
    entries: &mut Vec<SyncPlanEntry>,
) -> bool {
    let lower = message.to_ascii_lowercase();
    let path = message
        .split_whitespace()
        .find(|part| part.starts_with("//"))
        .map(|part| {
            part.split('#')
                .next()
                .unwrap_or(part)
                .trim_end_matches([',', ':'])
                .to_owned()
        });
    let paths = path.clone().into_iter().collect::<Vec<_>>();
    if lower.contains("up-to-date") || lower.contains("up to date") {
        entries.push(SyncPlanEntry {
            kind: SyncChangeKind::UpToDate,
            depot_path: path,
            client_path: None,
            revision: None,
            message: message.trim().into(),
        });
        return true;
    }
    let issue = if lower.contains("not in client view") || lower.contains("not under client's root")
    {
        Some((SyncIssueCode::NotInClient, true))
    } else if lower.contains("can't clobber writable") || lower.contains("cannot clobber writable")
    {
        Some((SyncIssueCode::WritableClobber, true))
    } else if lower.contains("unresolved") || lower.contains("must resolve") {
        Some((SyncIssueCode::UnresolvedFile, true))
    } else if lower.contains("permission") || lower.contains("protections") {
        Some((SyncIssueCode::PermissionDenied, true))
    } else if lower.contains("no space") || lower.contains("disk full") {
        Some((SyncIssueCode::DiskSpace, true))
    } else if lower.contains("opened") {
        Some((SyncIssueCode::OpenedFile, false))
    } else if lower.contains("warning") {
        Some((SyncIssueCode::InspectionUnknown, false))
    } else {
        None
    };
    if let Some((code, blocking)) = issue {
        let item = crate::app::sync_service::issue(code, message.trim(), paths);
        if blocking {
            blockers.push(item);
        } else {
            warnings.push(item);
        }
        return true;
    }
    false
}

fn counts(entries: &[SyncPlanEntry], warnings: &[SyncIssue]) -> SyncPlanCounts {
    let mut result = SyncPlanCounts::default();
    for entry in entries {
        match entry.kind {
            SyncChangeKind::Added => result.added += 1,
            SyncChangeKind::Updated => result.updated += 1,
            SyncChangeKind::Deleted => result.deleted += 1,
            SyncChangeKind::UpToDate => result.up_to_date += 1,
            SyncChangeKind::Warning => result.warnings += 1,
            SyncChangeKind::Conflict => result.conflicts += 1,
        }
    }
    result.warnings += warnings.len();
    result
}

fn affected_paths(entries: &[SyncPlanEntry]) -> Vec<String> {
    entries
        .iter()
        .filter_map(|entry| {
            entry
                .client_path
                .clone()
                .or_else(|| entry.depot_path.clone())
        })
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

fn writable_change_paths(entries: &[SyncPlanEntry]) -> Vec<String> {
    entries
        .iter()
        .filter(|entry| {
            matches!(
                entry.kind,
                SyncChangeKind::Updated | SyncChangeKind::Deleted | SyncChangeKind::Conflict
            )
        })
        .filter_map(|entry| entry.client_path.as_deref())
        .filter_map(|path| {
            let metadata = std::fs::metadata(path).ok()?;
            (!metadata.permissions().readonly()).then(|| path.to_owned())
        })
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

fn digest(target: &SyncTargetSnapshot, evaluation: &Evaluation) -> String {
    let bytes = serde_json::to_vec(&serde_json::json!({
        "target": target,
        "entries": evaluation.entries,
        "counts": evaluation.counts,
        "blockers": evaluation.blockers,
        "warnings": evaluation.warnings,
        "partial": evaluation.partial,
    }))
    .expect("sync preview digest input is serializable");
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn blocked_plan(
    target: SyncTargetSnapshot,
    code: SyncIssueCode,
    message: String,
    ttl_ms: u64,
) -> SyncPreviewPlan {
    let evaluation = Evaluation {
        entries: Vec::new(),
        counts: SyncPlanCounts::default(),
        blockers: vec![issue(code, message, Vec::new())],
        warnings: Vec::new(),
        partial: false,
        operation_ids: Vec::new(),
    };
    SyncPreviewPlan {
        ready: false,
        target: target.clone(),
        counts: evaluation.counts.clone(),
        entries: Vec::new(),
        total_entries: 0,
        truncated: false,
        partial: false,
        blockers: evaluation.blockers.clone(),
        warnings: Vec::new(),
        content_digest: digest(&target, &evaluation),
        token: None,
        expires_at: now_ms().saturating_add(ttl_ms as i64),
        ttl_ms,
        operation_ids: Vec::new(),
        log_reference: None,
    }
}

fn evaluation_error(message: String) -> Evaluation {
    Evaluation {
        entries: Vec::new(),
        counts: SyncPlanCounts::default(),
        blockers: vec![issue(issue_code(&message), message, Vec::new())],
        warnings: Vec::new(),
        partial: false,
        operation_ids: Vec::new(),
    }
}

fn issue(code: SyncIssueCode, message: impl Into<String>, mut paths: Vec<String>) -> SyncIssue {
    paths.sort();
    paths.dedup();
    SyncIssue {
        code,
        message: message.into(),
        paths,
    }
}

fn dedup_issues(items: &mut Vec<SyncIssue>) {
    items.sort_by(|left, right| {
        left.code
            .cmp(&right.code)
            .then(left.paths.cmp(&right.paths))
    });
    items.dedup_by(|left, right| left.code == right.code && left.paths == right.paths);
}

fn issue_code(text: &str) -> SyncIssueCode {
    let lower = text.to_ascii_lowercase();
    if lower.contains("permission") {
        return SyncIssueCode::PermissionDenied;
    }
    if lower.contains("no space") || lower.contains("disk full") {
        return SyncIssueCode::DiskSpace;
    }
    match classify_connection_error(text) {
        ConnectionErrorCode::Disconnected => SyncIssueCode::Offline,
        ConnectionErrorCode::NetworkError | ConnectionErrorCode::CliMissing => {
            SyncIssueCode::ServerUnreachable
        }
        ConnectionErrorCode::AuthRequired | ConnectionErrorCode::TicketExpired => {
            SyncIssueCode::AuthExpired
        }
        ConnectionErrorCode::PermissionDenied => SyncIssueCode::PermissionDenied,
        _ => SyncIssueCode::PreviewFailed,
    }
}

fn classify_failure(text: &str) -> SyncFailureCode {
    let lower = text.to_ascii_lowercase();
    if lower.contains("cancel") {
        return SyncFailureCode::Cancelled;
    }
    if lower.contains("no space") || lower.contains("disk full") {
        return SyncFailureCode::DiskSpace;
    }
    match classify_connection_error(text) {
        ConnectionErrorCode::Disconnected => SyncFailureCode::Offline,
        ConnectionErrorCode::NetworkError | ConnectionErrorCode::CliMissing => {
            SyncFailureCode::ServerUnreachable
        }
        ConnectionErrorCode::AuthRequired | ConnectionErrorCode::TicketExpired => {
            SyncFailureCode::AuthExpired
        }
        ConnectionErrorCode::PermissionDenied => SyncFailureCode::PermissionDenied,
        _ => SyncFailureCode::CommandFailure,
    }
}

fn failure_message(failure: SyncFailureCode) -> &'static str {
    match failure {
        SyncFailureCode::Cancelled => {
            "Sync was cancelled. Refresh because completed file transfers are not rolled back."
        }
        SyncFailureCode::DiskSpace => "Sync stopped because local disk space was exhausted.",
        SyncFailureCode::Offline => "The server is offline. Preview again after reconnecting.",
        SyncFailureCode::ServerUnreachable => {
            "The server could not be reached. Preview again after connectivity returns."
        }
        SyncFailureCode::AuthExpired => "Authentication expired. Sign in and preview again.",
        SyncFailureCode::PermissionDenied => "The server denied access to part of the sync scope.",
        _ => "Sync did not complete cleanly. Refresh and run a new preview before retrying.",
    }
}

/// The real p4 diagnostic plus the existing static hint, so the UI no longer
/// hides the actionable server text behind a fixed sentence.
fn failure_message_with_detail(failure: SyncFailureCode, detail: &str) -> String {
    let hint = failure_message(failure);
    let detail = bounded_detail(detail);
    if detail.is_empty() {
        hint.to_owned()
    } else {
        format!("{detail} {hint}")
    }
}

/// Redacts and caps p4 output while keeping the head of the actionable text.
fn bounded_detail(text: &str) -> String {
    let redacted = crate::security::redact_text(text);
    let trimmed = redacted.trim();
    let mut chars = trimmed.chars();
    let head = chars.by_ref().take(MAX_P4_DETAIL_CHARS).collect::<String>();
    if chars.next().is_some() {
        format!("{head}…")
    } else {
        head
    }
}

/// Human-readable p4 diagnostics: with `-Mj` the real text is in `data`, while
/// plain stderr lines are used verbatim.
fn p4_detail_text(result: &OperationResult) -> String {
    let mut parts = Vec::new();
    for event in &result.events {
        if !matches!(event.kind, EventKind::Stdout | EventKind::Stderr) {
            continue;
        }
        let Some(message) = event.message.as_deref() else {
            continue;
        };
        let message = message.trim();
        if message.is_empty() {
            continue;
        }
        match serde_json::from_str::<Value>(message) {
            Ok(value) => {
                if let Some(data) = string(&value, "data") {
                    let data = data.trim();
                    if !data.is_empty() {
                        parts.push(data.to_owned());
                    }
                }
            }
            Err(_) => parts.push(message.to_owned()),
        }
    }
    bounded_detail(&parts.join("\n"))
}

/// Warnings/errors p4 recorded even though the sync process itself exited 0.
fn sync_warning_detail(result: &OperationResult) -> Option<String> {
    let mut parts = Vec::new();
    for event in &result.events {
        if !matches!(event.kind, EventKind::Stdout | EventKind::Stderr) {
            continue;
        }
        let Some(message) = event.message.as_deref() else {
            continue;
        };
        let message = message.trim();
        if message.is_empty() {
            continue;
        }
        match serde_json::from_str::<Value>(message) {
            Ok(value) => {
                if record_is_failure(&value) {
                    parts.push(
                        string(&value, "data")
                            .map(|data| data.trim().to_owned())
                            .filter(|data| !data.is_empty())
                            .unwrap_or_else(|| message.to_owned()),
                    );
                }
            }
            Err(_) => {
                if contains_failure_text(message) {
                    parts.push(message.to_owned());
                }
            }
        }
    }
    (!parts.is_empty()).then(|| bounded_detail(&parts.join("\n")))
}

/// p4 2023.1 `-Mj` diagnostics carry `severity` (2 = failed), while ordinary
/// added/updated/deleted/up-to-date records have no severity field.
fn record_is_failure(value: &Value) -> bool {
    if number(value, "severity").is_some_and(|severity| severity >= 2) {
        return true;
    }
    string(value, "data").is_some_and(|data| contains_failure_text(&data))
}

fn contains_failure_text(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    [
        "file(s) not in client view",
        "not in client view",
        "no such file",
        "must refer to client",
        "not under client",
        "clobber writable",
        "must resolve",
        "permission denied",
        "no space",
        "disk full",
    ]
    .iter()
    .any(|needle| lower.contains(needle))
}

fn rejected(
    failure: SyncFailureCode,
    message: impl Into<String>,
    affected_paths: Vec<String>,
    counts: SyncPlanCounts,
) -> SyncResult {
    SyncResult {
        outcome: SyncOutcome::Rejected,
        failure: Some(failure),
        message: message.into(),
        operation_id: None,
        log_reference: None,
        affected_paths,
        counts,
        refresh_workspace: true,
        refresh_depot: true,
    }
}

fn string(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn number(value: &Value, key: &str) -> Option<i64> {
    value.get(key).and_then(Value::as_i64).or_else(|| {
        value
            .get(key)
            .and_then(Value::as_str)
            .and_then(|value| value.parse().ok())
    })
}

fn event_text(result: &OperationResult) -> String {
    result
        .events
        .iter()
        .filter_map(|event| event.message.as_deref())
        .collect::<Vec<_>>()
        .join("\n")
}

fn valid_operation_id(value: Option<String>) -> Option<String> {
    value.filter(|value| !value.trim().is_empty() && value.len() <= 256)
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn target(force: bool) -> SyncTargetSnapshot {
        SyncTargetSnapshot {
            server: "localhost:1666".into(),
            user: "alice".into(),
            client: "main".into(),
            workspace: "C:/work".into(),
            context_generation: 7,
            paths: vec!["//depot/main/...".into()],
            revision: SyncRevisionSpec {
                kind: SyncRevisionKind::Change,
                value: Some("42".into()),
            },
            force,
            parallel_threads: Some(2),
        }
    }

    #[test]
    fn builds_argument_arrays_without_shell_text() {
        let (preview, input) = preview_arguments(&target(true));
        assert_eq!(preview, vec!["-n", "-f", "//depot/main/...@42"]);
        assert!(input.is_none());
        let (execute, _) = execution_arguments(&target(true));
        assert_eq!(
            execute,
            vec![
                "-f",
                "--parallel=threads=2,batch=8,min=9",
                "//depot/main/...@42"
            ]
        );
    }

    #[test]
    fn rejects_revision_injection_and_unsafe_scopes() {
        assert!(validate_revision(&SyncRevisionSpec {
            kind: SyncRevisionKind::Change,
            value: Some("42 --force".into())
        })
        .is_err());
        let context = P4Context {
            cwd: Some(std::env::current_dir().unwrap().to_string_lossy().into()),
            ..P4Context::default()
        };
        assert!(normalize_sync_path(&context, "//depot/main/file@evil").is_err());
        assert!(normalize_sync_path(&context, "-f").is_err());
    }

    #[test]
    fn parses_realistic_preview_records_and_blockers() {
        let result = OperationResult {
            operation_id: "preview".into(),
            exit_code: 1,
            duration_ms: 1,
            events: vec![
                OperationEvent {
                    operation_id: "preview".into(),
                    kind: EventKind::Stdout,
                    message: Some(
                        r#"{"depotFile":"//depot/a.txt","clientFile":"C:/work/a.txt","rev":"2","action":"updated"}"#
                            .into(),
                    ),
                    progress: None,
                    timestamp: String::new(),
                },
                OperationEvent {
                    operation_id: "preview".into(),
                    kind: EventKind::Stderr,
                    message: Some("//depot/b.txt - can't clobber writable file".into()),
                    progress: None,
                    timestamp: String::new(),
                },
            ],
        };
        let value = evaluate_preview(&result);
        assert_eq!(value.counts.updated, 1);
        assert!(value
            .blockers
            .iter()
            .any(|issue| issue.code == SyncIssueCode::WritableClobber));
    }

    #[test]
    fn rejects_root_and_recursive_root_sync_targets() {
        let context = P4Context {
            cwd: Some(std::env::current_dir().unwrap().to_string_lossy().into()),
            ..P4Context::default()
        };
        for value in ["//", "///", "////", "//...", "/...", " //... ", "////..."] {
            assert!(
                normalize_sync_path(&context, value).is_err(),
                "{value:?} must be rejected as a root/broad sync target"
            );
        }
        assert_eq!(
            normalize_sync_path(&context, "//depot/main/file.txt").unwrap(),
            "//depot/main/file.txt"
        );
        assert_eq!(
            normalize_sync_path(&context, "//depot/main/...").unwrap(),
            "//depot/main/..."
        );
    }

    fn operation_result(exit_code: i32, lines: &[&str]) -> OperationResult {
        OperationResult {
            operation_id: "op".into(),
            exit_code,
            duration_ms: 1,
            events: lines
                .iter()
                .map(|line| OperationEvent {
                    operation_id: "op".into(),
                    kind: EventKind::Stdout,
                    message: Some((*line).into()),
                    progress: None,
                    timestamp: String::new(),
                })
                .collect(),
        }
    }

    #[test]
    fn treats_zero_exit_warning_records_as_failures() {
        let warning = r#"{"code0":"...","data":"//depot/main/a.txt - file(s) not in client view.\n","generic":17,"severity":2}"#;
        let detail = sync_warning_detail(&operation_result(0, &[warning]))
            .expect("a severity>=2 record must fail the sync");
        assert!(detail.contains("file(s) not in client view"), "{detail}");

        let normal = operation_result(
            0,
            &[
                r#"{"depotFile":"//depot/main/a.txt","clientFile":"C:/work/a.txt","rev":"2","action":"updated"}"#,
            ],
        );
        assert_eq!(sync_warning_detail(&normal), None);

        let unchanged = operation_result(
            0,
            &[r#"{"depotFile":"//depot/main/a.txt","action":"up-to-date"}"#],
        );
        assert_eq!(sync_warning_detail(&unchanged), None);

        let text_warning = operation_result(0, &["//depot/main/b.txt - no such file(s)."]);
        assert!(sync_warning_detail(&text_warning).is_some());
    }

    #[test]
    fn extracts_real_p4_error_text_and_keeps_the_static_hint() {
        let error = r#"{"code0":"...","data":"//depot/main/a.txt - can't clobber writable file\n","generic":17,"severity":2}"#;
        let result = operation_result(1, &[error]);
        let detail = p4_detail_text(&result);
        assert!(detail.contains("can't clobber writable file"), "{detail}");
        let message = failure_message_with_detail(SyncFailureCode::CommandFailure, &detail);
        assert!(message.contains("can't clobber writable file"), "{message}");
        assert!(message.contains("did not complete cleanly"), "{message}");

        let bounded = bounded_detail(&"x".repeat(MAX_P4_DETAIL_CHARS + 50));
        assert!(bounded.ends_with('…'), "{bounded}");
        assert_eq!(
            bounded.trim_end_matches('…').chars().count(),
            MAX_P4_DETAIL_CHARS
        );
    }

    #[test]
    fn matches_where_mappings_for_depot_and_verbatim_local_paths() {
        assert!(path_is_within("//depot/main", "//depot/main"));
        assert!(path_is_within("//depot/main/sub", "//depot/main"));
        assert!(!path_is_within("//depot/mainline/file", "//depot/main"));
        assert!(path_is_within(
            r"\\?\C:\Work\Main\File.txt",
            r"c:\work\main\file.txt"
        ));
        assert!(path_is_within(
            r"\\?\UNC\server\share\file.txt",
            r"\\server\share\file.txt"
        ));
    }

    use crate::persistence::{log_store::LogStore, operation_journal::OperationJournal};
    use std::path::PathBuf;

    struct LatestHarness {
        directory: PathBuf,
        service: SyncService,
        cache: Arc<StatusCache>,
    }

    impl Drop for LatestHarness {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.directory);
        }
    }

    fn latest_harness(label: &str, prepare: impl FnOnce(&Path) -> PathBuf) -> LatestHarness {
        let directory =
            std::env::temp_dir().join(format!("p4deck-sync-latest-{label}-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        let executable = prepare(&directory);
        let contexts = Arc::new(ContextStore::load(&directory).unwrap());
        contexts
            .save(P4Context {
                executable: Some(executable.to_string_lossy().into_owned()),
                server: "fake:1666".into(),
                user: "alice".into(),
                client: "main".into(),
                cwd: Some(directory.to_string_lossy().into_owned()),
                ..Default::default()
            })
            .unwrap();
        let logs = Arc::new(LogStore::open(&directory.join("logs.sqlite")).unwrap());
        let journal =
            Arc::new(OperationJournal::open(&directory.join("operations.sqlite")).unwrap());
        let runner = Arc::new(P4Runner::new(logs, journal));
        let cache = Arc::new(StatusCache::new(15_000, 8, 1024 * 1024));
        let service = SyncService::with_ttl(runner, contexts, cache.clone(), 120_000);
        LatestHarness {
            directory,
            service,
            cache,
        }
    }

    /// Deterministic fake `p4` (no real Perforce): records the full argument line
    /// and optionally prints one stdout line before the chosen exit code.
    fn fake_p4(directory: &Path, exit_code: i32, stdout: Option<&str>) -> PathBuf {
        let calls = directory.join("calls.txt");
        #[cfg(windows)]
        {
            let executable = directory.join("fake-p4.cmd");
            let echo = stdout
                .map(|line| format!("echo {line}\r\n"))
                .unwrap_or_default();
            let script = format!(
                "@echo off\r\necho %*>>\"{}\"\r\n{echo}exit /b {exit_code}\r\n",
                calls.display()
            );
            std::fs::write(&executable, script).unwrap();
            executable
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let executable = directory.join("fake-p4");
            let echo = stdout
                .map(|line| format!("printf '%s\\n' '{line}'\n"))
                .unwrap_or_default();
            let script = format!(
                "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"{}\"\n{echo}exit {exit_code}\n",
                calls.display()
            );
            std::fs::write(&executable, script).unwrap();
            let mut permissions = std::fs::metadata(&executable).unwrap().permissions();
            permissions.set_mode(0o700);
            std::fs::set_permissions(&executable, permissions).unwrap();
            executable
        }
    }

    /// Deterministic fake `p4` with a separate `where` answer: the read-only
    /// mapping preflight must be observable independently from the real sync.
    /// A stdout line prefixed with `stderr:` is written to stderr instead, which
    /// is where a real `p4` prints command errors.
    fn fake_p4_with_where(
        directory: &Path,
        where_result: (i32, Option<&str>),
        sync_result: (i32, Option<&str>),
    ) -> PathBuf {
        let calls = directory.join("calls.txt");
        let (where_exit, where_stdout) = where_result;
        let (sync_exit, sync_stdout) = sync_result;
        #[cfg(windows)]
        {
            let executable = directory.join("fake-p4.cmd");
            let echo = |line: &str| match line.strip_prefix("stderr:") {
                Some(text) => format!("echo {text} 1>&2\r\n"),
                None => format!("echo {line}\r\n"),
            };
            let sync_echo = sync_stdout.map(echo).unwrap_or_default();
            let where_echo = where_stdout.map(echo).unwrap_or_default();
            let script = format!(
                "@echo off\r\necho %*>>\"{}\"\r\necho %* | findstr /C:\" where \" >nul\r\nif not errorlevel 1 goto p4deckwhere\r\n{sync_echo}exit /b {sync_exit}\r\n:p4deckwhere\r\n{where_echo}exit /b {where_exit}\r\n",
                calls.display()
            );
            std::fs::write(&executable, script).unwrap();
            executable
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let executable = directory.join("fake-p4");
            let echo = |line: &str| match line.strip_prefix("stderr:") {
                Some(text) => format!("printf '%s\\n' '{text}' >&2\n"),
                None => format!("printf '%s\\n' '{line}'\n"),
            };
            let sync_echo = sync_stdout.map(echo).unwrap_or_default();
            let where_echo = where_stdout.map(echo).unwrap_or_default();
            let script = format!(
                "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"{}\"\ncase \" $* \" in\n  *\" where \"*) {where_echo}exit {where_exit};;\nesac\n{sync_echo}exit {sync_exit}\n",
                calls.display()
            );
            std::fs::write(&executable, script).unwrap();
            let mut permissions = std::fs::metadata(&executable).unwrap().permissions();
            permissions.set_mode(0o700);
            std::fs::set_permissions(&executable, permissions).unwrap();
            executable
        }
    }

    /// Fake `p4` for the confirm path: it answers the `sync -n` preview, the
    /// `fstat` inspection, and finally the real `sync` with `sync_stdout`.
    fn fake_p4_for_confirm(directory: &Path, preview_stdout: &str, sync_stdout: &str) -> PathBuf {
        let calls = directory.join("calls.txt");
        #[cfg(windows)]
        {
            let executable = directory.join("fake-p4.cmd");
            let script = format!(
                "@echo off\r\necho %*>>\"{}\"\r\necho %* | findstr /C:\" fstat \" >nul\r\nif not errorlevel 1 exit /b 0\r\necho %* | findstr /C:\" -n \" >nul\r\nif not errorlevel 1 goto p4deckpreview\r\necho {sync_stdout}\r\nexit /b 0\r\n:p4deckpreview\r\necho {preview_stdout}\r\nexit /b 0\r\n",
                calls.display()
            );
            std::fs::write(&executable, script).unwrap();
            executable
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let executable = directory.join("fake-p4");
            let script = format!(
                "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"{}\"\ncase \" $* \" in\n  *\" fstat \"*) exit 0;;\n  *\" -n \"*) printf '%s\\n' '{preview_stdout}'; exit 0;;\nesac\nprintf '%s\\n' '{sync_stdout}'\nexit 0\n",
                calls.display()
            );
            std::fs::write(&executable, script).unwrap();
            let mut permissions = std::fs::metadata(&executable).unwrap().permissions();
            permissions.set_mode(0o700);
            std::fs::set_permissions(&executable, permissions).unwrap();
            executable
        }
    }

    fn recorded_calls(directory: &Path) -> Vec<String> {
        std::fs::read_to_string(directory.join("calls.txt"))
            .unwrap_or_default()
            .lines()
            .filter(|line| !line.trim().is_empty())
            .map(str::to_owned)
            .collect()
    }

    fn latest_request() -> SyncPreviewRequest {
        SyncPreviewRequest {
            paths: vec!["//depot/main/...".into()],
            revision: SyncRevisionSpec {
                kind: SyncRevisionKind::Head,
                value: None,
            },
            force: false,
            parallel_threads: None,
            operation_id: Some("get-latest-test".into()),
        }
    }

    const WHERE_MAPPED: &str =
        r#"{"depotFile":"//depot/main","clientFile":"C:/work/main","path":"C:/work/main"}"#;

    #[tokio::test]
    async fn sync_latest_runs_where_then_one_plain_head_sync_and_invalidates_status() {
        let harness = latest_harness("success", |directory| {
            fake_p4_with_where(
                directory,
                (0, Some(WHERE_MAPPED)),
                (
                    0,
                    Some(r#"{"depotFile":"//depot/main/a","action":"updated"}"#),
                ),
            )
        });
        let mut request = latest_request();
        // Get Latest semantics are authoritative: force/change requests are
        // coerced to the plain head sync instead of passing -f/@42 through.
        request.force = true;
        request.revision = SyncRevisionSpec {
            kind: SyncRevisionKind::Change,
            value: Some("42".into()),
        };
        let result = harness.service.sync_latest(request, None).await;

        assert_eq!(result.outcome, SyncOutcome::Succeeded);
        assert_eq!(result.failure, None);
        assert_eq!(result.operation_id.as_deref(), Some("get-latest-test"));
        assert_eq!(result.affected_paths, vec!["//depot/main/...".to_string()]);
        assert!(result.refresh_workspace);
        assert!(result.refresh_depot);

        let calls = recorded_calls(&harness.directory);
        assert_eq!(
            calls.len(),
            2,
            "Get Latest must run one where preflight and one sync: {calls:?}"
        );
        let where_call = &calls[0];
        assert!(
            where_call.contains(" where "),
            "unexpected invocation: {where_call}"
        );
        assert!(where_call.contains("//depot/main"), "{where_call}");
        assert!(
            !where_call.contains("/..."),
            "where must use the stripped target: {where_call}"
        );
        assert!(!where_call.contains("#head"), "{where_call}");
        let line = &calls[1];
        assert!(line.contains(" sync "), "unexpected invocation: {line}");
        assert!(line.contains("//depot/main/...#head"), "{line}");
        assert!(!line.contains("@42"), "{line}");
        let arguments = line.split_whitespace().collect::<Vec<_>>();
        assert!(!arguments.contains(&"-n"), "{line}");
        assert!(!arguments.contains(&"-f"), "{line}");
        assert!(!line.contains("fstat"), "{line}");

        let diagnostics = harness.cache.diagnostics();
        assert_eq!(
            diagnostics
                .invalidation_reasons
                .get("FileMutation")
                .copied(),
            Some(1)
        );
    }

    #[tokio::test]
    async fn sync_latest_blocks_before_sync_when_where_reports_no_mapping() {
        const NOT_IN_VIEW: &str = r#"{"code0":"...","data":"//depot/main - file(s) not in client view.\n","generic":17,"severity":2}"#;
        let harness = latest_harness("where-unmapped", |directory| {
            fake_p4_with_where(
                directory,
                (1, Some(NOT_IN_VIEW)),
                (
                    0,
                    Some(r#"{"depotFile":"//depot/main/a","action":"updated"}"#),
                ),
            )
        });
        let result = harness.service.sync_latest(latest_request(), None).await;

        assert_eq!(result.outcome, SyncOutcome::Failed);
        assert!(
            result.message.contains("no mapping for //depot/main"),
            "{}",
            result.message
        );
        assert!(
            result.message.contains("file(s) not in client view"),
            "{}",
            result.message
        );
        assert!(
            result.message.contains("did not complete cleanly"),
            "{}",
            result.message
        );
        let calls = recorded_calls(&harness.directory);
        assert_eq!(
            calls.len(),
            1,
            "p4 sync must not run after a failed where: {calls:?}"
        );
        assert!(calls[0].contains(" where "), "{calls:?}");
        assert!(!calls[0].contains(" sync "), "{calls:?}");
        assert!(harness.cache.diagnostics().invalidation_reasons.is_empty());
    }

    #[tokio::test]
    async fn sync_latest_surfaces_real_p4_error_text_on_nonzero_exit() {
        const NO_SUCH_FILE: &str = r#"stderr:{"code0":"...","data":"//depot/main/a.txt - no such file(s).\n","generic":17,"severity":2}"#;
        let harness = latest_harness("exit-code", |directory| {
            fake_p4_with_where(directory, (0, Some(WHERE_MAPPED)), (1, Some(NO_SUCH_FILE)))
        });
        let result = harness.service.sync_latest(latest_request(), None).await;

        assert_eq!(result.outcome, SyncOutcome::Failed);
        assert_eq!(result.failure, Some(SyncFailureCode::CommandFailure));
        assert!(
            result.message.contains("no such file(s)"),
            "real p4 text missing: {}",
            result.message
        );
        assert!(
            result.message.contains("did not complete cleanly"),
            "{}",
            result.message
        );
        assert_eq!(recorded_calls(&harness.directory).len(), 2);
        assert_eq!(
            harness
                .cache
                .diagnostics()
                .invalidation_reasons
                .get("FileMutation")
                .copied(),
            Some(1)
        );
    }

    #[tokio::test]
    async fn sync_latest_treats_zero_exit_warning_records_as_failed() {
        const WARNING: &str = r#"{"code0":"...","data":"//depot/main/a.txt - file(s) not in client view.\n","generic":17,"severity":2}"#;
        let harness = latest_harness("zero-exit-warning", |directory| {
            fake_p4_with_where(directory, (0, Some(WHERE_MAPPED)), (0, Some(WARNING)))
        });
        let result = harness.service.sync_latest(latest_request(), None).await;

        assert_eq!(result.outcome, SyncOutcome::Failed);
        assert_eq!(result.failure, Some(SyncFailureCode::CommandFailure));
        assert!(
            result.message.contains("file(s) not in client view"),
            "{}",
            result.message
        );
        assert!(
            result.message.contains("did not complete cleanly"),
            "{}",
            result.message
        );
        assert_eq!(recorded_calls(&harness.directory).len(), 2);
        // The transfer did run, so status invalidation still happens.
        assert_eq!(
            harness
                .cache
                .diagnostics()
                .invalidation_reasons
                .get("FileMutation")
                .copied(),
            Some(1)
        );
    }

    #[tokio::test]
    async fn confirm_treats_zero_exit_warning_records_as_failed() {
        const PREVIEW: &str = r#"{"depotFile":"//depot/main/a.txt","clientFile":"C:/work/a.txt","rev":"2","action":"updated"}"#;
        const WARNING: &str = r#"{"code0":"...","data":"//depot/main/a.txt - file(s) not in client view.\n","generic":17,"severity":2}"#;
        let harness = latest_harness("confirm-warning", |directory| {
            fake_p4_for_confirm(directory, PREVIEW, WARNING)
        });
        let plan = harness.service.preview(latest_request(), None).await;
        assert!(plan.ready, "preview was blocked: {plan:?}");
        let token = plan.token.clone().expect("a ready preview issues a token");
        let result = harness
            .service
            .confirm(
                SyncConfirmRequest {
                    token,
                    target: plan.target.clone(),
                    acknowledge_force: false,
                    operation_id: Some("confirm-warning".into()),
                },
                None,
            )
            .await;

        assert_eq!(result.outcome, SyncOutcome::Failed);
        assert_eq!(result.failure, Some(SyncFailureCode::CommandFailure));
        assert!(
            result.message.contains("file(s) not in client view"),
            "{}",
            result.message
        );
        assert!(
            result.message.contains("did not complete cleanly"),
            "{}",
            result.message
        );
        let calls = recorded_calls(&harness.directory);
        assert_eq!(
            calls.len(),
            5,
            "preview, confirm recheck and one real sync: {calls:?}"
        );
        let last = calls.last().unwrap();
        assert!(last.contains(" sync "), "{calls:?}");
        assert!(
            !last.split_whitespace().any(|argument| argument == "-n"),
            "{calls:?}"
        );
    }

    #[tokio::test]
    async fn sync_latest_reports_where_launch_error_as_failed_without_running_sync() {
        let harness = latest_harness("spawn-error", |directory| directory.join("missing-p4.exe"));
        let result = harness.service.sync_latest(latest_request(), None).await;

        assert_eq!(result.outcome, SyncOutcome::Failed);
        assert!(result.failure.is_some());
        assert!(
            result.message.contains("p4 where could not run"),
            "{}",
            result.message
        );
        assert!(
            result.message.contains("p4 CLI was not found"),
            "{}",
            result.message
        );
        assert!(recorded_calls(&harness.directory).is_empty());
        assert!(harness.cache.diagnostics().invalidation_reasons.is_empty());
    }

    #[tokio::test]
    async fn sync_latest_rejects_unsafe_targets_before_running_p4() {
        let harness = latest_harness("invalid-target", |directory| fake_p4(directory, 0, None));
        let mut request = latest_request();
        request.paths = vec!["-f //depot/main/...".into()];
        let result = harness.service.sync_latest(request, None).await;

        assert_eq!(result.outcome, SyncOutcome::Failed);
        assert!(result
            .message
            .contains("Get Latest was rejected before running p4 sync"));
        assert!(
            recorded_calls(&harness.directory).is_empty(),
            "p4 must not run"
        );
        assert!(harness.cache.diagnostics().invalidation_reasons.is_empty());
    }

    #[tokio::test]
    async fn sync_latest_rejects_root_targets_before_running_p4() {
        let harness = latest_harness("root-target", |directory| fake_p4(directory, 0, None));
        let mut request = latest_request();
        request.paths = vec!["//...".into(), "/...".into()];
        let result = harness.service.sync_latest(request, None).await;

        assert_eq!(result.outcome, SyncOutcome::Failed);
        assert!(result.message.contains("root"), "{}", result.message);
        assert!(
            recorded_calls(&harness.directory).is_empty(),
            "p4 must not run"
        );
        assert!(harness.cache.diagnostics().invalidation_reasons.is_empty());
    }
}
