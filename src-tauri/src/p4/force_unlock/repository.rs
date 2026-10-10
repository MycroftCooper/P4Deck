use super::{command, parser};
use crate::{
    domain::*,
    p4::runner::{MutationGuard, OperationGroup, P4Runner},
};
use std::sync::Arc;
use tauri::AppHandle;

#[derive(Debug, Clone)]
pub struct ForceUnlockInspection {
    pub server_services: Option<String>,
    pub locks: Vec<ForceUnlockLockFact>,
    pub operation_ids: Vec<String>,
}

pub struct ForceUnlockRepository {
    runner: Arc<P4Runner>,
}

impl ForceUnlockRepository {
    pub fn new(runner: Arc<P4Runner>) -> Self {
        Self { runner }
    }

    pub fn begin_group(&self, operation_id: String) -> OperationGroup {
        self.runner.begin_operation_group(operation_id)
    }

    pub async fn lock_mutations(&self, server: &str) -> MutationGuard {
        self.runner.lock_mutations(server).await
    }

    pub async fn inspect(
        &self,
        context: &P4Context,
        paths: &[String],
        origin: &ForceUnlockOrigin,
        prefix: &str,
        app: Option<&AppHandle>,
    ) -> Result<ForceUnlockInspection, String> {
        let paths = command::validate_paths(paths)?;
        command::validate_origin(origin)?;
        let mut operation_ids = Vec::new();
        let info = self
            .run(context, command::info(), format!("{prefix}:info"), app)
            .await?;
        operation_ids.push(info.operation_id.clone());
        ensure_success(&info, "server topology probe")?;
        let server = parser::server_facts(&info.events)
            .ok_or("server topology probe returned no structured facts")?;

        let fstat = self
            .run(
                context,
                command::fstat(&paths)?,
                format!("{prefix}:fstat"),
                app,
            )
            .await?;
        operation_ids.push(fstat.operation_id.clone());
        if fstat.exit_code != 0 && parser::lock_facts(&fstat.events).is_empty() {
            return Err("force unlock lock facts are unavailable".into());
        }
        let facts = parser::lock_facts(&fstat.events);

        let protects = self
            .run(
                context,
                command::protects(&paths)?,
                format!("{prefix}:protects"),
                app,
            )
            .await?;
        operation_ids.push(protects.operation_id.clone());
        let permissions = if protects.exit_code == 0 && !parser::has_error(&protects.events) {
            parser::permissions(&protects.events)
        } else {
            Default::default()
        };

        let opened = if matches!(origin.mode, ForceUnlockOriginMode::OpenedChangelist) {
            let result = self
                .run(
                    context,
                    command::opened(origin, &paths)?,
                    format!("{prefix}:opened"),
                    app,
                )
                .await?;
            operation_ids.push(result.operation_id.clone());
            parser::opened_facts(&result.events)
        } else {
            Vec::new()
        };

        let locks = paths
            .iter()
            .map(|path| {
                snapshot(
                    path,
                    origin,
                    context,
                    facts.iter().find(|fact| fact.depot_path == *path),
                    &opened,
                    parser::permission_for(&permissions, path),
                    server.services.as_deref(),
                )
            })
            .collect();
        Ok(ForceUnlockInspection {
            server_services: server.services,
            locks,
            operation_ids,
        })
    }

    pub async fn mutate(
        &self,
        context: &P4Context,
        origin: &ForceUnlockOrigin,
        path: &str,
        operation_id: String,
        guard: &MutationGuard,
        app: Option<&AppHandle>,
    ) -> Result<OperationResult, String> {
        let invocation = command::mutate(origin, path)?;
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

fn snapshot(
    path: &str,
    origin: &ForceUnlockOrigin,
    context: &P4Context,
    fact: Option<&parser::LockFact>,
    opened: &[parser::OpenedFact],
    permission: ForceUnlockPermission,
    _server_services: Option<&str>,
) -> ForceUnlockLockFact {
    let Some(fact) = fact else {
        return ForceUnlockLockFact {
            depot_path: path.into(),
            exists: false,
            locked: false,
            lock_owner: None,
            lock_user: None,
            lock_client: None,
            change_id: None,
            opened_action: None,
            file_type: None,
            exclusive: false,
            origin: origin.clone(),
            origin_proven: false,
            permission,
        };
    };
    if fact.our_lock {
        return ForceUnlockLockFact {
            depot_path: path.into(),
            exists: true,
            locked: true,
            lock_owner: Some(format!("{}@{}", context.user, context.client)),
            lock_user: Some(context.user.clone()),
            lock_client: Some(context.client.clone()),
            change_id: origin.change_id,
            opened_action: None,
            file_type: fact.file_type.clone(),
            exclusive: fact.file_type.as_deref().is_some_and(is_exclusive),
            origin: origin.clone(),
            origin_proven: false,
            permission,
        };
    }
    let owner = (fact.owners.len() == 1).then(|| fact.owners[0].clone());
    let opened_match = owner.as_ref().and_then(|owner| {
        opened.iter().find(|opened| {
            opened.depot_path == path
                && opened.user == owner.user
                && opened.client == owner.client
                && opened.change_id == origin.change_id
        })
    });
    let origin_proven = match origin.mode {
        ForceUnlockOriginMode::OpenedChangelist => opened_match.is_some(),
        // Current tagged fstat/opened records do not distinguish an ordinary
        // pending lock from the special lock created by an aborted submit -e.
        ForceUnlockOriginMode::ShelvedChangelist => false,
        // `opened -x` lists cross-server +l opens but does not prove orphaning.
        ForceUnlockOriginMode::OrphanDistributed => false,
    };
    ForceUnlockLockFact {
        depot_path: path.into(),
        exists: fact.exists,
        locked: !fact.owners.is_empty(),
        lock_owner: owner.as_ref().and_then(|owner| owner.owner.clone()),
        lock_user: owner.as_ref().and_then(|owner| owner.user.clone()),
        lock_client: owner.as_ref().and_then(|owner| owner.client.clone()),
        change_id: owner.as_ref().and_then(|owner| owner.change_id),
        opened_action: opened_match
            .and_then(|opened| opened.action.clone())
            .or_else(|| owner.as_ref().and_then(|owner| owner.action.clone())),
        file_type: fact.file_type.clone(),
        exclusive: fact.file_type.as_deref().is_some_and(is_exclusive),
        origin: origin.clone(),
        origin_proven,
        permission,
    }
}

fn is_exclusive(file_type: &str) -> bool {
    file_type
        .split_once('+')
        .is_some_and(|(_, modifiers)| modifiers.contains('l'))
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

fn ensure_success(result: &OperationResult, label: &str) -> Result<(), String> {
    (result.exit_code == 0 && !parser::has_error(&result.events))
        .then_some(())
        .ok_or_else(|| format!("{label} failed; inspect the operation log"))
}
