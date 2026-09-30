use super::{command, parser};
use crate::{domain::*, p4::runner::P4Runner};
use std::sync::Arc;
use tauri::AppHandle;

pub struct ChangelistRepository {
    runner: Arc<P4Runner>,
}

impl ChangelistRepository {
    pub fn new(runner: Arc<P4Runner>) -> Self {
        Self { runner }
    }

    pub async fn query(
        &self,
        context: P4Context,
        query: ClQuery,
        app: &AppHandle,
    ) -> Result<ClQueryResult, String> {
        let invocation = command::query_invocation(&query);
        let result = self
            .runner
            .run(
                P4CommandRequest {
                    operation_id: None,
                    source: OperationSource::Gui,
                    command: invocation.command.into(),
                    args: invocation.args,
                    context,
                    output_mode: OutputMode::JsonLines,
                    timeout_ms: Some(120_000),
                    input: invocation.input,
                },
                Some(app),
            )
            .await
            .map_err(|error| error.to_string())?;
        ensure_success(&result)?;

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

    pub async fn perform(
        &self,
        context: P4Context,
        action: ClAction,
        app: &AppHandle,
    ) -> Result<ClActionResult, String> {
        let prepared = command::action_invocation(action);
        let operation = self
            .runner
            .run(
                P4CommandRequest {
                    operation_id: None,
                    source: OperationSource::Gui,
                    command: prepared.invocation.command.into(),
                    args: prepared.invocation.args,
                    context,
                    output_mode: OutputMode::JsonLines,
                    timeout_ms: Some(300_000),
                    input: prepared.invocation.input,
                },
                Some(app),
            )
            .await
            .map_err(|error| error.to_string())?;
        ensure_success(&operation)?;
        Ok(ClActionResult {
            operation,
            affected_changes: prepared.affected_changes,
            warnings: prepared.warnings,
        })
    }
}

fn ensure_success(result: &OperationResult) -> Result<(), String> {
    if result.exit_code == 0 {
        return Ok(());
    }
    Err(result
        .events
        .iter()
        .filter_map(|event| event.message.as_deref())
        .collect::<Vec<_>>()
        .join("\n"))
}
