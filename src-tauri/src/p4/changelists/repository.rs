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
            let mut batch = parser::parse_change_events(&result.events);
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

    pub async fn query_pending(
        &self,
        context: P4Context,
        app: Option<&AppHandle>,
    ) -> Result<Vec<PendingChange>, String> {
        let pending = self
            .run(
                &context,
                command::pending_changes_invocation(&context)?,
                None,
                app,
            )
            .await?;
        let opened = self
            .run_allow_empty_opened(&context, command::opened_invocation(&context)?, app)
            .await?;
        let shelved = self
            .run(
                &context,
                command::shelved_changes_invocation(&context)?,
                None,
                app,
            )
            .await?;

        let mut changes = parser::parse_pending_changes(
            &pending.events,
            context.user.trim(),
            context.client.trim(),
        )
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
        for change_id in numbered_ids {
            let result = self
                .run(
                    &context,
                    command::change_spec_invocation(change_id)?,
                    None,
                    app,
                )
                .await?;
            let spec = parser::parse_change_spec(&result.events)
                .ok_or_else(|| format!("p4 change -o {change_id} returned no specification"))?;
            if spec.id != change_id
                || spec.user != context.user
                || spec.client != context.client
                || spec.status != "pending"
            {
                return Err(format!(
                    "changelist {change_id} is outside the current user/client scope"
                ));
            }
            if let Some(change) = changes.get_mut(&change_id) {
                change.description = spec.description;
                change.jobs = spec.jobs;
            }
        }

        for (change_id, file) in parser::parse_opened_files(&opened.events) {
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

        let shelved_ids = parser::parse_shelved_change_ids(
            &shelved.events,
            context.user.trim(),
            context.client.trim(),
        )
        .into_iter()
        .filter(|id| changes.contains_key(id))
        .collect::<Vec<_>>();
        if !shelved_ids.is_empty() {
            let described = self
                .run(
                    &context,
                    command::describe_shelves_invocation(&shelved_ids)?,
                    None,
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
        Ok(result)
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

    pub async fn perform_pending(
        &self,
        context: P4Context,
        request: &PendingChangeMutationRequest,
        app: Option<&AppHandle>,
    ) -> Result<PendingMutationExecution, String> {
        let prepared = command::pending_mutation_invocation(&request.mutation)?;
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
                    operation_id,
                    source: OperationSource::Gui,
                    command: invocation.command.into(),
                    args: invocation.args,
                    context: context.clone(),
                    output_mode,
                    timeout_ms: Some(300_000),
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
                    operation_id,
                    source: OperationSource::Gui,
                    command: invocation.command.into(),
                    args: invocation.args,
                    context: context.clone(),
                    output_mode: OutputMode::JsonLines,
                    timeout_ms: Some(60_000),
                    input: None,
                },
                app,
            )
            .await
            .map_err(|error| error.to_string())?;
        ensure_success(&result)?;
        Ok(result)
    }

    async fn run_allow_empty_opened(
        &self,
        context: &P4Context,
        invocation: command::P4Invocation,
        app: Option<&AppHandle>,
    ) -> Result<OperationResult, String> {
        let result = self
            .runner
            .run(
                P4CommandRequest {
                    operation_id: None,
                    source: OperationSource::Gui,
                    command: invocation.command.into(),
                    args: invocation.args,
                    context: context.clone(),
                    output_mode: OutputMode::JsonLines,
                    timeout_ms: Some(120_000),
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

    fn query() -> ClQuery {
        ClQuery {
            operation_id: "submitted-query".into(),
            request_generation: 1,
            keyword: " 修复 ".into(),
            users: vec!["alice".into(), "alice".into()],
            clients: Vec::new(),
            depot_path: Some("//depot/main/...".into()),
            stream: Some("//depot/main".into()),
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
}
