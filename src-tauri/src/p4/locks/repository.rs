use super::{command, parser};
use crate::{
    domain::*,
    p4::runner::{MutationGuard, OperationGroup, P4Runner},
};
use std::sync::Arc;
use tauri::AppHandle;

#[derive(Debug, Clone)]
pub struct LockInspection {
    pub files: Vec<FileLockFileSnapshot>,
    pub operation_ids: Vec<String>,
}

pub struct LockRepository {
    runner: Arc<P4Runner>,
}

impl LockRepository {
    pub fn new(runner: Arc<P4Runner>) -> Self {
        Self { runner }
    }
    pub async fn lock_mutations(&self, server: &str) -> MutationGuard {
        self.runner.lock_mutations(server).await
    }
    /// Unified S1B write lane: same-server writes serialize and the durable
    /// WriteLease is attached until `MutationGuard::finish`.
    pub async fn lock_write_transaction(
        &self,
        context: &P4Context,
        operation_id: &str,
    ) -> Result<MutationGuard, String> {
        self.runner
            .lock_write_transaction(context, operation_id)
            .await
            .map_err(|error| error.to_string())
    }
    pub fn begin_group(&self, operation_id: String) -> OperationGroup {
        self.runner.begin_operation_group(operation_id)
    }

    pub async fn inspect(
        &self,
        context: &P4Context,
        operation: FileLockOperation,
        paths: &[String],
        prefix: &str,
        app: Option<&AppHandle>,
    ) -> Result<LockInspection, String> {
        let inputs = command::validate_paths(paths)?;
        let mut operation_ids = Vec::new();
        let info = self
            .run(context, command::info(), format!("{prefix}:info"), app)
            .await?;
        operation_ids.push(info.operation_id.clone());
        ensure_success(&info, "connection/profile validation")?;
        let where_result = self
            .run(
                context,
                command::where_paths(&inputs)?,
                format!("{prefix}:where"),
                app,
            )
            .await?;
        operation_ids.push(where_result.operation_id.clone());
        let mappings = parser::mappings(&where_result.events);
        let depot_paths = mappings
            .iter()
            .map(|mapping| mapping.depot_path.clone())
            .collect::<Vec<_>>();
        let facts_result = if depot_paths.is_empty() {
            None
        } else {
            let result = self
                .run(
                    context,
                    command::fstat(&depot_paths)?,
                    format!("{prefix}:fstat"),
                    app,
                )
                .await?;
            operation_ids.push(result.operation_id.clone());
            Some(result)
        };
        let facts = facts_result
            .as_ref()
            .map(|result| parser::file_facts(&result.events))
            .unwrap_or_default();
        let permission_result = if depot_paths.is_empty() {
            None
        } else {
            let result = self
                .run(
                    context,
                    command::protects(&depot_paths)?,
                    format!("{prefix}:protects"),
                    app,
                )
                .await?;
            operation_ids.push(result.operation_id.clone());
            Some(result)
        };
        let permissions = permission_result
            .as_ref()
            .filter(|result| result.exit_code == 0)
            .map(|result| parser::permissions(&result.events))
            .unwrap_or_default();
        let mut files = inputs
            .into_iter()
            .map(|input| {
                let mapping = mappings
                    .iter()
                    .find(|mapping| parser::matches_input(&input, mapping));
                let fact = mapping.and_then(|mapping| {
                    facts
                        .iter()
                        .find(|fact| fact.depot_path == mapping.depot_path)
                });
                snapshot(operation, input, mapping, fact, &permissions)
            })
            .collect::<Vec<_>>();
        files.sort_by(|left, right| {
            left.depot_path
                .as_bytes()
                .cmp(right.depot_path.as_bytes())
                .then_with(|| left.input_path.as_bytes().cmp(right.input_path.as_bytes()))
        });
        Ok(LockInspection {
            files,
            operation_ids,
        })
    }

    pub async fn mutate(
        &self,
        context: &P4Context,
        operation: FileLockOperation,
        depot_path: &str,
        operation_id: String,
        guard: &MutationGuard,
        app: Option<&AppHandle>,
    ) -> Result<OperationResult, String> {
        let invocation = command::mutate(operation, depot_path)?;
        self.runner
            .run_with_mutation_guard_and_input(
                request(context, &invocation, operation_id),
                app,
                Some(1),
                invocation.argument_input,
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
            .run_with_progress(
                request(context, &invocation, operation_id),
                app,
                None,
                invocation.argument_input,
            )
            .await
            .map_err(|error| error.to_string())
    }
}

fn request(
    context: &P4Context,
    invocation: &command::Invocation,
    operation_id: String,
) -> P4CommandRequest {
    P4CommandRequest {
        operation_id: Some(operation_id),
        source: OperationSource::Gui,
        command: invocation.command.into(),
        args: invocation.args.clone(),
        context: context.clone(),
        output_mode: OutputMode::JsonLines,
        timeout_ms: Some(120_000),
        input: None,
    }
}

fn snapshot(
    operation: FileLockOperation,
    input: String,
    mapping: Option<&parser::Mapping>,
    fact: Option<&parser::FileFact>,
    permissions: &std::collections::BTreeMap<String, FileLockPermission>,
) -> FileLockFileSnapshot {
    let Some(mapping) = mapping else {
        return unavailable(input, "The target is outside the current client view.");
    };
    let Some(fact) = fact else {
        return FileLockFileSnapshot {
            input_path: input,
            depot_path: mapping.depot_path.clone(),
            client_path: mapping.client_path.clone(),
            local_path: mapping.local_path.clone(),
            opened_action: String::new(),
            changelist_id: -1,
            file_type: String::new(),
            exclusive: false,
            ownership: FileLockOwnership::Unknown,
            lock_owner: None,
            other_open: Vec::new(),
            permission: FileLockPermission::Unknown,
            applicable: false,
            reason: Some("Authoritative opened and lock state is unavailable.".into()),
        };
    };
    let permission = parser::permission_for(permissions, &fact.depot_path);
    let action_supported = matches!(
        fact.action.as_deref(),
        Some(
            "add"
                | "edit"
                | "delete"
                | "move/add"
                | "move/delete"
                | "branch"
                | "integrate"
                | "import"
        )
    );
    let (applicable, reason) = if !action_supported {
        (
            false,
            Some(
                match fact.action.as_deref() {
                    None => "The file is not opened in the current workspace.",
                    Some("archive" | "purge") => {
                        "Archive and purge actions cannot be locked by this workflow."
                    }
                    _ => "The opened action is unknown and cannot be changed safely.",
                }
                .into(),
            ),
        )
    } else if permission == FileLockPermission::Denied {
        (
            false,
            Some("The current user lacks open/write permission for this file.".into()),
        )
    } else {
        match (operation, fact.ownership) {
            (FileLockOperation::Lock, FileLockOwnership::Unlocked) => (true, None),
            (FileLockOperation::Lock, FileLockOwnership::Ours) => (false, Some("The file is already locked by this workspace.".into())),
            (FileLockOperation::Unlock, FileLockOwnership::Ours) => (true, None),
            (FileLockOperation::Unlock, FileLockOwnership::Unlocked) => (false, Some("The file is not locked by this workspace.".into())),
            (_, FileLockOwnership::Other) => (false, Some("Another user or workspace owns the lock; contact an administrator because P4Deck cannot unlock it.".into())),
            (_, FileLockOwnership::Unknown) => (false, Some("Lock ownership is unknown.".into())),
        }
    };
    FileLockFileSnapshot {
        input_path: input,
        depot_path: fact.depot_path.clone(),
        client_path: mapping.client_path.clone(),
        local_path: fact
            .local_path
            .clone()
            .or_else(|| mapping.local_path.clone()),
        opened_action: fact.action.clone().unwrap_or_default(),
        changelist_id: fact.change_id,
        file_type: fact.file_type.clone(),
        exclusive: parser::exclusive(&fact.file_type),
        ownership: fact.ownership,
        lock_owner: fact.lock_owner.clone(),
        other_open: fact.other_open.clone(),
        permission,
        applicable,
        reason,
    }
}

fn unavailable(input: String, reason: &str) -> FileLockFileSnapshot {
    FileLockFileSnapshot {
        input_path: input,
        depot_path: String::new(),
        client_path: String::new(),
        local_path: None,
        opened_action: String::new(),
        changelist_id: -1,
        file_type: String::new(),
        exclusive: false,
        ownership: FileLockOwnership::Unknown,
        lock_owner: None,
        other_open: Vec::new(),
        permission: FileLockPermission::Unknown,
        applicable: false,
        reason: Some(reason.into()),
    }
}

fn ensure_success(result: &OperationResult, label: &str) -> Result<(), String> {
    (result.exit_code == 0).then_some(()).ok_or_else(|| {
        let detail = result
            .events
            .iter()
            .filter_map(|event| event.message.as_deref())
            .collect::<Vec<_>>()
            .join("\n");
        if detail.trim().is_empty() {
            format!("{label} failed")
        } else {
            format!("{label} failed: {detail}")
        }
    })
}
