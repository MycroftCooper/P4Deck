use super::{command, parser};
use crate::{
    domain::*,
    p4::runner::{MutationGuard, P4Runner},
};
use std::sync::Arc;
use tauri::AppHandle;

#[derive(Debug)]
pub struct BranchListBatch {
    pub items: Vec<BranchMappingSummary>,
    pub scanned_count: usize,
    pub invalid_record_count: usize,
    pub truncated: bool,
    pub operation_ids: Vec<String>,
}

pub struct BranchMappingRepository {
    runner: Arc<P4Runner>,
}

impl BranchMappingRepository {
    pub fn new(runner: Arc<P4Runner>) -> Self {
        Self { runner }
    }

    pub async fn lock_mutations(&self, server: &str) -> MutationGuard {
        self.runner.lock_mutations(server).await
    }

    pub async fn list(
        &self,
        context: &P4Context,
        name_filter: Option<&str>,
        owner: Option<&str>,
        operation_id: String,
        app: Option<&AppHandle>,
    ) -> Result<BranchListBatch, String> {
        let result = self
            .run(
                context,
                command::list(name_filter, owner)?,
                operation_id.clone(),
                app,
            )
            .await?;
        let (records, malformed_lines) = parser::json_records(&result.events);
        let (mut items, invalid_records, server_error) = parser::summaries(&records);
        if result.exit_code != 0 || server_error {
            return Err("branch mapping list query was rejected; inspect the operation log".into());
        }
        let scanned_count = items.len();
        let truncated = items.len() > command::BRANCH_SCAN_LIMIT;
        items.truncate(command::BRANCH_SCAN_LIMIT);
        let normalized_filter = name_filter.map(str::to_lowercase);
        items.retain(|item| {
            normalized_filter
                .as_deref()
                .is_none_or(|filter| item.name.to_lowercase().contains(filter))
                && owner.is_none_or(|owner| {
                    item.owner
                        .as_deref()
                        .is_some_and(|actual| actual.eq_ignore_ascii_case(owner))
                })
        });
        items.sort_by(|left, right| left.name.cmp(&right.name));
        Ok(BranchListBatch {
            items,
            scanned_count,
            invalid_record_count: invalid_records.saturating_add(malformed_lines),
            truncated,
            operation_ids: vec![operation_id],
        })
    }

    pub async fn detail(
        &self,
        context: &P4Context,
        name: &str,
        operation_id: String,
        app: Option<&AppHandle>,
    ) -> Result<Option<BranchMappingDetail>, String> {
        let result = self
            .run(context, command::detail(name)?, operation_id.clone(), app)
            .await?;
        let (records, _) = parser::json_records(&result.events);
        let detail = parser::detail(&records, operation_id)?;
        if result.exit_code != 0 && detail.is_none() {
            return Ok(None);
        }
        Ok(detail)
    }

    pub async fn targets_mapped(
        &self,
        context: &P4Context,
        paths: &[String],
        operation_id: String,
        app: Option<&AppHandle>,
    ) -> Result<bool, String> {
        let result = self
            .run(context, command::where_paths(paths)?, operation_id, app)
            .await?;
        let (records, _) = parser::json_records(&result.events);
        if parser::has_permission_error(&records) {
            return Err("branch mapping workspace check was denied by server permissions".into());
        }
        Ok(result.exit_code == 0 && parser::where_complete(&records, paths.len()))
    }

    pub async fn preview(
        &self,
        context: &P4Context,
        name: &str,
        reverse: bool,
        limit: usize,
        operation_id: String,
        app: Option<&AppHandle>,
    ) -> Result<(Vec<BranchImpactItem>, usize, usize, bool), String> {
        let result = self
            .run(
                context,
                command::preview(name, reverse, limit)?,
                operation_id,
                app,
            )
            .await?;
        let (records, malformed) = parser::json_records(&result.events);
        let (mut items, invalid, server_error) = parser::preview_items(&records);
        if result.exit_code != 0 || server_error {
            return Err(if parser::has_permission_error(&records) {
                "branch impact preview was denied by server permissions".into()
            } else {
                "branch impact preview was rejected; inspect the operation log".into()
            });
        }
        let scanned = items.len();
        let truncated = items.len() > limit;
        items.truncate(limit);
        Ok((
            items,
            invalid.saturating_add(malformed),
            scanned,
            truncated || scanned > limit,
        ))
    }

    pub async fn save(
        &self,
        context: &P4Context,
        draft: &BranchMappingDraft,
        operation_id: String,
        guard: &MutationGuard,
        app: Option<&AppHandle>,
    ) -> Result<OperationResult, String> {
        let (invocation, input) = command::save(draft)?;
        // `p4 -Mj branch -i` switches form input away from the normal text form
        // protocol and the server reports a missing Branch field. Writes use the
        // ordinary form protocol; the independent verification read remains tagged JSON.
        let mut write_request = request(context, invocation, operation_id, Some(input), 120_000);
        write_request.output_mode = OutputMode::Text;
        self.runner
            .run_with_mutation_guard(write_request, app, Some(1), guard)
            .await
            .map_err(|error| error.to_string())
    }

    pub async fn delete(
        &self,
        context: &P4Context,
        name: &str,
        operation_id: String,
        guard: &MutationGuard,
        app: Option<&AppHandle>,
    ) -> Result<OperationResult, String> {
        self.runner
            .run_with_mutation_guard(
                request(context, command::delete(name)?, operation_id, None, 120_000),
                app,
                Some(1),
                guard,
            )
            .await
            .map_err(|error| error.to_string())
    }

    async fn run(
        &self,
        context: &P4Context,
        invocation: command::Invocation,
        operation_id: String,
        app: Option<&AppHandle>,
    ) -> Result<OperationResult, String> {
        self.runner
            .run(
                request(context, invocation, operation_id, None, 120_000),
                app,
            )
            .await
            .map_err(|error| error.to_string())
    }
}

fn request(
    context: &P4Context,
    invocation: command::Invocation,
    operation_id: String,
    input: Option<String>,
    timeout_ms: u64,
) -> P4CommandRequest {
    P4CommandRequest {
        operation_id: Some(operation_id),
        source: OperationSource::Gui,
        command: invocation.command.into(),
        args: invocation.args,
        context: context.clone(),
        output_mode: OutputMode::JsonLines,
        timeout_ms: Some(timeout_ms),
        input,
    }
}
