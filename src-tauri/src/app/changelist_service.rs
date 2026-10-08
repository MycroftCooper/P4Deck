use crate::{
    app::status_cache::{InvalidationReason, StatusCache, StatusQueryKind},
    domain::*,
    p4::changelists::ChangelistRepository,
};
use std::{collections::BTreeSet, sync::Arc};
use tauri::AppHandle;

pub struct ChangelistService {
    repository: ChangelistRepository,
    status_cache: Arc<StatusCache>,
}

impl ChangelistService {
    pub fn new(repository: ChangelistRepository, status_cache: Arc<StatusCache>) -> Self {
        Self {
            repository,
            status_cache,
        }
    }

    pub async fn query(
        &self,
        context: P4Context,
        query: ClQuery,
        app: Option<&AppHandle>,
    ) -> Result<ClQueryResult, String> {
        self.repository.query(context, query, app).await
    }

    pub async fn query_pending(
        &self,
        context: P4Context,
        app: Option<&AppHandle>,
    ) -> Result<Vec<PendingChange>, String> {
        self.repository.query_pending(context, app).await
    }

    pub async fn mutate_pending(
        &self,
        context: P4Context,
        request: PendingChangeMutationRequest,
        app: Option<&AppHandle>,
    ) -> Result<PendingChangeMutationResult, String> {
        let before = self.repository.query_pending(context.clone(), app).await?;
        let mut affected_changes = validate_pending_mutation(&before, &request.mutation)?;
        let jobs = match &request.mutation {
            PendingChangeMutation::Create { jobs, .. }
            | PendingChangeMutation::Edit { jobs, .. } => jobs.as_slice(),
            _ => &[],
        };
        self.repository
            .ensure_jobs_exist(&context, jobs, app)
            .await?;
        let requested_paths = match &request.mutation {
            PendingChangeMutation::MoveFiles { depot_paths, .. } => depot_paths.clone(),
            _ => Vec::new(),
        };
        let local_paths = self
            .repository
            .local_paths(&context, &requested_paths, app)
            .await?;
        let execution = self
            .repository
            .perform_pending(context.clone(), &request, app)
            .await?;

        affected_changes.extend(execution.affected_changes.iter().copied());
        let mut created_change_id = execution.created_change_id;
        if !local_paths.is_empty() {
            self.status_cache.invalidate(
                &context.server,
                &context.user,
                &context.client,
                &local_paths,
                &[StatusQueryKind::WorkspaceStatus, StatusQueryKind::Opened],
                InvalidationReason::ChangelistMutation,
            );
        }

        let (after, refresh_error) = match self.repository.query_pending(context, app).await {
            Ok(changes) => (changes, None),
            Err(error) => (Vec::new(), Some(error)),
        };
        if created_change_id.is_none()
            && matches!(request.mutation, PendingChangeMutation::Create { .. })
        {
            let previous_ids = before
                .iter()
                .map(|change| change.id)
                .collect::<BTreeSet<_>>();
            created_change_id = after
                .iter()
                .map(|change| change.id)
                .find(|id| *id > 0 && !previous_ids.contains(id));
        }
        if let Some(change_id) = created_change_id {
            affected_changes.insert(change_id);
        }
        let refreshed_changes = after
            .into_iter()
            .filter(|change| affected_changes.contains(&change.id))
            .collect();
        Ok(PendingChangeMutationResult {
            operation: execution.operation,
            created_change_id,
            affected_changes: affected_changes.into_iter().collect(),
            affected_paths: execution.affected_paths,
            refreshed_changes,
            refresh_error,
        })
    }

    pub async fn perform(
        &self,
        context: P4Context,
        action: ClAction,
        app: Option<&AppHandle>,
    ) -> Result<ClActionResult, String> {
        let reason = if matches!(action, ClAction::SubmitValidate { .. }) {
            InvalidationReason::Submit
        } else {
            InvalidationReason::ChangelistMutation
        };
        let result = self
            .repository
            .perform(context.clone(), action, app)
            .await?;
        self.status_cache.invalidate(
            &context.server,
            &context.user,
            &context.client,
            &[],
            &[
                StatusQueryKind::WorkspaceStatus,
                StatusQueryKind::Opened,
                StatusQueryKind::Reconcile,
            ],
            reason,
        );
        Ok(result)
    }
}

fn validate_pending_mutation(
    changes: &[PendingChange],
    mutation: &PendingChangeMutation,
) -> Result<BTreeSet<i64>, String> {
    let mut affected = BTreeSet::new();
    match mutation {
        PendingChangeMutation::Create { .. } => {}
        PendingChangeMutation::Edit { change_id, .. } => {
            require_numbered_change(changes, *change_id)?;
            affected.insert(*change_id);
        }
        PendingChangeMutation::Delete { change_id } => {
            let change = require_numbered_change(changes, *change_id)?;
            if !change.files.is_empty()
                || !change.shelved_files.is_empty()
                || !change.jobs.is_empty()
            {
                return Err(format!(
                    "changelist {change_id} is not empty; clear Jobs, move/revert opened files, and delete shelves first"
                ));
            }
            affected.insert(*change_id);
        }
        PendingChangeMutation::MoveFiles {
            target_change_id,
            depot_paths,
        } => {
            if *target_change_id > 0 {
                require_numbered_change(changes, *target_change_id)?;
            } else if *target_change_id < 0 {
                return Err("target changelist must be Default (0) or numbered".into());
            }
            affected.insert(*target_change_id);
            for path in depot_paths {
                let source = changes
                    .iter()
                    .find(|change| change.files.iter().any(|file| file.depot_path == *path))
                    .ok_or_else(|| {
                        format!("{path} is not opened by the current user and client")
                    })?;
                affected.insert(source.id);
            }
        }
    }
    Ok(affected)
}

fn require_numbered_change(
    changes: &[PendingChange],
    change_id: i64,
) -> Result<&PendingChange, String> {
    if change_id <= 0 {
        return Err("a numbered pending changelist is required".into());
    }
    changes
        .iter()
        .find(|change| change.id == change_id)
        .ok_or_else(|| {
            format!("changelist {change_id} is not pending in the current user/client scope")
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn change(id: i64, paths: &[&str], shelves: &[&str]) -> PendingChange {
        let file = |path: &&str| PendingFile {
            depot_path: (*path).into(),
            action: "edit".into(),
            state: Some("openedEdit".into()),
            client_path: None,
            revision: None,
            file_type: None,
        };
        PendingChange {
            id,
            description: String::new(),
            user: "u".into(),
            client: "c".into(),
            status: "pending".into(),
            updated_at: None,
            jobs: Vec::new(),
            files: paths.iter().map(file).collect(),
            shelved_files: shelves.iter().map(file).collect(),
        }
    }

    #[test]
    fn move_tracks_source_and_target_and_delete_requires_empty() {
        let changes = [change(0, &["//depot/a"], &[]), change(7, &[], &[])];
        let affected = validate_pending_mutation(
            &changes,
            &PendingChangeMutation::MoveFiles {
                target_change_id: 7,
                depot_paths: vec!["//depot/a".into()],
            },
        )
        .unwrap();
        assert_eq!(affected.into_iter().collect::<Vec<_>>(), vec![0, 7]);
        assert!(validate_pending_mutation(
            &[change(7, &["//depot/a"], &[])],
            &PendingChangeMutation::Delete { change_id: 7 }
        )
        .is_err());
    }
}
