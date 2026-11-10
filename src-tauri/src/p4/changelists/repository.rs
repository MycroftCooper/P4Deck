use super::{command, parser};
use crate::{
    domain::*,
    p4::{query as stable_query, runner::P4Runner},
};
use chrono::DateTime;
use serde_json::json;
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    sync::Arc,
};
use tauri::AppHandle;

pub struct ChangelistRepository {
    runner: Arc<P4Runner>,
}

pub struct PendingMutationExecution {
    pub operation: OperationResult,
    pub created_change_id: Option<i64>,
    pub affected_changes: Vec<i64>,
    pub affected_paths: Vec<String>,
}

pub struct PendingScan {
    pub changes: Vec<PendingChange>,
    pub scanned_count: usize,
    pub truncated_by_safety_limit: bool,
}

/// Shown for pending/shelved changelists, where opened files belong to the
/// owner's client and only the shelf can be inspected from another workspace.
const PENDING_DETAIL_MESSAGE: &str = "This changelist is pending; opened files belong to its owner's client and only shelved files are listed.";

/// Projects a `describe -s -S` detail of a pending/shelved changelist onto the
/// `PendingChange` shape used by workflow preflights. Shelf records carry no
/// workspace state, so `files` (opened files) stays empty by design.
pub(crate) fn pending_from_shelved_detail(detail: SubmittedChangeDetail) -> PendingChange {
    PendingChange {
        id: detail.change_id,
        description: detail.description,
        user: detail.user,
        client: detail.client,
        status: detail.status,
        updated_at: (!detail.time.is_empty()).then_some(detail.time),
        jobs: detail.jobs,
        files: Vec::new(),
        shelved_files: detail
            .files
            .into_iter()
            .map(|file| PendingFile {
                depot_path: file.depot_path,
                action: file.action,
                state: None,
                client_path: None,
                revision: file.revision,
                head_revision: None,
                file_type: file.file_type,
                lock_ownership: None,
                lock_owner: None,
                other_open: Vec::new(),
                exclusive_open: None,
                resolve: None,
            })
            .collect(),
    }
}

impl ChangelistRepository {
    pub fn new(runner: Arc<P4Runner>) -> Self {
        Self { runner }
    }

    pub async fn query(
        &self,
        context: P4Context,
        query: ClQuery,
        connection_generation: u64,
        known_details: &HashMap<i64, SubmittedChangeDetail>,
        app: Option<&AppHandle>,
    ) -> Result<ClQueryResult, String> {
        let query = normalize_query(query)?;
        if query.streams.is_empty() {
            return self
                .query_single(context, query, connection_generation, known_details, app)
                .await;
        }
        let fingerprint = semantic_query_fingerprint(&query)?;
        let connection = stable_query::fingerprint(&context)?;
        let upper = query
            .cursor
            .as_deref()
            .map(|cursor| {
                stable_query::decode_change_cursor(
                    cursor,
                    &fingerprint,
                    &connection,
                    connection_generation,
                )
            })
            .transpose()?;
        let mut pages = Vec::new();
        for stream in &query.streams {
            let mut child = query.clone();
            child.streams.clear();
            child.stream = Some(stream.clone());
            if child.depot_path.as_ref().is_some_and(|path| {
                path.ends_with("...") && stream.starts_with(path.trim_end_matches("..."))
            }) {
                child.depot_path = None;
            }
            child.cursor = upper
                .map(|bound| {
                    stable_query::encode_change_cursor(
                        bound,
                        &semantic_query_fingerprint(&child)?,
                        &connection,
                        connection_generation,
                    )
                })
                .transpose()?;
            let page = self
                .query_single(
                    context.clone(),
                    child,
                    connection_generation,
                    known_details,
                    app,
                )
                .await?;
            if page.stats.truncated_by_safety_limit {
                return Err("Stream union scan is incomplete; narrow the date range or stream selection before retrying.".into());
            }
            pages.push(page);
        }
        let mut result = merge_stream_pages(pages, query.page_size, query.request_generation);
        if result.has_more {
            let bound = result
                .items
                .last()
                .and_then(|item| item.id.checked_sub(1))
                .filter(|id| *id > 0);
            result.next_cursor = bound
                .map(|bound| {
                    stable_query::encode_change_cursor(
                        bound,
                        &fingerprint,
                        &connection,
                        connection_generation,
                    )
                })
                .transpose()?;
            result.has_more = result.next_cursor.is_some();
        }
        Ok(result)
    }

    async fn query_single(
        &self,
        context: P4Context,
        query: ClQuery,
        connection_generation: u64,
        known_details: &HashMap<i64, SubmittedChangeDetail>,
        app: Option<&AppHandle>,
    ) -> Result<ClQueryResult, String> {
        const MAX_SCAN: usize = 5_000;
        const MAX_FIXES: usize = 5_000;
        let query = normalize_query(query)?;
        let query_fingerprint = semantic_query_fingerprint(&query)?;
        let connection_fingerprint = stable_query::fingerprint(&context)?;
        let mut upper_change_id = query
            .cursor
            .as_deref()
            .map(|cursor| {
                stable_query::decode_change_cursor(
                    cursor,
                    &query_fingerprint,
                    &connection_fingerprint,
                    connection_generation,
                )
            })
            .transpose()?;
        let operation_id = Some(query.operation_id.clone());
        let mut job_change_ids = None;
        let mut truncated_by_safety_limit = false;
        if !query.jobs.is_empty() {
            let mut union = HashSet::new();
            for job in &query.jobs {
                let result = self
                    .run(
                        &context,
                        command::job_fixes_invocation(job, MAX_FIXES + 1)?,
                        operation_id.clone(),
                        app,
                    )
                    .await?;
                let mut ids = parser::parse_fix_change_ids(&result.events);
                if ids.len() > MAX_FIXES {
                    ids.truncate(MAX_FIXES);
                    truncated_by_safety_limit = true;
                }
                union.extend(ids);
            }
            job_change_ids = Some(union);
        }

        let page_size = query.page_size;
        let batch_size = (page_size.saturating_mul(2)).clamp(50, 500);
        let mut items = Vec::with_capacity(page_size);
        let mut scanned_count = 0;
        let mut hidden_reliable_merge_count = 0;
        let mut has_more = false;
        let mut next_upper_change_id = None;

        'scan: while scanned_count < MAX_SCAN {
            let request_size = batch_size.min(MAX_SCAN - scanned_count);
            let result = self
                .run(
                    &context,
                    command::query_invocation(&query, request_size, upper_change_id)?,
                    operation_id.clone(),
                    app,
                )
                .await?;
            let mut batch = parser::parse_submitted_page(&result.events)?;
            batch.sort_by_key(|change| std::cmp::Reverse(change.id));
            batch.dedup_by_key(|change| change.id);
            if let Some(upper) = upper_change_id {
                batch.retain(|change| change.id <= upper);
            }
            if batch.is_empty() {
                break;
            }
            scanned_count += batch.len();
            let batch_was_full = batch.len() >= request_size;
            let after_batch = batch
                .iter()
                .map(|change| change.id)
                .min()
                .and_then(|change_id| change_id.checked_sub(1))
                .filter(|change_id| *change_id > 0);

            let needs_metadata = query.has_job.is_some()
                || !query.merge_classifications.is_empty()
                || query.hide_reliable_merges
                || !query.keyword.is_empty();
            let metadata = if needs_metadata {
                self.query_metadata(&context, &batch, operation_id.clone(), app)
                    .await?
            } else {
                HashMap::new()
            };

            for mut change in batch {
                if let Some(metadata) = metadata.get(&change.id) {
                    change.jobs = metadata.jobs.clone();
                    change.file_count = metadata.file_count;
                    if metadata.merge_classification == MergeClassification::ReliableMerge {
                        change.merge_classification = MergeClassification::ReliableMerge;
                    }
                }
                if let Some(detail) = known_details.get(&change.id) {
                    change.jobs = detail.jobs.clone();
                    change.file_count = detail.files.len();
                    change.merge_classification = detail.merge_classification.clone();
                }
                if let Some(stream) = &query.stream {
                    change.stream = Some(stream.clone());
                }
                if let Some(job_ids) = &job_change_ids {
                    if !job_ids.contains(&change.id) {
                        continue;
                    }
                    for job in &query.jobs {
                        if !change.jobs.contains(job) {
                            change.jobs.push(job.clone());
                        }
                    }
                }
                let extra_search_text = metadata
                    .get(&change.id)
                    .map(|metadata| metadata.search_text.as_str())
                    .unwrap_or_default();
                if !matches_query(&change, &query, extra_search_text) {
                    continue;
                }
                if query.hide_reliable_merges
                    && change.merge_classification == MergeClassification::ReliableMerge
                {
                    hidden_reliable_merge_count += 1;
                    continue;
                }
                if items.len() == page_size {
                    has_more = true;
                    next_upper_change_id = Some(change.id);
                    break 'scan;
                }
                items.push(change);
            }

            if !batch_was_full || after_batch.is_none() {
                break;
            }
            upper_change_id = after_batch;
            if scanned_count >= MAX_SCAN {
                has_more = true;
                truncated_by_safety_limit = true;
                next_upper_change_id = upper_change_id;
            }
        }
        let next_cursor = if has_more {
            next_upper_change_id
                .map(|upper| {
                    stable_query::encode_change_cursor(
                        upper,
                        &query_fingerprint,
                        &connection_fingerprint,
                        connection_generation,
                    )
                })
                .transpose()?
        } else {
            None
        };
        Ok(ClQueryResult {
            request_generation: query.request_generation,
            stats: ClQueryStats {
                scanned_count,
                matched_count: items.len(),
                hidden_reliable_merge_count,
                truncated_by_safety_limit,
            },
            items,
            has_more,
            next_cursor,
        })
    }

    async fn query_metadata(
        &self,
        context: &P4Context,
        changes: &[ChangelistSummary],
        operation_id: Option<String>,
        app: Option<&AppHandle>,
    ) -> Result<HashMap<i64, parser::SubmittedQueryMetadata>, String> {
        let mut metadata = HashMap::new();
        for chunk in changes.chunks(100) {
            let ids = chunk.iter().map(|change| change.id).collect::<Vec<_>>();
            let result = self
                .run_detail(
                    context,
                    command::query_describe_invocation(&ids)?,
                    operation_id.clone(),
                    app,
                )
                .await?;
            metadata.extend(parser::parse_query_metadata(&result.events));
        }
        Ok(metadata)
    }

    /// Exact numbered-CL identity, without scanning unrelated pending changes.
    pub async fn pending_identity(
        &self,
        context: &P4Context,
        change_id: i64,
        operation_id: String,
        app: Option<&AppHandle>,
    ) -> Result<PendingChange, String> {
        let result = self
            .run(
                context,
                command::pending_metadata_invocation(&[change_id])?,
                Some(operation_id),
                app,
            )
            .await?;
        let spec = parser::parse_pending_metadata(&result.events)
            .remove(&change_id)
            .ok_or_else(|| format!("p4 describe omitted changelist {change_id}"))?;
        if spec.id != change_id
            || spec.user != context.user
            || spec.client != context.client
            || spec.status != "pending"
        {
            return Err("Changelist is outside the current pending user/client scope".into());
        }
        Ok(PendingChange {
            id: spec.id,
            description: spec.description,
            user: spec.user,
            client: spec.client,
            status: spec.status,
            updated_at: None,
            jobs: spec.jobs,
            files: Vec::new(),
            shelved_files: Vec::new(),
        })
    }
    pub async fn query_pending(
        &self,
        context: P4Context,
        app: Option<&AppHandle>,
    ) -> Result<Vec<PendingChange>, String> {
        Ok(self
            .query_pending_scan(context, None, None, app)
            .await?
            .changes)
    }

    pub async fn query_pending_bounded(
        &self,
        context: P4Context,
        max_changes: usize,
        max_files: usize,
        operation_id: Option<String>,
        app: Option<&AppHandle>,
    ) -> Result<PendingScan, String> {
        if max_changes == 0 || max_changes > 5_000 {
            return Err("pending changelist scan cap must be between 1 and 5000".into());
        }
        if max_files == 0 || max_files > 100_000 {
            return Err("pending file scan cap must be between 1 and 100000".into());
        }
        self.query_pending_scan(context, Some((max_changes, max_files)), operation_id, app)
            .await
    }

    async fn query_pending_scan(
        &self,
        context: P4Context,
        limits: Option<(usize, usize)>,
        operation_id: Option<String>,
        app: Option<&AppHandle>,
    ) -> Result<PendingScan, String> {
        let _group = operation_id
            .as_ref()
            .map(|id| self.runner.begin_operation_group(id.clone()));
        let child_operation = |step: &str| operation_id.as_ref().map(|id| format!("{id}:{step}"));
        let pending_invocation = match limits {
            Some((max_changes, _)) => {
                command::pending_changes_bounded_invocation(&context, max_changes + 1)?
            }
            None => command::pending_changes_invocation(&context)?,
        };
        let opened_invocation = match limits {
            Some((_, max_files)) => command::opened_bounded_invocation(&context, max_files + 1)?,
            None => command::opened_invocation(&context)?,
        };
        let shelved_invocation = match limits {
            Some((max_changes, _)) => {
                command::shelved_changes_bounded_invocation(&context, max_changes + 1)?
            }
            None => command::shelved_changes_invocation(&context)?,
        };
        let (pending, opened, shelved) = tokio::join!(
            self.run(
                &context,
                pending_invocation,
                child_operation("changes"),
                app
            ),
            self.run_allow_empty_opened_with_operation(
                &context,
                opened_invocation,
                child_operation("opened"),
                app,
            ),
            self.run(
                &context,
                shelved_invocation,
                child_operation("shelves"),
                app
            ),
        );
        let (pending, opened, shelved) = (pending?, opened?, shelved?);

        let mut parsed_changes = parser::parse_pending_changes(
            &pending.events,
            context.user.trim(),
            context.client.trim(),
        );
        let mut opened_files = parser::parse_opened_files(&opened.events);
        let mut shelved_ids = parser::parse_shelved_change_ids(
            &shelved.events,
            context.user.trim(),
            context.client.trim(),
        );
        let mut truncated_by_safety_limit = false;
        if let Some((max_changes, max_files)) = limits {
            if parsed_changes.len() > max_changes {
                parsed_changes.truncate(max_changes);
                truncated_by_safety_limit = true;
            }
            if opened_files.len() > max_files {
                opened_files.truncate(max_files);
                truncated_by_safety_limit = true;
            }
            if shelved_ids.len() > max_changes {
                shelved_ids.truncate(max_changes);
                truncated_by_safety_limit = true;
            }
        }
        if !opened_files.is_empty() {
            let depot_paths = opened_files
                .iter()
                .map(|(_, file)| file.depot_path.clone())
                .collect::<Vec<_>>();
            if let Ok(invocation) = crate::p4::locks::command::fstat_status(&depot_paths) {
                let lock_operation_id = operation_id
                    .as_deref()
                    .map(|id| format!("{id}:lock-status"));
                if let Ok(lock_status) = self
                    .run_lock_status(&context, invocation, lock_operation_id, app)
                    .await
                {
                    let facts = crate::p4::locks::parser::file_facts(&lock_status.events);
                    parser::merge_lock_status(&mut opened_files, &facts);
                }
            }
        }
        if !opened_files.is_empty() {
            let resolve_invocation = command::P4Invocation {
                command: "resolve",
                args: vec!["-n".into()],
                input: None,
            };
            // Text mode: `resolve -n` prints plain <path> - merging lines, not marshal JSON.
            if let Ok(result) = self
                .run_preview(
                    &context,
                    resolve_invocation,
                    child_operation("resolve-preview"),
                    OutputMode::Text,
                    app,
                )
                .await
            {
                let preview = parser::parse_resolve_preview(&result.events);
                for (_, file) in opened_files.iter_mut() {
                    let by_client = file
                        .client_path
                        .as_deref()
                        .map(parser::normalize_client_path)
                        .is_some_and(|path| {
                            preview
                                .client_paths
                                .iter()
                                .any(|local| local == &path || local.ends_with(&path))
                        });
                    // resolve -n prints the *local* path first; the depot token is the merge source,
                    // which may live in another stream, so client-path matching is authoritative.
                    if by_client || preview.depot_paths.contains(&file.depot_path) {
                        file.resolve = Some("unresolved".into());
                    }
                }
            }
        }
        let scanned_count = parsed_changes.len();
        let mut changes = parsed_changes
            .into_iter()
            .map(|change| (change.id, change))
            .collect::<BTreeMap<_, _>>();
        changes.insert(
            0,
            PendingChange {
                id: 0,
                description: String::new(),
                user: context.user.clone(),
                client: context.client.clone(),
                status: "pending".into(),
                updated_at: None,
                jobs: Vec::new(),
                files: Vec::new(),
                shelved_files: Vec::new(),
            },
        );

        let numbered_ids = changes
            .keys()
            .copied()
            .filter(|id| *id > 0)
            .collect::<Vec<_>>();
        for (index, batch) in numbered_ids.chunks(100).enumerate() {
            let result = self
                .run(
                    &context,
                    command::pending_metadata_invocation(batch)?,
                    child_operation(&format!("metadata-{index}")),
                    app,
                )
                .await?;
            let mut metadata = parser::parse_pending_metadata(&result.events);
            for change_id in batch {
                let spec = metadata
                    .remove(change_id)
                    .ok_or_else(|| format!("p4 describe omitted changelist {change_id}"))?;
                if spec.id != *change_id
                    || spec.user != context.user
                    || spec.client != context.client
                    || spec.status != "pending"
                {
                    return Err(format!(
                        "changelist {change_id} is outside the current user/client scope"
                    ));
                }
                if let Some(change) = changes.get_mut(change_id) {
                    change.description = spec.description;
                    change.jobs = spec.jobs;
                }
            }
        }

        for (change_id, file) in opened_files {
            if limits.is_some() && change_id > 0 && !changes.contains_key(&change_id) {
                truncated_by_safety_limit = true;
                continue;
            }
            let change = changes.entry(change_id).or_insert_with(|| PendingChange {
                id: change_id,
                description: String::new(),
                user: context.user.clone(),
                client: context.client.clone(),
                status: "pending".into(),
                updated_at: None,
                jobs: Vec::new(),
                files: Vec::new(),
                shelved_files: Vec::new(),
            });
            change.files.push(file);
        }

        let shelved_ids = shelved_ids
            .into_iter()
            .filter(|id| changes.contains_key(id))
            .collect::<Vec<_>>();
        if !shelved_ids.is_empty() {
            let described = self
                .run(
                    &context,
                    command::describe_shelves_invocation(&shelved_ids)?,
                    child_operation("describe-shelves"),
                    app,
                )
                .await?;
            for (change_id, file) in parser::parse_shelved_files(&described.events) {
                if let Some(change) = changes.get_mut(&change_id) {
                    change.shelved_files.push(file);
                }
            }
        }

        let mut result = changes.into_values().collect::<Vec<_>>();
        result.sort_by_key(|change| if change.id == 0 { i64::MIN } else { -change.id });
        Ok(PendingScan {
            changes: result,
            scanned_count,
            truncated_by_safety_limit,
        })
    }

    pub async fn submitted_detail(
        &self,
        context: &P4Context,
        request: &SubmittedChangeDetailRequest,
        app: Option<&AppHandle>,
    ) -> Result<SubmittedChangeDetail, String> {
        if request.change_id <= 0 {
            return Err("a positive submitted changelist ID is required".into());
        }
        if request.operation_id.trim().is_empty() || request.operation_id.len() > 128 {
            return Err("a valid operation ID is required".into());
        }
        let operation_id = Some(request.operation_id.clone());
        let described = self
            .run_detail(
                context,
                command::submitted_detail_invocation(request.change_id)?,
                operation_id.clone(),
                app,
            )
            .await?;
        let mut detail = parser::parse_submitted_detail(&described.events, request.change_id)?;
        if detail.status != "submitted" {
            return self
                .shelved_only_detail(context, request, detail, operation_id, app)
                .await;
        }
        if !detail.integration_evidence.is_empty() {
            return Ok(detail);
        }
        const MAX_FILELOG_FILES: usize = 64;
        const MAX_FILELOG_ARGUMENT_BYTES: usize = 24 * 1024;
        let filelog_argument_bytes = detail
            .files
            .iter()
            .map(|file| file.depot_path.len() + 32)
            .sum::<usize>();
        if detail.files.len() > MAX_FILELOG_FILES
            || filelog_argument_bytes > MAX_FILELOG_ARGUMENT_BYTES
        {
            detail.inspection_status = SubmittedInspectionStatus::Partial;
            detail.message = Some(format!(
                "Integration inspection is bounded to {MAX_FILELOG_FILES} files and {MAX_FILELOG_ARGUMENT_BYTES} argument bytes; this changelist has {} files.",
                detail.files.len()
            ));
            return Ok(detail);
        }
        let filelog = self
            .run_detail(
                context,
                command::submitted_filelog_invocation(&detail.files)?,
                operation_id,
                app,
            )
            .await?;
        let evidence = parser::parse_filelog_integration_evidence(
            &filelog.events,
            request.change_id,
            &detail.files,
        )?;
        parser::finalize_submitted_classification(&mut detail, evidence);
        Ok(detail)
    }

    /// Fills a pending/shelved detail from `p4 describe -s -S <id>`: only shelf
    /// files are visible, zero shelves is a legitimate result, and no filelog
    /// integration inspection is attempted (there is no submitted revision).
    async fn shelved_only_detail(
        &self,
        context: &P4Context,
        request: &SubmittedChangeDetailRequest,
        mut detail: SubmittedChangeDetail,
        operation_id: Option<String>,
        app: Option<&AppHandle>,
    ) -> Result<SubmittedChangeDetail, String> {
        let shelved = self
            .run_detail(
                context,
                command::describe_shelves_invocation(&[request.change_id])?,
                operation_id,
                app,
            )
            .await?;
        detail.files = parser::parse_shelved_files(&shelved.events)
            .into_iter()
            .filter(|(change_id, _)| *change_id == request.change_id)
            .map(|(_, file)| SubmittedChangeFile {
                depot_path: file.depot_path,
                action: file.action,
                revision: file.revision,
                file_type: file.file_type,
            })
            .collect();
        detail.integration_evidence.clear();
        detail.merge_classification = MergeClassification::Unknown;
        detail.inspection_status = SubmittedInspectionStatus::Partial;
        detail.message = Some(PENDING_DETAIL_MESSAGE.into());
        Ok(detail)
    }

    /// Read-only lookup of any changelist's shelf via `p4 describe -s -S <id>`.
    /// Unlike `query_pending`, this is not limited to the current user/client, so
    /// a workflow can preflight unshelving from another user's pending changelist.
    /// Returns `None` for submitted changelists (they have no shelf to unshelve).
    pub async fn shelved_change(
        &self,
        context: &P4Context,
        change_id: i64,
        prefix: &str,
        app: Option<&AppHandle>,
    ) -> Result<Option<PendingChange>, String> {
        if change_id <= 0 {
            return Err("a positive source changelist is required".into());
        }
        let described = self
            .run_detail(
                context,
                command::describe_shelves_invocation(&[change_id])?,
                Some(format!("{prefix}:describe")),
                app,
            )
            .await?;
        let detail = parser::parse_submitted_detail(&described.events, change_id)?;
        if detail.status == "submitted" {
            return Ok(None);
        }
        Ok(Some(pending_from_shelved_detail(detail)))
    }

    pub async fn perform_pending(
        &self,
        context: P4Context,
        request: &PendingChangeMutationRequest,
        preserved_files: &[String],
        app: Option<&AppHandle>,
    ) -> Result<PendingMutationExecution, String> {
        let prepared = command::pending_mutation_invocation(&request.mutation, preserved_files)?;
        let output_mode = if prepared.invocation.input.is_some() {
            OutputMode::Text
        } else {
            OutputMode::JsonLines
        };
        let operation = self
            .run_mode(
                &context,
                prepared.invocation,
                request.operation_id.clone(),
                output_mode,
                app,
            )
            .await?;
        let created_change_id = if matches!(request.mutation, PendingChangeMutation::Create { .. })
        {
            parser::parse_created_change_id(&operation)
        } else {
            None
        };
        let mut affected_changes = prepared.affected_changes;
        if let Some(change_id) = created_change_id {
            affected_changes.push(change_id);
        }
        Ok(PendingMutationExecution {
            operation,
            created_change_id,
            affected_changes,
            affected_paths: prepared.affected_paths,
        })
    }

    pub async fn local_paths(
        &self,
        context: &P4Context,
        depot_paths: &[String],
        app: Option<&AppHandle>,
    ) -> Result<Vec<String>, String> {
        if depot_paths.is_empty() {
            return Ok(Vec::new());
        }
        let result = self
            .run(context, command::where_invocation(depot_paths)?, None, app)
            .await?;
        Ok(parser::parse_where_paths(&result.events))
    }

    pub async fn ensure_jobs_exist(
        &self,
        context: &P4Context,
        jobs: &[String],
        app: Option<&AppHandle>,
    ) -> Result<(), String> {
        for job in jobs {
            let result = self
                .run(context, command::job_query_invocation(job)?, None, app)
                .await?;
            if !parser::parse_job_ids(&result.events)
                .iter()
                .any(|candidate| candidate == job)
            {
                return Err(format!("job {job} does not exist"));
            }
        }
        Ok(())
    }

    pub async fn perform(
        &self,
        context: P4Context,
        action: ClAction,
        app: Option<&AppHandle>,
    ) -> Result<ClActionResult, String> {
        let prepared = command::action_invocation(action)?;
        let output_mode = if prepared.invocation.input.is_some() {
            OutputMode::Text
        } else {
            OutputMode::JsonLines
        };
        let operation = self
            .run_mode(&context, prepared.invocation, None, output_mode, app)
            .await?;
        Ok(ClActionResult {
            operation,
            affected_changes: prepared.affected_changes,
            warnings: prepared.warnings,
        })
    }

    async fn run(
        &self,
        context: &P4Context,
        invocation: command::P4Invocation,
        operation_id: Option<String>,
        app: Option<&AppHandle>,
    ) -> Result<OperationResult, String> {
        self.run_mode(
            context,
            invocation,
            operation_id,
            OutputMode::JsonLines,
            app,
        )
        .await
    }

    async fn run_mode(
        &self,
        context: &P4Context,
        invocation: command::P4Invocation,
        operation_id: Option<String>,
        output_mode: OutputMode,
        app: Option<&AppHandle>,
    ) -> Result<OperationResult, String> {
        let result = self
            .runner
            .run(
                P4CommandRequest {
                    // Changelist reads and writes are interactive: create, edit,
                    // delete, move files in/out. Mutations may wait on the
                    // server, so this is the widest interactive family.
                    bound: crate::p4::bounds::IoBound::Command,
                    operation_id,
                    source: OperationSource::Gui,
                    command: invocation.command.into(),
                    args: invocation.args,
                    context: context.clone(),
                    output_mode,
                    timeout_ms: None,
                    input: invocation.input,
                },
                app,
            )
            .await
            .map_err(|error| error.to_string())?;
        ensure_success(&result)?;
        Ok(result)
    }

    /// A best-effort enrichment inside a larger changelist read: the conflict
    /// preview (`resolve -n`) must not inherit the interactive command bound.
    /// When another P4 tool holds the client workspace this preview can stall
    /// for minutes, so it fails fast under the short read bound and the list is
    /// still returned without the resolve flags.
    async fn run_preview(
        &self,
        context: &P4Context,
        invocation: command::P4Invocation,
        operation_id: Option<String>,
        output_mode: OutputMode,
        app: Option<&AppHandle>,
    ) -> Result<OperationResult, String> {
        let result = self
            .runner
            .run(
                P4CommandRequest {
                    bound: crate::p4::bounds::IoBound::Read,
                    operation_id,
                    source: OperationSource::Gui,
                    command: invocation.command.into(),
                    args: invocation.args,
                    context: context.clone(),
                    output_mode,
                    timeout_ms: None,
                    input: invocation.input,
                },
                app,
            )
            .await
            .map_err(|error| error.to_string())?;
        ensure_success(&result)?;
        Ok(result)
    }

    async fn run_detail(
        &self,
        context: &P4Context,
        invocation: command::P4Invocation,
        operation_id: Option<String>,
        app: Option<&AppHandle>,
    ) -> Result<OperationResult, String> {
        let result = self
            .runner
            .run(
                P4CommandRequest {
                    bound: crate::p4::bounds::IoBound::ReadLong,
                    operation_id,
                    source: OperationSource::Gui,
                    command: invocation.command.into(),
                    args: invocation.args,
                    context: context.clone(),
                    output_mode: OutputMode::JsonLines,
                    timeout_ms: None,
                    input: None,
                },
                app,
            )
            .await
            .map_err(|error| error.to_string())?;
        ensure_success(&result)?;
        Ok(result)
    }

    async fn run_lock_status(
        &self,
        context: &P4Context,
        invocation: crate::p4::locks::command::Invocation,
        operation_id: Option<String>,
        app: Option<&AppHandle>,
    ) -> Result<OperationResult, String> {
        self.runner
            .run_with_progress(
                P4CommandRequest {
                    bound: crate::p4::bounds::IoBound::ReadLong,
                    operation_id,
                    source: OperationSource::Gui,
                    command: invocation.command.into(),
                    args: invocation.args,
                    context: context.clone(),
                    output_mode: OutputMode::JsonLines,
                    timeout_ms: None,
                    input: None,
                },
                app,
                None,
                invocation.argument_input,
            )
            .await
            .map_err(|error| error.to_string())
    }

    async fn run_allow_empty_opened_with_operation(
        &self,
        context: &P4Context,
        invocation: command::P4Invocation,
        operation_id: Option<String>,
        app: Option<&AppHandle>,
    ) -> Result<OperationResult, String> {
        let result = self
            .runner
            .run(
                P4CommandRequest {
                    bound: crate::p4::bounds::IoBound::Read,
                    operation_id,
                    source: OperationSource::Gui,
                    command: invocation.command.into(),
                    args: invocation.args,
                    context: context.clone(),
                    output_mode: OutputMode::JsonLines,
                    timeout_ms: None,
                    input: invocation.input,
                },
                app,
            )
            .await
            .map_err(|error| error.to_string())?;
        if result.exit_code == 0 || event_text(&result).contains("not opened") {
            Ok(result)
        } else {
            Err(event_text(&result))
        }
    }
}

// Every branch supplies its newest page. Sort/dedup BEFORE truncation; the union
// cursor resumes below the last emitted CL, never below a branch's fetched tail.
fn merge_stream_pages(
    pages: Vec<ClQueryResult>,
    page_size: usize,
    generation: u64,
) -> ClQueryResult {
    let mut items = Vec::new();
    let mut scanned = 0;
    let mut hidden = 0;
    let mut more = false;
    for page in pages {
        scanned += page.stats.scanned_count;
        hidden += page.stats.hidden_reliable_merge_count;
        more |= page.has_more;
        items.extend(page.items);
    }
    items.sort_by_key(|item| std::cmp::Reverse(item.id));
    items.dedup_by_key(|item| item.id);
    more |= items.len() > page_size;
    items.truncate(page_size);
    ClQueryResult {
        request_generation: generation,
        stats: ClQueryStats {
            scanned_count: scanned,
            matched_count: items.len(),
            hidden_reliable_merge_count: hidden,
            truncated_by_safety_limit: false,
        },
        items,
        has_more: more,
        next_cursor: None,
    }
}

pub(crate) fn normalize_query(mut query: ClQuery) -> Result<ClQuery, String> {
    if query.operation_id.trim().is_empty()
        || query.operation_id.len() > 128
        || query.operation_id.chars().any(char::is_control)
    {
        return Err("a valid submitted query operation ID is required".into());
    }
    query.operation_id = query.operation_id.trim().into();
    query.keyword = query.keyword.trim().into();
    if query.keyword.len() > 512 || query.keyword.contains('\0') {
        return Err("submitted query keyword is too large or invalid".into());
    }
    if !(1..=500).contains(&query.page_size) {
        return Err("submitted query page size must be between 1 and 500".into());
    }
    query.users = normalize_tokens(query.users, "user", 16)?;
    query.clients = normalize_tokens(query.clients, "client", 16)?;
    query.jobs = normalize_tokens(query.jobs, "job", 16)?;
    query
        .merge_classifications
        .sort_by_key(|value| match value {
            MergeClassification::Normal => 0,
            MergeClassification::ReliableMerge => 1,
            MergeClassification::SuspectedMerge => 2,
            MergeClassification::Unknown => 3,
        });
    query.merge_classifications.dedup();
    let from = DateTime::parse_from_rfc3339(&query.from)
        .map_err(|_| "submitted query dates must be RFC 3339 timestamps")?;
    let to = DateTime::parse_from_rfc3339(&query.to)
        .map_err(|_| "submitted query dates must be RFC 3339 timestamps")?;
    if from > to {
        return Err("submitted query start time must not be after its end time".into());
    }
    if !query.jobs.is_empty() && query.has_job == Some(false) {
        return Err("a Job filter cannot be combined with hasJob=false".into());
    }
    query.streams = normalize_tokens(query.streams, "stream", 16)?
        .into_iter()
        .map(|value| value.trim_end_matches('/').to_owned())
        .collect();
    if !query.streams.is_empty() {
        if let Some(stream) = query.stream.take() {
            query.streams.push(stream.trim_end_matches('/').to_owned());
        }
        query.streams.sort();
        query.streams.dedup();
        if query.streams.len() > 16 {
            return Err("At most 16 streams may be selected.".into());
        }
        for stream in &query.streams {
            let mut check = query.clone();
            check.stream = Some(stream.clone());
            check.depot_path = None;
            command::query_invocation(&check, 1, None)?;
        }
        if let Some(path) = &query.depot_path {
            let prefix = path.strip_suffix("...");
            query.streams.retain(|stream| {
                path == stream
                    || path.starts_with(&format!("{stream}/"))
                    || prefix.is_some_and(|prefix| stream.starts_with(prefix))
            });
            if query.streams.is_empty() {
                return Err("Depot path does not intersect the selected streams.".into());
            }
        }
    }
    // Force validation before any cursor content can affect a command boundary.
    command::query_invocation(&query, 1, None)?;
    Ok(query)
}

fn normalize_tokens(
    values: Vec<String>,
    name: &str,
    max_items: usize,
) -> Result<Vec<String>, String> {
    if values.len() > max_items {
        return Err(format!(
            "submitted query accepts at most {max_items} {name} filters"
        ));
    }
    let mut result = Vec::new();
    for value in values {
        let value = value.trim();
        if value.is_empty()
            || value.len() > 1024
            || value.chars().any(char::is_control)
            || value.chars().any(char::is_whitespace)
        {
            return Err(format!("invalid submitted {name} filter"));
        }
        if !result.iter().any(|candidate| candidate == value) {
            result.push(value.into());
        }
    }
    result.sort();
    Ok(result)
}

pub(crate) fn semantic_query_fingerprint(query: &ClQuery) -> Result<String, String> {
    stable_query::fingerprint(&json!({
        "keyword": query.keyword,
        "users": query.users,
        "clients": query.clients,
        "depotPath": query.depot_path,
        "stream": query.stream,
        "streams": query.streams,
        "from": query.from,
        "to": query.to,
        "jobs": query.jobs,
        "hasJob": query.has_job,
        "mergeClassifications": query.merge_classifications,
        "hideReliableMerges": query.hide_reliable_merges,
        "pageSize": query.page_size,
    }))
}

fn matches_query(change: &ChangelistSummary, query: &ClQuery, extra_search_text: &str) -> bool {
    if !query.users.is_empty() && !query.users.contains(&change.user) {
        return false;
    }
    if !query.clients.is_empty() && !query.clients.contains(&change.client) {
        return false;
    }
    if let Some(has_job) = query.has_job {
        if !change.jobs.is_empty() != has_job {
            return false;
        }
    }
    if !query.merge_classifications.is_empty()
        && !query
            .merge_classifications
            .contains(&change.merge_classification)
    {
        return false;
    }
    let keyword = query.keyword.to_lowercase();
    keyword.is_empty()
        || format!(
            "{} {} {} {} {} {}",
            change.id,
            change.description,
            change.user,
            change.client,
            change.jobs.join(" "),
            extra_search_text
        )
        .to_lowercase()
        .contains(&keyword)
}

fn ensure_success(result: &OperationResult) -> Result<(), String> {
    if result.exit_code == 0 {
        Ok(())
    } else {
        Err(event_text(result))
    }
}

fn event_text(result: &OperationResult) -> String {
    result
        .events
        .iter()
        .filter_map(|event| event.message.as_deref())
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    #[ignore = "read-only regression; requires explicit isolated fixture contexts"]
    async fn fixture_pending_metadata_batches_match_change_specs() {
        use crate::persistence::{log_store::LogStore, operation_journal::OperationJournal};
        let contexts: Vec<P4Context> = serde_json::from_str(
            &std::env::var("P4DECK_PENDING_PROBE_CONTEXTS")
                .expect("explicit fixture contexts required"),
        )
        .unwrap();
        assert!(!contexts.is_empty());
        let directory = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../artifacts/qa-20261021")
            .join(format!("pending-read-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        let logs = Arc::new(LogStore::open(&directory.join("probe.sqlite")).unwrap());
        let runner = Arc::new(P4Runner::new(
            logs.clone(),
            Arc::new(OperationJournal::open(&directory.join("journal.sqlite")).unwrap()),
        ));
        let repository = ChangelistRepository::new(runner);
        for (index, context) in contexts.iter().enumerate() {
            assert_eq!(context.server, "127.0.0.1:16661");
            assert!(context.client.starts_with("p4deck-"));
            let operation = format!("pending-batch-probe-{index}");
            let started = std::time::Instant::now();
            let scan = repository
                .query_pending_bounded(context.clone(), 500, 100_000, Some(operation.clone()), None)
                .await
                .unwrap();
            assert!(!scan.truncated_by_safety_limit);
            let numbered = scan
                .changes
                .iter()
                .filter(|change| change.id > 0)
                .collect::<Vec<_>>();
            let calls = logs.query(&LogQuery {
                limit: Some(500),
                ..Default::default()
            });
            let metadata_calls = calls
                .iter()
                .filter(|entry| {
                    entry
                        .operation_id
                        .starts_with(&format!("{operation}:metadata-"))
                })
                .map(|entry| &entry.operation_id)
                .collect::<HashSet<_>>();
            assert_eq!(metadata_calls.len(), numbered.len().div_ceil(100));
            assert!(calls
                .iter()
                .filter(|entry| entry.operation_id.starts_with(&operation))
                .all(|entry| !entry.command.starts_with("change ")));
            for change in numbered {
                assert_eq!(change.user, context.user);
                assert_eq!(change.client, context.client);
                let reference = repository
                    .run(
                        context,
                        command::P4Invocation {
                            command: "change",
                            args: vec!["-o".into(), change.id.to_string()],
                            input: None,
                        },
                        None,
                        None,
                    )
                    .await
                    .unwrap();
                let spec: serde_json::Value = reference
                    .events
                    .iter()
                    .filter_map(|event| event.message.as_deref())
                    .filter_map(|message| serde_json::from_str::<serde_json::Value>(message).ok())
                    .find(|value| value.get("Change").is_some())
                    .expect("change spec");
                assert_eq!(
                    change.description,
                    spec["Description"]
                        .as_str()
                        .unwrap()
                        .replace("\r\n", "\n")
                        .trim_end_matches('\n')
                );
                let mut jobs = Vec::new();
                for index in 0.. {
                    let Some(job) = spec
                        .get(format!("Jobs{index}"))
                        .and_then(|value| value.as_str())
                    else {
                        break;
                    };
                    jobs.push(job.to_owned());
                }
                assert_eq!(change.jobs, jobs);
            }
            println!(
                "{}: {} CLs, {} metadata batches, {} ms",
                context.client,
                scan.changes.len(),
                metadata_calls.len(),
                started.elapsed().as_millis()
            );
        }
    }

    fn query() -> ClQuery {
        ClQuery {
            operation_id: "submitted-query".into(),
            request_generation: 1,
            keyword: " 修复 ".into(),
            users: vec!["alice".into(), "alice".into()],
            clients: Vec::new(),
            depot_path: Some("//depot/main/...".into()),
            stream: Some("//depot/main".into()),
            streams: Vec::new(),
            from: "2026-10-01T00:00:00Z".into(),
            to: "2026-10-09T00:00:00Z".into(),
            jobs: Vec::new(),
            has_job: None,
            merge_classifications: vec![MergeClassification::Unknown],
            hide_reliable_merges: true,
            page_size: 50,
            cursor: None,
        }
    }

    #[test]
    fn stream_union_normalizes_and_binds_cursor_scope() {
        let mut value = query();
        value.depot_path = None;
        value.stream = None;
        value.streams = vec!["//d/dev".into(), "//d/main/".into(), "//d/main".into()];
        let normalized = normalize_query(value).unwrap();
        assert_eq!(normalized.streams, ["//d/dev", "//d/main"]);
        let fingerprint = semantic_query_fingerprint(&normalized).unwrap();
        let mut changed = normalized.clone();
        changed.streams.pop();
        assert_ne!(fingerprint, semantic_query_fingerprint(&changed).unwrap());
        changed.streams = vec!["//d/main#4".into()];
        assert!(normalize_query(changed).is_err());
    }

    #[test]
    fn stream_union_merges_interleaved_pages_without_skipping_or_duplicates() {
        fn page(ids: &[i64], more: bool) -> ClQueryResult {
            let items = ids.iter().map(|id| serde_json::from_value(serde_json::json!({
                "id":id,"description":"test","user":"alice","client":"test","status":"submitted",
                "time":"2026-10-27T00:00:00Z","fileCount":0,"hasShelf":false,"jobs":[],"mergeClassification":"unknown"
            })).unwrap()).collect();
            ClQueryResult {
                request_generation: 1,
                items,
                has_more: more,
                next_cursor: None,
                stats: ClQueryStats {
                    scanned_count: ids.len(),
                    matched_count: ids.len(),
                    hidden_reliable_merge_count: 0,
                    truncated_by_safety_limit: false,
                },
            }
        }
        let first = merge_stream_pages(
            vec![page(&[100, 70, 40], true), page(&[90, 80, 70], true)],
            3,
            1,
        );
        assert_eq!(
            first.items.iter().map(|row| row.id).collect::<Vec<_>>(),
            [100, 90, 80]
        );
        assert!(first.has_more);
        let bound = first.items.last().unwrap().id - 1;
        assert_eq!(bound, 79);
        let second = merge_stream_pages(vec![page(&[70, 40], false), page(&[70, 60], false)], 3, 1);
        assert_eq!(
            second.items.iter().map(|row| row.id).collect::<Vec<_>>(),
            [70, 60, 40]
        );
        assert!(!second.has_more);
        assert_eq!(second.stats.matched_count, 3);
    }

    #[test]
    fn normalizes_query_and_rejects_invalid_ranges_and_sizes() {
        let normalized = normalize_query(query()).unwrap();
        assert_eq!(normalized.keyword, "修复");
        assert_eq!(normalized.users, ["alice"]);

        let mut invalid = query();
        invalid.from = "2026-10-10T00:00:00Z".into();
        assert!(normalize_query(invalid).is_err());
        let mut invalid = query();
        invalid.page_size = 501;
        assert!(normalize_query(invalid).is_err());
        let mut invalid = query();
        invalid.jobs = vec!["JOB-1".into()];
        invalid.has_job = Some(false);
        assert!(normalize_query(invalid).is_err());
    }

    #[test]
    fn only_reliable_merge_is_hidden() {
        let query = normalize_query(query()).unwrap();
        let summary = |classification| ChangelistSummary {
            id: 1,
            description: "修复".into(),
            user: "alice".into(),
            client: "c".into(),
            status: "submitted".into(),
            time: "2026-10-08T00:00:00Z".into(),
            file_count: 0,
            has_shelf: false,
            jobs: Vec::new(),
            stream: None,
            merge_classification: classification,
        };
        assert!(matches_query(
            &summary(MergeClassification::Unknown),
            &query,
            ""
        ));
        assert!(!matches_query(
            &summary(MergeClassification::SuspectedMerge),
            &query,
            ""
        ));
    }

    #[test]
    fn pending_shelved_detail_maps_another_users_shelf_without_opened_files() {
        let detail = SubmittedChangeDetail {
            change_id: 77,
            status: "pending".into(),
            description: "shelf of another user".into(),
            user: "alice".into(),
            client: "alice_ws".into(),
            time: "2023-11-14T22:13:20+00:00".into(),
            jobs: vec!["JOB-1".into()],
            files: vec![
                SubmittedChangeFile {
                    depot_path: "//depot/main/a".into(),
                    action: "edit".into(),
                    revision: Some(3),
                    file_type: Some("text".into()),
                },
                SubmittedChangeFile {
                    depot_path: "//depot/main/b".into(),
                    action: "add".into(),
                    revision: None,
                    file_type: Some("binary".into()),
                },
            ],
            integration_evidence: Vec::new(),
            merge_classification: MergeClassification::Unknown,
            inspection_status: SubmittedInspectionStatus::Partial,
            message: None,
        };
        let change = pending_from_shelved_detail(detail);
        assert_eq!(change.id, 77);
        assert_eq!(change.status, "pending");
        assert_eq!(change.user, "alice");
        assert_eq!(change.client, "alice_ws");
        assert_eq!(change.description, "shelf of another user");
        assert_eq!(
            change.updated_at.as_deref(),
            Some("2023-11-14T22:13:20+00:00")
        );
        assert_eq!(change.jobs, vec!["JOB-1".to_owned()]);
        assert!(change.files.is_empty());
        assert_eq!(change.shelved_files.len(), 2);
        assert_eq!(change.shelved_files[0].depot_path, "//depot/main/a");
        assert_eq!(change.shelved_files[0].action, "edit");
        assert_eq!(change.shelved_files[0].revision, Some(3));
        assert_eq!(change.shelved_files[0].file_type.as_deref(), Some("text"));
        assert_eq!(change.shelved_files[1].depot_path, "//depot/main/b");
        assert_eq!(change.shelved_files[1].action, "add");
        assert_eq!(change.shelved_files[1].revision, None);
        assert_eq!(change.shelved_files[1].file_type.as_deref(), Some("binary"));
        assert!(change.shelved_files.iter().all(|file| {
            file.state.is_none()
                && file.client_path.is_none()
                && file.head_revision.is_none()
                && file.lock_ownership.is_none()
                && file.lock_owner.is_none()
                && file.other_open.is_empty()
                && file.exclusive_open.is_none()
                && file.resolve.is_none()
        }));

        // A pending changelist without shelves is a valid, empty mapping.
        let empty = pending_from_shelved_detail(SubmittedChangeDetail {
            change_id: 78,
            status: "pending".into(),
            description: String::new(),
            user: "bob".into(),
            client: "bob_ws".into(),
            time: String::new(),
            jobs: Vec::new(),
            files: Vec::new(),
            integration_evidence: Vec::new(),
            merge_classification: MergeClassification::Unknown,
            inspection_status: SubmittedInspectionStatus::Partial,
            message: None,
        });
        assert_eq!(empty.status, "pending");
        assert!(empty.updated_at.is_none());
        assert!(empty.shelved_files.is_empty());
        assert!(empty.files.is_empty());
    }
}
