use crate::{
    app::{
        confirmation::{ConfirmationStore, ConfirmationTicket, IssuedConfirmation},
        external_merge, manual_merge,
        status_cache::{InvalidationReason, StatusCache, StatusQueryKind},
    },
    domain::*,
    p4::{
        context::ContextStore,
        workflows::{
            content_digest, local_content_facts, parser, resolve_stats as resolve_stats_math,
            MoveInspection, PermissionAssessment, ResolveInspection, ShelfInspection,
            UnshelveInspection, WorkflowRepository,
        },
    },
};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::Path;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc,
};
use tauri::AppHandle;
use tokio::sync::Mutex as AsyncMutex;
use uuid::Uuid;

const DEFAULT_TOKEN_TTL_MS: u64 = 120_000;

#[derive(Clone)]
struct ResolveTokenPayload {
    paths: Vec<String>,
    /// `p4 resolve -f`: the token is only valid for a force re-resolve.
    force: bool,
}

#[derive(Clone)]
enum TokenPayload {
    Shelf(ShelfPreflightRequest),
    Unshelve(UnshelvePreflightRequest),
    Resolve(ResolveTokenPayload),
    Move(MoveFilesPreflightRequest),
}

/// What a workflow confirmation binds on top of its target snapshot.
///
/// It rides in the shared [`IssuedConfirmation`] digest slot: same one-time
/// token, same TTL pruning, but the workflow still needs to know which family
/// and which validated request produced the token.
#[derive(Clone)]
struct ReviewPayload {
    content_digest: String,
    payload: TokenPayload,
}

type TokenRecord = IssuedConfirmation<WorkflowTargetSnapshot, ReviewPayload>;

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
struct ManualMergeSessionRecord {
    session: ManualMergeSession,
    active_profile_id: Option<String>,
}

/// A saved manual-merge result waiting for its CAS-protected write.
type ManualMergeSaveRecord = IssuedConfirmation<ManualMergeSaveTarget, ManualMergeSavePayload>;

#[derive(Clone, PartialEq, Eq)]
struct ManualMergeSaveTarget {
    session_id: String,
}

#[derive(Clone)]
struct ManualMergeSavePayload {
    result_digest: String,
    bytes: Vec<u8>,
}

/// A saved manual-merge result waiting to be marked resolved.
type ManualMergeResolveRecord =
    IssuedConfirmation<ManualMergeResolveTarget, ManualMergeResolvePayload>;

#[derive(Clone, PartialEq, Eq)]
struct ManualMergeResolveTarget {
    session_id: String,
    result_digest: String,
}

#[derive(Clone)]
struct ManualMergeResolvePayload {
    file_snapshot: ManualMergeFileSnapshot,
    resolve_digest: String,
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
    tickets: ConfirmationTicket<WorkflowTargetSnapshot, ReviewPayload>,
    confirmation_gate: AsyncMutex<()>,
    ttl_ms: u64,
    shelf_details: parking_lot::Mutex<ShelfDetailSnapshotState>,
    shelf_generation: AtomicU64,
    manual_merge_sessions: parking_lot::Mutex<HashMap<String, ManualMergeSessionRecord>>,
    manual_merge_saves: ConfirmationStore<ManualMergeSaveRecord>,
    manual_merge_resolves: ConfirmationStore<ManualMergeResolveRecord>,
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
            tickets: ConfirmationTicket::new(ttl_ms),
            confirmation_gate: AsyncMutex::new(()),
            ttl_ms: ttl_ms.max(1),
            shelf_details: parking_lot::Mutex::new(ShelfDetailSnapshotState {
                entries: HashMap::new(),
                access_clock: 0,
            }),
            shelf_generation: AtomicU64::new(1),
            manual_merge_sessions: parking_lot::Mutex::new(HashMap::new()),
            manual_merge_saves: ConfirmationStore::default(),
            manual_merge_resolves: ConfirmationStore::default(),
        }
    }

    pub fn clear_confirmations(&self) {
        // Blocking clear: await it so a context switch serialises against
        // any in-flight confirmation of this family.
        tauri::async_runtime::block_on(self.tickets.clear());
        self.manual_merge_sessions.lock().clear();
        self.manual_merge_saves.clear();
        self.manual_merge_resolves.clear();
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
            self.tickets.issue_review(IssuedConfirmation::new(
                snapshot.clone(),
                ReviewPayload {
                    content_digest: digest.clone(),
                    payload: TokenPayload::Move(request),
                },
                expires_at,
            ))
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
        let TokenPayload::Move(request) = record.digest.payload else {
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
            || digest != record.digest.content_digest
            || !same_active_context(&self.contexts, &record.target)
        {
            return rejected_move(rejected(
                &record.target,
                if digest != record.digest.content_digest {
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
                request.mode,
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
            self.tickets.issue_review(IssuedConfirmation::new(
                target.clone(),
                ReviewPayload {
                    content_digest: evaluation.digest.clone(),
                    payload: TokenPayload::Shelf(request),
                },
                expires_at,
            ))
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

    /// Compatibility entry used only by the feature-gated e2e harness.
    /// Production IPC uses `confirm_shelf_admitted` with the unified lane/lease.
    #[allow(dead_code)]
    pub async fn confirm_shelf(
        &self,
        confirmation: WorkflowConfirmation,
        app: Option<&AppHandle>,
    ) -> WorkflowResult {
        self.confirm_shelf_inner(confirmation, None, app).await
    }
    pub async fn confirm_shelf_admitted(
        &self,
        confirmation: WorkflowConfirmation,
        guard: &crate::p4::runner::MutationGuard,
        app: Option<&AppHandle>,
    ) -> WorkflowResult {
        self.confirm_shelf_inner(confirmation, Some(guard), app)
            .await
    }
    async fn confirm_shelf_inner(
        &self,
        confirmation: WorkflowConfirmation,
        admitted: Option<&crate::p4::runner::MutationGuard>,
        app: Option<&AppHandle>,
    ) -> WorkflowResult {
        let _gate = self.confirmation_gate.lock().await;
        let record = match self.consume(&confirmation, "shelf") {
            Ok(record) => record,
            Err(result) => return *result,
        };
        let TokenPayload::Shelf(request) = record.digest.payload else {
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
        let owned_guard;
        let guard = match admitted {
            Some(guard) => guard,
            None => {
                owned_guard = self.repository.lock_mutations(&context.server).await;
                &owned_guard
            }
        };
        let inspection = self
            .repository
            .inspect_shelf(
                &context,
                request.change_id,
                request.mode,
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
        if evaluation.digest != record.digest.content_digest {
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
            .execute_shelf(&context, &request, operation_id.clone(), guard, app)
            .await;
        self.clear_shelf_details();
        self.invalidate(
            &context,
            &request.depot_paths,
            InvalidationReason::ChangelistMutation,
        );
        let revalidated = self
            .revalidate_shelf_after_write(&context, &request, &record.digest.content_digest, app)
            .await;
        shelf_unshelve_result(
            &record.target,
            execution,
            operation_id,
            revalidated,
            "Shelf command completed; refresh the shelf before relying on membership.",
        )
    }

    /// Write-after recheck for SHELF: the command-level lifecycle is only
    /// accepted as confirmed when the shelf state can be re-inspected and the
    /// content digest moved away from the reviewed one. No per-file success is
    /// inferred here; this only separates known from unknown.
    async fn revalidate_shelf_after_write(
        &self,
        context: &P4Context,
        request: &ShelfPreflightRequest,
        reviewed_digest: &str,
        app: Option<&AppHandle>,
    ) -> bool {
        match self
            .repository
            .inspect_shelf(
                context,
                request.change_id,
                request.mode,
                &request.depot_paths,
                &format!("shelf-postwrite-{}", Uuid::new_v4()),
                app,
            )
            .await
        {
            Ok(inspection) => evaluate_shelf(request, inspection).digest != reviewed_digest,
            Err(_) => false,
        }
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
            self.tickets.issue_review(IssuedConfirmation::new(
                target.clone(),
                ReviewPayload {
                    content_digest: evaluation.digest.clone(),
                    payload: TokenPayload::Unshelve(request),
                },
                expires_at,
            ))
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

    /// Compatibility entry used only by the feature-gated e2e harness.
    /// Production IPC uses `confirm_unshelve_admitted` with the unified lane/lease.
    #[allow(dead_code)]
    pub async fn confirm_unshelve(
        &self,
        confirmation: WorkflowConfirmation,
        app: Option<&AppHandle>,
    ) -> WorkflowResult {
        self.confirm_unshelve_inner(confirmation, None, app).await
    }

    pub async fn confirm_unshelve_admitted(
        &self,
        confirmation: WorkflowConfirmation,
        guard: &crate::p4::runner::MutationGuard,
        app: Option<&AppHandle>,
    ) -> WorkflowResult {
        self.confirm_unshelve_inner(confirmation, Some(guard), app)
            .await
    }

    async fn confirm_unshelve_inner(
        &self,
        confirmation: WorkflowConfirmation,
        admitted: Option<&crate::p4::runner::MutationGuard>,
        app: Option<&AppHandle>,
    ) -> WorkflowResult {
        let _gate = self.confirmation_gate.lock().await;
        let record = match self.consume(&confirmation, "unshelve") {
            Ok(record) => record,
            Err(result) => return *result,
        };
        let TokenPayload::Unshelve(request) = record.digest.payload else {
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
        let owned_guard;
        let guard = match admitted {
            Some(guard) => guard,
            None => {
                owned_guard = self.repository.lock_mutations(&context.server).await;
                &owned_guard
            }
        };
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
        if evaluation.digest != record.digest.content_digest {
            return rejected(
                &record.target,
                WorkflowFailureCode::ContentChanged,
                "The source shelf or target workspace changed after preflight.",
            );
        }
        if self.contexts.snapshot() != (context.clone(), generation) {
            return rejected(
                &record.target,
                WorkflowFailureCode::ContextChanged,
                "The active connection changed during Unshelve confirmation.",
            );
        }
        let operation_id = valid_operation_id(confirmation.operation_id);
        let execution = self
            .repository
            .execute_unshelve(
                &evaluation.target_context,
                &request,
                operation_id.clone(),
                guard,
                app,
            )
            .await;
        self.invalidate(
            &evaluation.target_context,
            &request.depot_paths,
            InvalidationReason::ChangelistMutation,
        );
        let revalidated = self
            .revalidate_unshelve_after_write(&context, &request, &record.digest.content_digest, app)
            .await;
        shelf_unshelve_result(
            &record.target,
            execution,
            operation_id,
            revalidated,
            "Unshelve command completed; refresh the target changelist/workspace and check Resolve before relying on per-file state.",
        )
    }

    /// Write-after recheck for UNSHELVE: same rules as SHELF. Only a readable
    /// post-write state whose digest changed can confirm the command-level
    /// lifecycle; no requested path is ever marked as per-file success.
    async fn revalidate_unshelve_after_write(
        &self,
        context: &P4Context,
        request: &UnshelvePreflightRequest,
        reviewed_digest: &str,
        app: Option<&AppHandle>,
    ) -> bool {
        match self
            .repository
            .inspect_unshelve(
                context,
                request,
                &format!("unshelve-postwrite-{}", Uuid::new_v4()),
                app,
            )
            .await
        {
            Ok(inspection) => evaluate_unshelve(request, inspection).digest != reviewed_digest,
            Err(_) => false,
        }
    }

    pub async fn preflight_resolve(
        &self,
        mut request: ResolvePreflightRequest,
        app: Option<&AppHandle>,
    ) -> ResolvePreflight {
        request.depot_paths = normalized_paths(request.depot_paths);
        let force = request.force;
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
                force,
                &format!("resolve-preflight-{}", Uuid::new_v4()),
                app,
            )
            .await;
        let evaluation = inspection
            .map(|value| evaluate_resolve(&request.depot_paths, value, force))
            .unwrap_or_else(|_| failed_resolve_evaluation(&request.depot_paths));
        let ready = evaluation.blockers.is_empty();
        let expires_at = now_ms().saturating_add(self.ttl_ms as i64);
        let token = ready.then(|| {
            self.tickets.issue_review(IssuedConfirmation::new(
                target.clone(),
                ReviewPayload {
                    content_digest: evaluation.digest.clone(),
                    payload: TokenPayload::Resolve(ResolveTokenPayload {
                        paths: request.depot_paths,
                        force,
                    }),
                },
                expires_at,
            ))
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

    pub async fn open_manual_merge(
        &self,
        request: ManualMergeOpenRequest,
        app: Option<&AppHandle>,
    ) -> Result<ManualMergeSession, String> {
        let paths = normalized_paths(vec![request.depot_path]);
        if paths.len() != 1 {
            return Err("Manual merge opens exactly one explicit depot file".into());
        }
        let operation_id = valid_operation_id(request.operation_id);
        let operation = self.repository.begin_operation_group(operation_id.clone());
        let (context, generation) = self.contexts.snapshot();
        let active_profile_id = self.contexts.active_profile_id();
        let inspection = self
            .repository
            .inspect_resolve(
                &context,
                &paths,
                false,
                &format!("{operation_id}:inspect"),
                app,
            )
            .await?;
        operation.ensure_active()?;
        let resolve_record_digest = content_digest(&(
            &inspection.facts,
            &inspection.records,
            &inspection.preview,
            &paths,
        ));
        let fact = inspection
            .facts
            .iter()
            .find(|fact| fact.depot_path == paths[0])
            .cloned()
            .ok_or("Perforce did not return the target file metadata")?;
        let evaluation = evaluate_resolve(&paths, inspection, false);
        if !evaluation.blockers.is_empty()
            || evaluation.conflicts.len() != 1
            || evaluation.conflicts[0].status != "unresolved"
            || evaluation.conflicts[0].conflict_type != "content"
        {
            return Err(format!(
                "This resolve record is not a supported unresolved text-content conflict (status={}, type={}, sources={}); use the existing resolve choices",
                evaluation
                    .conflicts
                    .first()
                    .map(|value| value.status.as_str())
                    .unwrap_or("missing"),
                evaluation
                    .conflicts
                    .first()
                    .map(|value| value.conflict_type.as_str())
                    .unwrap_or("missing"),
                evaluation.conflicts.first().map(|value| value.sources.len()).unwrap_or(0)
            ));
        }
        let conflict = &evaluation.conflicts[0];
        let base = conflict
            .sources
            .iter()
            .find(|source| source.role == "base")
            .and_then(|source| Some((source.depot_path.clone()?, source.revision?)))
            .filter(|(_, revision)| *revision > 0)
            .ok_or("Perforce did not provide an authoritative base revision")?;
        let theirs = conflict
            .sources
            .iter()
            .find(|source| source.role == "theirs")
            .and_then(|source| Some((source.depot_path.clone()?, source.revision?)))
            .filter(|(_, revision)| *revision > 0)
            .ok_or("Perforce did not provide an authoritative incoming revision")?;
        let file_type = fact.file_type.to_ascii_lowercase();
        let action = fact.action.to_ascii_lowercase();
        if file_type.contains("binary")
            || file_type.contains("symlink")
            || action.contains("delete")
            || action.contains("move")
        {
            return Err(
                "Binary, symlink, delete, and move resolves stay on the existing resolve choices"
                    .into(),
            );
        }
        let root = context
            .cwd
            .as_deref()
            .ok_or("Workspace root is not configured")?;
        let local = fact
            .client_path
            .as_deref()
            .ok_or("Perforce did not return a local target path")?;
        let local_path = manual_merge::secure_workspace_file(root, local)?;
        let (file_snapshot, yours_bytes) = manual_merge::snapshot(&local_path)?;
        let yours = manual_merge::decode(&yours_bytes)?;
        let temp_root = std::env::temp_dir().join(format!("p4deck-merge-{}", Uuid::new_v4()));
        std::fs::create_dir(&temp_root)
            .map_err(|error| format!("Cannot create protected merge staging directory: {error}"))?;
        let base_path = temp_root.join("base");
        let theirs_path = temp_root.join("theirs");
        let load_result = async {
            let base_spec = format!("{}#{}", base.0, base.1);
            let theirs_spec = format!("{}#{}", theirs.0, theirs.1);
            self.repository
                .print_revision_to(
                    &context,
                    &base_spec,
                    &base_path,
                    format!("{operation_id}:base"),
                    app,
                )
                .await?;
            operation.ensure_active()?;
            self.repository
                .print_revision_to(
                    &context,
                    &theirs_spec,
                    &theirs_path,
                    format!("{operation_id}:theirs"),
                    app,
                )
                .await?;
            operation.ensure_active()?;
            let base_bytes = std::fs::read(&base_path)
                .map_err(|error| format!("Cannot read staged base revision: {error}"))?;
            let theirs_bytes = std::fs::read(&theirs_path)
                .map_err(|error| format!("Cannot read staged incoming revision: {error}"))?;
            if base_bytes.len() as u64 > manual_merge::MAX_MANUAL_MERGE_BYTES
                || theirs_bytes.len() as u64 > manual_merge::MAX_MANUAL_MERGE_BYTES
            {
                return Err("A merge input exceeds the 4 MiB text safety limit".into());
            }
            Ok::<_, String>((
                manual_merge::decode(&base_bytes)?,
                manual_merge::decode(&theirs_bytes)?,
            ))
        }
        .await;
        let _ = std::fs::remove_dir_all(&temp_root);
        let (base_doc, theirs_doc) = load_result?;
        let final_record = self
            .repository
            .inspect_resolve(
                &context,
                &paths,
                false,
                &format!("{operation_id}:final-record"),
                app,
            )
            .await?;
        if content_digest(&(
            &final_record.facts,
            &final_record.records,
            &final_record.preview,
            &paths,
        )) != resolve_record_digest
        {
            return Err(
                "The Perforce resolve record changed while the merge inputs were loading".into(),
            );
        }
        let mut operation_ids = evaluation.operation_ids.clone();
        operation_ids.extend([
            format!("{operation_id}:base"),
            format!("{operation_id}:theirs"),
        ]);
        operation_ids.extend(final_record.operation_ids);
        self.ensure_manual_context(&context, generation, active_profile_id.as_deref())?;
        operation.ensure_active()?;
        let (result, unresolved_blocks) = manual_merge::merge_text(
            &base_doc.text,
            &yours.text,
            &theirs_doc.text,
            &yours.line_ending,
        );
        let session_id = Uuid::new_v4().to_string();
        let target = target("resolve", &context, generation, None, None, paths.clone());
        let session = ManualMergeSession {
            session_id: session_id.clone(),
            active_profile_id: active_profile_id.clone(),
            target,
            depot_path: paths[0].clone(),
            local_path: local_path.to_string_lossy().into_owned(),
            base_source: ManualMergeSource {
                depot_path: base.0,
                revision: base.1,
            },
            theirs_source: ManualMergeSource {
                depot_path: theirs.0,
                revision: theirs.1,
            },
            file_snapshot,
            resolve_digest: resolve_record_digest,
            base: base_doc.text,
            theirs: theirs_doc.text,
            yours: yours.text,
            result,
            encoding: yours.encoding,
            line_ending: yours.line_ending,
            had_bom: yours.had_bom,
            unresolved_blocks,
            expires_at: now_ms().saturating_add(20 * 60 * 1000),
            operation_ids,
        };
        self.manual_merge_sessions.lock().insert(
            session_id,
            ManualMergeSessionRecord {
                session: session.clone(),
                active_profile_id,
            },
        );
        Ok(session)
    }

    /// Detection only; never starts P4Merge and never touches a merge session.
    pub fn detect_external_merge_tool(&self) -> ExternalMergeToolInfo {
        let external_merge::ToolDetection { tool, reason } = external_merge::detect_tool();
        match tool {
            Some(tool) => ExternalMergeToolInfo {
                available: true,
                executable: Some(tool.executable.to_string_lossy().into_owned()),
                source: Some(match tool.source {
                    external_merge::ToolSource::Env => ExternalMergeToolSource::Env,
                    external_merge::ToolSource::CommonPath => ExternalMergeToolSource::CommonPath,
                    external_merge::ToolSource::Path => ExternalMergeToolSource::Path,
                }),
                reason,
            },
            None => ExternalMergeToolInfo {
                available: false,
                executable: None,
                source: None,
                reason: Some(reason.unwrap_or_else(|| {
                    "P4Merge was not found in P4MERGE, the common install locations, or PATH".into()
                })),
            },
        }
    }

    /// Open the installed P4Merge on the current session inputs and return the
    /// saved text as a *candidate* result. This never writes the workspace file
    /// and never resolves; the user still reviews and runs validate/save/resolve.
    pub fn run_external_merge(
        &self,
        request: ExternalMergeRunRequest,
    ) -> Result<ExternalMergeRunResult, String> {
        let record = self.manual_session(&request.session_id)?;
        self.ensure_manual_target_current(&record)?;
        let normalized = external_merge::normalize_line_endings(&request.result);
        if normalized.len() as u64 > manual_merge::MAX_MANUAL_MERGE_BYTES {
            return Err("External merge input exceeds the 4 MiB text safety limit".into());
        }
        if normalized.lines().count() > manual_merge::MAX_MANUAL_MERGE_LINES {
            return Err("External merge input exceeds the 100,000-line text safety limit".into());
        }
        let operation_ids = record.session.operation_ids.clone();
        let external_merge::ToolDetection { tool, reason } = external_merge::detect_tool();
        let Some(tool) = tool else {
            return Ok(ExternalMergeRunResult {
                status: ExternalMergeStatus::NotInstalled,
                result: None,
                exit_code: None,
                reason: Some(reason.unwrap_or_else(|| {
                    "P4Merge was not found in P4MERGE, the common install locations, or PATH".into()
                })),
                operation_ids,
            });
        };
        let inputs = external_merge::MergeInputs {
            base: &record.session.base,
            theirs: &record.session.theirs,
            yours: &record.session.yours,
            result: &request.result,
        };
        let outcome = external_merge::execute(&tool.executable, &inputs);
        let result = match outcome {
            external_merge::MergeOutcome::Completed { result, exit_code } => {
                ExternalMergeRunResult {
                    status: ExternalMergeStatus::Completed,
                    result: Some(result),
                    exit_code,
                    reason: None,
                    operation_ids,
                }
            }
            external_merge::MergeOutcome::Unchanged { exit_code } => ExternalMergeRunResult {
                status: ExternalMergeStatus::Unchanged,
                result: None,
                exit_code,
                reason: None,
                operation_ids,
            },
            external_merge::MergeOutcome::Failed { exit_code, reason } => ExternalMergeRunResult {
                status: ExternalMergeStatus::Failed,
                result: None,
                exit_code,
                reason: Some(reason),
                operation_ids,
            },
            external_merge::MergeOutcome::Timeout => ExternalMergeRunResult {
                status: ExternalMergeStatus::Timeout,
                result: None,
                exit_code: None,
                reason: Some(
                    "P4Merge did not save within 30 minutes and was stopped; nothing was written"
                        .into(),
                ),
                operation_ids,
            },
            external_merge::MergeOutcome::Cancelled => ExternalMergeRunResult {
                status: ExternalMergeStatus::Cancelled,
                result: None,
                exit_code: None,
                reason: Some(
                    "P4Merge was terminated before saving a result; nothing was written".into(),
                ),
                operation_ids,
            },
        };
        Ok(result)
    }

    pub fn validate_manual_merge(
        &self,
        request: ManualMergeValidateRequest,
    ) -> Result<ManualMergeValidation, String> {
        let record = self.manual_session(&request.session_id)?;
        self.ensure_manual_target_current(&record)?;
        let unresolved_blocks = manual_merge::unresolved_blocks(&request.result);
        let bytes = manual_merge::encode(
            &request.result,
            &record.session.encoding,
            record.session.had_bom,
        )?;
        if bytes.len() as u64 > manual_merge::MAX_MANUAL_MERGE_BYTES {
            return Err("Edited result exceeds the 4 MiB text safety limit".into());
        }
        if request.result.lines().count() > manual_merge::MAX_MANUAL_MERGE_LINES {
            return Err("Edited result exceeds the 100,000-line text safety limit".into());
        }
        let result_digest = manual_merge::sha256(&bytes);
        let expires_at = now_ms().saturating_add(self.ttl_ms as i64);
        let valid = unresolved_blocks == 0 && !manual_merge::has_conflict_marker(&request.result);
        let token = valid.then(|| {
            self.manual_merge_saves.issue(
                IssuedConfirmation::new(
                    ManualMergeSaveTarget {
                        session_id: request.session_id,
                    },
                    ManualMergeSavePayload {
                        result_digest: result_digest.clone(),
                        bytes,
                    },
                    expires_at,
                ),
                now_ms(),
            )
        });
        Ok(ManualMergeValidation {
            valid,
            unresolved_blocks,
            result_digest,
            token,
            expires_at,
            message: if valid {
                "Result has no P4Deck conflict blocks and is ready for a CAS-protected save.".into()
            } else if unresolved_blocks > 0 {
                format!("Resolve {unresolved_blocks} conflict block(s) before saving.")
            } else {
                "Remove the incomplete P4Deck conflict marker before saving.".into()
            },
        })
    }

    pub async fn confirm_manual_merge_save(
        &self,
        confirmation: ManualMergeSaveConfirmation,
        app: Option<&AppHandle>,
    ) -> Result<ManualMergeSaveResult, String> {
        let _gate = self.confirmation_gate.lock().await;
        let record = self
            .manual_merge_saves
            .consume(&confirmation.token)
            .ok_or("The manual merge save token is unknown or was already used")?;
        if record.expires_at <= now_ms() {
            return Err("The manual merge save token expired".into());
        }
        if record.target.session_id != confirmation.session_id
            || record.digest.result_digest != confirmation.result_digest
        {
            return Err("The manual merge save token is bound to another result".into());
        }
        let mut session_record = self.manual_session(&record.target.session_id)?;
        self.ensure_manual_target_current(&session_record)?;
        let operation_id = valid_operation_id(confirmation.operation_id);
        let operation = self.repository.begin_operation_group(operation_id.clone());
        let (context, _) = self.contexts.snapshot();
        let guard = self
            .repository
            .lock_write_transaction(&context, &operation_id)
            .await?;
        self.ensure_manual_target_current(&session_record)?;
        operation.ensure_active()?;
        let recheck = self
            .repository
            .inspect_resolve(
                &context,
                &[session_record.session.depot_path.clone()],
                false,
                &format!("{operation_id}:recheck"),
                app,
            )
            .await?;
        let resolve_record_digest = content_digest(&(
            &recheck.facts,
            &recheck.records,
            &recheck.preview,
            &[session_record.session.depot_path.clone()],
        ));
        let evaluation =
            evaluate_resolve(&[session_record.session.depot_path.clone()], recheck, false);
        if !evaluation.blockers.is_empty()
            || resolve_record_digest != session_record.session.resolve_digest
        {
            return Err("The Perforce resolve record changed after the editor was opened".into());
        }
        let root = context
            .cwd
            .as_deref()
            .ok_or("Workspace root is not configured")?;
        let path = manual_merge::secure_workspace_file(root, &session_record.session.local_path)?;
        let (current, _) = manual_merge::snapshot(&path)?;
        if current != session_record.session.file_snapshot {
            return Err("The workspace file changed outside this merge session".into());
        }
        operation.ensure_active()?;
        self.repository
            .start_local_file_operation(&operation_id, &context)?;
        let saved = manual_merge::atomic_replace_with_backup(&path, &record.digest.bytes);
        let _ = self
            .repository
            .finish_local_file_operation(&operation_id, saved.is_ok());
        let saved = saved?;
        let (saved_snapshot, _) = manual_merge::snapshot(&path)?;
        if saved_snapshot.content_digest != record.digest.result_digest {
            return Err("Atomic save completed but the result digest could not be verified".into());
        }
        session_record.session.file_snapshot = saved_snapshot.clone();
        self.manual_merge_sessions
            .lock()
            .insert(record.target.session_id.clone(), session_record.clone());
        let resolve_expires_at = now_ms().saturating_add(self.ttl_ms as i64);
        let resolve_token = self.manual_merge_resolves.issue(
            IssuedConfirmation::new(
                ManualMergeResolveTarget {
                    session_id: record.target.session_id,
                    result_digest: record.digest.result_digest.clone(),
                },
                ManualMergeResolvePayload {
                    file_snapshot: saved_snapshot,
                    resolve_digest: session_record.session.resolve_digest.clone(),
                },
                resolve_expires_at,
            ),
            now_ms(),
        );
        self.invalidate(
            &context,
            &[session_record.session.depot_path.clone()],
            InvalidationReason::FileMutation,
        );
        guard.finish(saved.durability_confirmed)?;
        Ok(ManualMergeSaveResult {
            outcome: if saved.durability_confirmed {
                WorkflowOutcome::Succeeded
            } else {
                WorkflowOutcome::Unknown
            },
            message: if saved.durability_confirmed {
                "Edited merge result was atomically saved and verified. It is not marked resolved yet."
                    .into()
            } else {
                "Edited merge result and backup were verified, but directory durability could not be confirmed. Review the backup before explicitly marking resolved."
                    .into()
            },
            result_digest: record.digest.result_digest,
            backup_path: Some(saved.backup_path.to_string_lossy().into_owned()),
            resolve_token: Some(resolve_token),
            resolve_expires_at,
            operation_id,
            refresh: refresh(
                vec![session_record.session.depot_path],
                "Manual merge content changed; dependent views must refresh.",
            ),
        })
    }

    pub async fn confirm_manual_merge_resolve(
        &self,
        confirmation: ManualMergeResolveConfirmation,
        app: Option<&AppHandle>,
    ) -> WorkflowResult {
        let _gate = self.confirmation_gate.lock().await;
        let Some(record) = self.manual_merge_resolves.consume(&confirmation.token) else {
            return rejected_manual(
                WorkflowFailureCode::TokenUnknown,
                "The manual resolve token is unknown or was already used.",
            );
        };
        if !confirmation.acknowledge {
            return rejected_manual(
                WorkflowFailureCode::PreflightBlocked,
                "Explicit acknowledgement is required before marking the edited file resolved.",
            );
        }
        if record.expires_at <= now_ms() {
            return rejected_manual(
                WorkflowFailureCode::TokenExpired,
                "The manual resolve confirmation expired.",
            );
        }
        if record.target.session_id != confirmation.session_id
            || record.target.result_digest != confirmation.result_digest
        {
            return rejected_manual(
                WorkflowFailureCode::TargetMismatch,
                "The manual resolve confirmation is bound to another result.",
            );
        }
        let Ok(session) = self.manual_session(&record.target.session_id) else {
            return rejected_manual(
                WorkflowFailureCode::TokenExpired,
                "The manual merge session expired.",
            );
        };
        if self.ensure_manual_target_current(&session).is_err() {
            return rejected(
                &session.session.target,
                WorkflowFailureCode::ContextChanged,
                "The connection, profile, or workspace changed after save.",
            );
        }
        let operation_id = valid_operation_id(confirmation.operation_id);
        let operation = self.repository.begin_operation_group(operation_id.clone());
        let (context, _) = self.contexts.snapshot();
        let guard = self.repository.lock_mutations(&context.server).await;
        if self.ensure_manual_target_current(&session).is_err() {
            return rejected(
                &session.session.target,
                WorkflowFailureCode::ContextChanged,
                "The connection, profile, or workspace changed before resolve.",
            );
        }
        if operation.ensure_active().is_err() {
            return rejected(
                &session.session.target,
                WorkflowFailureCode::Cancelled,
                "The manual resolve operation was cancelled.",
            );
        }
        let Ok(path) = manual_merge::secure_workspace_file(
            context.cwd.as_deref().unwrap_or_default(),
            &session.session.local_path,
        ) else {
            return rejected(
                &session.session.target,
                WorkflowFailureCode::ContentChanged,
                "The saved workspace path is no longer safe.",
            );
        };
        let Ok((snapshot, _)) = manual_merge::snapshot(&path) else {
            return rejected(
                &session.session.target,
                WorkflowFailureCode::ContentChanged,
                "The saved result can no longer be verified.",
            );
        };
        if snapshot != record.digest.file_snapshot
            || snapshot.content_digest != record.target.result_digest
        {
            return rejected(
                &session.session.target,
                WorkflowFailureCode::ContentChanged,
                "The saved result changed before resolve confirmation.",
            );
        }
        let recheck = self
            .repository
            .inspect_resolve(
                &context,
                std::slice::from_ref(&session.session.depot_path),
                false,
                &format!("{operation_id}:recheck"),
                app,
            )
            .await;
        let Ok(recheck) = recheck else {
            return rejected(
                &session.session.target,
                WorkflowFailureCode::PreflightBlocked,
                "The resolve record could not be revalidated.",
            );
        };
        let resolve_record_digest = content_digest(&(
            &recheck.facts,
            &recheck.records,
            &recheck.preview,
            std::slice::from_ref(&session.session.depot_path),
        ));
        let evaluation = evaluate_resolve(
            std::slice::from_ref(&session.session.depot_path),
            recheck,
            false,
        );
        if !evaluation.blockers.is_empty() || resolve_record_digest != record.digest.resolve_digest
        {
            return rejected(
                &session.session.target,
                WorkflowFailureCode::ContentChanged,
                "The resolve record changed after the edited result was saved.",
            );
        }
        if operation.ensure_active().is_err() {
            return rejected(
                &session.session.target,
                WorkflowFailureCode::Cancelled,
                "The manual resolve operation was cancelled before execution.",
            );
        }
        let selection = ResolveSelection {
            depot_path: session.session.depot_path.clone(),
            strategy: ResolveStrategy::AcceptYours,
        };
        let execution = self
            .repository
            .execute_resolve(
                &context,
                &selection,
                false,
                operation_id.clone(),
                &guard,
                app,
            )
            .await;
        let mut file = file_result(
            selection.depot_path.clone(),
            execution,
            operation_id.clone(),
        );
        if operation.ensure_active().is_err() && file.state != WorkflowFileState::Succeeded {
            file.state = WorkflowFileState::Unknown;
            file.message = "Resolve execution was cancelled; refresh before retrying.".into();
        }
        let verified = self
            .repository
            .inspect_resolve(
                &context,
                std::slice::from_ref(&selection.depot_path),
                false,
                &format!("{operation_id}:verify"),
                app,
            )
            .await;
        match verified {
            Ok(value)
                if value.facts.iter().any(|fact| {
                    fact.depot_path == selection.depot_path && fact.unresolved == 0
                }) => {}
            Ok(_) => {
                file.state = WorkflowFileState::Blocked;
                file.message = "Perforce still reports this file as unresolved.".into();
            }
            Err(_) => {
                file.state = WorkflowFileState::Unknown;
                file.message = "Resolve ran, but final state verification was unavailable.".into();
            }
        }
        self.invalidate(
            &context,
            &[selection.depot_path],
            InvalidationReason::ChangelistMutation,
        );
        result_from_files(
            vec![file],
            vec![
                format!("{operation_id}:recheck"),
                operation_id.clone(),
                format!("{operation_id}:verify"),
            ],
            &session.session.target,
            "Edited result resolve completed with verification.",
        )
    }

    fn manual_session(&self, session_id: &str) -> Result<ManualMergeSessionRecord, String> {
        let mut sessions = self.manual_merge_sessions.lock();
        sessions.retain(|_, record| record.session.expires_at > now_ms());
        sessions
            .get(session_id)
            .cloned()
            .ok_or_else(|| "The manual merge session is unknown or expired".into())
    }

    fn ensure_manual_target_current(
        &self,
        record: &ManualMergeSessionRecord,
    ) -> Result<(), String> {
        let (context, generation) = self.contexts.snapshot();
        self.ensure_manual_context(&context, generation, record.active_profile_id.as_deref())?;
        if target(
            "resolve",
            &context,
            generation,
            None,
            None,
            vec![record.session.depot_path.clone()],
        ) != record.session.target
        {
            return Err("The manual merge target no longer matches the active workspace".into());
        }
        Ok(())
    }

    fn ensure_manual_context(
        &self,
        context: &P4Context,
        generation: u64,
        profile: Option<&str>,
    ) -> Result<(), String> {
        let (current, current_generation) = self.contexts.snapshot();
        if current != *context
            || current_generation != generation
            || self.contexts.active_profile_id().as_deref() != profile
        {
            return Err("The connection profile or context generation changed".into());
        }
        Ok(())
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
        let TokenPayload::Resolve(ResolveTokenPayload { paths, force }) = record.digest.payload
        else {
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
        // P4V-style per-file resolve: any non-empty subset of the checked files is
        // executable, but duplicates, unknown paths, and preview-only strategies
        // are rejected before anything runs.
        if selections.is_empty()
            || selections.len() != selected_paths.len()
            || !selected_paths.is_subset(&expected_paths)
            || selections
                .iter()
                .any(|item| item.strategy == ResolveStrategy::MergePreview)
        {
            return rejected(
                &record.target,
                WorkflowFailureCode::TargetMismatch,
                "Resolve confirmation must select at least one checked file, without duplicates or unknown paths, and cannot use a preview-only strategy.",
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
                force,
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
        let evaluation = evaluate_resolve(&paths, inspection, force);
        if !evaluation.blockers.is_empty() {
            return rejected(
                &record.target,
                WorkflowFailureCode::PreflightBlocked,
                "Resolve preflight no longer passes.",
            );
        }
        if evaluation.digest != record.digest.content_digest {
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
                .execute_resolve(
                    &context,
                    selection,
                    force,
                    operation_id.clone(),
                    &guard,
                    app,
                )
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
                force,
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

    /// Read-only best-effort statistics for the Resolve dialog. Any missing
    /// metadata/content becomes `None`; nothing is fabricated and no errors are
    /// thrown for unreadable sides.
    pub async fn resolve_stats(
        &self,
        request: ResolveStatsRequest,
        app: Option<&AppHandle>,
    ) -> ResolveStats {
        let (context, _generation) = self.contexts.snapshot();
        // P4's own resolve engine prints the authoritative chunk summary used by
        // P4V. Prefer it over any client-side diff approximation; when it is
        // available the version contents do not need to be printed at all.
        let engine_counts = self
            .repository
            .resolve_diff_counts(
                &context,
                &request.depot_path,
                request.force,
                format!("resolve-stats-counts-{}", Uuid::new_v4()),
                app,
            )
            .await
            .ok()
            .flatten();
        let need_content = engine_counts.is_none();
        let staging = if need_content {
            let staging =
                std::env::temp_dir().join(format!("p4deck-resolve-stats-{}", Uuid::new_v4()));
            std::fs::create_dir_all(&staging).ok().map(|_| staging)
        } else {
            None
        };
        let (mut base, base_text) = self
            .resolve_version_stats(
                &context,
                request.base_depot_path,
                request.base_revision,
                "base",
                staging.as_deref(),
                need_content,
                app,
            )
            .await;
        let (mut source, source_text) = self
            .resolve_version_stats(
                &context,
                request.source_depot_path,
                request.source_revision,
                "source",
                staging.as_deref(),
                need_content,
                app,
            )
            .await;
        let target_text = if need_content {
            request
                .target_path
                .as_deref()
                .and_then(read_resolve_stats_text)
        } else {
            None
        };
        let mut target = ResolveTargetStats {
            path: request.target_path,
            base_revision: request.base_revision,
            diff_blocks: None,
        };
        let mut conflicts = engine_counts.as_ref().map(|counts| counts.conflicting);
        if let Some(counts) = &engine_counts {
            base.diff_blocks = Some(counts.theirs);
            source.diff_blocks = Some(counts.theirs);
            target.diff_blocks = Some(counts.yours);
        }
        if source.diff_blocks.is_none() {
            if let (Some(base_text), Some(source_text)) = (&base_text, &source_text) {
                let blocks = resolve_stats_math::diff_blocks(base_text, source_text);
                base.diff_blocks = Some(blocks);
                source.diff_blocks = Some(blocks);
            }
        }
        if target.diff_blocks.is_none() {
            if let (Some(base_text), Some(target_text)) = (&base_text, &target_text) {
                target.diff_blocks = Some(resolve_stats_math::diff_blocks(base_text, target_text));
            }
        }
        if conflicts.is_none() {
            if let (Some(base_text), Some(source_text), Some(target_text)) =
                (&base_text, &source_text, &target_text)
            {
                conflicts = Some(resolve_stats_math::conflict_blocks(
                    base_text,
                    source_text,
                    target_text,
                ));
            }
        }
        if let Some(staging) = staging {
            let _ = std::fs::remove_dir_all(staging);
        }
        ResolveStats {
            base,
            source,
            target,
            conflicts,
        }
    }

    #[allow(clippy::too_many_arguments)]
    async fn resolve_version_stats(
        &self,
        context: &P4Context,
        depot_path: Option<String>,
        revision: Option<i64>,
        role: &str,
        staging: Option<&Path>,
        load_content: bool,
        app: Option<&AppHandle>,
    ) -> (ResolveVersionStats, Option<String>) {
        let mut stats = ResolveVersionStats {
            depot_path: depot_path.clone(),
            revision,
            ..ResolveVersionStats::default()
        };
        let (Some(depot_path), Some(revision)) = (depot_path, revision) else {
            return (stats, None);
        };
        if revision <= 0 || depot_path.len() > 4096 || !depot_path.starts_with("//") {
            return (stats, None);
        }
        if let Ok(filelog) = self
            .repository
            .filelog_revision(
                context,
                &depot_path,
                revision,
                format!("resolve-stats-{role}-filelog-{}", Uuid::new_v4()),
                app,
            )
            .await
        {
            stats.change = filelog.change;
            stats.user = filelog.user;
            stats.time = filelog.time;
            stats.description = filelog.description;
        }
        if !load_content {
            return (stats, None);
        }
        let Some(staging) = staging else {
            return (stats, None);
        };
        let output = staging.join(format!("{role}-content"));
        let spec = format!("{depot_path}#{revision}");
        if self
            .repository
            .print_revision_to(
                context,
                &spec,
                &output,
                format!("resolve-stats-{role}-print-{}", Uuid::new_v4()),
                app,
            )
            .await
            .is_err()
        {
            return (stats, None);
        }
        (stats, read_resolve_stats_text(&output.to_string_lossy()))
    }

    /// Take the reviewed confirmation for `kind` out of the shared store.
    ///
    /// Identical decision order to [`ConfirmationTicket::confirm`]'s first four
    /// steps (unknown → expired → target/digest → wrong family), kept here
    /// because each workflow family finishes with its own re-check and result
    /// mapping; the token store, TTL and one-time semantics are the shared ones.
    /// Take a workflow confirmation out of the shared ticket's store.
    ///
    /// The four families keep their own re-check and result mapping (one shared
    /// decision maps to two different workflow codes for Shelf/Unshelve/Move),
    /// but the token itself is the shared one: same one-time store, same TTL
    /// pruning, same clock, and the same refusal order as
    /// `ConfirmationTicket::confirm` — unknown, then expired, then target, then
    /// the family the token was issued for.
    fn consume(
        &self,
        confirmation: &WorkflowConfirmation,
        kind: &str,
    ) -> Result<TokenRecord, Box<WorkflowResult>> {
        let Some(record) = self.tickets.take(&confirmation.token) else {
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

fn evaluate_resolve(
    paths: &[String],
    inspection: ResolveInspection,
    force: bool,
) -> ResolveEvaluation {
    let mut blockers = Vec::new();
    let mut warnings = Vec::new();
    let facts = inspection
        .facts
        .iter()
        .map(|fact| (fact.depot_path.clone(), fact))
        .collect::<BTreeMap<_, _>>();
    let fallback_sources = parser::resolve_sources(&inspection.preview);
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
    let basename = |value: &str| {
        value
            .rsplit(['/', '\\'])
            .next()
            .unwrap_or(value)
            .to_ascii_lowercase()
    };
    for path in paths {
        let fact = facts.get(path).copied();
        let record = inspection
            .records
            .iter()
            .find(|record| {
                record.target_file.as_deref().is_some_and(|target| {
                    target == path
                        || fact.and_then(|item| item.client_path.as_deref()) == Some(target)
                        || basename(target) == basename(path)
                }) || record.base_file.as_deref() == Some(path)
                    || record.from_file.as_deref() == Some(path)
            })
            .or_else(|| (inspection.records.len() == 1).then(|| &inspection.records[0]));
        let mut sources = record
            .and_then(|record| {
                Some(vec![
                    ResolveVersionSource {
                        role: "base".into(),
                        depot_path: Some(record.base_file.clone()?),
                        revision: Some(record.base_revision?),
                        description: "base revision reported by p4 resolve -n -o".into(),
                    },
                    ResolveVersionSource {
                        role: "theirs".into(),
                        depot_path: Some(record.from_file.clone()?),
                        revision: Some(record.end_from_revision?),
                        description: "incoming revision reported by p4 resolve -n -o".into(),
                    },
                ])
            })
            .unwrap_or_else(|| fallback_sources.clone());
        if sources.is_empty() {
            if let Some(fact) = fact {
                let mut built = Vec::new();
                if let Some(revision) = fact.have_revision {
                    built.push(ResolveVersionSource {
                        role: "base".into(),
                        depot_path: Some(path.clone()),
                        revision: Some(revision),
                        description: "base revision (have) from fstat".into(),
                    });
                }
                if let Some(revision) = fact.head_revision {
                    built.push(ResolveVersionSource {
                        role: "theirs".into(),
                        depot_path: Some(path.clone()),
                        revision: Some(revision),
                        description: "incoming head revision from fstat".into(),
                    });
                }
                sources = built;
            }
        }
        let structured_type = record
            .and_then(|record| record.resolve_type.as_deref())
            .map(str::to_ascii_lowercase);
        let conflict_type = structured_type
            .as_deref()
            .map(|value| {
                if value.contains("content") || value.contains("text") {
                    "content"
                } else if value.contains("filetype") || value.contains("type") {
                    "filetype"
                } else if value.contains("branch") || value.contains("delete") {
                    "branch"
                } else if value.contains("move") {
                    "move"
                } else {
                    conflict_type
                }
            })
            .unwrap_or(conflict_type);
        match fact {
            Some(fact) if fact.unresolved == 0 && !(force && fact.resolved > 0) => {
                // Clean files are not conflicts: report the fact as a warning so
                // the UI can say "nothing to resolve" instead of fabricating a
                // blocked conflict (and without blocking a mixed selection).
                // In force mode an already resolved record is re-resolvable, so
                // only files without any resolve record at all land here.
                warnings.push(issue(
                    WorkflowIssueCode::NotResolvable,
                    WorkflowIssueCertainty::Confirmed,
                    "The file has no unresolved integration record; nothing to resolve.",
                    vec![path.clone()],
                ));
            }
            // Genuine unresolved records are always conflicts; in force mode an
            // already resolved (not yet submitted) record is also re-resolvable.
            Some(fact) if inspection.preview_succeeded => {
                let typed_conflict = if conflict_type == "unknown"
                    && sources.iter().any(|source| source.role == "base")
                    && sources.iter().any(|source| source.role == "theirs")
                    && !fact.file_type.to_ascii_lowercase().contains("binary")
                    && !fact.file_type.to_ascii_lowercase().contains("symlink")
                    && !fact.action.to_ascii_lowercase().contains("delete")
                    && !fact.action.to_ascii_lowercase().contains("move")
                {
                    // `resolve -n -o` supplied the authoritative three-way record;
                    // this is stronger than classifying localized preview prose.
                    "content"
                } else {
                    conflict_type
                };
                conflicts.push(ResolveConflictDetail {
                    depot_path: path.clone(),
                    client_path: fact.client_path.clone(),
                    conflict_type: typed_conflict.into(),
                    status: "unresolved".into(),
                    available_strategies: vec![
                        ResolveStrategy::Safe,
                        ResolveStrategy::AcceptYours,
                        ResolveStrategy::AcceptTheirs,
                        ResolveStrategy::MergePreview,
                    ],
                    sources,
                    preview: inspection
                        .preview
                        .iter()
                        .filter(|line| line.contains(path) || paths.len() == 1)
                        .cloned()
                        .collect(),
                })
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
        &inspection.records,
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
    // One clock for every confirmation family (and every service that shares
    // the confirmation skeleton); the local copy used to be a second one.
    crate::app::confirmation::now_ms()
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
        execution: None,
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

fn rejected_manual(failure: WorkflowFailureCode, message: impl Into<String>) -> WorkflowResult {
    WorkflowResult {
        execution: None,
        outcome: WorkflowOutcome::Rejected,
        failure: Some(failure),
        message: message.into(),
        operation_ids: Vec::new(),
        log_reference: None,
        files: Vec::new(),
        refresh: refresh(
            Vec::new(),
            "Reload the manual merge session and current resolve state before retrying.",
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

/// SHELF create/replace/update and UNSHELVE have no authoritative per-file
/// facts. The optimistic boundary is intent/progress only: a clean command
/// lifecycle plus a revalidated post-write state can be confirmed at command
/// level, but no requested path is ever projected as per-file success.
fn shelf_unshelve_result(
    target: &WorkflowTargetSnapshot,
    result: Result<OperationResult, String>,
    operation_id: String,
    revalidated: bool,
    success: &str,
) -> WorkflowResult {
    let clean = result.as_ref().is_ok_and(|operation| {
        operation.exit_code == 0
            && !operation.events.iter().any(|event| {
                matches!(
                    event.kind,
                    EventKind::Error | EventKind::Cancelled | EventKind::Warning
                ) || event
                    .message
                    .as_deref()
                    .and_then(|text| serde_json::from_str::<serde_json::Value>(text).ok())
                    .is_some_and(|value| {
                        value.get("code").and_then(|code| code.as_str()) == Some("error")
                            || value
                                .get("severity")
                                .and_then(|severity| {
                                    severity.as_i64().or_else(|| {
                                        severity.as_str().and_then(|text| text.parse().ok())
                                    })
                                })
                                .is_some_and(|severity| severity >= 2)
                    })
            })
    });
    let confirmed = clean && revalidated;
    let message = if confirmed {
        success
    } else {
        "The command may have completed, but the shelf/unshelve state could not be revalidated. Individual outcomes are unconfirmed; refresh and inspect before any manual retry."
    };
    let outcome = if confirmed {
        WorkflowOutcome::Succeeded
    } else {
        WorkflowOutcome::Unknown
    };
    let state = if confirmed {
        "commandCompleted"
    } else {
        "unknown"
    };
    WorkflowResult {
        execution: Some(WorkflowExecution {
            kind: target.kind.clone(),
            operation_id: operation_id.clone(),
            state: state.into(),
            outcome,
            files: Vec::new(),
        }),
        outcome,
        failure: if confirmed {
            None
        } else {
            Some(WorkflowFailureCode::UncertainOutcome)
        },
        message: message.into(),
        operation_ids: vec![operation_id.clone()],
        log_reference: Some(operation_id),
        files: Vec::new(),
        refresh: refresh(
            target.depot_paths.clone(),
            "Refresh shelf detail, Pending changes and review caches; do not treat this result as per-file success.",
        ),
    }
}

/// Generic command-level result builder kept for unit tests and non-shelf
/// command lifecycles. SHELF/UNSHELVE now use `shelf_unshelve_result`, which
/// adds the lifecycle envelope and claims no per-file success.
#[allow(dead_code)]
fn operation_result(
    target: &WorkflowTargetSnapshot,
    result: Result<OperationResult, String>,
    operation_id: String,
    success: &str,
) -> WorkflowResult {
    // A failed/cancelled batch can have mutated some paths. Without a per-file
    // authoritative post-state, neither failure nor completion is proven for them.
    // Do not infer acknowledgements from localized human-readable output.
    let confirmed = result.as_ref().is_ok_and(|operation| {
        operation.exit_code == 0
            && !operation.events.iter().any(|event| {
                matches!(
                    event.kind,
                    EventKind::Error | EventKind::Cancelled | EventKind::Warning
                ) || event
                    .message
                    .as_deref()
                    .and_then(|text| serde_json::from_str::<serde_json::Value>(text).ok())
                    .is_some_and(|value| {
                        value.get("code").and_then(|code| code.as_str()) == Some("error")
                            || value
                                .get("severity")
                                .and_then(|severity| {
                                    severity.as_i64().or_else(|| {
                                        severity.as_str().and_then(|text| text.parse().ok())
                                    })
                                })
                                .is_some_and(|severity| severity >= 2)
                    })
            })
    });
    let message = if confirmed {
        success
    } else {
        "Some files may have changed; individual outcomes are unconfirmed. Refresh and inspect before any manual retry."
    };
    WorkflowResult {
        execution: None,
        outcome: if confirmed {
            WorkflowOutcome::Succeeded
        } else {
            WorkflowOutcome::Unknown
        },
        failure: if confirmed {
            None
        } else {
            Some(WorkflowFailureCode::UncertainOutcome)
        },
        message: message.into(),
        operation_ids: vec![operation_id.clone()],
        log_reference: Some(operation_id.clone()),
        files: target
            .depot_paths
            .iter()
            .map(|path| WorkflowFileResult {
                depot_path: path.clone(),
                state: if confirmed {
                    WorkflowFileState::Succeeded
                } else {
                    WorkflowFileState::Unknown
                },
                message: message.into(),
                operation_id: Some(operation_id.clone()),
            })
            .collect(),
        refresh: refresh(
            target.depot_paths.clone(),
            "Refresh affected changelist and workspace views before retrying.",
        ),
    }
}
/// Read a stats source without ever fabricating content: regular file only,
/// same 4 MiB text safety limit as manual merge, strict decodable text.
fn read_resolve_stats_text(path: &str) -> Option<String> {
    let metadata = std::fs::symlink_metadata(path).ok()?;
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || metadata.len() > manual_merge::MAX_MANUAL_MERGE_BYTES
    {
        return None;
    }
    let bytes = std::fs::read(path).ok()?;
    if bytes.len() as u64 > manual_merge::MAX_MANUAL_MERGE_BYTES {
        return None;
    }
    manual_merge::decode(&bytes)
        .ok()
        .map(|document| document.text)
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
        execution: None,
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

    #[test]
    fn shelf_i01_batch_errors_never_claim_per_file_failure_or_success() {
        let target = WorkflowTargetSnapshot {
            kind: "unshelve".into(),
            server: "synthetic".into(),
            user: "tester".into(),
            client: "workspace".into(),
            workspace: r"C:\synthetic".into(),
            context_generation: 1,
            source_change_id: Some(7),
            target_change_id: Some(9),
            depot_paths: vec!["//depot/a".into(), "//depot/b".into()],
        };
        for (exit_code, kind, message, expected) in [
            (0, EventKind::Completed, "", WorkflowOutcome::Succeeded),
            (
                1,
                EventKind::Error,
                "one file may have changed",
                WorkflowOutcome::Unknown,
            ),
            (0, EventKind::Error, "error", WorkflowOutcome::Unknown),
            (
                0,
                EventKind::Cancelled,
                "cancelled",
                WorkflowOutcome::Unknown,
            ),
            (
                0,
                EventKind::Stdout,
                r#"{"severity":3,"data":"denied"}"#,
                WorkflowOutcome::Unknown,
            ),
            (
                0,
                EventKind::Stdout,
                r#"{"severity":"2","data":"warning"}"#,
                WorkflowOutcome::Unknown,
            ),
            (
                0,
                EventKind::Warning,
                "output truncated",
                WorkflowOutcome::Unknown,
            ),
        ] {
            let operation = OperationResult {
                operation_id: "synthetic".into(),
                exit_code,
                duration_ms: 0,
                events: vec![crate::domain::OperationEvent {
                    operation_id: "synthetic".into(),
                    kind,
                    message: Some(message.into()),
                    progress: None,
                    timestamp: String::new(),
                }],
            };
            let result = operation_result(&target, Ok(operation), "synthetic".into(), "done");
            assert_eq!(result.outcome, expected);
            assert_eq!(result.files.len(), 2);
            assert!(result.files.iter().all(|file| file.state
                == if expected == WorkflowOutcome::Succeeded {
                    WorkflowFileState::Succeeded
                } else {
                    WorkflowFileState::Unknown
                }));
        }
        assert_eq!(
            operation_result(&target, Err("transport".into()), "id".into(), "done").outcome,
            WorkflowOutcome::Unknown
        );
    }
    #[test]
    fn shelf_unshelve_result_never_claims_per_file_success() {
        let target = WorkflowTargetSnapshot {
            kind: "shelf".into(),
            server: "synthetic".into(),
            user: "tester".into(),
            client: "workspace".into(),
            workspace: r"C:\synthetic".into(),
            context_generation: 1,
            source_change_id: Some(7),
            target_change_id: None,
            depot_paths: vec!["//depot/a".into(), "//depot/b".into()],
        };
        let clean = OperationResult {
            operation_id: "synthetic".into(),
            exit_code: 0,
            duration_ms: 0,
            events: vec![],
        };
        let confirmed = shelf_unshelve_result(
            &target,
            Ok(clean.clone()),
            "synthetic-op".into(),
            true,
            "done",
        );
        assert_eq!(confirmed.outcome, WorkflowOutcome::Succeeded);
        assert!(confirmed
            .files
            .iter()
            .all(|file| file.state == WorkflowFileState::Unknown));
        let unverified =
            shelf_unshelve_result(&target, Ok(clean), "synthetic-op".into(), false, "done");
        assert_eq!(unverified.outcome, WorkflowOutcome::Unknown);
        assert_eq!(
            unverified.failure,
            Some(WorkflowFailureCode::UncertainOutcome)
        );
        assert!(unverified
            .files
            .iter()
            .all(|file| file.state == WorkflowFileState::Unknown));
    }
    #[test]
    fn shelf_i01_delete_scope_permission_and_stale_digest() {
        let mut current = change();
        current.shelved_files = current.files.clone();
        let request = ShelfPreflightRequest {
            change_id: 7,
            depot_paths: vec!["//depot/a".into()],
            mode: ShelfMode::Delete,
            replace: false,
        };
        let inspect = |change, permission| ShelfInspection {
            change,
            permission,
            facts: Vec::new(),
            shelf_facts: Vec::new(),
            operation_ids: Vec::new(),
        };
        let first = evaluate_shelf(
            &request,
            inspect(Some(current.clone()), PermissionAssessment::Allowed),
        );
        assert!(first.blockers.is_empty());
        assert_eq!(first.scope.delete_paths, request.depot_paths);
        assert!(first.scope.create_paths.is_empty());
        assert!(first.scope.replace_paths.is_empty());
        let denied = evaluate_shelf(
            &request,
            inspect(
                Some(current.clone()),
                PermissionAssessment::Denied(request.depot_paths.clone()),
            ),
        );
        assert!(denied
            .blockers
            .iter()
            .any(|item| item.code == WorkflowIssueCode::PermissionDenied));
        let unknown = evaluate_shelf(
            &request,
            inspect(Some(current.clone()), PermissionAssessment::Unknown),
        );
        assert!(unknown
            .warnings
            .iter()
            .any(|item| item.code == WorkflowIssueCode::PermissionUnknown));
        current.shelved_files.clear();
        let stale = evaluate_shelf(
            &request,
            inspect(Some(current), PermissionAssessment::Allowed),
        );
        assert_ne!(first.digest, stale.digest);
        assert!(stale
            .blockers
            .iter()
            .any(|item| item.code == WorkflowIssueCode::FileNotShelved));
        let absent = evaluate_shelf(&request, inspect(None, PermissionAssessment::Allowed));
        assert!(absent
            .blockers
            .iter()
            .any(|item| item.code == WorkflowIssueCode::ChangeNotFound));
    }
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
                head_revision: None,
                file_type: Some("text".into()),
                lock_ownership: None,
                lock_owner: None,
                other_open: Vec::new(),
                exclusive_open: None,
                resolve: None,
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
                    resolved: 0,
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
                records: Vec::new(),
                preview: Vec::new(),
                preview_succeeded: false,
                operation_ids: Vec::new(),
            },
            false,
        );
        assert!(!resolve.blockers.is_empty());
        assert_eq!(resolve.conflicts[0].status, "unknown");
    }

    fn resolve_fact(path: &str, unresolved: usize, resolved: usize) -> parser::WorkflowFileFact {
        parser::WorkflowFileFact {
            depot_path: path.into(),
            client_path: None,
            action: "edit".into(),
            change_id: Some(7),
            have_revision: Some(1),
            head_revision: Some(2),
            file_type: "text".into(),
            digest: "a".into(),
            shelved_digest: String::new(),
            size: Some(1),
            shelved_size: None,
            shelved_type: None,
            unresolved,
            resolved,
            other_open: 0,
            other_lock: 0,
            our_lock: 0,
        }
    }

    fn resolve_inspection(
        facts: Vec<parser::WorkflowFileFact>,
        preview_succeeded: bool,
    ) -> ResolveInspection {
        ResolveInspection {
            facts,
            records: Vec::new(),
            preview: Vec::new(),
            preview_succeeded,
            operation_ids: Vec::new(),
        }
    }

    #[test]
    fn resolve_preflight_reports_clean_files_as_no_conflict() {
        // A file without an unresolved integration record is not a conflict and
        // must not block the preflight; it is only a NotResolvable warning.
        let clean = evaluate_resolve(
            &["//depot/clean".into()],
            resolve_inspection(vec![resolve_fact("//depot/clean", 0, 0)], true),
            false,
        );
        assert!(clean.conflicts.is_empty());
        assert!(clean.blockers.is_empty());
        assert!(clean
            .warnings
            .iter()
            .any(|warning| warning.code == WorkflowIssueCode::NotResolvable
                && warning.paths == vec!["//depot/clean".to_owned()]));

        // Mixed selection: only the genuinely unresolved file is a conflict, and
        // the clean file does not block resolving the dirty one.
        let mixed = evaluate_resolve(
            &["//depot/dirty".into(), "//depot/clean".into()],
            resolve_inspection(
                vec![
                    resolve_fact("//depot/dirty", 1, 0),
                    resolve_fact("//depot/clean", 0, 0),
                ],
                true,
            ),
            false,
        );
        assert_eq!(mixed.conflicts.len(), 1);
        assert_eq!(mixed.conflicts[0].depot_path, "//depot/dirty");
        assert_eq!(mixed.conflicts[0].status, "unresolved");
        assert!(mixed.blockers.is_empty());
        assert!(mixed
            .warnings
            .iter()
            .any(|warning| warning.code == WorkflowIssueCode::NotResolvable
                && warning.paths == vec!["//depot/clean".to_owned()]));
    }

    #[test]
    fn resolve_preflight_force_reopens_already_resolved_files() {
        // Without force an already resolved (not submitted) record is still not a
        // conflict: `p4 resolve -n` ignores it until `-f` opts in.
        let non_force = evaluate_resolve(
            &["//depot/resolved".into()],
            resolve_inspection(vec![resolve_fact("//depot/resolved", 0, 1)], true),
            false,
        );
        assert!(non_force.conflicts.is_empty());
        assert!(non_force.blockers.is_empty());
        assert!(non_force
            .warnings
            .iter()
            .any(|warning| warning.code == WorkflowIssueCode::NotResolvable
                && warning.paths == vec!["//depot/resolved".to_owned()]));

        // Force turns the already resolved record into an executable conflict.
        let forced = evaluate_resolve(
            &["//depot/resolved".into()],
            resolve_inspection(vec![resolve_fact("//depot/resolved", 0, 1)], true),
            true,
        );
        assert_eq!(forced.conflicts.len(), 1);
        assert_eq!(forced.conflicts[0].depot_path, "//depot/resolved");
        assert_eq!(forced.conflicts[0].status, "unresolved");
        assert_eq!(forced.conflicts[0].conflict_type, "content");
        assert!(forced.blockers.is_empty());
        assert!(forced.warnings.is_empty());

        // Mixed already-resolved plus unresolved is fully executable in force mode.
        let mixed = evaluate_resolve(
            &["//depot/resolved".into(), "//depot/dirty".into()],
            resolve_inspection(
                vec![
                    resolve_fact("//depot/resolved", 0, 1),
                    resolve_fact("//depot/dirty", 1, 0),
                ],
                true,
            ),
            true,
        );
        assert_eq!(mixed.conflicts.len(), 2);
        assert!(mixed
            .conflicts
            .iter()
            .all(|conflict| conflict.status == "unresolved"));
        assert!(mixed.blockers.is_empty());

        // A file with no resolve record at all stays a warning even under force.
        let clean = evaluate_resolve(
            &["//depot/clean".into()],
            resolve_inspection(vec![resolve_fact("//depot/clean", 0, 0)], true),
            true,
        );
        assert!(clean.conflicts.is_empty());
        assert!(clean.blockers.is_empty());
        assert!(clean
            .warnings
            .iter()
            .any(|warning| warning.code == WorkflowIssueCode::NotResolvable));
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
                head_revision: None,
                file_type: Some("text".into()),
                lock_ownership: None,
                lock_owner: None,
                other_open: Vec::new(),
                exclusive_open: None,
                resolve: None,
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
            resolved: 0,
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

    use crate::p4::runner::P4Runner;
    use crate::persistence::{log_store::LogStore, operation_journal::OperationJournal};
    use std::path::Path;

    #[cfg(windows)]
    const RESOLVE_WINDOWS_SCRIPT: &str = r#"@echo off
echo %*>>"__CALLS__"
echo %* | findstr /C:" fstat " >nul
if %errorlevel%==0 (
  if exist "__MARKER__" (
    echo {"depotFile":"//depot/a","clientFile":"C:/p4deck-nonexistent/a.txt","action":"edit","type":"text","unresolved":"0"}
    echo {"depotFile":"//depot/b","clientFile":"C:/p4deck-nonexistent/b.txt","action":"edit","type":"text","unresolved":"0"}
  ) else (
    echo {"depotFile":"//depot/a","clientFile":"C:/p4deck-nonexistent/a.txt","action":"edit","type":"text","unresolved":"1"}
    echo {"depotFile":"//depot/b","clientFile":"C:/p4deck-nonexistent/b.txt","action":"edit","type":"text","unresolved":"1"}
  )
  exit /b 0
)
echo %* | findstr /C:" resolve -f -n " >nul
if %errorlevel%==0 (
  echo {"clientFile":"//depot/a","resolveBaseFile":"//depot/a","resolveBaseRev":"1","resolveFromFile":"//depot/from/a","resolveEndFromRev":"2","resolveType":"content"}
  echo {"clientFile":"//depot/b","resolveBaseFile":"//depot/b","resolveBaseRev":"1","resolveFromFile":"//depot/from/b","resolveEndFromRev":"2","resolveType":"content"}
  exit /b 0
)
echo %* | findstr /C:" resolve -f -a" >nul
if %errorlevel%==0 (
  type nul >"__MARKER__"
  echo {"data":"resolved"}
  exit /b 0
)
echo %* | findstr /C:" resolve -n " >nul
if %errorlevel%==0 (
  echo {"clientFile":"//depot/a","resolveBaseFile":"//depot/a","resolveBaseRev":"1","resolveFromFile":"//depot/from/a","resolveEndFromRev":"2","resolveType":"content"}
  echo {"clientFile":"//depot/b","resolveBaseFile":"//depot/b","resolveBaseRev":"1","resolveFromFile":"//depot/from/b","resolveEndFromRev":"2","resolveType":"content"}
  exit /b 0
)
echo %* | findstr /C:" resolve -a" >nul
if %errorlevel%==0 (
  type nul >"__MARKER__"
  echo {"data":"resolved"}
  exit /b 0
)
echo unexpected resolve command 1>&2
exit /b 9
"#;

    #[cfg(unix)]
    const RESOLVE_UNIX_SCRIPT: &str = r#"#!/bin/sh
printf '%s\n' "$*" >> "__CALLS__"
case "$*" in
*" resolve -f -n "*)
  printf '%s\n' '{"clientFile":"//depot/a","resolveBaseFile":"//depot/a","resolveBaseRev":"1","resolveFromFile":"//depot/from/a","resolveEndFromRev":"2","resolveType":"content"}'
  printf '%s\n' '{"clientFile":"//depot/b","resolveBaseFile":"//depot/b","resolveBaseRev":"1","resolveFromFile":"//depot/from/b","resolveEndFromRev":"2","resolveType":"content"}'
  exit 0;;
*" resolve -f -a"*)
  : > "__MARKER__"
  printf '%s\n' '{"data":"resolved"}'
  exit 0;;
*" fstat "*)
  if [ -f "__MARKER__" ]; then u=0; else u=1; fi
  printf '%s\n' "{\"depotFile\":\"//depot/a\",\"clientFile\":\"C:/p4deck-nonexistent/a.txt\",\"action\":\"edit\",\"type\":\"text\",\"unresolved\":\"$u\"}"
  printf '%s\n' "{\"depotFile\":\"//depot/b\",\"clientFile\":\"C:/p4deck-nonexistent/b.txt\",\"action\":\"edit\",\"type\":\"text\",\"unresolved\":\"$u\"}"
  exit 0;;
*" resolve -n "*)
  printf '%s\n' '{"clientFile":"//depot/a","resolveBaseFile":"//depot/a","resolveBaseRev":"1","resolveFromFile":"//depot/from/a","resolveEndFromRev":"2","resolveType":"content"}'
  printf '%s\n' '{"clientFile":"//depot/b","resolveBaseFile":"//depot/b","resolveBaseRev":"1","resolveFromFile":"//depot/from/b","resolveEndFromRev":"2","resolveType":"content"}'
  exit 0;;
*" resolve -a"*)
  : > "__MARKER__"
  printf '%s\n' '{"data":"resolved"}'
  exit 0;;
esac
echo unexpected resolve command >&2
exit 9
"#;

    /// Deterministic fake `p4` for resolve flows: two unresolved files become
    /// resolved after the first `resolve -a*` mutation. No real Perforce.
    fn resolve_fake_p4(directory: &Path) -> std::path::PathBuf {
        let calls = directory.join("calls.txt");
        let marker = directory.join("resolved.marker");
        #[cfg(windows)]
        {
            let executable = directory.join("fake-p4.cmd");
            let script = RESOLVE_WINDOWS_SCRIPT
                .replace("__CALLS__", &calls.to_string_lossy())
                .replace("__MARKER__", &marker.to_string_lossy());
            std::fs::write(&executable, script).unwrap();
            executable
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let executable = directory.join("fake-p4");
            let script = RESOLVE_UNIX_SCRIPT
                .replace("__CALLS__", &calls.to_string_lossy())
                .replace("__MARKER__", &marker.to_string_lossy());
            std::fs::write(&executable, script).unwrap();
            let mut permissions = std::fs::metadata(&executable).unwrap().permissions();
            permissions.set_mode(0o700);
            std::fs::set_permissions(&executable, permissions).unwrap();
            executable
        }
    }

    struct ResolveHarness {
        directory: std::path::PathBuf,
        service: WorkflowService,
    }

    impl Drop for ResolveHarness {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.directory);
        }
    }

    fn resolve_harness(label: &str) -> ResolveHarness {
        let directory =
            std::env::temp_dir().join(format!("p4deck-resolve-{label}-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        let executable = resolve_fake_p4(&directory);
        let contexts = Arc::new(crate::p4::context::ContextStore::load(&directory).unwrap());
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
        ResolveHarness {
            service: WorkflowService::new(
                WorkflowRepository::new(runner),
                contexts,
                crate::app::status_cache::shared_default(),
            ),
            directory,
        }
    }

    fn resolve_calls(directory: &Path) -> Vec<String> {
        std::fs::read_to_string(directory.join("calls.txt"))
            .unwrap_or_default()
            .lines()
            .filter(|line| !line.trim().is_empty())
            .map(str::to_owned)
            .collect()
    }

    async fn ready_resolve_preflight(harness: &ResolveHarness) -> ResolvePreflight {
        let preflight = harness
            .service
            .preflight_resolve(
                ResolvePreflightRequest {
                    depot_paths: vec!["//depot/a".into(), "//depot/b".into()],
                    force: false,
                },
                None,
            )
            .await;
        assert!(preflight.ready, "{:?}", preflight.blockers);
        preflight
    }

    fn resolve_selection(path: &str, strategy: ResolveStrategy) -> ResolveSelection {
        ResolveSelection {
            depot_path: path.into(),
            strategy,
        }
    }

    fn resolve_confirmation(
        preflight: &ResolvePreflight,
        resolutions: Vec<ResolveSelection>,
    ) -> ResolveConfirmation {
        ResolveConfirmation {
            token: preflight.token.clone().unwrap(),
            target: preflight.target.clone(),
            operation_id: Some("resolve-p4v".into()),
            resolutions,
        }
    }

    #[tokio::test]
    async fn confirm_resolve_executes_only_the_selected_subset() {
        let harness = resolve_harness("partial");
        let preflight = ready_resolve_preflight(&harness).await;
        let result = harness
            .service
            .confirm_resolve(
                resolve_confirmation(
                    &preflight,
                    vec![resolve_selection("//depot/a", ResolveStrategy::AcceptYours)],
                ),
                None,
            )
            .await;

        assert_eq!(result.outcome, WorkflowOutcome::Succeeded);
        assert_eq!(result.files.len(), 1);
        assert_eq!(result.files[0].depot_path, "//depot/a");
        assert_eq!(result.files[0].state, WorkflowFileState::Succeeded);
        assert_eq!(result.operation_ids.len(), 1);

        let calls = resolve_calls(&harness.directory);
        let executions = calls
            .iter()
            .filter(|line| line.contains(" resolve -a"))
            .collect::<Vec<_>>();
        assert_eq!(
            executions.len(),
            1,
            "only the selected file may execute: {calls:?}"
        );
        assert!(executions[0].contains("//depot/a"));
        assert!(!executions[0].contains("//depot/b"));
    }

    #[tokio::test]
    async fn confirm_resolve_full_selection_keeps_executing_every_checked_file() {
        let harness = resolve_harness("full");
        let preflight = ready_resolve_preflight(&harness).await;
        let result = harness
            .service
            .confirm_resolve(
                resolve_confirmation(
                    &preflight,
                    vec![
                        resolve_selection("//depot/a", ResolveStrategy::AcceptYours),
                        resolve_selection("//depot/b", ResolveStrategy::AcceptTheirs),
                    ],
                ),
                None,
            )
            .await;

        assert_eq!(result.outcome, WorkflowOutcome::Succeeded);
        assert_eq!(result.files.len(), 2);
        assert_eq!(result.operation_ids.len(), 2);
        let calls = resolve_calls(&harness.directory);
        assert_eq!(
            calls
                .iter()
                .filter(|line| line.contains(" resolve -a"))
                .count(),
            2,
            "{calls:?}"
        );
    }

    #[tokio::test]
    async fn force_resolve_token_round_trip_executes_with_force_flag() {
        let harness = resolve_harness("force-round-trip");
        let preflight = harness
            .service
            .preflight_resolve(
                ResolvePreflightRequest {
                    depot_paths: vec!["//depot/a".into()],
                    force: true,
                },
                None,
            )
            .await;
        assert!(preflight.ready, "{:?}", preflight.blockers);
        let token = preflight.token.expect("force preflight returned no token");
        let result = harness
            .service
            .confirm_resolve(
                ResolveConfirmation {
                    token,
                    target: preflight.target,
                    operation_id: Some("force-resolve".into()),
                    resolutions: vec![resolve_selection("//depot/a", ResolveStrategy::AcceptYours)],
                },
                None,
            )
            .await;
        assert_eq!(result.outcome, WorkflowOutcome::Succeeded, "{result:?}");
        let calls = resolve_calls(&harness.directory);
        assert!(
            calls.iter().any(|line| line.contains(" resolve -f -n ")),
            "force preflight did not pass -f to the preview: {calls:?}"
        );
        assert!(
            calls.iter().any(|line| line.contains(" resolve -f -ay ")),
            "force confirm did not pass -f to the execution: {calls:?}"
        );
    }

    #[tokio::test]
    async fn confirm_resolve_rejects_empty_duplicate_unknown_and_preview_selections() {
        for (label, resolutions) in [
            ("empty", Vec::new()),
            (
                "duplicate",
                vec![
                    resolve_selection("//depot/a", ResolveStrategy::AcceptYours),
                    resolve_selection("//depot/a", ResolveStrategy::AcceptTheirs),
                ],
            ),
            (
                "unknown",
                vec![resolve_selection(
                    "//depot/zzz",
                    ResolveStrategy::AcceptYours,
                )],
            ),
            (
                "preview",
                vec![resolve_selection(
                    "//depot/a",
                    ResolveStrategy::MergePreview,
                )],
            ),
        ] {
            let harness = resolve_harness(label);
            let preflight = ready_resolve_preflight(&harness).await;
            let result = harness
                .service
                .confirm_resolve(resolve_confirmation(&preflight, resolutions), None)
                .await;
            assert_eq!(result.outcome, WorkflowOutcome::Rejected, "{label}");
            assert!(
                result
                    .files
                    .iter()
                    .all(|file| file.state == WorkflowFileState::Blocked),
                "{label}: a rejected confirmation must not report executed files"
            );
            assert!(
                result.message.contains("at least one checked file"),
                "{label}: {}",
                result.message
            );
            let calls = resolve_calls(&harness.directory);
            assert!(
                !calls.iter().any(|line| line.contains(" resolve -a")),
                "{label} must not execute a resolve: {calls:?}"
            );
        }
    }

    const STATS_WINDOWS_SCRIPT: &str = r#"@echo off
echo %*>>"__CALLS__"
echo %* | findstr /C:" filelog " >nul
if %errorlevel%==0 (
  if exist "__FAIL_FILELOG__" exit /b 5
  echo {"depotFile":"//depot/a","rev":"2","change":"42","user":"alice","time":"1700000000","desc":"Add feature"}
  exit /b 0
)
echo %* | findstr /C:" print " >nul
if not %errorlevel%==0 goto unexpected
if exist "__FAIL_PRINT__" exit /b 6
set OUT=
:args
if "%~1"=="" goto written
if "%~1"=="-o" set OUT=%~2
shift
goto args
:written
if not defined OUT exit /b 7
if exist "__PRINT_COUNTER__" goto source
(echo one& echo two& echo three)>"%OUT%"
type nul>"__PRINT_COUNTER__"
exit /b 0
:source
(echo one& echo TWO& echo three)>"%OUT%"
exit /b 0
:unexpected
echo unexpected stats command 1>&2
exit /b 9
"#;

    #[cfg(unix)]
    const STATS_UNIX_SCRIPT: &str = r#"#!/bin/sh
printf '%s\n' "$*" >> "__CALLS__"
case "$*" in
*" filelog "*)
  [ -f "__FAIL_FILELOG__" ] && exit 5
  printf '%s\n' '{"depotFile":"//depot/a","rev":"2","change":"42","user":"alice","time":"1700000000","desc":"Add feature"}'
  exit 0;;
*" print "*)
  [ -f "__FAIL_PRINT__" ] && exit 6
  out=
  while [ $# -gt 0 ]; do
    case "$1" in
      -o) out="$2"; shift 2;;
      *) shift;;
    esac
  done
  [ -n "$out" ] || exit 7
  if [ -f "__PRINT_COUNTER__" ]; then
    printf 'one\nTWO\nthree\n' > "$out"
  else
    printf 'one\ntwo\nthree\n' > "$out"
    : > "__PRINT_COUNTER__"
  fi
  exit 0;;
esac
echo unexpected stats command >&2
exit 9
"#;

    fn stats_fake_p4(directory: &Path) -> std::path::PathBuf {
        let calls = directory.join("calls.txt");
        let fail_filelog = directory.join("FAIL_FILELOG");
        let fail_print = directory.join("FAIL_PRINT");
        let counter = directory.join("PRINT_COUNTER");
        #[cfg(windows)]
        {
            let executable = directory.join("fake-p4.cmd");
            let script = STATS_WINDOWS_SCRIPT
                .replace("__CALLS__", &calls.to_string_lossy())
                .replace("__FAIL_FILELOG__", &fail_filelog.to_string_lossy())
                .replace("__FAIL_PRINT__", &fail_print.to_string_lossy())
                .replace("__PRINT_COUNTER__", &counter.to_string_lossy());
            std::fs::write(&executable, script).unwrap();
            executable
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let executable = directory.join("fake-p4");
            let script = STATS_UNIX_SCRIPT
                .replace("__CALLS__", &calls.to_string_lossy())
                .replace("__FAIL_FILELOG__", &fail_filelog.to_string_lossy())
                .replace("__FAIL_PRINT__", &fail_print.to_string_lossy())
                .replace("__PRINT_COUNTER__", &counter.to_string_lossy());
            std::fs::write(&executable, script).unwrap();
            let mut permissions = std::fs::metadata(&executable).unwrap().permissions();
            permissions.set_mode(0o700);
            std::fs::set_permissions(&executable, permissions).unwrap();
            executable
        }
    }

    struct StatsHarness {
        directory: std::path::PathBuf,
        service: WorkflowService,
    }

    impl Drop for StatsHarness {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.directory);
        }
    }

    fn stats_harness(label: &str) -> StatsHarness {
        let directory =
            std::env::temp_dir().join(format!("p4deck-resolve-stats-{label}-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        let executable = stats_fake_p4(&directory);
        let contexts = Arc::new(crate::p4::context::ContextStore::load(&directory).unwrap());
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
        StatsHarness {
            service: WorkflowService::new(
                WorkflowRepository::new(runner),
                contexts,
                crate::app::status_cache::shared_default(),
            ),
            directory,
        }
    }

    fn stats_request(target: &Path) -> ResolveStatsRequest {
        ResolveStatsRequest {
            depot_path: "//depot/a".into(),
            force: false,
            base_depot_path: Some("//depot/a".into()),
            base_revision: Some(2),
            source_depot_path: Some("//depot/a".into()),
            source_revision: Some(3),
            target_path: Some(target.to_string_lossy().into_owned()),
        }
    }

    #[tokio::test]
    async fn resolve_stats_reads_filelog_print_and_target_with_real_counts() {
        let harness = stats_harness("counts");
        let target = harness.directory.join("target.txt");
        std::fs::write(&target, "one\nTWO\nTHREE\n").unwrap();
        let stats = harness
            .service
            .resolve_stats(stats_request(&target), None)
            .await;

        assert_eq!(stats.base.depot_path.as_deref(), Some("//depot/a"));
        assert_eq!(stats.base.revision, Some(2));
        assert_eq!(stats.base.change, Some(42));
        assert_eq!(stats.base.user.as_deref(), Some("alice"));
        assert_eq!(
            stats.base.time.as_deref(),
            Some("2023-11-14T22:13:20+00:00")
        );
        assert_eq!(stats.base.description.as_deref(), Some("Add feature"));
        // base one/two/three -> source one/TWO/three: one changed block.
        assert_eq!(stats.base.diff_blocks, Some(1));
        assert_eq!(stats.source.diff_blocks, Some(1));
        // base -> target changes lines two and three as one contiguous block.
        assert_eq!(stats.target.base_revision, Some(2));
        assert_eq!(stats.target.diff_blocks, Some(1));
        // Source and target both change line two: one conflict block.
        assert_eq!(stats.conflicts, Some(1));
    }

    #[tokio::test]
    async fn resolve_stats_reports_none_for_missing_metadata_or_content() {
        // print fails: metadata from filelog survives, but no diff/conflict numbers.
        let harness = stats_harness("no-print");
        let target = harness.directory.join("target.txt");
        std::fs::write(&target, "one\nTWO\nTHREE\n").unwrap();
        std::fs::write(harness.directory.join("FAIL_PRINT"), b"1").unwrap();
        let stats = harness
            .service
            .resolve_stats(stats_request(&target), None)
            .await;
        assert_eq!(stats.base.change, Some(42));
        assert_eq!(stats.base.diff_blocks, None);
        assert_eq!(stats.source.diff_blocks, None);
        assert_eq!(stats.target.diff_blocks, None);
        assert_eq!(stats.conflicts, None);

        // filelog fails: content-based numbers still work, metadata stays None.
        let harness = stats_harness("no-filelog");
        let target = harness.directory.join("target.txt");
        std::fs::write(&target, "one\nTWO\nTHREE\n").unwrap();
        std::fs::write(harness.directory.join("FAIL_FILELOG"), b"1").unwrap();
        let stats = harness
            .service
            .resolve_stats(stats_request(&target), None)
            .await;
        assert_eq!(stats.base.change, None);
        assert_eq!(stats.base.user, None);
        assert_eq!(stats.base.diff_blocks, Some(1));
        assert_eq!(stats.conflicts, Some(1));

        // Missing local target: no target diff, no conflict number, no fabrication.
        let harness = stats_harness("missing-target");
        let missing = harness.directory.join("does-not-exist.txt");
        let stats = harness
            .service
            .resolve_stats(stats_request(&missing), None)
            .await;
        assert_eq!(stats.base.diff_blocks, Some(1));
        assert_eq!(
            stats.target.path.as_deref(),
            Some(missing.to_string_lossy().as_ref())
        );
        assert_eq!(stats.target.diff_blocks, None);
        assert_eq!(stats.conflicts, None);
    }
}
