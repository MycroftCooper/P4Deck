use super::{command, parser};
use crate::{
    domain::*,
    p4::runner::{MutationGuard, P4Runner},
};
use std::{path::Path, sync::Arc};
use tauri::AppHandle;

pub struct RenameRepository {
    runner: Arc<P4Runner>,
}

#[derive(Debug, Clone)]
pub struct RenameInspection {
    pub source: Option<RenameMoveMapping>,
    pub target: Option<RenameMoveMapping>,
    pub source_state: Option<RenameMoveSourceState>,
    pub source_exists: bool,
    pub target_exists: bool,
    pub target_parent_exists: bool,
    pub target_change_valid: bool,
    pub operation_ids: Vec<String>,
}

impl RenameRepository {
    pub fn new(runner: Arc<P4Runner>) -> Self {
        Self { runner }
    }

    pub async fn lock_mutations(&self, server: &str) -> MutationGuard {
        self.runner.lock_mutations(server).await
    }

    pub async fn inspect(
        &self,
        context: &P4Context,
        request: &RenameMovePreflightRequest,
        operation_prefix: &str,
        app: Option<&AppHandle>,
    ) -> Result<RenameInspection, String> {
        command::validate(request)?;
        let source_where_id = format!("{operation_prefix}-source-where");
        let target_where_id = format!("{operation_prefix}-target-where");
        let source_fstat_id = format!("{operation_prefix}-source-fstat");
        let target_fstat_id = format!("{operation_prefix}-target-fstat");
        let source_where = self
            .run(
                context,
                command::where_path(&request.source_path)?,
                source_where_id.clone(),
                app,
            )
            .await?;
        let target_where = self
            .run(
                context,
                command::where_path(&request.target_path)?,
                target_where_id.clone(),
                app,
            )
            .await?;
        let source_fstat = self
            .run(
                context,
                command::fstat(&request.source_path)?,
                source_fstat_id.clone(),
                app,
            )
            .await?;
        let target_fstat = self
            .run(
                context,
                command::fstat(&request.target_path)?,
                target_fstat_id.clone(),
                app,
            )
            .await?;

        let source = parser::mapping(&source_where.events);
        let target = parser::mapping(&target_where.events);
        let source_state = parser::source_state(&source_fstat.events);
        let source_exists = source
            .as_ref()
            .is_some_and(|mapping| Path::new(&mapping.local_path).is_file())
            && parser::source_is_controlled(&source_fstat.events);
        let target_on_disk = target
            .as_ref()
            .is_some_and(|mapping| Path::new(&mapping.local_path).exists());
        let target_exists = target_on_disk || parser::target_exists(&target_fstat.events);
        let target_parent_exists = target.as_ref().is_some_and(|mapping| {
            Path::new(&mapping.local_path)
                .parent()
                .is_some_and(Path::is_dir)
        });
        let mut operation_ids = vec![
            source_where_id,
            target_where_id,
            source_fstat_id,
            target_fstat_id,
        ];
        let target_change_valid = if request.target_change_id == 0 {
            true
        } else {
            let id = format!("{operation_prefix}-change");
            let change = self
                .run(
                    context,
                    command::change(request.target_change_id)?,
                    id.clone(),
                    app,
                )
                .await?;
            operation_ids.push(id);
            parser::changelist_is_valid(
                &change.events,
                request.target_change_id,
                &context.client,
                &context.user,
            )
        };
        Ok(RenameInspection {
            source,
            target,
            source_state,
            source_exists,
            target_exists,
            target_parent_exists,
            target_change_valid,
            operation_ids,
        })
    }

    pub async fn execute(
        &self,
        context: &P4Context,
        target: &RenameMoveTargetSnapshot,
        operation_id: String,
        guard: &MutationGuard,
        app: Option<&AppHandle>,
    ) -> Result<OperationResult, String> {
        let invocation = command::move_file(
            &target.source.depot_path,
            &target.target.depot_path,
            target.target_change_id,
        )?;
        self.runner
            .run_with_mutation_guard(
                P4CommandRequest {
                    // `p4 move` rewrites the client, so it is a mutation.
                    bound: crate::p4::bounds::IoBound::Command,
                    operation_id: Some(operation_id),
                    source: OperationSource::Gui,
                    command: invocation.command.into(),
                    args: invocation.args,
                    context: context.clone(),
                    output_mode: OutputMode::JsonLines,
                    timeout_ms: None,
                    input: None,
                },
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
                P4CommandRequest {
                    bound: crate::p4::bounds::IoBound::ReadLong,
                    operation_id: Some(operation_id),
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
            .map_err(|error| error.to_string())
    }
}
