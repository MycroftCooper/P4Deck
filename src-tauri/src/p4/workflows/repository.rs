use super::{command, parser};
use crate::{
    domain::*,
    p4::{
        changelists::ChangelistRepository,
        runner::{MutationGuard, P4Runner},
    },
};
use sha2::{Digest, Sha256};
use std::{collections::BTreeSet, sync::Arc};
use tauri::AppHandle;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PermissionAssessment {
    Allowed,
    Denied(Vec<String>),
    Unknown,
}

pub struct ShelfInspection {
    pub change: Option<PendingChange>,
    pub facts: Vec<parser::WorkflowFileFact>,
    pub shelf_facts: Vec<parser::WorkflowFileFact>,
    pub permission: PermissionAssessment,
    pub operation_ids: Vec<String>,
}

pub struct UnshelveInspection {
    pub source: Option<PendingChange>,
    pub target_change: Option<PendingChange>,
    pub target_context: P4Context,
    pub source_facts: Vec<parser::WorkflowFileFact>,
    pub target_facts: Vec<parser::WorkflowFileFact>,
    pub mappings: Vec<(String, String)>,
    pub modified_paths: Vec<String>,
    pub permission: PermissionAssessment,
    pub preview: Vec<String>,
    pub preview_succeeded: bool,
    pub operation_ids: Vec<String>,
}

pub struct ResolveInspection {
    pub facts: Vec<parser::WorkflowFileFact>,
    pub preview: Vec<String>,
    pub preview_succeeded: bool,
    pub operation_ids: Vec<String>,
}

pub struct MoveInspection {
    pub changes: Vec<PendingChange>,
    pub facts: Vec<parser::WorkflowFileFact>,
    pub operation_ids: Vec<String>,
}

pub struct ShelfDetailInspection {
    pub detail: parser::ParsedShelfDetail,
    pub operation_ids: Vec<String>,
}

pub struct WorkflowRepository {
    runner: Arc<P4Runner>,
    changelists: ChangelistRepository,
}

impl WorkflowRepository {
    pub fn new(runner: Arc<P4Runner>) -> Self {
        Self {
            changelists: ChangelistRepository::new(runner.clone()),
            runner,
        }
    }

    pub async fn lock_mutations(&self, server: &str) -> MutationGuard {
        self.runner.lock_mutations(server).await
    }

    pub fn begin_operation_group(&self, operation_id: String) -> crate::p4::runner::OperationGroup {
        self.runner.begin_operation_group(operation_id)
    }

    pub async fn shelf_detail(
        &self,
        context: &P4Context,
        change_id: i64,
        prefix: &str,
        app: Option<&AppHandle>,
    ) -> Result<ShelfDetailInspection, String> {
        command::ensure_context(context)?;
        let described = self
            .checked_named(
                context,
                command::describe_shelf(change_id)?,
                format!("{prefix}:describe"),
                app,
            )
            .await?;
        let preliminary = parser::shelf_detail(&described.events, change_id, &[])?;
        let paths = preliminary
            .files
            .iter()
            .map(|file| file.depot_path.clone())
            .collect::<Vec<_>>();
        let mut operation_ids = vec![described.operation_id.clone()];
        let facts = self
            .checked_named(
                context,
                command::fstat(&paths, Some(change_id))?,
                format!("{prefix}:fstat"),
                app,
            )
            .await
            .map(|result| {
                operation_ids.push(result.operation_id.clone());
                parser::file_facts(&result.events)
            })
            .unwrap_or_default();
        Ok(ShelfDetailInspection {
            detail: parser::shelf_detail(&described.events, change_id, &facts)?,
            operation_ids,
        })
    }

    pub async fn inspect_move(
        &self,
        context: &P4Context,
        paths: &[String],
        prefix: &str,
        app: Option<&AppHandle>,
    ) -> Result<MoveInspection, String> {
        command::ensure_context(context)?;
        let paths = command::validate_paths(paths)?;
        let changes = self.changelists.query_pending(context.clone(), app).await?;
        let result = self
            .checked_named(
                context,
                command::fstat(&paths, None)?,
                format!("{prefix}-fstat"),
                app,
            )
            .await?;
        Ok(MoveInspection {
            changes,
            facts: parser::file_facts(&result.events),
            operation_ids: vec![result.operation_id],
        })
    }

    pub async fn execute_reopen(
        &self,
        context: &P4Context,
        target_change_id: i64,
        path: &str,
        operation_id: String,
        guard: &MutationGuard,
        app: Option<&AppHandle>,
    ) -> Result<OperationResult, String> {
        self.guarded(
            context,
            command::reopen(target_change_id, path)?,
            operation_id,
            1,
            guard,
            app,
        )
        .await
    }

    pub async fn pending_snapshot(
        &self,
        context: P4Context,
        app: Option<&AppHandle>,
    ) -> Result<Vec<PendingChange>, String> {
        self.changelists.query_pending(context, app).await
    }

    pub async fn inspect_shelf(
        &self,
        context: &P4Context,
        change_id: i64,
        paths: &[String],
        prefix: &str,
        app: Option<&AppHandle>,
    ) -> Result<ShelfInspection, String> {
        command::ensure_context(context)?;
        let paths = command::validate_paths(paths)?;
        let change = self
            .changelists
            .query_pending(context.clone(), app)
            .await?
            .into_iter()
            .find(|change| change.id == change_id);
        let mut operation_ids = Vec::new();
        let facts = self
            .checked_named(
                context,
                command::fstat(&paths, None)?,
                format!("{prefix}-files"),
                app,
            )
            .await
            .map(|result| {
                operation_ids.push(result.operation_id.clone());
                parser::file_facts(&result.events)
            })
            .unwrap_or_default();
        let shelf_facts = self
            .checked_named(
                context,
                command::fstat(&paths, Some(change_id))?,
                format!("{prefix}-shelves"),
                app,
            )
            .await
            .map(|result| {
                operation_ids.push(result.operation_id.clone());
                parser::file_facts(&result.events)
            })
            .unwrap_or_default();
        let permission = self
            .checked_named(
                context,
                command::protects(&paths)?,
                format!("{prefix}-permissions"),
                app,
            )
            .await
            .map(|result| {
                operation_ids.push(result.operation_id.clone());
                assess_permissions(&paths, parser::permissions(&result.events))
            })
            .unwrap_or(PermissionAssessment::Unknown);
        Ok(ShelfInspection {
            change,
            facts,
            shelf_facts,
            permission,
            operation_ids,
        })
    }

    pub async fn inspect_unshelve(
        &self,
        context: &P4Context,
        request: &UnshelvePreflightRequest,
        prefix: &str,
        app: Option<&AppHandle>,
    ) -> Result<UnshelveInspection, String> {
        command::ensure_context(context)?;
        let paths = command::validate_paths(&request.depot_paths)?;
        let source = self
            .changelists
            .query_pending(context.clone(), app)
            .await?
            .into_iter()
            .find(|change| change.id == request.source_change_id);
        let target_context = self
            .workspace_context(context, &request.target_workspace, prefix, app)
            .await?;
        let target_change = self
            .changelists
            .query_pending(target_context.clone(), app)
            .await?
            .into_iter()
            .find(|change| change.id == request.target_change_id);
        let mut operation_ids = Vec::new();
        let source_facts = self
            .checked_named(
                context,
                command::fstat(&paths, Some(request.source_change_id))?,
                format!("{prefix}-source"),
                app,
            )
            .await
            .map(|result| {
                operation_ids.push(result.operation_id.clone());
                parser::file_facts(&result.events)
            })
            .unwrap_or_default();
        let target_facts = self
            .checked_named(
                &target_context,
                command::fstat(&paths, None)?,
                format!("{prefix}-target"),
                app,
            )
            .await
            .map(|result| {
                operation_ids.push(result.operation_id.clone());
                parser::file_facts(&result.events)
            })
            .unwrap_or_default();
        let mappings = self
            .checked_named(
                &target_context,
                command::where_paths(&paths)?,
                format!("{prefix}-mapping"),
                app,
            )
            .await
            .map(|result| {
                operation_ids.push(result.operation_id.clone());
                parser::mappings(&result.events)
            })
            .unwrap_or_default();
        let mut modified_paths = self
            .raw_named(
                &target_context,
                command::modified_paths(&paths, false)?,
                format!("{prefix}-modified-unopened"),
                app,
            )
            .await
            .map(|result| {
                operation_ids.push(result.operation_id.clone());
                parser::path_output(&result.events)
            })
            .unwrap_or_default();
        let opened_modified = self
            .raw_named(
                &target_context,
                command::modified_paths(&paths, true)?,
                format!("{prefix}-modified-opened"),
                app,
            )
            .await
            .map(|result| {
                operation_ids.push(result.operation_id.clone());
                parser::path_output(&result.events)
            })
            .unwrap_or_default();
        modified_paths.extend(opened_modified);
        modified_paths.sort();
        modified_paths.dedup();
        let permission = self
            .checked_named(
                &target_context,
                command::protects(&paths)?,
                format!("{prefix}-permissions"),
                app,
            )
            .await
            .map(|result| {
                operation_ids.push(result.operation_id.clone());
                assess_permissions(&paths, parser::permissions(&result.events))
            })
            .unwrap_or(PermissionAssessment::Unknown);
        let preview_result = self
            .raw_named(
                &target_context,
                command::unshelve(
                    request.source_change_id,
                    request.target_change_id,
                    &paths,
                    true,
                )?,
                format!("{prefix}-preview"),
                app,
            )
            .await?;
        operation_ids.push(preview_result.operation_id.clone());
        Ok(UnshelveInspection {
            source,
            target_change,
            target_context,
            source_facts,
            target_facts,
            mappings,
            modified_paths,
            permission,
            preview: parser::preview_lines(&preview_result.events),
            preview_succeeded: preview_result.exit_code == 0,
            operation_ids,
        })
    }

    pub async fn inspect_resolve(
        &self,
        context: &P4Context,
        paths: &[String],
        prefix: &str,
        app: Option<&AppHandle>,
    ) -> Result<ResolveInspection, String> {
        command::ensure_context(context)?;
        let paths = command::validate_paths(paths)?;
        let mut operation_ids = Vec::new();
        let facts = self
            .raw_named(
                context,
                command::fstat(&paths, None)?,
                format!("{prefix}-files"),
                app,
            )
            .await
            .map(|result| {
                operation_ids.push(result.operation_id.clone());
                parser::file_facts(&result.events)
            })
            .unwrap_or_default();
        let preview_result = self
            .raw_named(
                context,
                command::resolve_preview(&paths)?,
                format!("{prefix}-preview"),
                app,
            )
            .await?;
        operation_ids.push(preview_result.operation_id.clone());
        Ok(ResolveInspection {
            facts,
            preview: parser::preview_lines(&preview_result.events),
            preview_succeeded: preview_result.exit_code == 0,
            operation_ids,
        })
    }

    pub async fn execute_shelf(
        &self,
        context: &P4Context,
        request: &ShelfPreflightRequest,
        operation_id: String,
        guard: &MutationGuard,
        app: Option<&AppHandle>,
    ) -> Result<OperationResult, String> {
        self.guarded(
            context,
            command::shelf(
                request.change_id,
                &request.depot_paths,
                request.mode,
                request.replace,
            )?,
            operation_id,
            request.depot_paths.len(),
            guard,
            app,
        )
        .await
    }

    pub async fn execute_unshelve(
        &self,
        context: &P4Context,
        request: &UnshelvePreflightRequest,
        operation_id: String,
        guard: &MutationGuard,
        app: Option<&AppHandle>,
    ) -> Result<OperationResult, String> {
        self.guarded(
            context,
            command::unshelve(
                request.source_change_id,
                request.target_change_id,
                &request.depot_paths,
                false,
            )?,
            operation_id,
            request.depot_paths.len(),
            guard,
            app,
        )
        .await
    }

    pub async fn execute_resolve(
        &self,
        context: &P4Context,
        selection: &ResolveSelection,
        operation_id: String,
        guard: &MutationGuard,
        app: Option<&AppHandle>,
    ) -> Result<OperationResult, String> {
        self.guarded(
            context,
            command::resolve(&selection.depot_path, selection.strategy)?,
            operation_id,
            1,
            guard,
            app,
        )
        .await
    }

    async fn workspace_context(
        &self,
        context: &P4Context,
        client: &str,
        prefix: &str,
        app: Option<&AppHandle>,
    ) -> Result<P4Context, String> {
        if client == context.client {
            return Ok(context.clone());
        }
        let result = self
            .checked_named(
                context,
                command::client_spec(client)?,
                format!("{prefix}-workspace"),
                app,
            )
            .await?;
        let spec = parser::workspace_spec(&result.events)
            .filter(|spec| spec.client == client && !spec.root.trim().is_empty())
            .ok_or_else(|| format!("target workspace {client} was not found or has no root"))?;
        if spec.owner != context.user {
            return Err(format!(
                "target workspace {client} is not owned by the current user"
            ));
        }
        let mut target = context.clone();
        target.client = client.to_owned();
        target.cwd = Some(spec.root);
        Ok(target)
    }

    async fn checked_named(
        &self,
        context: &P4Context,
        invocation: command::Invocation,
        operation_id: String,
        app: Option<&AppHandle>,
    ) -> Result<OperationResult, String> {
        let result = self
            .raw_named(context, invocation, operation_id, app)
            .await?;
        if result.exit_code == 0 {
            Ok(result)
        } else {
            Err(event_text(&result))
        }
    }

    async fn raw_named(
        &self,
        context: &P4Context,
        invocation: command::Invocation,
        operation_id: String,
        app: Option<&AppHandle>,
    ) -> Result<OperationResult, String> {
        self.runner
            .run_with_progress(
                P4CommandRequest {
                    operation_id: Some(operation_id),
                    source: OperationSource::Gui,
                    command: invocation.command.into(),
                    args: invocation.args,
                    context: context.clone(),
                    output_mode: OutputMode::JsonLines,
                    timeout_ms: Some(300_000),
                    input: None,
                },
                app,
                None,
                invocation.argument_input,
            )
            .await
            .map_err(|error| error.to_string())
    }

    async fn guarded(
        &self,
        context: &P4Context,
        invocation: command::Invocation,
        operation_id: String,
        count: usize,
        guard: &MutationGuard,
        app: Option<&AppHandle>,
    ) -> Result<OperationResult, String> {
        self.runner
            .run_with_mutation_guard_and_input(
                P4CommandRequest {
                    operation_id: Some(operation_id),
                    source: OperationSource::Gui,
                    command: invocation.command.into(),
                    args: invocation.args,
                    context: context.clone(),
                    output_mode: OutputMode::JsonLines,
                    timeout_ms: Some(600_000),
                    input: None,
                },
                app,
                Some(count.max(1)),
                invocation.argument_input,
                guard,
            )
            .await
            .map_err(|error| error.to_string())
    }
}

pub fn content_digest<T: serde::Serialize>(value: &T) -> String {
    let bytes = serde_json::to_vec(value).expect("workflow digest input is serializable");
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

pub fn local_content_facts(facts: &[parser::WorkflowFileFact]) -> Vec<(String, String)> {
    let mut result = facts
        .iter()
        .map(|fact| {
            let digest = fact
                .client_path
                .as_deref()
                .and_then(|path| std::fs::read(path).ok())
                .map(|bytes| {
                    Sha256::digest(bytes)
                        .iter()
                        .map(|byte| format!("{byte:02x}"))
                        .collect()
                })
                .unwrap_or_else(|| "missing-or-unreadable".into());
            (fact.depot_path.clone(), digest)
        })
        .collect::<Vec<_>>();
    result.sort();
    result
}

fn assess_permissions(
    paths: &[String],
    facts: Vec<parser::PermissionFact>,
) -> PermissionAssessment {
    if facts.is_empty() {
        return PermissionAssessment::Unknown;
    }
    let requested = paths.iter().cloned().collect::<BTreeSet<_>>();
    let mut covered = BTreeSet::new();
    let mut denied = BTreeSet::new();
    let mut universal_allow = false;
    for fact in facts {
        let allowed = matches!(
            fact.permission
                .trim_start_matches('=')
                .to_ascii_lowercase()
                .as_str(),
            "write" | "admin" | "super"
        );
        match fact.depot_path {
            Some(path) if allowed => {
                covered.insert(path);
            }
            Some(path) => {
                denied.insert(path);
            }
            None if allowed => universal_allow = true,
            None => denied.extend(requested.iter().cloned()),
        }
    }
    if !denied.is_empty() {
        PermissionAssessment::Denied(denied.into_iter().collect())
    } else if universal_allow || requested.is_subset(&covered) {
        PermissionAssessment::Allowed
    } else {
        PermissionAssessment::Unknown
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
