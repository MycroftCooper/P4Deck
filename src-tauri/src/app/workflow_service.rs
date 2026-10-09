use crate::{
    app::{
        confirmation::{ConfirmationStore, ExpiringConfirmation},
        status_cache::{InvalidationReason, StatusCache, StatusQueryKind},
    },
    domain::*,
    p4::{
        context::ContextStore,
        workflows::{
            content_digest, local_content_facts, parser, PermissionAssessment, ResolveInspection,
            ShelfInspection, UnshelveInspection, WorkflowRepository,
        },
    },
};
use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;
use tauri::AppHandle;
use tokio::sync::Mutex as AsyncMutex;
use uuid::Uuid;

const DEFAULT_TOKEN_TTL_MS: u64 = 120_000;

#[derive(Clone)]
enum TokenPayload {
    Shelf(ShelfPreflightRequest),
    Unshelve(UnshelvePreflightRequest),
    Resolve(Vec<String>),
}

#[derive(Clone)]
struct TokenRecord {
    target: WorkflowTargetSnapshot,
    content_digest: String,
    expires_at: i64,
    payload: TokenPayload,
}

impl ExpiringConfirmation for TokenRecord {
    fn expires_at(&self) -> i64 {
        self.expires_at
    }
}

struct ShelfEvaluation {
    change: Option<PendingChange>,
    blockers: Vec<WorkflowIssue>,
    warnings: Vec<WorkflowIssue>,
    scope: ShelfScopeSummary,
    digest: String,
    operation_ids: Vec<String>,
}

struct UnshelveEvaluation {
    source: Option<PendingChange>,
    target_change: Option<PendingChange>,
    target_context: P4Context,
    mappings: Vec<UnshelveMapping>,
    blockers: Vec<WorkflowIssue>,
    warnings: Vec<WorkflowIssue>,
    digest: String,
    operation_ids: Vec<String>,
}

struct ResolveEvaluation {
    conflicts: Vec<ResolveConflictDetail>,
    blockers: Vec<WorkflowIssue>,
    warnings: Vec<WorkflowIssue>,
    digest: String,
    operation_ids: Vec<String>,
}

pub struct WorkflowService {
    repository: WorkflowRepository,
    contexts: Arc<ContextStore>,
    status_cache: Arc<StatusCache>,
    tokens: ConfirmationStore<TokenRecord>,
    confirmation_gate: AsyncMutex<()>,
    ttl_ms: u64,
}

impl WorkflowService {
    pub fn new(
        repository: WorkflowRepository,
        contexts: Arc<ContextStore>,
        status_cache: Arc<StatusCache>,
    ) -> Self {
        Self::with_ttl(repository, contexts, status_cache, DEFAULT_TOKEN_TTL_MS)
    }

    pub(crate) fn with_ttl(
        repository: WorkflowRepository,
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

    pub async fn preflight_shelf(
        &self,
        mut request: ShelfPreflightRequest,
        app: Option<&AppHandle>,
    ) -> ShelfPreflight {
        request.depot_paths = normalized_paths(request.depot_paths);
        let (context, generation) = self.contexts.snapshot();
        let target = target(
            "shelf",
            &context,
            generation,
            Some(request.change_id),
            None,
            request.depot_paths.clone(),
        );
        let inspection = self
            .repository
            .inspect_shelf(
                &context,
                request.change_id,
                &request.depot_paths,
                &format!("shelf-preflight-{}", Uuid::new_v4()),
                app,
            )
            .await;
        let evaluation = inspection
            .map(|value| evaluate_shelf(&request, value))
            .unwrap_or_else(|_| failed_shelf_evaluation(&request));
        let ready = evaluation.blockers.is_empty();
        let expires_at = now_ms().saturating_add(self.ttl_ms as i64);
        let token = ready.then(|| {
            self.tokens.issue(
                TokenRecord {
                    target: target.clone(),
                    content_digest: evaluation.digest.clone(),
                    expires_at,
                    payload: TokenPayload::Shelf(request),
                },
                now_ms(),
            )
        });
        ShelfPreflight {
            ready,
            change: evaluation.change,
            blockers: evaluation.blockers,
            warnings: evaluation.warnings,
            target,
            scope: evaluation.scope,
            token,
            expires_at,
            ttl_ms: self.ttl_ms,
            log_reference: evaluation.operation_ids.first().cloned(),
            operation_ids: evaluation.operation_ids,
        }
    }

    pub async fn confirm_shelf(
        &self,
        confirmation: WorkflowConfirmation,
        app: Option<&AppHandle>,
    ) -> WorkflowResult {
        let _gate = self.confirmation_gate.lock().await;
        let record = match self.consume(&confirmation, "shelf") {
            Ok(record) => record,
            Err(result) => return *result,
        };
        let TokenPayload::Shelf(request) = record.payload else {
            return rejected(
                &confirmation.target,
                WorkflowFailureCode::TargetMismatch,
                "The token belongs to another workflow.",
            );
        };
        let (context, generation) = self.contexts.snapshot();
        if target(
            "shelf",
            &context,
            generation,
            Some(request.change_id),
            None,
            request.depot_paths.clone(),
        ) != record.target
        {
            return rejected(
                &record.target,
                WorkflowFailureCode::ContextChanged,
                "The connection or workspace changed after preflight.",
            );
        }
        let guard = self.repository.lock_mutations(&context.server).await;
        let inspection = self
            .repository
            .inspect_shelf(
                &context,
                request.change_id,
                &request.depot_paths,
                &format!("shelf-recheck-{}", Uuid::new_v4()),
                app,
            )
            .await;
        let Ok(inspection) = inspection else {
            return rejected(
                &record.target,
                WorkflowFailureCode::PreflightBlocked,
                "The shelf snapshot could not be revalidated safely.",
            );
        };
        let evaluation = evaluate_shelf(&request, inspection);
        if !evaluation.blockers.is_empty() {
            return rejected(
                &record.target,
                WorkflowFailureCode::PreflightBlocked,
                "Shelf preflight no longer passes.",
            );
        }
        if evaluation.digest != record.content_digest {
            return rejected(
                &record.target,
                WorkflowFailureCode::ContentChanged,
                "Opened or shelved file content changed after preflight.",
            );
        }
        if !same_active_context(&self.contexts, &record.target) {
            return rejected(
                &record.target,
                WorkflowFailureCode::ContextChanged,
                "The connection changed during confirmation.",
            );
        }
        let operation_id = valid_operation_id(confirmation.operation_id);
        let execution = self
            .repository
            .execute_shelf(&context, &request, operation_id.clone(), &guard, app)
            .await;
        self.invalidate(
            &context,
            &request.depot_paths,
            InvalidationReason::ChangelistMutation,
        );
        operation_result(
            &record.target,
            execution,
            operation_id,
            "Shelf operation completed.",
        )
    }

    pub async fn preflight_unshelve(
        &self,
        mut request: UnshelvePreflightRequest,
        app: Option<&AppHandle>,
    ) -> UnshelvePreflight {
        request.depot_paths = normalized_paths(request.depot_paths);
        let (context, generation) = self.contexts.snapshot();
        let inspection = self
            .repository
            .inspect_unshelve(
                &context,
                &request,
                &format!("unshelve-preflight-{}", Uuid::new_v4()),
                app,
            )
            .await;
        let evaluation = inspection
            .map(|value| evaluate_unshelve(&request, value))
            .unwrap_or_else(|_| failed_unshelve_evaluation(&context, &request));
        let target = target(
            "unshelve",
            &evaluation.target_context,
            generation,
            Some(request.source_change_id),
            Some(request.target_change_id),
            request.depot_paths.clone(),
        );
        let ready = evaluation.blockers.is_empty();
        let expires_at = now_ms().saturating_add(self.ttl_ms as i64);
        let token = ready.then(|| {
            self.tokens.issue(
                TokenRecord {
                    target: target.clone(),
                    content_digest: evaluation.digest.clone(),
                    expires_at,
                    payload: TokenPayload::Unshelve(request),
                },
                now_ms(),
            )
        });
        UnshelvePreflight {
            ready,
            source: evaluation.source,
            target_change: evaluation.target_change,
            mappings: evaluation.mappings,
            blockers: evaluation.blockers,
            warnings: evaluation.warnings,
            target,
            content_digest: evaluation.digest,
            token,
            expires_at,
            ttl_ms: self.ttl_ms,
            log_reference: evaluation.operation_ids.first().cloned(),
            operation_ids: evaluation.operation_ids,
        }
    }

    pub async fn confirm_unshelve(
        &self,
        confirmation: WorkflowConfirmation,
        app: Option<&AppHandle>,
    ) -> WorkflowResult {
        let _gate = self.confirmation_gate.lock().await;
        let record = match self.consume(&confirmation, "unshelve") {
            Ok(record) => record,
            Err(result) => return *result,
        };
        let TokenPayload::Unshelve(request) = record.payload else {
            return rejected(
                &confirmation.target,
                WorkflowFailureCode::TargetMismatch,
                "The token belongs to another workflow.",
            );
        };
        let (context, generation) = self.contexts.snapshot();
        if context.server != record.target.server
            || context.user != record.target.user
            || generation != record.target.context_generation
        {
            return rejected(
                &record.target,
                WorkflowFailureCode::ContextChanged,
                "The source connection changed after preflight.",
            );
        }
        let guard = self.repository.lock_mutations(&context.server).await;
        let inspection = self
            .repository
            .inspect_unshelve(
                &context,
                &request,
                &format!("unshelve-recheck-{}", Uuid::new_v4()),
                app,
            )
            .await;
        let Ok(inspection) = inspection else {
            return rejected(
                &record.target,
                WorkflowFailureCode::PreflightBlocked,
                "The unshelve snapshot could not be revalidated safely.",
            );
        };
        let evaluation = evaluate_unshelve(&request, inspection);
        let current_target = target(
            "unshelve",
            &evaluation.target_context,
            generation,
            Some(request.source_change_id),
            Some(request.target_change_id),
            request.depot_paths.clone(),
        );
        if current_target != record.target {
            return rejected(
                &record.target,
                WorkflowFailureCode::ContextChanged,
                "The target workspace mapping changed after preflight.",
            );
        }
        if !evaluation.blockers.is_empty() {
            return rejected(
                &record.target,
                WorkflowFailureCode::PreflightBlocked,
                "Unshelve preflight no longer passes.",
            );
        }
        if evaluation.digest != record.content_digest {
            return rejected(
                &record.target,
                WorkflowFailureCode::ContentChanged,
                "The source shelf or target workspace changed after preflight.",
            );
        }
        let operation_id = valid_operation_id(confirmation.operation_id);
        let execution = self
            .repository
            .execute_unshelve(
                &evaluation.target_context,
                &request,
                operation_id.clone(),
                &guard,
                app,
            )
            .await;
        self.invalidate(
            &evaluation.target_context,
            &request.depot_paths,
            InvalidationReason::ChangelistMutation,
        );
        operation_result(
            &record.target,
            execution,
            operation_id,
            "Unshelve completed; files may still require Resolve.",
        )
    }

    pub async fn preflight_resolve(
        &self,
        mut request: ResolvePreflightRequest,
        app: Option<&AppHandle>,
    ) -> ResolvePreflight {
        request.depot_paths = normalized_paths(request.depot_paths);
        let (context, generation) = self.contexts.snapshot();
        let target = target(
            "resolve",
            &context,
            generation,
            None,
            None,
            request.depot_paths.clone(),
        );
        let inspection = self
            .repository
            .inspect_resolve(
                &context,
                &request.depot_paths,
                &format!("resolve-preflight-{}", Uuid::new_v4()),
                app,
            )
            .await;
        let evaluation = inspection
            .map(|value| evaluate_resolve(&request.depot_paths, value))
            .unwrap_or_else(|_| failed_resolve_evaluation(&request.depot_paths));
        let ready = evaluation.blockers.is_empty();
        let expires_at = now_ms().saturating_add(self.ttl_ms as i64);
        let token = ready.then(|| {
            self.tokens.issue(
                TokenRecord {
                    target: target.clone(),
                    content_digest: evaluation.digest.clone(),
                    expires_at,
                    payload: TokenPayload::Resolve(request.depot_paths),
                },
                now_ms(),
            )
        });
        ResolvePreflight {
            ready,
            conflicts: evaluation.conflicts,
            blockers: evaluation.blockers,
            warnings: evaluation.warnings,
            target,
            content_digest: evaluation.digest,
            token,
            expires_at,
            ttl_ms: self.ttl_ms,
            log_reference: evaluation.operation_ids.first().cloned(),
            operation_ids: evaluation.operation_ids,
        }
    }

    pub async fn confirm_resolve(
        &self,
        confirmation: ResolveConfirmation,
        app: Option<&AppHandle>,
    ) -> WorkflowResult {
        let _gate = self.confirmation_gate.lock().await;
        let workflow_confirmation = WorkflowConfirmation {
            token: confirmation.token.clone(),
            target: confirmation.target.clone(),
            operation_id: confirmation.operation_id.clone(),
        };
        let record = match self.consume(&workflow_confirmation, "resolve") {
            Ok(record) => record,
            Err(result) => return *result,
        };
        let TokenPayload::Resolve(paths) = record.payload else {
            return rejected(
                &confirmation.target,
                WorkflowFailureCode::TargetMismatch,
                "The token belongs to another workflow.",
            );
        };
        let selections = confirmation.resolutions;
        let selected_paths = selections
            .iter()
            .map(|item| item.depot_path.clone())
            .collect::<BTreeSet<_>>();
        let expected_paths = paths.iter().cloned().collect::<BTreeSet<_>>();
        if selections.len() != selected_paths.len()
            || selected_paths != expected_paths
            || selections
                .iter()
                .any(|item| item.strategy == ResolveStrategy::MergePreview)
        {
            return rejected(
                &record.target,
                WorkflowFailureCode::TargetMismatch,
                "Resolve confirmation must select one executable strategy for every checked file.",
            );
        }
        let (context, generation) = self.contexts.snapshot();
        if target("resolve", &context, generation, None, None, paths.clone()) != record.target {
            return rejected(
                &record.target,
                WorkflowFailureCode::ContextChanged,
                "The connection or workspace changed after preflight.",
            );
        }
        let guard = self.repository.lock_mutations(&context.server).await;
        let inspection = self
            .repository
            .inspect_resolve(
                &context,
                &paths,
                &format!("resolve-recheck-{}", Uuid::new_v4()),
                app,
            )
            .await;
        let Ok(inspection) = inspection else {
            return rejected(
                &record.target,
                WorkflowFailureCode::PreflightBlocked,
                "Resolve details could not be revalidated safely.",
            );
        };
        let evaluation = evaluate_resolve(&paths, inspection);
        if !evaluation.blockers.is_empty() {
            return rejected(
                &record.target,
                WorkflowFailureCode::PreflightBlocked,
                "Resolve preflight no longer passes.",
            );
        }
        if evaluation.digest != record.content_digest {
            return rejected(
                &record.target,
                WorkflowFailureCode::ContentChanged,
                "Conflict content changed after preflight.",
            );
        }
        let base_id = valid_operation_id(confirmation.operation_id);
        let mut operation_ids = Vec::new();
        let mut files = Vec::new();
        for (index, selection) in selections.iter().enumerate() {
            let operation_id = format!("{base_id}-{}", index + 1);
            let result = self
                .repository
                .execute_resolve(&context, selection, operation_id.clone(), &guard, app)
                .await;
            operation_ids.push(operation_id.clone());
            files.push(file_result(
                selection.depot_path.clone(),
                result,
                operation_id,
            ));
        }
        let post = self
            .repository
            .inspect_resolve(
                &context,
                &paths,
                &format!("resolve-verify-{}", Uuid::new_v4()),
                app,
            )
            .await;
        match post {
            Ok(post) => {
                let final_facts = post
                    .facts
                    .into_iter()
                    .map(|fact| (fact.depot_path.clone(), fact))
                    .collect::<BTreeMap<_, _>>();
                for file in &mut files {
                    match final_facts.get(&file.depot_path) {
                        Some(fact) if fact.unresolved > 0 => {
                            file.state = WorkflowFileState::Blocked;
                            file.message =
                                "The file remains unresolved after the selected strategy.".into();
                        }
                        Some(_) => {}
                        None if file.state == WorkflowFileState::Succeeded => {
                            file.state = WorkflowFileState::Unknown;
                            file.message =
                                "Resolve ran, but the final file state was not returned.".into();
                        }
                        None => {}
                    }
                }
            }
            Err(_) => {
                for file in &mut files {
                    if file.state == WorkflowFileState::Succeeded {
                        file.state = WorkflowFileState::Unknown;
                        file.message =
                            "Resolve ran, but the final conflict state could not be verified."
                                .into();
                    }
                }
            }
        }
        self.invalidate(&context, &paths, InvalidationReason::ChangelistMutation);
        result_from_files(
            files,
            operation_ids,
            &record.target,
            "Resolve execution completed with per-file verification.",
        )
    }

    fn consume(
        &self,
        confirmation: &WorkflowConfirmation,
        kind: &str,
    ) -> Result<TokenRecord, Box<WorkflowResult>> {
        let Some(record) = self.tokens.consume(&confirmation.token) else {
            return Err(Box::new(rejected(
                &confirmation.target,
                WorkflowFailureCode::TokenUnknown,
                "The confirmation token is unknown or was already used.",
            )));
        };
        if record.expires_at <= now_ms() {
            return Err(Box::new(rejected(
                &record.target,
                WorkflowFailureCode::TokenExpired,
                "The preflight expired. Run it again.",
            )));
        }
        if record.target != confirmation.target || record.target.kind != kind {
            return Err(Box::new(rejected(
                &record.target,
                WorkflowFailureCode::TargetMismatch,
                "The confirmation target does not match the checked snapshot.",
            )));
        }
        Ok(record)
    }

    fn invalidate(&self, context: &P4Context, paths: &[String], reason: InvalidationReason) {
        self.status_cache.invalidate(
            &context.server,
            &context.user,
            &context.client,
            paths,
            &[
                StatusQueryKind::WorkspaceStatus,
                StatusQueryKind::Opened,
                StatusQueryKind::Reconcile,
            ],
            reason,
        );
    }
}

fn evaluate_shelf(request: &ShelfPreflightRequest, inspection: ShelfInspection) -> ShelfEvaluation {
    let paths = request.depot_paths.clone();
    let mut blockers = Vec::new();
    let mut warnings = Vec::new();
    let opened = inspection
        .change
        .as_ref()
        .map(|change| {
            change
                .files
                .iter()
                .map(|file| file.depot_path.clone())
                .collect::<BTreeSet<_>>()
        })
        .unwrap_or_default();
    let shelves = inspection
        .change
        .as_ref()
        .map(|change| {
            change
                .shelved_files
                .iter()
                .map(|file| file.depot_path.clone())
                .collect::<BTreeSet<_>>()
        })
        .unwrap_or_default();
    if request.change_id <= 0 {
        blockers.push(issue(
            WorkflowIssueCode::InvalidTarget,
            WorkflowIssueCertainty::Confirmed,
            "Shelf operations require a numbered pending changelist.",
            paths.clone(),
        ));
    }
    if inspection.change.is_none() {
        blockers.push(issue(
            WorkflowIssueCode::ChangeNotFound,
            WorkflowIssueCertainty::Confirmed,
            "The changelist is not pending in the current user/workspace scope.",
            paths.clone(),
        ));
    }
    let missing = paths
        .iter()
        .filter(|path| match request.mode {
            ShelfMode::CreateOrUpdate => !opened.contains(*path),
            ShelfMode::Delete => !shelves.contains(*path),
        })
        .cloned()
        .collect::<Vec<_>>();
    if !missing.is_empty() {
        blockers.push(issue(
            if request.mode == ShelfMode::Delete {
                WorkflowIssueCode::FileNotShelved
            } else {
                WorkflowIssueCode::FileNotInChange
            },
            WorkflowIssueCertainty::Confirmed,
            "One or more selected files are outside the requested changelist scope.",
            missing,
        ));
    }
    let replacements = paths
        .iter()
        .filter(|path| shelves.contains(*path))
        .cloned()
        .collect::<Vec<_>>();
    if request.mode == ShelfMode::CreateOrUpdate && !request.replace && !replacements.is_empty() {
        blockers.push(issue(
            WorkflowIssueCode::ExistingShelfRequiresReplace,
            WorkflowIssueCertainty::Confirmed,
            "Existing shelf revisions require explicit replacement confirmation.",
            replacements.clone(),
        ));
    }
    let fact_paths = inspection
        .facts
        .iter()
        .map(|fact| fact.depot_path.as_str())
        .collect::<BTreeSet<_>>();
    let unknown = paths
        .iter()
        .filter(|path| !fact_paths.contains(path.as_str()))
        .cloned()
        .collect::<Vec<_>>();
    if request.mode == ShelfMode::CreateOrUpdate && !unknown.is_empty() {
        blockers.push(issue(
            WorkflowIssueCode::InspectionUnknown,
            WorkflowIssueCertainty::Unknown,
            "Current file content could not be inspected safely.",
            unknown,
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
            WorkflowIssueCode::LockedFile,
            WorkflowIssueCertainty::Confirmed,
            "One or more files are locked by another workspace.",
            locked,
        ));
    }
    permission_issues(
        inspection.permission.clone(),
        &paths,
        &mut blockers,
        &mut warnings,
    );
    let digest = content_digest(&(
        inspection.change.as_ref(),
        &inspection.facts,
        &inspection.shelf_facts,
        local_content_facts(&inspection.facts),
        request,
    ));
    let scope = ShelfScopeSummary {
        opened_paths: opened.into_iter().collect(),
        existing_shelved_paths: shelves.iter().cloned().collect(),
        create_paths: if request.mode == ShelfMode::CreateOrUpdate {
            paths
                .iter()
                .filter(|path| !shelves.contains(*path))
                .cloned()
                .collect()
        } else {
            Vec::new()
        },
        replace_paths: if request.mode == ShelfMode::CreateOrUpdate {
            replacements
        } else {
            Vec::new()
        },
        delete_paths: if request.mode == ShelfMode::Delete {
            paths
        } else {
            Vec::new()
        },
        content_digest: digest.clone(),
    };
    ShelfEvaluation {
        change: inspection.change,
        blockers,
        warnings,
        scope,
        digest,
        operation_ids: inspection.operation_ids,
    }
}

fn evaluate_unshelve(
    request: &UnshelvePreflightRequest,
    inspection: UnshelveInspection,
) -> UnshelveEvaluation {
    let paths = request.depot_paths.clone();
    let mut blockers = Vec::new();
    let mut warnings = Vec::new();
    if request.source_change_id <= 0 || request.target_change_id < 0 {
        blockers.push(issue(
            WorkflowIssueCode::InvalidTarget,
            WorkflowIssueCertainty::Confirmed,
            "Unshelve requires a numbered source and Default or numbered target changelist.",
            paths.clone(),
        ));
    }
    let source_paths = inspection
        .source
        .as_ref()
        .map(|change| {
            change
                .shelved_files
                .iter()
                .map(|file| file.depot_path.clone())
                .collect::<BTreeSet<_>>()
        })
        .unwrap_or_default();
    let missing = paths
        .iter()
        .filter(|path| !source_paths.contains(*path))
        .cloned()
        .collect::<Vec<_>>();
    if inspection.source.is_none() || !missing.is_empty() {
        blockers.push(issue(
            WorkflowIssueCode::FileNotShelved,
            WorkflowIssueCertainty::Confirmed,
            "The source shelf does not contain every selected file.",
            if missing.is_empty() {
                paths.clone()
            } else {
                missing
            },
        ));
    }
    if inspection.target_change.is_none() {
        blockers.push(issue(
            WorkflowIssueCode::ChangeNotFound,
            WorkflowIssueCertainty::Confirmed,
            "The target changelist is outside the target workspace scope.",
            paths.clone(),
        ));
    }
    let mapping_map = inspection
        .mappings
        .iter()
        .cloned()
        .collect::<BTreeMap<_, _>>();
    let modified = inspection
        .modified_paths
        .iter()
        .cloned()
        .collect::<BTreeSet<_>>();
    let target_facts = inspection
        .target_facts
        .iter()
        .map(|fact| (fact.depot_path.clone(), fact))
        .collect::<BTreeMap<_, _>>();
    let mut mappings = Vec::new();
    for path in &paths {
        let target_path = mapping_map.get(path).cloned();
        let fact = target_facts.get(path).copied();
        let locally_modified = modified.contains(path)
            || target_path
                .as_ref()
                .is_some_and(|local| modified.contains(local));
        let opened_change_id = fact.and_then(|value| value.change_id);
        let locked = fact.is_some_and(|value| value.other_lock > 0);
        let resolve_likely =
            opened_change_id.is_some() || preview_mentions_resolve(&inspection.preview, path);
        mappings.push(UnshelveMapping {
            depot_path: path.clone(),
            target_path: target_path.clone(),
            mapped: target_path.is_some(),
            locally_modified,
            opened_change_id,
            locked,
            resolve_risk: if resolve_likely {
                ResolveRisk::Likely
            } else if inspection.preview_succeeded {
                ResolveRisk::None
            } else {
                ResolveRisk::Unknown
            },
        });
    }
    let unmapped = mappings
        .iter()
        .filter(|item| !item.mapped)
        .map(|item| item.depot_path.clone())
        .collect::<Vec<_>>();
    if !unmapped.is_empty() {
        blockers.push(issue(
            WorkflowIssueCode::MappingFailed,
            WorkflowIssueCertainty::Confirmed,
            "Files are not mapped in the target workspace.",
            unmapped,
        ));
    }
    let dirty = mappings
        .iter()
        .filter(|item| item.locally_modified)
        .map(|item| item.depot_path.clone())
        .collect::<Vec<_>>();
    if !dirty.is_empty() {
        blockers.push(issue(
            WorkflowIssueCode::LocalModification,
            WorkflowIssueCertainty::Confirmed,
            "Unshelve would overlap local modifications; force overwrite is not enabled.",
            dirty,
        ));
    }
    let locked = mappings
        .iter()
        .filter(|item| item.locked)
        .map(|item| item.depot_path.clone())
        .collect::<Vec<_>>();
    if !locked.is_empty() {
        blockers.push(issue(
            WorkflowIssueCode::LockedFile,
            WorkflowIssueCertainty::Confirmed,
            "Files are locked in another workspace.",
            locked,
        ));
    }
    let opened = mappings
        .iter()
        .filter(|item| item.opened_change_id.is_some())
        .map(|item| item.depot_path.clone())
        .collect::<Vec<_>>();
    if !opened.is_empty() {
        warnings.push(issue(
            WorkflowIssueCode::AlreadyOpened,
            WorkflowIssueCertainty::Confirmed,
            "Files are already opened in the target workspace.",
            opened,
        ));
    }
    let risky = mappings
        .iter()
        .filter(|item| item.resolve_risk == ResolveRisk::Likely)
        .map(|item| item.depot_path.clone())
        .collect::<Vec<_>>();
    if !risky.is_empty() {
        warnings.push(issue(
            WorkflowIssueCode::ResolveLikely,
            WorkflowIssueCertainty::Confirmed,
            "Unshelve is expected to leave integration records that require Resolve.",
            risky,
        ));
    }
    if !inspection.preview_succeeded {
        blockers.push(issue(
            WorkflowIssueCode::InspectionUnknown,
            WorkflowIssueCertainty::Unknown,
            "The server dry-run did not complete successfully; execution remains blocked.",
            paths.clone(),
        ));
    }
    permission_issues(
        inspection.permission.clone(),
        &paths,
        &mut blockers,
        &mut warnings,
    );
    let digest = content_digest(&(
        inspection.source.as_ref(),
        inspection.target_change.as_ref(),
        &inspection.source_facts,
        &inspection.target_facts,
        &inspection.mappings,
        &inspection.modified_paths,
        &inspection.preview,
        request,
    ));
    UnshelveEvaluation {
        source: inspection.source,
        target_change: inspection.target_change,
        target_context: inspection.target_context,
        mappings,
        blockers,
        warnings,
        digest,
        operation_ids: inspection.operation_ids,
    }
}

fn evaluate_resolve(paths: &[String], inspection: ResolveInspection) -> ResolveEvaluation {
    let mut blockers = Vec::new();
    let warnings = Vec::new();
    let facts = inspection
        .facts
        .iter()
        .map(|fact| (fact.depot_path.clone(), fact))
        .collect::<BTreeMap<_, _>>();
    let sources = parser::resolve_sources(&inspection.preview);
    let preview_lower = inspection.preview.join(" ").to_ascii_lowercase();
    let conflict_type = if preview_lower.contains("filetype") {
        "filetype"
    } else if preview_lower.contains("branch") {
        "branch"
    } else if preview_lower.contains("move") {
        "move"
    } else if preview_lower.contains("merge") {
        "content"
    } else {
        "unknown"
    };
    let mut conflicts = Vec::new();
    for path in paths {
        match facts.get(path).copied() {
            Some(fact) if fact.unresolved > 0 && inspection.preview_succeeded => {
                conflicts.push(ResolveConflictDetail {
                    depot_path: path.clone(),
                    client_path: fact.client_path.clone(),
                    conflict_type: conflict_type.into(),
                    status: "unresolved".into(),
                    available_strategies: vec![
                        ResolveStrategy::Safe,
                        ResolveStrategy::AcceptYours,
                        ResolveStrategy::AcceptTheirs,
                        ResolveStrategy::MergePreview,
                    ],
                    sources: sources.clone(),
                    preview: inspection
                        .preview
                        .iter()
                        .filter(|line| line.contains(path) || paths.len() == 1)
                        .cloned()
                        .collect(),
                })
            }
            Some(fact) if fact.unresolved == 0 => {
                blockers.push(issue(
                    WorkflowIssueCode::NotResolvable,
                    WorkflowIssueCertainty::Confirmed,
                    "The file has no unresolved integration record.",
                    vec![path.clone()],
                ));
                conflicts.push(ResolveConflictDetail {
                    depot_path: path.clone(),
                    client_path: fact.client_path.clone(),
                    conflict_type: "unknown".into(),
                    status: "blocked".into(),
                    available_strategies: vec![ResolveStrategy::MergePreview],
                    sources: Vec::new(),
                    preview: Vec::new(),
                });
            }
            Some(fact) => {
                blockers.push(issue(
                    WorkflowIssueCode::InspectionUnknown,
                    WorkflowIssueCertainty::Unknown,
                    "The resolve preview failed; this conflict cannot be resolved safely.",
                    vec![path.clone()],
                ));
                conflicts.push(ResolveConflictDetail {
                    depot_path: path.clone(),
                    client_path: fact.client_path.clone(),
                    conflict_type: "unknown".into(),
                    status: "unknown".into(),
                    available_strategies: vec![ResolveStrategy::MergePreview],
                    sources: Vec::new(),
                    preview: inspection.preview.clone(),
                });
            }
            None => {
                blockers.push(issue(
                    WorkflowIssueCode::InspectionUnknown,
                    WorkflowIssueCertainty::Unknown,
                    "Conflict state could not be read; unknown is not treated as resolved.",
                    vec![path.clone()],
                ));
                conflicts.push(ResolveConflictDetail {
                    depot_path: path.clone(),
                    client_path: None,
                    conflict_type: "unknown".into(),
                    status: "unknown".into(),
                    available_strategies: vec![ResolveStrategy::MergePreview],
                    sources: Vec::new(),
                    preview: Vec::new(),
                });
            }
        }
    }
    let digest = content_digest(&(
        &inspection.facts,
        local_content_facts(&inspection.facts),
        &inspection.preview,
        paths,
    ));
    ResolveEvaluation {
        conflicts,
        blockers,
        warnings,
        digest,
        operation_ids: inspection.operation_ids,
    }
}

fn failed_shelf_evaluation(request: &ShelfPreflightRequest) -> ShelfEvaluation {
    ShelfEvaluation {
        change: None,
        blockers: vec![issue(
            WorkflowIssueCode::InspectionUnknown,
            WorkflowIssueCertainty::Unknown,
            "Shelf preflight could not obtain a reliable server snapshot.",
            request.depot_paths.clone(),
        )],
        warnings: Vec::new(),
        scope: ShelfScopeSummary {
            opened_paths: Vec::new(),
            existing_shelved_paths: Vec::new(),
            create_paths: Vec::new(),
            replace_paths: Vec::new(),
            delete_paths: Vec::new(),
            content_digest: content_digest(request),
        },
        digest: content_digest(request),
        operation_ids: Vec::new(),
    }
}

fn failed_unshelve_evaluation(
    context: &P4Context,
    request: &UnshelvePreflightRequest,
) -> UnshelveEvaluation {
    let mut target_context = context.clone();
    target_context.client = request.target_workspace.clone();
    UnshelveEvaluation {
        source: None,
        target_change: None,
        target_context,
        mappings: Vec::new(),
        blockers: vec![issue(
            WorkflowIssueCode::InspectionUnknown,
            WorkflowIssueCertainty::Unknown,
            "Unshelve preflight could not obtain a reliable source and target snapshot.",
            request.depot_paths.clone(),
        )],
        warnings: Vec::new(),
        digest: content_digest(request),
        operation_ids: Vec::new(),
    }
}

fn failed_resolve_evaluation(paths: &[String]) -> ResolveEvaluation {
    ResolveEvaluation {
        conflicts: paths
            .iter()
            .map(|path| ResolveConflictDetail {
                depot_path: path.clone(),
                client_path: None,
                conflict_type: "unknown".into(),
                status: "unknown".into(),
                available_strategies: vec![ResolveStrategy::MergePreview],
                sources: Vec::new(),
                preview: Vec::new(),
            })
            .collect(),
        blockers: vec![issue(
            WorkflowIssueCode::InspectionUnknown,
            WorkflowIssueCertainty::Unknown,
            "Resolve preflight could not obtain reliable conflict details.",
            paths.to_vec(),
        )],
        warnings: Vec::new(),
        digest: content_digest(&paths),
        operation_ids: Vec::new(),
    }
}

fn permission_issues(
    permission: PermissionAssessment,
    paths: &[String],
    blockers: &mut Vec<WorkflowIssue>,
    warnings: &mut Vec<WorkflowIssue>,
) {
    match permission {
        PermissionAssessment::Denied(paths) => blockers.push(issue(
            WorkflowIssueCode::PermissionDenied,
            WorkflowIssueCertainty::Confirmed,
            "The current user lacks write permission for one or more files.",
            paths,
        )),
        PermissionAssessment::Unknown => warnings.push(issue(
            WorkflowIssueCode::PermissionUnknown,
            WorkflowIssueCertainty::Unknown,
            "Write permission could not be verified; the server remains authoritative.",
            paths.to_vec(),
        )),
        PermissionAssessment::Allowed => {}
    }
}

fn issue(
    code: WorkflowIssueCode,
    certainty: WorkflowIssueCertainty,
    message: impl Into<String>,
    mut paths: Vec<String>,
) -> WorkflowIssue {
    paths.sort();
    paths.dedup();
    WorkflowIssue {
        code,
        certainty,
        message: message.into(),
        paths,
    }
}

fn target(
    kind: &str,
    context: &P4Context,
    generation: u64,
    source_change_id: Option<i64>,
    target_change_id: Option<i64>,
    depot_paths: Vec<String>,
) -> WorkflowTargetSnapshot {
    WorkflowTargetSnapshot {
        kind: kind.into(),
        server: context.server.clone(),
        user: context.user.clone(),
        client: context.client.clone(),
        workspace: context.cwd.clone().unwrap_or_default(),
        context_generation: generation,
        source_change_id,
        target_change_id,
        depot_paths,
    }
}

fn same_active_context(contexts: &ContextStore, target: &WorkflowTargetSnapshot) -> bool {
    let (context, generation) = contexts.snapshot();
    context.server == target.server
        && context.user == target.user
        && context.client == target.client
        && context.cwd.as_deref().unwrap_or_default() == target.workspace
        && generation == target.context_generation
}

fn normalized_paths(mut paths: Vec<String>) -> Vec<String> {
    paths.sort();
    paths.dedup();
    paths
}
fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}
fn valid_operation_id(value: Option<String>) -> String {
    value
        .filter(|value| !value.trim().is_empty() && value.len() <= 200)
        .unwrap_or_else(|| Uuid::new_v4().to_string())
}
fn preview_mentions_resolve(lines: &[String], path: &str) -> bool {
    lines.iter().any(|line| {
        let lower = line.to_ascii_lowercase();
        (line.contains(path) || !line.contains("//"))
            && (lower.contains("resolve") || lower.contains("merge"))
    })
}

fn rejected(
    target: &WorkflowTargetSnapshot,
    failure: WorkflowFailureCode,
    message: impl Into<String>,
) -> WorkflowResult {
    WorkflowResult {
        outcome: WorkflowOutcome::Rejected,
        failure: Some(failure),
        message: message.into(),
        operation_ids: Vec::new(),
        log_reference: None,
        files: target
            .depot_paths
            .iter()
            .map(|path| WorkflowFileResult {
                depot_path: path.clone(),
                state: WorkflowFileState::Blocked,
                message: "Run preflight again against the current state.".into(),
                operation_id: None,
            })
            .collect(),
        refresh: refresh(
            target.depot_paths.clone(),
            "Refresh related changelist and workspace state before retrying.",
        ),
    }
}

fn operation_result(
    target: &WorkflowTargetSnapshot,
    result: Result<OperationResult, String>,
    operation_id: String,
    success: &str,
) -> WorkflowResult {
    match result {
        Ok(operation) if operation.exit_code == 0 => WorkflowResult {
            outcome: WorkflowOutcome::Succeeded,
            failure: None,
            message: success.into(),
            operation_ids: vec![operation_id.clone()],
            log_reference: Some(operation_id.clone()),
            files: target
                .depot_paths
                .iter()
                .map(|path| WorkflowFileResult {
                    depot_path: path.clone(),
                    state: WorkflowFileState::Succeeded,
                    message: success.into(),
                    operation_id: Some(operation_id.clone()),
                })
                .collect(),
            refresh: refresh(
                target.depot_paths.clone(),
                "Refresh affected changelist and workspace views.",
            ),
        },
        Ok(operation) => {
            let cancelled = operation
                .events
                .iter()
                .any(|event| matches!(event.kind, EventKind::Cancelled));
            WorkflowResult { outcome: if cancelled { WorkflowOutcome::Cancelled } else { WorkflowOutcome::Failed }, failure: Some(if cancelled { WorkflowFailureCode::Cancelled } else { WorkflowFailureCode::CommandFailure }), message: if cancelled { "Operation was cancelled.".into() } else { "The server rejected the operation.".into() }, operation_ids: vec![operation_id.clone()], log_reference: Some(operation_id.clone()), files: target.depot_paths.iter().map(|path| WorkflowFileResult { depot_path: path.clone(), state: if cancelled { WorkflowFileState::Cancelled } else { WorkflowFileState::Failed }, message: "Refresh before retrying because a partial server-side change is possible.".into(), operation_id: Some(operation_id.clone()) }).collect(), refresh: refresh(target.depot_paths.clone(), "Failure or cancellation may be partial; refresh before retrying.") }
        }
        Err(_) => WorkflowResult {
            outcome: WorkflowOutcome::Unknown,
            failure: Some(WorkflowFailureCode::UncertainOutcome),
            message: "The command outcome is uncertain.".into(),
            operation_ids: vec![operation_id.clone()],
            log_reference: Some(operation_id.clone()),
            files: target
                .depot_paths
                .iter()
                .map(|path| WorkflowFileResult {
                    depot_path: path.clone(),
                    state: WorkflowFileState::Unknown,
                    message: "Refresh before any retry.".into(),
                    operation_id: Some(operation_id.clone()),
                })
                .collect(),
            refresh: refresh(
                target.depot_paths.clone(),
                "The outcome is uncertain; refresh all related state.",
            ),
        },
    }
}

fn file_result(
    path: String,
    result: Result<OperationResult, String>,
    operation_id: String,
) -> WorkflowFileResult {
    match result {
        Ok(operation) if operation.exit_code == 0 => WorkflowFileResult {
            depot_path: path,
            state: WorkflowFileState::Succeeded,
            message: "Resolve command completed; final state will be verified.".into(),
            operation_id: Some(operation_id),
        },
        Ok(operation)
            if operation
                .events
                .iter()
                .any(|event| matches!(event.kind, EventKind::Cancelled)) =>
        {
            WorkflowFileResult {
                depot_path: path,
                state: WorkflowFileState::Cancelled,
                message: "Resolve was cancelled.".into(),
                operation_id: Some(operation_id),
            }
        }
        Ok(_) => WorkflowFileResult {
            depot_path: path,
            state: WorkflowFileState::Failed,
            message: "The server rejected this resolve strategy.".into(),
            operation_id: Some(operation_id),
        },
        Err(_) => WorkflowFileResult {
            depot_path: path,
            state: WorkflowFileState::Unknown,
            message: "The resolve outcome is uncertain.".into(),
            operation_id: Some(operation_id),
        },
    }
}

fn result_from_files(
    files: Vec<WorkflowFileResult>,
    operation_ids: Vec<String>,
    target: &WorkflowTargetSnapshot,
    message: &str,
) -> WorkflowResult {
    let succeeded = files
        .iter()
        .filter(|file| file.state == WorkflowFileState::Succeeded)
        .count();
    let unknown = files
        .iter()
        .any(|file| file.state == WorkflowFileState::Unknown);
    let cancelled = files
        .iter()
        .any(|file| file.state == WorkflowFileState::Cancelled);
    let outcome = if succeeded == files.len() {
        WorkflowOutcome::Succeeded
    } else if succeeded > 0 {
        WorkflowOutcome::Partial
    } else if unknown {
        WorkflowOutcome::Unknown
    } else if cancelled {
        WorkflowOutcome::Cancelled
    } else {
        WorkflowOutcome::Failed
    };
    let failure = match outcome {
        WorkflowOutcome::Succeeded | WorkflowOutcome::Partial => None,
        WorkflowOutcome::Unknown => Some(WorkflowFailureCode::UncertainOutcome),
        WorkflowOutcome::Cancelled => Some(WorkflowFailureCode::Cancelled),
        _ => Some(WorkflowFailureCode::CommandFailure),
    };
    WorkflowResult {
        outcome,
        failure,
        message: message.into(),
        log_reference: operation_ids.first().cloned(),
        operation_ids,
        files,
        refresh: refresh(
            target.depot_paths.clone(),
            "Refresh conflict, opened-file and workspace status after Resolve.",
        ),
    }
}

fn refresh(paths: Vec<String>, reason: impl Into<String>) -> WorkflowRefreshAdvice {
    WorkflowRefreshAdvice {
        pending_changes: true,
        workspace_status: true,
        depot_paths: paths,
        reason: reason.into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn change() -> PendingChange {
        PendingChange {
            id: 7,
            description: "x".into(),
            user: "u".into(),
            client: "c".into(),
            status: "pending".into(),
            updated_at: None,
            jobs: Vec::new(),
            files: vec![PendingFile {
                depot_path: "//depot/a".into(),
                action: "edit".into(),
                state: Some("openedEdit".into()),
                client_path: Some("missing".into()),
                revision: Some(1),
                file_type: Some("text".into()),
            }],
            shelved_files: Vec::new(),
        }
    }

    #[test]
    fn shelf_requires_explicit_replace_and_unknown_resolve_stays_blocked() {
        let mut value = change();
        value.shelved_files = value.files.clone();
        let evaluation = evaluate_shelf(
            &ShelfPreflightRequest {
                change_id: 7,
                depot_paths: vec!["//depot/a".into()],
                mode: ShelfMode::CreateOrUpdate,
                replace: false,
            },
            ShelfInspection {
                change: Some(value),
                facts: vec![parser::WorkflowFileFact {
                    depot_path: "//depot/a".into(),
                    client_path: None,
                    action: "edit".into(),
                    change_id: Some(7),
                    have_revision: Some(1),
                    head_revision: Some(1),
                    file_type: "text".into(),
                    digest: "a".into(),
                    shelved_digest: "b".into(),
                    unresolved: 0,
                    other_open: 0,
                    other_lock: 0,
                }],
                shelf_facts: Vec::new(),
                permission: PermissionAssessment::Allowed,
                operation_ids: Vec::new(),
            },
        );
        assert!(evaluation
            .blockers
            .iter()
            .any(|item| item.code == WorkflowIssueCode::ExistingShelfRequiresReplace));
        let resolve = evaluate_resolve(
            &["//depot/a".into()],
            ResolveInspection {
                facts: Vec::new(),
                preview: Vec::new(),
                preview_succeeded: false,
                operation_ids: Vec::new(),
            },
        );
        assert!(!resolve.blockers.is_empty());
        assert_eq!(resolve.conflicts[0].status, "unknown");
    }
}
