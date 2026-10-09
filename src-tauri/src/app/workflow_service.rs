use crate::{
    app::{
        confirmation::{ConfirmationStore, ExpiringConfirmation},
        status_cache::{InvalidationReason, StatusCache, StatusQueryKind},
    },
    domain::*,
    p4::{
        context::ContextStore,
        workflows::{
            content_digest, local_content_facts, parser, MoveInspection, PermissionAssessment,
            ResolveInspection, ShelfInspection, UnshelveInspection, WorkflowRepository,
        },
    },
};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc,
};
use tauri::AppHandle;
use tokio::sync::Mutex as AsyncMutex;
use uuid::Uuid;

const DEFAULT_TOKEN_TTL_MS: u64 = 120_000;

#[derive(Clone)]
enum TokenPayload {
    Shelf(ShelfPreflightRequest),
    Unshelve(UnshelvePreflightRequest),
    Resolve(Vec<String>),
    Move(MoveFilesPreflightRequest),
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

#[derive(Clone)]
struct ShelfDetailSnapshot {
    query_fingerprint: String,
    connection_fingerprint: String,
    connection_generation: u64,
    shelf_generation: u64,
    detail: ShelfDetail,
    issued_cursors: HashMap<String, usize>,
    inserted_ms: i64,
    last_access: u64,
}

struct ShelfDetailSnapshotState {
    entries: HashMap<String, ShelfDetailSnapshot>,
    access_clock: u64,
}

pub struct WorkflowService {
    repository: WorkflowRepository,
    contexts: Arc<ContextStore>,
    status_cache: Arc<StatusCache>,
    tokens: ConfirmationStore<TokenRecord>,
    confirmation_gate: AsyncMutex<()>,
    ttl_ms: u64,
    shelf_details: parking_lot::Mutex<ShelfDetailSnapshotState>,
    shelf_generation: AtomicU64,
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
            shelf_details: parking_lot::Mutex::new(ShelfDetailSnapshotState {
                entries: HashMap::new(),
                access_clock: 0,
            }),
            shelf_generation: AtomicU64::new(1),
        }
    }

    pub fn clear_confirmations(&self) {
        self.tokens.clear();
    }

    pub fn clear_shelf_details(&self) {
        self.shelf_details.lock().entries.clear();
        self.shelf_generation.fetch_add(1, Ordering::SeqCst);
    }

    pub async fn shelf_detail(
        &self,
        request: ShelfDetailRequest,
        app: Option<&AppHandle>,
    ) -> Result<ShelfDetail, ShelfDetailRequestError> {
        const MAX_FILES: usize = 10_000;
        const CACHE_TTL_MS: i64 = 30_000;
        const SNAPSHOT_TTL_MS: i64 = 120_000;
        const SNAPSHOT_CAPACITY: usize = 32;
        if request.change_id <= 0 {
            return Err(shelf_detail_error(
                ShelfDetailRequestErrorCode::InvalidQuery,
                "A numbered shelved changelist is required; Default cannot own a shelf.",
            ));
        }
        if !(1..=500).contains(&request.page_size) {
            return Err(shelf_detail_error(
                ShelfDetailRequestErrorCode::InvalidQuery,
                "Shelf detail pageSize must be between 1 and 500.",
            ));
        }
        if request.refresh && request.cursor.is_some() {
            return Err(shelf_detail_error(
                ShelfDetailRequestErrorCode::InvalidQuery,
                "A refreshed shelf query must start without a cursor.",
            ));
        }
        let (context, generation) = self.contexts.snapshot();
        let profile = self.contexts.active_profile_id();
        if request.refresh {
            self.clear_shelf_details();
        }
        let shelf_generation = self.shelf_generation.load(Ordering::SeqCst);
        let connection_fingerprint = crate::p4::query::fingerprint(&(profile.clone(), &context))
            .map_err(|message| {
                shelf_detail_error(ShelfDetailRequestErrorCode::InvalidQuery, message)
            })?;
        let query_fingerprint =
            crate::p4::query::fingerprint(&(request.change_id, request.page_size)).map_err(
                |message| shelf_detail_error(ShelfDetailRequestErrorCode::InvalidQuery, message),
            )?;

        if let Some(cursor) = request.cursor.as_deref() {
            use crate::p4::query::ShelfDetailCursorError;
            let boundary = crate::p4::query::decode_shelf_detail_cursor(
                cursor,
                &query_fingerprint,
                &connection_fingerprint,
                generation,
                shelf_generation,
            )
            .map_err(|error| match error {
                ShelfDetailCursorError::ConnectionMismatch => shelf_detail_error(
                    ShelfDetailRequestErrorCode::ConnectionChanged,
                    "The shelf cursor belongs to another connection or profile.",
                ),
                ShelfDetailCursorError::GenerationMismatch => shelf_detail_error(
                    ShelfDetailRequestErrorCode::SnapshotChanged,
                    "The shelf data generation changed; refresh from the first page.",
                ),
                ShelfDetailCursorError::Invalid | ShelfDetailCursorError::QueryMismatch => {
                    shelf_detail_error(
                        ShelfDetailRequestErrorCode::InvalidCursor,
                        "The shelf cursor is invalid or belongs to another query.",
                    )
                }
            })?;
            return self.page_shelf_snapshot(
                &boundary.snapshot_id,
                Some(&boundary.cursor_id),
                boundary.offset,
                &request,
                &query_fingerprint,
                &connection_fingerprint,
                generation,
                shelf_generation,
                "cached",
                SNAPSHOT_TTL_MS,
            );
        }

        if !request.refresh {
            let now = now_ms();
            let reusable = {
                let mut state = self.shelf_details.lock();
                state.entries.retain(|_, snapshot| {
                    now.saturating_sub(snapshot.inserted_ms) <= SNAPSHOT_TTL_MS
                });
                state
                    .entries
                    .iter()
                    .filter(|(_, snapshot)| {
                        now.saturating_sub(snapshot.inserted_ms) <= CACHE_TTL_MS
                            && snapshot.query_fingerprint == query_fingerprint
                            && snapshot.connection_fingerprint == connection_fingerprint
                            && snapshot.connection_generation == generation
                            && snapshot.shelf_generation == shelf_generation
                    })
                    .max_by_key(|(_, snapshot)| snapshot.inserted_ms)
                    .map(|(id, _)| id.clone())
            };
            if let Some(snapshot_id) = reusable {
                return self.page_shelf_snapshot(
                    &snapshot_id,
                    None,
                    0,
                    &request,
                    &query_fingerprint,
                    &connection_fingerprint,
                    generation,
                    shelf_generation,
                    "cached",
                    SNAPSHOT_TTL_MS,
                );
            }
        }

        let operation_id = request
            .operation_id
            .clone()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| format!("shelf-detail-{}", Uuid::new_v4()));
        let operation = self.repository.begin_operation_group(operation_id.clone());
        let inspection = self
            .repository
            .shelf_detail(&context, request.change_id, &operation_id, app)
            .await
            .map_err(|message| {
                let code = if message.to_ascii_lowercase().contains("cancel") {
                    ShelfDetailRequestErrorCode::Cancelled
                } else {
                    ShelfDetailRequestErrorCode::QueryFailed
                };
                shelf_detail_error(code, message)
            })?;
        operation.ensure_active().map_err(|message| {
            shelf_detail_error(ShelfDetailRequestErrorCode::Cancelled, message)
        })?;
        let (current, current_generation) = self.contexts.snapshot();
        if current != context
            || current_generation != generation
            || self.contexts.active_profile_id() != profile
        {
            return Err(shelf_detail_error(
                ShelfDetailRequestErrorCode::ConnectionChanged,
                "The connection or profile changed while the shelf was loading.",
            ));
        }
        if self.shelf_generation.load(Ordering::SeqCst) != shelf_generation {
            return Err(shelf_detail_error(
                ShelfDetailRequestErrorCode::SnapshotChanged,
                "The shelf changed while its snapshot was loading; refresh and retry.",
            ));
        }
        let total_files = inspection.detail.files.len();
        let truncated = total_files > MAX_FILES;
        let mut files = inspection.detail.files;
        files.truncate(MAX_FILES);
        let detail = ShelfDetail {
            request_generation: request.request_generation,
            scope: ShelfDetailScope {
                server: context.server,
                user: context.user,
                client: context.client,
                workspace: context.cwd.unwrap_or_default(),
                active_profile_id: profile,
                context_generation: generation,
                change_id: request.change_id,
            },
            description: inspection.detail.description,
            time: inspection.detail.time,
            owner: inspection.detail.owner,
            user: inspection.detail.user,
            client: inspection.detail.client,
            jobs: inspection.detail.jobs,
            files,
            total_files,
            has_more: false,
            next_cursor: None,
            truncated,
            inspection_status: if truncated {
                ShelfInspectionStatus::Partial
            } else {
                inspection.detail.inspection_status
            },
            message: if truncated {
                Some("Shelf file list reached the 10,000-file safety limit.".into())
            } else {
                inspection.detail.message
            },
            operation_ids: inspection.operation_ids,
            cache_freshness: "fresh".into(),
        };
        operation.ensure_active().map_err(|message| {
            shelf_detail_error(ShelfDetailRequestErrorCode::Cancelled, message)
        })?;
        let snapshot_id = Uuid::new_v4().to_string();
        {
            let mut state = self.shelf_details.lock();
            state.access_clock = state.access_clock.saturating_add(1);
            let access = state.access_clock;
            state.entries.insert(
                snapshot_id.clone(),
                ShelfDetailSnapshot {
                    query_fingerprint: query_fingerprint.clone(),
                    connection_fingerprint: connection_fingerprint.clone(),
                    connection_generation: generation,
                    shelf_generation,
                    detail,
                    issued_cursors: HashMap::new(),
                    inserted_ms: now_ms(),
                    last_access: access,
                },
            );
            while state.entries.len() > SNAPSHOT_CAPACITY {
                let Some(oldest) = state
                    .entries
                    .iter()
                    .min_by_key(|(_, snapshot)| snapshot.last_access)
                    .map(|(id, _)| id.clone())
                else {
                    break;
                };
                state.entries.remove(&oldest);
            }
        }
        self.page_shelf_snapshot(
            &snapshot_id,
            None,
            0,
            &request,
            &query_fingerprint,
            &connection_fingerprint,
            generation,
            shelf_generation,
            "fresh",
            SNAPSHOT_TTL_MS,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn page_shelf_snapshot(
        &self,
        snapshot_id: &str,
        presented_cursor_id: Option<&str>,
        offset: usize,
        request: &ShelfDetailRequest,
        query_fingerprint: &str,
        connection_fingerprint: &str,
        connection_generation: u64,
        shelf_generation: u64,
        freshness: &str,
        snapshot_ttl_ms: i64,
    ) -> Result<ShelfDetail, ShelfDetailRequestError> {
        let now = now_ms();
        let mut state = self.shelf_details.lock();
        state
            .entries
            .retain(|_, snapshot| now.saturating_sub(snapshot.inserted_ms) <= snapshot_ttl_ms);
        state.access_clock = state.access_clock.saturating_add(1);
        let access = state.access_clock;
        let snapshot = state.entries.get_mut(snapshot_id).ok_or_else(|| {
            shelf_detail_error(
                ShelfDetailRequestErrorCode::CursorExpired,
                "The shelf cursor expired; refresh from the first page.",
            )
        })?;
        if snapshot.query_fingerprint != query_fingerprint
            || snapshot.connection_fingerprint != connection_fingerprint
            || snapshot.connection_generation != connection_generation
            || snapshot.shelf_generation != shelf_generation
        {
            return Err(shelf_detail_error(
                ShelfDetailRequestErrorCode::SnapshotChanged,
                "The shelf snapshot no longer matches this query or connection.",
            ));
        }
        if let Some(cursor_id) = presented_cursor_id {
            if snapshot.issued_cursors.remove(cursor_id) != Some(offset) {
                return Err(shelf_detail_error(
                    ShelfDetailRequestErrorCode::InvalidCursor,
                    "The shelf cursor was not issued by this server, was altered, or has already been used.",
                ));
            }
        }
        snapshot.last_access = access;
        if offset > snapshot.detail.files.len()
            || (offset > 0 && offset == snapshot.detail.files.len())
        {
            return Err(shelf_detail_error(
                ShelfDetailRequestErrorCode::InvalidCursor,
                "The shelf cursor points outside the result snapshot.",
            ));
        }
        let end = offset
            .saturating_add(request.page_size)
            .min(snapshot.detail.files.len());
        let files = snapshot.detail.files[offset..end].to_vec();
        let has_more = end < snapshot.detail.files.len();
        let next_cursor = if has_more {
            let cursor_id = Uuid::new_v4().to_string();
            let cursor = crate::p4::query::encode_shelf_detail_cursor(
                snapshot_id,
                &cursor_id,
                end,
                query_fingerprint,
                connection_fingerprint,
                connection_generation,
                shelf_generation,
            )
            .map_err(|message| {
                shelf_detail_error(ShelfDetailRequestErrorCode::InvalidCursor, message)
            })?;
            snapshot.issued_cursors.insert(cursor_id, end);
            Some(cursor)
        } else {
            None
        };
        let mut detail = snapshot.detail.clone();
        detail.request_generation = request.request_generation;
        detail.files = files;
        detail.has_more = has_more;
        detail.next_cursor = next_cursor;
        detail.cache_freshness = freshness.into();
        Ok(detail)
    }

    pub async fn preflight_move(
        &self,
        mut request: MoveFilesPreflightRequest,
        app: Option<&AppHandle>,
    ) -> MoveFilesPreflight {
        request.depot_paths = normalized_paths(request.depot_paths);
        let (context, generation) = self.contexts.snapshot();
        let snapshot = target(
            "move",
            &context,
            generation,
            None,
            Some(request.target_change_id),
            request.depot_paths.clone(),
        );
        let inspected = self
            .repository
            .inspect_move(
                &context,
                &request.depot_paths,
                request.operation_id.as_deref().unwrap_or("move-preflight"),
                app,
            )
            .await;
        let (files, blockers, warnings, digest, operation_ids) = match inspected {
            Ok(value) => evaluate_move(&request, value),
            Err(error) => (
                request
                    .depot_paths
                    .iter()
                    .map(|path| MoveFileCandidate {
                        depot_path: path.clone(),
                        source_change_id: None,
                        action: String::new(),
                        movable: false,
                        message: Some(error.clone()),
                    })
                    .collect(),
                vec![issue(
                    WorkflowIssueCode::InspectionUnknown,
                    WorkflowIssueCertainty::Unknown,
                    "Move preflight could not obtain a reliable server snapshot.",
                    request.depot_paths.clone(),
                )],
                Vec::new(),
                content_digest(&request),
                Vec::new(),
            ),
        };
        let ready =
            blockers.is_empty() && !files.is_empty() && files.iter().all(|file| file.movable);
        let expires_at = now_ms().saturating_add(self.ttl_ms as i64);
        let token = ready.then(|| {
            self.tokens.issue(
                TokenRecord {
                    target: snapshot.clone(),
                    content_digest: digest.clone(),
                    expires_at,
                    payload: TokenPayload::Move(request),
                },
                now_ms(),
            )
        });
        MoveFilesPreflight {
            ready,
            target: snapshot,
            files,
            blockers,
            warnings,
            content_digest: digest,
            token,
            expires_at,
            ttl_ms: self.ttl_ms,
            log_reference: operation_ids.first().cloned(),
            operation_ids,
        }
    }

    pub async fn confirm_move(
        &self,
        confirmation: WorkflowConfirmation,
        app: Option<&AppHandle>,
    ) -> MoveFilesResult {
        let _gate = self.confirmation_gate.lock().await;
        let record = match self.consume(&confirmation, "move") {
            Ok(record) => record,
            Err(result) => return rejected_move(*result),
        };
        let TokenPayload::Move(request) = record.payload else {
            return rejected_move(rejected(
                &confirmation.target,
                WorkflowFailureCode::TargetMismatch,
                "The token belongs to another workflow.",
            ));
        };
        let (context, generation) = self.contexts.snapshot();
        if target(
            "move",
            &context,
            generation,
            None,
            Some(request.target_change_id),
            request.depot_paths.clone(),
        ) != record.target
        {
            return rejected_move(rejected(
                &record.target,
                WorkflowFailureCode::ContextChanged,
                "The connection or workspace changed after preflight.",
            ));
        }
        let guard = self.repository.lock_mutations(&context.server).await;
        let inspected = self
            .repository
            .inspect_move(&context, &request.depot_paths, "move-recheck", app)
            .await;
        let Ok(inspected) = inspected else {
            return rejected_move(rejected(
                &record.target,
                WorkflowFailureCode::PreflightBlocked,
                "The move snapshot could not be revalidated safely.",
            ));
        };
        let (candidates, blockers, _, digest, mut operation_ids) =
            evaluate_move(&request, inspected);
        if !blockers.is_empty()
            || digest != record.content_digest
            || !same_active_context(&self.contexts, &record.target)
        {
            return rejected_move(rejected(
                &record.target,
                if digest != record.content_digest {
                    WorkflowFailureCode::ContentChanged
                } else {
                    WorkflowFailureCode::PreflightBlocked
                },
                "Opened files or target changelist changed after preflight.",
            ));
        }
        let root_id = valid_operation_id(confirmation.operation_id);
        let mut files = Vec::new();
        let mut cancelled = false;
        for (index, candidate) in candidates.iter().enumerate() {
            let operation_id = format!("{root_id}:{}", index + 1);
            if cancelled {
                files.push(WorkflowFileResult {
                    depot_path: candidate.depot_path.clone(),
                    state: WorkflowFileState::Cancelled,
                    message: "Move batch was cancelled before this file ran.".into(),
                    operation_id: None,
                });
                continue;
            }
            let result = self
                .repository
                .execute_reopen(
                    &context,
                    request.target_change_id,
                    &candidate.depot_path,
                    operation_id.clone(),
                    &guard,
                    app,
                )
                .await;
            let item =
                reopen_file_result(candidate.depot_path.clone(), result, operation_id.clone());
            cancelled = item.state == WorkflowFileState::Cancelled;
            operation_ids.push(operation_id);
            files.push(item);
        }
        let mut affected_changes = candidates
            .iter()
            .filter_map(|candidate| candidate.source_change_id)
            .collect::<BTreeSet<_>>();
        affected_changes.insert(request.target_change_id);
        let (after, refresh_error) =
            match self.repository.pending_snapshot(context.clone(), app).await {
                Ok(changes) => (changes, None),
                Err(error) => (Vec::new(), Some(error)),
            };
        if refresh_error.is_none() {
            for file in &mut files {
                if file.state != WorkflowFileState::Succeeded {
                    continue;
                }
                let verified = after
                    .iter()
                    .find(|change| change.id == request.target_change_id)
                    .is_some_and(|change| {
                        change
                            .files
                            .iter()
                            .any(|item| item.depot_path == file.depot_path)
                    });
                if !verified {
                    file.state = WorkflowFileState::Unknown;
                    file.message = "p4 reopen succeeded, but the final target changelist could not be verified.".into();
                }
            }
        }
        self.invalidate(
            &context,
            &request.depot_paths,
            InvalidationReason::ChangelistMutation,
        );
        let succeeded = files
            .iter()
            .filter(|file| file.state == WorkflowFileState::Succeeded)
            .count();
        let failed = files.len().saturating_sub(succeeded);
        let outcome = if succeeded == files.len() && refresh_error.is_none() {
            WorkflowOutcome::Succeeded
        } else if succeeded > 0 {
            WorkflowOutcome::Partial
        } else if cancelled {
            WorkflowOutcome::Cancelled
        } else {
            WorkflowOutcome::Failed
        };
        let affected_changes = affected_changes.into_iter().collect::<Vec<_>>();
        let refreshed_changes = after
            .into_iter()
            .filter(|change| affected_changes.contains(&change.id))
            .collect();
        MoveFilesResult {
            outcome,
            failure: (outcome != WorkflowOutcome::Succeeded).then_some(if cancelled {
                WorkflowFailureCode::Cancelled
            } else {
                WorkflowFailureCode::CommandFailure
            }),
            message: format!(
                "Moved {succeeded} file(s); {failed} file(s) were not confirmed moved."
            ),
            log_reference: operation_ids.first().cloned(),
            operation_ids,
            files,
            affected_changes,
            refreshed_changes,
            refresh_error,
            refresh: refresh(
                request.depot_paths,
                "Refresh only the affected source and target changelists and workspace status.",
            ),
        }
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
        self.clear_shelf_details();
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

fn shelf_detail_error(
    code: ShelfDetailRequestErrorCode,
    message: impl Into<String>,
) -> ShelfDetailRequestError {
    ShelfDetailRequestError {
        code,
        message: message.into(),
    }
}

fn evaluate_move(
    request: &MoveFilesPreflightRequest,
    inspection: MoveInspection,
) -> (
    Vec<MoveFileCandidate>,
    Vec<WorkflowIssue>,
    Vec<WorkflowIssue>,
    String,
    Vec<String>,
) {
    let mut blockers = Vec::new();
    let warnings = Vec::new();
    let target_exists = request.target_change_id == 0
        || inspection
            .changes
            .iter()
            .any(|change| change.id == request.target_change_id && change.status == "pending");
    if request.target_change_id < 0 || !target_exists {
        blockers.push(issue(
            WorkflowIssueCode::ChangeNotFound,
            WorkflowIssueCertainty::Confirmed,
            "The target changelist is not pending in the current user/client scope.",
            request.depot_paths.clone(),
        ));
    }
    if request.depot_paths.is_empty() {
        blockers.push(issue(
            WorkflowIssueCode::FileNotInChange,
            WorkflowIssueCertainty::Confirmed,
            "No opened files were selected.",
            Vec::new(),
        ));
    }
    let facts = inspection
        .facts
        .iter()
        .map(|fact| (fact.depot_path.as_str(), fact))
        .collect::<BTreeMap<_, _>>();
    let mut candidates = Vec::new();
    for path in &request.depot_paths {
        let source = inspection
            .changes
            .iter()
            .find(|change| change.files.iter().any(|file| file.depot_path == *path));
        let file = source.and_then(|change| {
            change
                .files
                .iter()
                .find(|file| file.depot_path == *path)
                .map(|file| (change.id, file))
        });
        let fact = facts.get(path.as_str()).copied();
        let message: Option<String> = if file.is_none() {
            Some("The file is not opened by the current user and workspace.".into())
        } else if source.is_some_and(|change| change.id == request.target_change_id) {
            Some("The file is already in the target changelist.".into())
        } else if fact.is_some_and(|fact| fact.other_lock > 0 || fact.our_lock > 0) {
            Some("The file is locked and cannot be moved safely.".into())
        } else {
            None
        };
        if let Some(message) = &message {
            blockers.push(issue(
                if message.contains("locked") {
                    WorkflowIssueCode::LockedFile
                } else {
                    WorkflowIssueCode::FileNotInChange
                },
                WorkflowIssueCertainty::Confirmed,
                message.clone(),
                vec![path.clone()],
            ));
        }
        candidates.push(MoveFileCandidate {
            depot_path: path.clone(),
            source_change_id: file.map(|(change_id, _)| change_id),
            action: file
                .map(|(_, file)| file.action.clone())
                .unwrap_or_default(),
            movable: message.is_none() && target_exists,
            message,
        });
    }
    let digest = content_digest(&(
        request,
        &candidates,
        inspection
            .changes
            .iter()
            .filter(|change| {
                change.id == request.target_change_id
                    || candidates
                        .iter()
                        .any(|candidate| candidate.source_change_id == Some(change.id))
            })
            .collect::<Vec<_>>(),
        &inspection.facts,
    ));
    (
        candidates,
        blockers,
        warnings,
        digest,
        inspection.operation_ids,
    )
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

fn rejected_move(result: WorkflowResult) -> MoveFilesResult {
    MoveFilesResult {
        outcome: result.outcome,
        failure: result.failure,
        message: result.message,
        operation_ids: result.operation_ids,
        log_reference: result.log_reference,
        files: result.files,
        affected_changes: Vec::new(),
        refreshed_changes: Vec::new(),
        refresh_error: None,
        refresh: result.refresh,
    }
}

fn reopen_file_result(
    path: String,
    result: Result<OperationResult, String>,
    operation_id: String,
) -> WorkflowFileResult {
    match result {
        Ok(operation) if operation.exit_code == 0 => WorkflowFileResult {
            depot_path: path,
            state: WorkflowFileState::Succeeded,
            message: "File moved; final changelist membership will be verified.".into(),
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
                message: "Move was cancelled.".into(),
                operation_id: Some(operation_id),
            }
        }
        Ok(_) => WorkflowFileResult {
            depot_path: path,
            state: WorkflowFileState::Failed,
            message: "The server rejected this file move; it remains in its source changelist."
                .into(),
            operation_id: Some(operation_id),
        },
        Err(error) => WorkflowFileResult {
            depot_path: path,
            state: if error.to_ascii_lowercase().contains("cancel") {
                WorkflowFileState::Cancelled
            } else {
                WorkflowFileState::Unknown
            },
            message: format!("Move outcome is not confirmed: {error}"),
            operation_id: Some(operation_id),
        },
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

    fn shelf_test_service() -> (WorkflowService, std::path::PathBuf) {
        let directory = std::env::temp_dir().join(format!(
            "p4deck-shelf-cursor-{}-{}",
            std::process::id(),
            Uuid::new_v4()
        ));
        std::fs::create_dir_all(&directory).unwrap();
        let logs = Arc::new(
            crate::persistence::log_store::LogStore::open(&directory.join("logs.sqlite")).unwrap(),
        );
        let journal = Arc::new(
            crate::persistence::operation_journal::OperationJournal::open(
                &directory.join("operations.sqlite"),
            )
            .unwrap(),
        );
        let runner = Arc::new(crate::p4::runner::P4Runner::new(logs, journal));
        let contexts = Arc::new(crate::p4::context::ContextStore::load(&directory).unwrap());
        (
            WorkflowService::new(
                WorkflowRepository::new(runner),
                contexts,
                crate::app::status_cache::shared_default(),
            ),
            directory,
        )
    }

    fn shelf_detail_with_files(count: usize) -> ShelfDetail {
        ShelfDetail {
            request_generation: 1,
            scope: ShelfDetailScope {
                server: "server:1666".into(),
                user: "user".into(),
                client: "client".into(),
                workspace: "/workspace".into(),
                active_profile_id: Some("profile".into()),
                context_generation: 7,
                change_id: 42,
            },
            description: "large shelf".into(),
            time: "2026-10-09T00:00:00Z".into(),
            owner: "user".into(),
            user: "user".into(),
            client: "client".into(),
            jobs: Vec::new(),
            files: (0..count)
                .map(|index| ShelfDetailFile {
                    depot_path: format!("//depot/file-{index:05}.txt"),
                    action: "edit".into(),
                    revision: Some(1),
                    file_type: Some("text".into()),
                    size: Some(1),
                    digest: Some(format!("digest-{index}")),
                    binary: false,
                    symlink: false,
                    deleted: false,
                })
                .collect(),
            total_files: count,
            has_more: false,
            next_cursor: None,
            truncated: false,
            inspection_status: ShelfInspectionStatus::Complete,
            message: None,
            operation_ids: vec!["test".into()],
            cache_freshness: "fresh".into(),
        }
    }

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
    fn shelf_snapshot_pages_more_than_500_without_duplicates_and_rejects_replay() {
        let (service, directory) = shelf_test_service();
        let snapshot_id = "snapshot-large";
        let query_fingerprint = "query";
        let connection_fingerprint = "connection";
        let generation = 7;
        let shelf_generation = service.shelf_generation.load(Ordering::SeqCst);
        service.shelf_details.lock().entries.insert(
            snapshot_id.into(),
            ShelfDetailSnapshot {
                query_fingerprint: query_fingerprint.into(),
                connection_fingerprint: connection_fingerprint.into(),
                connection_generation: generation,
                shelf_generation,
                detail: shelf_detail_with_files(1_201),
                issued_cursors: HashMap::new(),
                inserted_ms: now_ms(),
                last_access: 1,
            },
        );
        let request = ShelfDetailRequest {
            change_id: 42,
            request_generation: 11,
            page_size: 500,
            cursor: None,
            refresh: false,
            operation_id: None,
        };
        let first = service
            .page_shelf_snapshot(
                snapshot_id,
                None,
                0,
                &request,
                query_fingerprint,
                connection_fingerprint,
                generation,
                shelf_generation,
                "fresh",
                120_000,
            )
            .unwrap();
        assert_eq!(first.files.len(), 500);
        assert_eq!(first.request_generation, 11);
        let first_cursor = first.next_cursor.unwrap();
        let boundary = crate::p4::query::decode_shelf_detail_cursor(
            &first_cursor,
            query_fingerprint,
            connection_fingerprint,
            generation,
            shelf_generation,
        )
        .unwrap();
        let altered = service
            .page_shelf_snapshot(
                &boundary.snapshot_id,
                Some(&boundary.cursor_id),
                boundary.offset + 1,
                &request,
                query_fingerprint,
                connection_fingerprint,
                generation,
                shelf_generation,
                "cached",
                120_000,
            )
            .unwrap_err();
        assert_eq!(altered.code, ShelfDetailRequestErrorCode::InvalidCursor);
        let retry_first = service
            .page_shelf_snapshot(
                snapshot_id,
                None,
                0,
                &request,
                query_fingerprint,
                connection_fingerprint,
                generation,
                shelf_generation,
                "cached",
                120_000,
            )
            .unwrap();
        let first_cursor = retry_first.next_cursor.unwrap();
        let boundary = crate::p4::query::decode_shelf_detail_cursor(
            &first_cursor,
            query_fingerprint,
            connection_fingerprint,
            generation,
            shelf_generation,
        )
        .unwrap();
        let second = service
            .page_shelf_snapshot(
                &boundary.snapshot_id,
                Some(&boundary.cursor_id),
                boundary.offset,
                &request,
                query_fingerprint,
                connection_fingerprint,
                generation,
                shelf_generation,
                "cached",
                120_000,
            )
            .unwrap();
        assert_eq!(second.files.len(), 500);
        assert_ne!(first.files.last(), second.files.first());
        let replay = service
            .page_shelf_snapshot(
                &boundary.snapshot_id,
                Some(&boundary.cursor_id),
                boundary.offset,
                &request,
                query_fingerprint,
                connection_fingerprint,
                generation,
                shelf_generation,
                "cached",
                120_000,
            )
            .unwrap_err();
        assert_eq!(replay.code, ShelfDetailRequestErrorCode::InvalidCursor);
        drop(service);
        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn shelf_snapshot_reports_expiry_and_generation_drift() {
        let (service, directory) = shelf_test_service();
        let shelf_generation = service.shelf_generation.load(Ordering::SeqCst);
        service.shelf_details.lock().entries.insert(
            "snapshot".into(),
            ShelfDetailSnapshot {
                query_fingerprint: "query".into(),
                connection_fingerprint: "connection".into(),
                connection_generation: 7,
                shelf_generation,
                detail: shelf_detail_with_files(2),
                issued_cursors: HashMap::new(),
                inserted_ms: now_ms(),
                last_access: 1,
            },
        );
        let request = ShelfDetailRequest {
            change_id: 42,
            request_generation: 1,
            page_size: 1,
            cursor: None,
            refresh: false,
            operation_id: None,
        };
        let drift = service
            .page_shelf_snapshot(
                "snapshot",
                None,
                0,
                &request,
                "query",
                "connection",
                8,
                shelf_generation,
                "cached",
                120_000,
            )
            .unwrap_err();
        assert_eq!(drift.code, ShelfDetailRequestErrorCode::SnapshotChanged);
        let expired = service
            .page_shelf_snapshot(
                "snapshot",
                None,
                0,
                &request,
                "query",
                "connection",
                7,
                shelf_generation,
                "cached",
                -1,
            )
            .unwrap_err();
        assert_eq!(expired.code, ShelfDetailRequestErrorCode::CursorExpired);
        let previous = shelf_generation;
        service.clear_shelf_details();
        assert!(service.shelf_generation.load(Ordering::SeqCst) > previous);
        drop(service);
        let _ = std::fs::remove_dir_all(directory);
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
                    size: Some(1),
                    shelved_size: Some(1),
                    shelved_type: Some("text".into()),
                    unresolved: 0,
                    other_open: 0,
                    other_lock: 0,
                    our_lock: 0,
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

    #[test]
    fn move_preflight_tracks_source_target_and_blocks_unopened_locked_and_same_target() {
        let default = PendingChange {
            id: 0,
            files: vec![PendingFile {
                depot_path: "//depot/default.txt".into(),
                action: "edit".into(),
                state: None,
                client_path: None,
                revision: Some(1),
                file_type: Some("text".into()),
            }],
            ..change()
        };
        let request = MoveFilesPreflightRequest {
            target_change_id: 7,
            depot_paths: vec!["//depot/default.txt".into()],
            operation_id: None,
        };
        let fact = parser::WorkflowFileFact {
            depot_path: "//depot/default.txt".into(),
            client_path: None,
            action: "edit".into(),
            change_id: Some(0),
            have_revision: Some(1),
            head_revision: Some(1),
            file_type: "text".into(),
            digest: "a".into(),
            shelved_digest: String::new(),
            size: Some(1),
            shelved_size: None,
            shelved_type: None,
            unresolved: 0,
            other_open: 0,
            other_lock: 0,
            our_lock: 0,
        };
        let (files, blockers, _, _, _) = evaluate_move(
            &request,
            MoveInspection {
                changes: vec![default.clone(), change()],
                facts: vec![fact.clone()],
                operation_ids: vec!["inspect".into()],
            },
        );
        assert!(blockers.is_empty());
        assert_eq!(files[0].source_change_id, Some(0));
        assert!(files[0].movable);

        let mut locked = fact;
        locked.other_lock = 1;
        let (_, blockers, _, _, _) = evaluate_move(
            &request,
            MoveInspection {
                changes: vec![default, change()],
                facts: vec![locked],
                operation_ids: Vec::new(),
            },
        );
        assert!(blockers
            .iter()
            .any(|issue| issue.code == WorkflowIssueCode::LockedFile));

        let (_, blockers, _, _, _) = evaluate_move(
            &MoveFilesPreflightRequest {
                target_change_id: 7,
                depot_paths: vec!["//depot/missing".into()],
                operation_id: None,
            },
            MoveInspection {
                changes: vec![change()],
                facts: Vec::new(),
                operation_ids: Vec::new(),
            },
        );
        assert!(blockers
            .iter()
            .any(|issue| issue.code == WorkflowIssueCode::FileNotInChange));
    }
}
