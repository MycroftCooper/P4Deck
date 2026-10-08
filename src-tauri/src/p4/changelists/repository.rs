use super::{command, parser};
use crate::{domain::*, p4::runner::P4Runner};
use std::{collections::BTreeMap, sync::Arc};
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
        app: Option<&AppHandle>,
    ) -> Result<ClQueryResult, String> {
        let invocation = command::query_invocation(&query);
        let result = self.run(&context, invocation, None, app).await?;

        let keyword = query.keyword.to_lowercase();
        let mut hidden_merge_count = 0;
        let changes = parser::parse_change_events(&result.events)
            .into_iter()
            .filter(|change| {
                keyword.is_empty()
                    || format!(
                        "{} {} {} {}",
                        change.id, change.description, change.user, change.client
                    )
                    .to_lowercase()
                    .contains(&keyword)
            })
            .filter(|change| {
                let hidden = query.hide_reliable_merges
                    && change.merge_classification == MergeClassification::ReliableMerge;
                if hidden {
                    hidden_merge_count += 1;
                }
                !hidden
            })
            .collect::<Vec<_>>();
        let has_more = changes.len() >= query.limit;
        Ok(ClQueryResult {
            request_generation: query.request_generation,
            changes,
            hidden_merge_count,
            has_more,
            next_cursor: None,
        })
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
