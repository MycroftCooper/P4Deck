use crate::{
    app::confirmation::{
        Acknowledgement, BoxFuture, ConfirmRefusal, ConfirmationRefusalCode, ConfirmationRequest,
        ConfirmationTicket, IssuedConfirmation, MutationLane, RecheckVerdict, ReviewSpec,
    },
    domain::*,
    p4::{
        branches::{
            validate_draft, validate_name, BranchListBatch, BranchMappingRepository,
            BRANCH_SCAN_LIMIT,
        },
        context::ContextStore,
        query as stable_query,
        runner::{MutationGuard, P4Runner},
    },
};
use parking_lot::Mutex;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::AppHandle;
use tokio::sync::Mutex as AsyncMutex;
use uuid::Uuid;

const SNAPSHOT_TTL_MS: u64 = 120_000;
const SNAPSHOT_CAPACITY: usize = 16;
const DEFAULT_TOKEN_TTL_MS: u64 = 120_000;

#[derive(Clone)]
struct ListSnapshot {
    created_at_ms: u64,
    scope: BranchMappingScope,
    items: Vec<BranchMappingSummary>,
    partial: bool,
    truncated: bool,
    stats: BranchMappingStats,
    operation_ids: Vec<String>,
    next_cursor_id: Option<String>,
}

/// What a branch-mutation review binds next to its target snapshot.
///
/// The digest is the preview digest; the reviewed warnings are not needed by a
/// refusal here (the flow never reported them), so the digest is enough.
#[derive(Clone, PartialEq)]
struct BranchReview {
    preview_digest: String,
}

type BranchTicket = ConfirmationTicket<BranchMutationTarget, BranchReview>;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct QueryFingerprint<'a> {
    request_generation: u64,
    name_filter: &'a Option<String>,
    owner: &'a Option<String>,
    page_size: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ConnectionFingerprint<'a> {
    active_profile_id: &'a Option<String>,
    context: &'a P4Context,
}

struct MutationInspection {
    current: Option<BranchMappingDetail>,
    target: Option<BranchMutationTarget>,
    blockers: Vec<BranchIssue>,
    warnings: Vec<BranchIssue>,
    operation_ids: Vec<String>,
}

pub struct BranchMappingService {
    repository: BranchMappingRepository,
    runner: Arc<P4Runner>,
    contexts: Arc<ContextStore>,
    snapshots: Mutex<HashMap<String, ListSnapshot>>,
    cancelled: Mutex<HashSet<String>>,
    tokens: BranchTicket,
    confirmation_gate: Arc<AsyncMutex<()>>,
}

impl BranchMappingService {
    pub fn new(runner: Arc<P4Runner>, contexts: Arc<ContextStore>) -> Self {
        Self::with_ttl(runner, contexts, DEFAULT_TOKEN_TTL_MS)
    }

    pub(crate) fn with_ttl(
        runner: Arc<P4Runner>,
        contexts: Arc<ContextStore>,
        ttl_ms: u64,
    ) -> Self {
        let confirmation_gate = Arc::new(AsyncMutex::new(()));
        let tokens = BranchTicket::with_gate(ttl_ms.max(1), Some(confirmation_gate.clone()));
        Self {
            repository: BranchMappingRepository::new(runner.clone()),
            runner,
            contexts,
            snapshots: Mutex::new(HashMap::new()),
            cancelled: Mutex::new(HashSet::new()),
            tokens,
            confirmation_gate,
        }
    }

    pub fn cancel(&self, operation_id: &str) {
        self.cancelled.lock().insert(operation_id.to_owned());
        self.runner.cancel(operation_id);
    }

    pub fn clear_for_context_switch(&self) {
        self.snapshots.lock().clear();
        self.cancelled.lock().clear();
        // Blocking clear: await it so a context switch serialises against
        // any in-flight confirmation of this family.
        tauri::async_runtime::block_on(self.tokens.clear());
    }

    pub async fn list(
        &self,
        query: BranchMappingQuery,
        app: Option<&AppHandle>,
    ) -> Result<BranchMappingPage, BranchMappingRequestError> {
        let query = normalize_query(query)?;
        let (context, generation) = self.contexts.snapshot();
        let profile = self.contexts.active_profile_id();
        self.ensure_active(&query.operation_id, &context, generation, &profile)?;
        let connection_fingerprint = stable_query::fingerprint(&ConnectionFingerprint {
            active_profile_id: &profile,
            context: &context,
        })
        .map_err(|message| request_error(BranchMappingRequestErrorCode::InvalidQuery, message))?;
        let query_fingerprint = stable_query::fingerprint(&QueryFingerprint {
            request_generation: query.request_generation,
            name_filter: &query.name_filter,
            owner: &query.owner,
            page_size: query.page_size,
        })
        .map_err(|message| request_error(BranchMappingRequestErrorCode::InvalidQuery, message))?;
        let result = if let Some(cursor) = query.cursor.as_deref() {
            let boundary = stable_query::decode_branch_mapping_cursor(
                cursor,
                &query_fingerprint,
                &connection_fingerprint,
                generation,
            )
            .map_err(|message| {
                request_error(BranchMappingRequestErrorCode::InvalidCursor, message)
            })?;
            self.page_existing(
                &query,
                boundary,
                &query_fingerprint,
                &connection_fingerprint,
                generation,
            )?
        } else {
            let batch = self
                .repository
                .list(
                    &context,
                    query.name_filter.as_deref(),
                    query.owner.as_deref(),
                    query.operation_id.clone(),
                    app,
                )
                .await
                .map_err(|message| self.repository_error(&query.operation_id, &message))?;
            self.ensure_active(&query.operation_id, &context, generation, &profile)?;
            self.page_new(
                &query,
                snapshot_from_batch(batch, scope(&context, generation, profile.clone())),
                &query_fingerprint,
                &connection_fingerprint,
                generation,
            )?
        };
        self.ensure_active(&query.operation_id, &context, generation, &profile)?;
        self.cancelled.lock().remove(&query.operation_id);
        Ok(result)
    }

    pub async fn detail(
        &self,
        query: BranchMappingDetailQuery,
        app: Option<&AppHandle>,
    ) -> Result<BranchMappingDetailResult, BranchMappingRequestError> {
        validate_request_identity(&query.operation_id, query.request_generation)?;
        validate_name(&query.name).map_err(|message| {
            request_error(BranchMappingRequestErrorCode::InvalidQuery, message)
        })?;
        let (context, generation) = self.contexts.snapshot();
        if query
            .expected_generation
            .is_some_and(|expected| expected != generation)
        {
            return Err(request_error(
                BranchMappingRequestErrorCode::ConnectionChanged,
                "Connection changed before mapping inspection.",
            ));
        }
        let profile = self.contexts.active_profile_id();
        self.ensure_active(&query.operation_id, &context, generation, &profile)?;
        let detail = self
            .repository
            .detail(&context, &query.name, query.operation_id.clone(), app)
            .await
            .map_err(|message| self.repository_error(&query.operation_id, &message))?
            .ok_or_else(|| {
                request_error(
                    BranchMappingRequestErrorCode::NotFound,
                    "The Branch Mapping does not exist.",
                )
            })?;
        self.ensure_active(&query.operation_id, &context, generation, &profile)?;
        self.cancelled.lock().remove(&query.operation_id);
        Ok(BranchMappingDetailResult {
            request_generation: query.request_generation,
            scope: scope(&context, generation, profile),
            detail,
        })
    }

    pub async fn preview(
        &self,
        query: BranchImpactPreviewQuery,
        app: Option<&AppHandle>,
    ) -> Result<BranchImpactPreview, BranchMappingRequestError> {
        validate_request_identity(&query.operation_id, query.request_generation)?;
        validate_name(&query.name).map_err(|message| {
            request_error(BranchMappingRequestErrorCode::InvalidQuery, message)
        })?;
        if !(1..=BRANCH_SCAN_LIMIT).contains(&query.limit) {
            return Err(request_error(
                BranchMappingRequestErrorCode::InvalidQuery,
                "Branch impact preview limit must be between 1 and 5000.",
            ));
        }
        let (context, generation) = self.contexts.snapshot();
        let profile = self.contexts.active_profile_id();
        self.ensure_active(&query.operation_id, &context, generation, &profile)?;
        let detail_id = format!("{}:detail", query.operation_id);
        let detail = self
            .repository
            .detail(&context, &query.name, detail_id.clone(), app)
            .await
            .map_err(|message| self.repository_error(&query.operation_id, &message))?
            .ok_or_else(|| {
                request_error(
                    BranchMappingRequestErrorCode::NotFound,
                    "The Branch Mapping does not exist.",
                )
            })?;
        let paths = detail
            .view
            .iter()
            .filter(|line| {
                !matches!(
                    line.modifier,
                    BranchViewModifier::Exclude | BranchViewModifier::Unknown
                )
            })
            .filter_map(|line| match query.direction {
                BranchImpactDirection::Forward => line.target.clone(),
                BranchImpactDirection::Reverse => line.source.clone(),
            })
            .collect::<Vec<_>>();
        let where_id = format!("{}:where", query.operation_id);
        let mapped = if paths.is_empty() {
            false
        } else {
            match self
                .repository
                .targets_mapped(&context, &paths, where_id.clone(), app)
                .await
            {
                Ok(mapped) => mapped,
                Err(message) => {
                    self.ensure_active(&query.operation_id, &context, generation, &profile)?;
                    self.cancelled.lock().remove(&query.operation_id);
                    return Ok(blocked_preview(
                        &query,
                        BranchIssueCode::PermissionDenied,
                        if message.to_ascii_lowercase().contains("permission") {
                            "Server permissions do not allow the current Client mapping to be checked."
                        } else {
                            "The current Client mapping could not be checked safely."
                        },
                        vec![detail_id, where_id],
                    ));
                }
            }
        };
        if !mapped {
            self.ensure_active(&query.operation_id, &context, generation, &profile)?;
            self.cancelled.lock().remove(&query.operation_id);
            return Ok(blocked_preview(
                &query,
                BranchIssueCode::WorkspaceUnmapped,
                "The current Client does not map every preview target; no integrate preview was run.",
                vec![detail_id, where_id],
            ));
        }
        let preview_id = format!("{}:integrate-preview", query.operation_id);
        let preview_result = self
            .repository
            .preview(
                &context,
                &query.name,
                matches!(query.direction, BranchImpactDirection::Reverse),
                query.limit,
                preview_id.clone(),
                app,
            )
            .await;
        let (items, invalid, scanned_count, truncated) = match preview_result {
            Ok(result) => result,
            Err(message) => {
                self.ensure_active(&query.operation_id, &context, generation, &profile)?;
                self.cancelled.lock().remove(&query.operation_id);
                return Ok(blocked_preview(
                    &query,
                    if message.to_ascii_lowercase().contains("permission") {
                        BranchIssueCode::PermissionDenied
                    } else {
                        BranchIssueCode::PreviewUnavailable
                    },
                    "The server did not provide a reliable Branch Mapping preview; inspect the operation log.",
                    vec![detail_id, where_id, preview_id],
                ));
            }
        };
        self.ensure_active(&query.operation_id, &context, generation, &profile)?;
        self.cancelled.lock().remove(&query.operation_id);
        Ok(BranchImpactPreview {
            request_generation: query.request_generation,
            name: query.name,
            direction: query.direction,
            items,
            blockers: Vec::new(),
            partial: truncated || invalid > 0,
            truncated,
            scanned_count,
            safety_limit: query.limit,
            operation_ids: vec![detail_id, where_id, preview_id],
            simulated: false,
        })
    }

    pub async fn preflight(
        &self,
        request: BranchMutationPreflightRequest,
        app: Option<&AppHandle>,
    ) -> BranchMutationPreflight {
        let operation_id = safe_operation_id(request.operation_id.as_deref(), "branch-preflight");
        let (context, generation) = self.contexts.snapshot();
        let profile = self.contexts.active_profile_id();
        if let Err(error) = self.ensure_active(&operation_id, &context, generation, &profile) {
            let issue_code = if error.code == BranchMappingRequestErrorCode::Cancelled {
                BranchIssueCode::Cancelled
            } else {
                BranchIssueCode::ContextChanged
            };
            return BranchMutationPreflight {
                ready: false,
                mode: request.mode,
                name: request.name,
                current: None,
                desired: request.desired,
                blockers: vec![issue(issue_code, error.message)],
                warnings: Vec::new(),
                target: None,
                preview_digest: String::new(),
                token: None,
                expires_at: now_i64(),
                ttl_ms: self.tokens.ttl_ms(),
                operation_ids: vec![operation_id],
            };
        }
        let inspection = self
            .inspect_mutation(
                &context,
                generation,
                profile.clone(),
                &request,
                &operation_id,
                app,
            )
            .await;
        if let Err(error) = self.ensure_active(&operation_id, &context, generation, &profile) {
            return BranchMutationPreflight {
                ready: false,
                mode: request.mode,
                name: request.name,
                current: inspection.current,
                desired: request.desired,
                blockers: vec![issue(
                    if error.code == BranchMappingRequestErrorCode::Cancelled {
                        BranchIssueCode::Cancelled
                    } else {
                        BranchIssueCode::ContextChanged
                    },
                    error.message,
                )],
                warnings: Vec::new(),
                target: None,
                preview_digest: String::new(),
                token: None,
                expires_at: now_i64(),
                ttl_ms: self.tokens.ttl_ms(),
                operation_ids: inspection.operation_ids,
            };
        }
        let preview_digest = digest(&(
            inspection.target.as_ref(),
            &inspection.blockers,
            &inspection.warnings,
        ));
        let ready = inspection.blockers.is_empty() && inspection.target.is_some();
        let (token, expires_at) = match inspection.target.clone() {
            Some(target) if ready => {
                match self.tokens.issue(
                    true,
                    target,
                    BranchReview {
                        preview_digest: preview_digest.clone(),
                    },
                ) {
                    Some((expires_at, token)) => (Some(token), expires_at),
                    None => (None, self.tokens.planned_expires_at()),
                }
            }
            _ => (None, self.tokens.planned_expires_at()),
        };
        self.cancelled.lock().remove(&operation_id);
        BranchMutationPreflight {
            ready,
            mode: request.mode,
            name: request.name,
            current: inspection.current,
            desired: inspection
                .target
                .as_ref()
                .and_then(|target| target.desired.clone())
                .or(request.desired),
            blockers: inspection.blockers,
            warnings: inspection.warnings,
            target: inspection.target,
            preview_digest,
            token,
            expires_at,
            ttl_ms: self.tokens.ttl_ms(),
            operation_ids: inspection.operation_ids,
        }
    }

    /// Compatibility entry used only by the feature-gated e2e harness.
    /// Production IPC uses confirm_admitted with the unified lane/lease.
    #[allow(dead_code)]
    pub async fn confirm(
        &self,
        confirmation: BranchMutationConfirmation,
        app: Option<&AppHandle>,
    ) -> BranchMutationResult {
        let (context, _) = self.contexts.snapshot();
        let guard = self.repository.lock_mutations(&context.server).await;
        self.confirm_admitted(confirmation, &guard, app).await
    }

    pub async fn confirm_admitted(
        &self,
        confirmation: BranchMutationConfirmation,
        guard: &crate::p4::runner::MutationGuard,
        app: Option<&AppHandle>,
    ) -> BranchMutationResult {
        self.confirm_inner(confirmation, Some(guard), app).await
    }

    async fn confirm_inner(
        &self,
        confirmation: BranchMutationConfirmation,
        admitted: Option<&MutationGuard>,
        app: Option<&AppHandle>,
    ) -> BranchMutationResult {
        let request = ConfirmationRequest {
            token: &confirmation.token,
            target: &confirmation.target,
            digest: None,
            acknowledged: Acknowledgement::required(
                false,
                confirmation.acknowledge_dangerous_delete,
            ),
        };
        let mut spec = BranchReviewSpec {
            service: self,
            admitted,
            app,
            reviewed: None,
            recheck_operation_ids: Vec::new(),
            // Minted once for the whole attempt and reused by `lane`, the
            // re-check, the write and the verification.
            root_id: safe_operation_id(confirmation.operation_id.as_deref(), "branch-mutation"),
            echoed_target: Some(confirmation.target.clone()),
        };
        match self.tokens.confirm(request, &mut spec).await {
            Ok(output) => output,
            Err(refusal) => branch_refusal_result(refusal, &spec),
        }
    }

    /// The write, run after every shared check and the re-check passed.
    async fn run_branch_mutation(
        &self,
        target: &BranchMutationTarget,
        recheck_operation_ids: Vec<String>,
        guard: &MutationGuard,
        root_id: String,
        app: Option<&AppHandle>,
    ) -> BranchMutationResult {
        let (context, generation) = self.contexts.snapshot();
        let write_id = format!("{root_id}:write");
        let execution = match target.mode {
            BranchMutationMode::Create | BranchMutationMode::Edit => {
                self.repository
                    .save(
                        &context,
                        target.desired.as_ref().expect("write target"),
                        write_id.clone(),
                        guard,
                        app,
                    )
                    .await
            }
            BranchMutationMode::Delete => {
                self.repository
                    .delete(&context, &target.name, write_id.clone(), guard, app)
                    .await
            }
        };
        self.snapshots.lock().clear();
        let verify_id = format!("{root_id}:verify");
        let observed = self
            .repository
            .detail(&context, &target.name, verify_id.clone(), app)
            .await;
        let (current_context, current_generation) = self.contexts.snapshot();
        let context_current = target_matches(
            target,
            &current_context,
            current_generation,
            self.contexts.active_profile_id(),
        );
        let _ = generation;
        let mut operation_ids = recheck_operation_ids;
        operation_ids.extend([write_id, verify_id]);
        mutation_result(target, execution, observed, context_current, operation_ids)
    }

    async fn inspect_mutation(
        &self,
        context: &P4Context,
        generation: u64,
        profile: Option<String>,
        request: &BranchMutationPreflightRequest,
        operation_id: &str,
        app: Option<&AppHandle>,
    ) -> MutationInspection {
        let mut blockers = Vec::new();
        let mut warnings = Vec::new();
        if let Err(message) = validate_name(&request.name) {
            blockers.push(issue(BranchIssueCode::InvalidInput, message));
            return MutationInspection {
                current: None,
                target: None,
                blockers,
                warnings,
                operation_ids: Vec::new(),
            };
        }
        let detail_id = format!("{operation_id}:detail");
        let current = match self
            .repository
            .detail(context, &request.name, detail_id.clone(), app)
            .await
        {
            Ok(value) => value,
            Err(message) => {
                blockers.push(issue(
                    if message.to_ascii_lowercase().contains("cancel") {
                        BranchIssueCode::Cancelled
                    } else {
                        BranchIssueCode::PermissionDenied
                    },
                    format!("Branch Mapping state could not be read safely: {message}"),
                ));
                return MutationInspection {
                    current: None,
                    target: None,
                    blockers,
                    warnings,
                    operation_ids: vec![detail_id],
                };
            }
        };
        let mut desired = request.desired.clone();
        if let Some(draft) = desired.as_mut() {
            draft.description = draft.description.trim().to_owned();
            if draft.name != request.name {
                blockers.push(issue(
                    BranchIssueCode::InvalidInput,
                    "The desired Branch name must match the preflight target.",
                ));
            }
            if let Err(message) = validate_draft(draft) {
                blockers.push(issue(BranchIssueCode::InvalidInput, message));
            }
        }
        match request.mode {
            BranchMutationMode::Create => {
                if current.is_some() {
                    blockers.push(issue(
                        BranchIssueCode::AlreadyExists,
                        "The Branch Mapping already exists.",
                    ));
                }
                match desired.as_ref() {
                    Some(draft) if draft.owner == context.user => {}
                    Some(_) => blockers.push(issue(
                        BranchIssueCode::OwnerMismatch,
                        "New Branch Mappings must be owned by the active user.",
                    )),
                    None => blockers.push(issue(
                        BranchIssueCode::InvalidInput,
                        "Create requires a desired Branch Mapping.",
                    )),
                }
            }
            BranchMutationMode::Edit | BranchMutationMode::Delete => {
                let Some(existing) = current.as_ref() else {
                    blockers.push(issue(
                        BranchIssueCode::NotFound,
                        "The Branch Mapping does not exist.",
                    ));
                    return MutationInspection {
                        current,
                        target: None,
                        blockers,
                        warnings,
                        operation_ids: vec![detail_id],
                    };
                };
                if existing.owner != context.user {
                    blockers.push(issue(
                        BranchIssueCode::OwnerMismatch,
                        "Only the current Branch Mapping owner may modify or delete it in P4Deck.",
                    ));
                }
                if matches!(request.mode, BranchMutationMode::Edit) {
                    if !existing.editable {
                        blockers.push(issue(BranchIssueCode::UnknownFields, "The existing Branch Mapping contains unknown or non-round-trippable fields; editing is blocked."));
                    }
                    match desired.as_ref() {
                        Some(draft) if draft.owner == existing.owner => {}
                        Some(_) => blockers.push(issue(
                            BranchIssueCode::OwnerMismatch,
                            "P4Deck does not transfer Branch Mapping ownership during edit.",
                        )),
                        None => blockers.push(issue(
                            BranchIssueCode::InvalidInput,
                            "Edit requires a desired Branch Mapping.",
                        )),
                    }
                } else {
                    if desired.is_some() {
                        blockers.push(issue(
                            BranchIssueCode::InvalidInput,
                            "Delete does not accept a desired Branch Mapping.",
                        ));
                    }
                    if existing.locked {
                        blockers.push(issue(BranchIssueCode::Locked, "A locked Branch Mapping must be explicitly unlocked in a separate edit before deletion."));
                    }
                    warnings.push(issue(BranchIssueCode::DestructiveDelete, "Deleting the Branch Mapping is irreversible and requires explicit confirmation."));
                }
            }
        }
        let current_digest = current.as_ref().map(spec_digest);
        let desired_digest = desired.as_ref().map(digest);
        let target = blockers.is_empty().then(|| BranchMutationTarget {
            active_profile_id: profile,
            context_generation: generation,
            server: context.server.clone(),
            user: context.user.clone(),
            client: context.client.clone(),
            mode: request.mode,
            name: request.name.clone(),
            current_exists: current.is_some(),
            current_digest,
            desired,
            desired_digest,
        });
        MutationInspection {
            current,
            target,
            blockers,
            warnings,
            operation_ids: vec![detail_id],
        }
    }

    fn page_new(
        &self,
        query: &BranchMappingQuery,
        snapshot: ListSnapshot,
        query_fingerprint: &str,
        connection_fingerprint: &str,
        generation: u64,
    ) -> Result<BranchMappingPage, BranchMappingRequestError> {
        self.page(
            query,
            Uuid::new_v4().to_string(),
            snapshot,
            0,
            query_fingerprint,
            connection_fingerprint,
            generation,
        )
    }

    fn ensure_active(
        &self,
        operation_id: &str,
        context: &P4Context,
        generation: u64,
        profile: &Option<String>,
    ) -> Result<(), BranchMappingRequestError> {
        if self.cancelled.lock().contains(operation_id) {
            return Err(request_error(
                BranchMappingRequestErrorCode::Cancelled,
                "The Branch Mapping request was cancelled.",
            ));
        }
        ensure_context(&self.contexts, context, generation, profile)
    }

    fn repository_error(&self, operation_id: &str, message: &str) -> BranchMappingRequestError {
        if self.cancelled.lock().contains(operation_id)
            || message.to_ascii_lowercase().contains("cancel")
        {
            request_error(
                BranchMappingRequestErrorCode::Cancelled,
                "The Branch Mapping request was cancelled.",
            )
        } else {
            repository_error(message)
        }
    }

    fn page_existing(
        &self,
        query: &BranchMappingQuery,
        boundary: stable_query::BranchMappingCursorBoundary,
        query_fingerprint: &str,
        connection_fingerprint: &str,
        generation: u64,
    ) -> Result<BranchMappingPage, BranchMappingRequestError> {
        let now = now_u64();
        let snapshot = {
            let mut snapshots = self.snapshots.lock();
            snapshots.retain(|_, snapshot| {
                now.saturating_sub(snapshot.created_at_ms) <= SNAPSHOT_TTL_MS
            });
            let stored = snapshots.get_mut(&boundary.snapshot_id).ok_or_else(|| {
                request_error(
                    BranchMappingRequestErrorCode::CursorExpired,
                    "The Branch Mapping cursor expired.",
                )
            })?;
            if stored.next_cursor_id.as_deref() != Some(boundary.cursor_id.as_str()) {
                return Err(request_error(
                    BranchMappingRequestErrorCode::InvalidCursor,
                    "The Branch Mapping cursor was already used or is not current.",
                ));
            }
            stored.next_cursor_id = None;
            stored.clone()
        };
        self.page(
            query,
            boundary.snapshot_id,
            snapshot,
            boundary.offset,
            query_fingerprint,
            connection_fingerprint,
            generation,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn page(
        &self,
        query: &BranchMappingQuery,
        snapshot_id: String,
        mut snapshot: ListSnapshot,
        offset: usize,
        query_fingerprint: &str,
        connection_fingerprint: &str,
        generation: u64,
    ) -> Result<BranchMappingPage, BranchMappingRequestError> {
        if offset > 0 && offset >= snapshot.items.len() {
            return Err(request_error(
                BranchMappingRequestErrorCode::InvalidCursor,
                "The Branch Mapping cursor points beyond the snapshot.",
            ));
        }
        let end = offset
            .saturating_add(query.page_size)
            .min(snapshot.items.len());
        let items = snapshot.items[offset..end].to_vec();
        let has_more = end < snapshot.items.len();
        let next_cursor = if has_more {
            let cursor_id = Uuid::new_v4().to_string();
            let encoded = stable_query::encode_branch_mapping_cursor(
                &snapshot_id,
                &cursor_id,
                end,
                query_fingerprint,
                connection_fingerprint,
                generation,
            )
            .map_err(|message| {
                request_error(BranchMappingRequestErrorCode::InvalidCursor, message)
            })?;
            snapshot.next_cursor_id = Some(cursor_id);
            let mut snapshots = self.snapshots.lock();
            if snapshots.len() >= SNAPSHOT_CAPACITY && !snapshots.contains_key(&snapshot_id) {
                if let Some(oldest) = snapshots
                    .iter()
                    .min_by_key(|(_, value)| value.created_at_ms)
                    .map(|(id, _)| id.clone())
                {
                    snapshots.remove(&oldest);
                }
            }
            snapshots.insert(snapshot_id, snapshot.clone());
            Some(encoded)
        } else {
            self.snapshots.lock().remove(&snapshot_id);
            None
        };
        let mut stats = snapshot.stats;
        stats.returned_count = items.len();
        Ok(BranchMappingPage {
            request_generation: query.request_generation,
            scope: snapshot.scope,
            items,
            has_more,
            next_cursor,
            partial: snapshot.partial,
            truncated: snapshot.truncated,
            stats,
            operation_ids: snapshot.operation_ids,
            simulated: false,
        })
    }
}

/// One branch-mutation confirmation attempt.
struct BranchReviewSpec<'a> {
    service: &'a BranchMappingService,
    /// Lane admitted by the caller (production IPC), otherwise taken in
    /// `lane()` exactly where the hand-written flow locked it.
    admitted: Option<&'a MutationGuard>,
    app: Option<&'a AppHandle>,
    reviewed: Option<IssuedConfirmation<BranchMutationTarget, BranchReview>>,
    /// Operation ids the re-check produced, reported by its refusals.
    recheck_operation_ids: Vec<String>,
    /// Root id for the grouped write (`{root}:write`, `{root}:verify`).
    root_id: String,
    /// The target echoed by the confirmation, used by the context checks that
    /// run before `on_reviewed` hands over the consumed record.
    echoed_target: Option<BranchMutationTarget>,
}

impl<'a> ReviewSpec for BranchReviewSpec<'a> {
    type Target = BranchMutationTarget;
    type Digest = BranchReview;
    type Recheck = MutationInspection;
    type Output = BranchMutationResult;
    type RefusalCode = BranchMutationFailureCode;
    type Error = ConfirmRefusal<BranchMutationFailureCode>;

    fn unwrap_error(error: Self::Error) -> ConfirmRefusal<Self::RefusalCode> {
        error
    }

    fn refusal_code(&self, shared: ConfirmationRefusalCode) -> BranchMutationFailureCode {
        match shared {
            ConfirmationRefusalCode::TokenUnknown => BranchMutationFailureCode::TokenUnknown,
            ConfirmationRefusalCode::TokenExpired => BranchMutationFailureCode::TokenExpired,
            ConfirmationRefusalCode::TargetMismatch => BranchMutationFailureCode::TargetMismatch,
            // Deleting a mapping is the only dangerous review in this family.
            ConfirmationRefusalCode::AcknowledgementRequired => {
                BranchMutationFailureCode::DangerousConfirmationRequired
            }
            ConfirmationRefusalCode::ContextChanged => BranchMutationFailureCode::ContextChanged,
            // This domain has no separate "now blocked" outcome; it keeps reporting
            // a blocked re-check as a changed one.
            ConfirmationRefusalCode::RecheckBlocked | ConfirmationRefusalCode::RecheckChanged => {
                BranchMutationFailureCode::PreflightChanged
            }
            ConfirmationRefusalCode::RecheckUnavailable => {
                BranchMutationFailureCode::PreflightChanged
            }
            ConfirmationRefusalCode::Cancelled => BranchMutationFailureCode::Cancelled,
        }
    }

    fn refusal_message(&self, shared: ConfirmationRefusalCode) -> &'static str {
        match shared {
            ConfirmationRefusalCode::TokenUnknown => {
                "The Branch Mapping confirmation token is unknown or already used."
            }
            ConfirmationRefusalCode::TokenExpired => "The Branch Mapping preflight expired.",
            ConfirmationRefusalCode::TargetMismatch => {
                "The confirmation does not match the reviewed Branch Mapping snapshot."
            }
            ConfirmationRefusalCode::AcknowledgementRequired => {
                "Deleting a Branch Mapping requires explicit dangerous confirmation."
            }
            ConfirmationRefusalCode::ContextChanged => {
                "The active profile, connection, Client, or generation changed after preflight."
            }
            ConfirmationRefusalCode::RecheckBlocked | ConfirmationRefusalCode::RecheckChanged => {
                "The Branch Mapping or permission snapshot changed after preflight."
            }
            ConfirmationRefusalCode::RecheckUnavailable => {
                "The Branch Mapping or permission snapshot changed after preflight."
            }
            ConfirmationRefusalCode::Cancelled => {
                "The Branch Mapping mutation was cancelled before it executed."
            }
        }
    }

    /// Only a delete needs the dangerous acknowledgement, and the reviewed mode
    /// is read from the token record so the wire cannot clear it.
    fn required_acknowledgement(
        &self,
        reviewed: &IssuedConfirmation<Self::Target, Self::Digest>,
    ) -> Acknowledgement {
        Acknowledgement::required(
            matches!(reviewed.target.mode, BranchMutationMode::Delete),
            false,
        )
    }

    fn context_current(&self) -> bool {
        let (context, generation) = self.service.contexts.snapshot();
        // `check_record` runs before `on_reviewed` on the first pass, so fall
        // back to the echoed target, which `check_record` already proved equal
        // to the reviewed one.
        let target = self
            .reviewed
            .as_ref()
            .map(|reviewed| &reviewed.target)
            .or(self.echoed_target.as_ref());
        match target {
            Some(target) => target_matches(
                target,
                &context,
                generation,
                self.service.contexts.active_profile_id(),
            ),
            None => false,
        }
    }

    fn on_reviewed(&mut self, reviewed: &IssuedConfirmation<Self::Target, Self::Digest>) {
        self.reviewed = Some(reviewed.clone());
    }

    fn lane(&mut self, _operation_id: &str) -> BoxFuture<'_, Option<MutationLane>> {
        Box::pin(async move {
            match self.admitted {
                Some(_) => None,
                None => {
                    let (context, _) = self.service.contexts.snapshot();
                    let guard = self
                        .service
                        .repository
                        .lock_mutations(&context.server)
                        .await;
                    Some(Box::new(guard) as MutationLane)
                }
            }
        })
    }

    fn recheck(&mut self) -> BoxFuture<'_, Result<MutationInspection, String>> {
        Box::pin(async move {
            let reviewed = self
                .reviewed
                .clone()
                .ok_or_else(|| "The Branch Mapping review is unavailable.".to_string())?;
            let (context, generation) = self.service.contexts.snapshot();
            let recheck_request = BranchMutationPreflightRequest {
                mode: reviewed.target.mode,
                name: reviewed.target.name.clone(),
                desired: reviewed.target.desired.clone(),
                operation_id: None,
            };
            let reinspection = self
                .service
                .inspect_mutation(
                    &context,
                    generation,
                    self.service.contexts.active_profile_id(),
                    &recheck_request,
                    &format!("{}:recheck", self.root_id),
                    self.app,
                )
                .await;
            self.recheck_operation_ids = reinspection.operation_ids.clone();
            Ok(reinspection)
        })
    }

    fn recheck_verdict(&self, reinspection: &MutationInspection) -> RecheckVerdict {
        let Some(reviewed) = self.reviewed.as_ref() else {
            return RecheckVerdict::Changed;
        };
        if !reinspection.blockers.is_empty()
            || reinspection.target.as_ref() != Some(&reviewed.target)
            || digest(&(
                reinspection.target.as_ref(),
                &reinspection.blockers,
                &reinspection.warnings,
            )) != reviewed.digest.preview_digest
        {
            return RecheckVerdict::Changed;
        }
        RecheckVerdict::Unchanged
    }

    fn gate(&self) -> Arc<AsyncMutex<()>> {
        self.service.confirmation_gate.clone()
    }

    fn execute<'b>(
        &'b mut self,
        _recheck: MutationInspection,
        _operation_id: String,
    ) -> BoxFuture<'b, Result<BranchMutationResult, Self::Error>> {
        Box::pin(async move {
            let service = self.service;
            let reviewed = match self.reviewed.clone() {
                Some(reviewed) => reviewed,
                None => {
                    return Err(refused_branch(
                        BranchMutationFailureCode::TokenUnknown,
                        "The Branch Mapping review is unavailable.",
                    ))
                }
            };
            // One root id for the whole attempt: the re-check, the write and
            // the verification must stay siblings, or the returned
            // `operation_ids` and cancellation grouping drift apart.
            let root_id = self.root_id.clone();
            let group = service.runner.begin_operation_group(root_id.clone());
            let (context, _) = service.contexts.snapshot();
            let owned_guard;
            let guard = match self.admitted {
                Some(guard) => guard,
                None => {
                    // `lane()` already took the lane when nothing was admitted;
                    // this keeps the admitted path identical to before.
                    owned_guard = service.repository.lock_mutations(&context.server).await;
                    &owned_guard
                }
            };
            if group.ensure_active().is_err() {
                // Same shape the hand-written flow produced for a closed lane.
                return Err(ConfirmRefusal::Cancelled);
            }
            Ok(service
                .run_branch_mutation(
                    &reviewed.target,
                    self.recheck_operation_ids.clone(),
                    guard,
                    root_id,
                    self.app,
                )
                .await)
        })
    }
}

fn refused_branch(
    code: BranchMutationFailureCode,
    message: &'static str,
) -> ConfirmRefusal<BranchMutationFailureCode> {
    ConfirmRefusal::Refused {
        shared: ConfirmationRefusalCode::Cancelled,
        code,
        message: message.to_string(),
        recheck: None,
    }
}

/// Map a ticket refusal onto the branch-mutation wire shape. Refusals decided
/// after the re-check keep pointing at the re-check's log entries.
fn branch_refusal_result(
    refusal: ConfirmRefusal<BranchMutationFailureCode>,
    spec: &BranchReviewSpec<'_>,
) -> BranchMutationResult {
    if refusal.is_cancelled() {
        return cancelled(spec.root_id.clone());
    }
    let code = refusal
        .code()
        .unwrap_or(BranchMutationFailureCode::Cancelled);
    let message = refusal
        .message()
        .unwrap_or("The Branch Mapping mutation was cancelled before it executed.");
    match refusal.after_recheck() {
        true => rejected_with_operation(code, message, spec.recheck_operation_ids.clone()),
        false => rejected(code, message),
    }
}

fn snapshot_from_batch(batch: BranchListBatch, scope: BranchMappingScope) -> ListSnapshot {
    let matched_count = batch.items.len();
    ListSnapshot {
        created_at_ms: now_u64(),
        scope,
        items: batch.items,
        partial: batch.truncated || batch.invalid_record_count > 0,
        truncated: batch.truncated,
        stats: BranchMappingStats {
            scanned_count: batch.scanned_count,
            matched_count,
            returned_count: 0,
            invalid_record_count: batch.invalid_record_count,
            safety_limit: BRANCH_SCAN_LIMIT,
        },
        operation_ids: batch.operation_ids,
        next_cursor_id: None,
    }
}

fn normalize_query(
    mut query: BranchMappingQuery,
) -> Result<BranchMappingQuery, BranchMappingRequestError> {
    validate_request_identity(&query.operation_id, query.request_generation)?;
    if !(1..=200).contains(&query.page_size) {
        return Err(request_error(
            BranchMappingRequestErrorCode::InvalidQuery,
            "Branch Mapping page size must be between 1 and 200.",
        ));
    }
    query.name_filter = query
        .name_filter
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty());
    query.owner = query
        .owner
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty());
    if let Some(filter) = query.name_filter.as_deref() {
        if filter.chars().count() > 128
            || filter.chars().any(|character| {
                character.is_control() || matches!(character, '*' | '%' | '@' | '#')
            })
        {
            return Err(request_error(
                BranchMappingRequestErrorCode::InvalidQuery,
                "Branch Mapping name filter must be a literal value.",
            ));
        }
    }
    if let Some(owner) = query.owner.as_deref() {
        validate_name(owner).map_err(|message| {
            request_error(BranchMappingRequestErrorCode::InvalidQuery, message)
        })?;
    }
    Ok(query)
}

fn validate_request_identity(
    operation_id: &str,
    request_generation: u64,
) -> Result<(), BranchMappingRequestError> {
    if request_generation == 0 || !valid_operation_id(operation_id) {
        return Err(request_error(
            BranchMappingRequestErrorCode::InvalidQuery,
            "A valid operation ID and positive request generation are required.",
        ));
    }
    Ok(())
}

fn scope(context: &P4Context, generation: u64, profile: Option<String>) -> BranchMappingScope {
    BranchMappingScope {
        active_profile_id: profile,
        context_generation: generation,
        server: context.server.clone(),
        user: context.user.clone(),
        client: context.client.clone(),
    }
}

fn ensure_context(
    contexts: &ContextStore,
    expected: &P4Context,
    generation: u64,
    profile: &Option<String>,
) -> Result<(), BranchMappingRequestError> {
    let (current, current_generation) = contexts.snapshot();
    if current != *expected
        || current_generation != generation
        || contexts.active_profile_id() != *profile
    {
        return Err(request_error(
            BranchMappingRequestErrorCode::ConnectionChanged,
            "The active profile, connection, Client, or generation changed.",
        ));
    }
    Ok(())
}

fn target_matches(
    target: &BranchMutationTarget,
    context: &P4Context,
    generation: u64,
    profile: Option<String>,
) -> bool {
    target.active_profile_id == profile
        && target.context_generation == generation
        && target.server == context.server
        && target.user == context.user
        && target.client == context.client
}

fn spec_digest(detail: &BranchMappingDetail) -> String {
    digest(&(
        &detail.name,
        &detail.owner,
        &detail.update,
        &detail.access,
        &detail.description,
        detail.locked,
        &detail.view,
        &detail.unknown_fields,
        detail.editable,
    ))
}

fn draft_matches(detail: &BranchMappingDetail, expected: &BranchMappingDraft) -> bool {
    detail.editable
        && detail.name == expected.name
        && detail.owner == expected.owner
        && detail.description.trim() == expected.description.trim()
        && detail.locked == expected.locked
        && detail.view == expected.view
}

fn mutation_result(
    target: &BranchMutationTarget,
    execution: Result<OperationResult, String>,
    observed: Result<Option<BranchMappingDetail>, String>,
    context_current: bool,
    operation_ids: Vec<String>,
) -> BranchMutationResult {
    let command_succeeded = execution.as_ref().is_ok_and(|result| result.exit_code == 0);
    let permission_denied = execution.as_ref().is_ok_and(|result| {
        result
            .events
            .iter()
            .filter_map(|event| event.message.as_deref())
            .any(|message| {
                let message = message.to_ascii_lowercase();
                message.contains("permission")
                    || message.contains("protect")
                    || message.contains("access for user")
            })
    }) || execution.as_ref().is_err_and(|message| {
        let message = message.to_ascii_lowercase();
        message.contains("permission") || message.contains("protect")
    });
    let cancelled = execution.as_ref().is_ok_and(|result| {
        result
            .events
            .iter()
            .any(|event| matches!(event.kind, EventKind::Cancelled))
    }) || execution
        .as_ref()
        .is_err_and(|message| message.to_ascii_lowercase().contains("cancel"));
    let verified = match (&target.mode, &observed) {
        (BranchMutationMode::Delete, Ok(None)) => true,
        (BranchMutationMode::Create | BranchMutationMode::Edit, Ok(Some(detail))) => target
            .desired
            .as_ref()
            .is_some_and(|draft| draft_matches(detail, draft)),
        _ => false,
    };
    let observed_detail = observed.ok().flatten();
    if command_succeeded && verified && context_current {
        return BranchMutationResult {
            outcome: BranchMutationOutcome::Succeeded,
            failure: None,
            message: "The Branch Mapping mutation was verified by the server; no integration or workspace file change was performed.".into(),
            observed: observed_detail,
            operation_ids,
            refresh_branch_mappings: true,
        };
    }
    let (outcome, failure, message) = if cancelled && !verified {
        (
            BranchMutationOutcome::Cancelled,
            BranchMutationFailureCode::Cancelled,
            "The Branch Mapping mutation was cancelled; refresh before retrying.",
        )
    } else if permission_denied && !verified {
        (
            BranchMutationOutcome::Failed,
            BranchMutationFailureCode::PermissionDenied,
            "Server permissions rejected the Branch Mapping mutation; refresh before retrying.",
        )
    } else if !command_succeeded && !verified && execution.is_ok() {
        (
            BranchMutationOutcome::Failed,
            BranchMutationFailureCode::CommandFailure,
            "The server rejected the Branch Mapping mutation; refresh before retrying.",
        )
    } else {
        (BranchMutationOutcome::Unknown, BranchMutationFailureCode::UncertainOutcome, "The Branch Mapping mutation could not be verified reliably; refresh and inspect the server before retrying.")
    };
    BranchMutationResult {
        outcome,
        failure: Some(failure),
        message: message.into(),
        observed: observed_detail,
        operation_ids,
        refresh_branch_mappings: true,
    }
}

fn issue(code: BranchIssueCode, message: impl Into<String>) -> BranchIssue {
    BranchIssue {
        code,
        message: message.into(),
    }
}

fn blocked_preview(
    query: &BranchImpactPreviewQuery,
    code: BranchIssueCode,
    message: impl Into<String>,
    operation_ids: Vec<String>,
) -> BranchImpactPreview {
    BranchImpactPreview {
        request_generation: query.request_generation,
        name: query.name.clone(),
        direction: query.direction,
        items: Vec::new(),
        blockers: vec![issue(code, message)],
        partial: true,
        truncated: false,
        scanned_count: 0,
        safety_limit: query.limit,
        operation_ids,
        simulated: false,
    }
}

fn rejected(
    failure: BranchMutationFailureCode,
    message: impl Into<String>,
) -> BranchMutationResult {
    BranchMutationResult {
        outcome: BranchMutationOutcome::Rejected,
        failure: Some(failure),
        message: message.into(),
        observed: None,
        operation_ids: Vec::new(),
        refresh_branch_mappings: true,
    }
}

fn rejected_with_operation(
    failure: BranchMutationFailureCode,
    message: impl Into<String>,
    operation_ids: Vec<String>,
) -> BranchMutationResult {
    let mut result = rejected(failure, message);
    result.operation_ids = operation_ids;
    result
}

fn cancelled(operation_id: String) -> BranchMutationResult {
    BranchMutationResult {
        outcome: BranchMutationOutcome::Cancelled,
        failure: Some(BranchMutationFailureCode::Cancelled),
        message: "The Branch Mapping mutation was cancelled before execution.".into(),
        observed: None,
        operation_ids: vec![operation_id],
        refresh_branch_mappings: true,
    }
}

fn repository_error(message: &str) -> BranchMappingRequestError {
    request_error(
        if message.to_ascii_lowercase().contains("cancel") {
            BranchMappingRequestErrorCode::Cancelled
        } else {
            BranchMappingRequestErrorCode::QueryFailed
        },
        message,
    )
}

fn request_error(
    code: BranchMappingRequestErrorCode,
    message: impl Into<String>,
) -> BranchMappingRequestError {
    BranchMappingRequestError {
        code,
        message: message.into(),
    }
}

fn digest<T: Serialize>(value: &T) -> String {
    Sha256::digest(serde_json::to_vec(value).unwrap_or_default())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn valid_operation_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | ':')
        })
}

fn safe_operation_id(value: Option<&str>, prefix: &str) -> String {
    value
        .filter(|value| valid_operation_id(value))
        .map(str::to_owned)
        .unwrap_or_else(|| format!("{prefix}-{}", Uuid::new_v4()))
}

fn now_u64() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn now_i64() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::confirmation::ConfirmationStore;

    fn detail(name: &str) -> BranchMappingDetail {
        BranchMappingDetail {
            name: name.into(),
            owner: "alice".into(),
            update: Some("1".into()),
            access: Some("2".into()),
            description: "mapping".into(),
            locked: false,
            view: vec![BranchViewLine {
                modifier: BranchViewModifier::Map,
                source: Some("//d/a/...".into()),
                target: Some("//d/b/...".into()),
                comment: None,
                unknown: None,
            }],
            unknown_fields: Vec::new(),
            editable: true,
            operation_ids: Vec::new(),
            simulated: false,
        }
    }

    #[test]
    fn spec_digest_binds_unknown_fields_and_update_state() {
        let mut value = detail("map-one");
        let first = spec_digest(&value);
        value.update = Some("2".into());
        assert_ne!(first, spec_digest(&value));
        value.unknown_fields.push(BranchUnknownField {
            name: "Future".into(),
            value: "x".into(),
        });
        assert_ne!(first, spec_digest(&value));
    }

    #[test]
    fn verified_result_never_claims_success_for_unknown_outcome() {
        let draft = BranchMappingDraft {
            name: "map-one".into(),
            owner: "alice".into(),
            description: "mapping".into(),
            locked: false,
            view: detail("map-one").view,
        };
        let target = BranchMutationTarget {
            active_profile_id: None,
            context_generation: 1,
            server: "s".into(),
            user: "alice".into(),
            client: "c".into(),
            mode: BranchMutationMode::Edit,
            name: "map-one".into(),
            current_exists: true,
            current_digest: Some("old".into()),
            desired: Some(draft),
            desired_digest: Some("new".into()),
        };
        let result = mutation_result(
            &target,
            Err("operation timed out".into()),
            Ok(Some(detail("map-one"))),
            true,
            vec![],
        );
        assert_eq!(result.outcome, BranchMutationOutcome::Unknown);
    }

    #[test]
    fn permission_rejection_is_structured_and_never_claims_success() {
        let target = BranchMutationTarget {
            active_profile_id: None,
            context_generation: 1,
            server: "s".into(),
            user: "alice".into(),
            client: "c".into(),
            mode: BranchMutationMode::Delete,
            name: "map-one".into(),
            current_exists: true,
            current_digest: Some("old".into()),
            desired: None,
            desired_digest: None,
        };
        let execution = OperationResult {
            operation_id: "permission-denied".into(),
            exit_code: 1,
            events: vec![OperationEvent {
                operation_id: "permission-denied".into(),
                kind: EventKind::Stderr,
                message: Some("Protections table denies permission".into()),
                progress: None,
                timestamp: "2026-10-10T00:00:00Z".into(),
            }],
            duration_ms: 1,
        };
        let result = mutation_result(
            &target,
            Ok(execution),
            Ok(Some(detail("map-one"))),
            true,
            vec![],
        );
        assert_eq!(result.outcome, BranchMutationOutcome::Failed);
        assert_eq!(
            result.failure,
            Some(BranchMutationFailureCode::PermissionDenied)
        );
    }

    #[test]
    fn query_normalization_rejects_forged_filters_and_bounds() {
        let valid = BranchMappingQuery {
            operation_id: "branch-list".into(),
            request_generation: 1,
            name_filter: Some(" release ".into()),
            owner: Some("alice".into()),
            page_size: 200,
            cursor: None,
        };
        assert_eq!(
            normalize_query(valid.clone())
                .unwrap()
                .name_filter
                .as_deref(),
            Some("release")
        );
        let mut invalid = valid.clone();
        invalid.name_filter = Some("*".into());
        assert!(normalize_query(invalid).is_err());
        let mut invalid = valid;
        invalid.page_size = 201;
        assert!(normalize_query(invalid).is_err());
    }

    #[test]
    fn confirmation_store_consumes_once_and_expires() {
        let store = ConfirmationStore::default();
        let target = BranchMutationTarget {
            active_profile_id: None,
            context_generation: 1,
            server: "s".into(),
            user: "alice".into(),
            client: "c".into(),
            mode: BranchMutationMode::Delete,
            name: "map".into(),
            current_exists: true,
            current_digest: Some("a".into()),
            desired: None,
            desired_digest: None,
        };
        let token = store.issue(
            IssuedConfirmation::new(
                target.clone(),
                BranchReview {
                    preview_digest: "x".into(),
                },
                10,
            ),
            0,
        );
        assert!(store.consume(&token).is_some());
        assert!(store.consume(&token).is_none());
        let expired = store.issue(
            IssuedConfirmation::new(
                target,
                BranchReview {
                    preview_digest: "x".into(),
                },
                1,
            ),
            0,
        );
        let _ = store.issue(
            IssuedConfirmation::new(
                BranchMutationTarget {
                    active_profile_id: None,
                    context_generation: 1,
                    server: "s".into(),
                    user: "alice".into(),
                    client: "c".into(),
                    mode: BranchMutationMode::Delete,
                    name: "other".into(),
                    current_exists: true,
                    current_digest: Some("b".into()),
                    desired: None,
                    desired_digest: None,
                },
                BranchReview {
                    preview_digest: "y".into(),
                },
                20,
            ),
            2,
        );
        assert!(store.consume(&expired).is_none());
    }
}
