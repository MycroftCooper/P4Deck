use super::*;
use crate::app::confirmation::ExpiringConfirmation;
use crate::p4::connection_setup::{SpecWriteError, WorkspaceSpecSnapshot};
pub(super) struct WorkspaceToken {
    request: WorkspaceMutationRequest,
    context: P4Context,
    spec: WorkspaceSpecSnapshot,
    expires: i64,
}
impl ExpiringConfirmation for WorkspaceToken {
    fn expires_at(&self) -> i64 {
        self.expires
    }
}

pub fn validate_mutation(request: &WorkspaceMutationRequest, current: &str) -> Result<(), String> {
    if !valid_entity_name(&request.workspace) {
        return Err("Invalid workspace name.".into());
    }
    if request.workspace.eq_ignore_ascii_case(current) {
        return Err(
            "Switch to another workspace before renaming or deleting this workspace.".into(),
        );
    }
    if request.action == WorkspaceMutationAction::Rename {
        let name = request.new_name.as_deref().unwrap_or_default();
        if !valid_entity_name(name) || name.eq_ignore_ascii_case(&request.workspace) {
            return Err(
                "Use a valid, different workspace name; case-only renames are not supported."
                    .into(),
            );
        }
    } else if request.new_name.is_some() {
        return Err("Delete does not accept a new name.".into());
    }
    Ok(())
}
fn supports_rename(version: Option<&str>) -> bool {
    version
        .and_then(|value| {
            value.split('/').find_map(|part| {
                let (major, minor) = part.split_once('.')?;
                Some((major.parse::<u32>().ok()?, minor.parse::<u32>().ok()?))
            })
        })
        .is_some_and(|version| version >= (2022, 2))
}
impl ConnectionService {
    async fn inspect_workspace_mutation(
        &self,
        request: &WorkspaceMutationRequest,
        context: &P4Context,
        app: Option<&AppHandle>,
    ) -> Result<WorkspaceSpecSnapshot, String> {
        validate_mutation(request, &context.client)?;
        validate_connection_context(context)
            .map_err(|_| "Invalid active connection.".to_owned())?;
        let id = format!("workspace-preflight-{}", Uuid::new_v4());
        if !self
            .setup
            .workspace_exists(context, &request.workspace, &id, app)
            .await?
            .0
        {
            return Err("Workspace no longer exists.".into());
        }
        let spec = self
            .setup
            .read_workspace(context, &request.workspace, &id, app)
            .await?
            .0
            .ok_or("Workspace spec unavailable.")?;
        if spec.name != request.workspace || spec.owner != context.user {
            return Err(
                "Only an exactly identified workspace owned by the current user may be changed."
                    .into(),
            );
        }
        if request.action == WorkspaceMutationAction::Rename {
            let identity = self.setup.inspect_identity(context, &id, app).await?.0;
            if !supports_rename(identity.server_version.as_deref()) {
                return Err(
                    "Rename requires P4 Server 2022.2 or later; no copy/delete fallback is used."
                        .into(),
                );
            }
            if self
                .setup
                .workspace_exists(context, request.new_name.as_deref().unwrap(), &id, app)
                .await?
                .0
            {
                return Err("The new workspace name already exists.".into());
            }
        } else if self
            .setup
            .workspace_has_pending(context, &request.workspace, &id, app)
            .await?
            || self
                .setup
                .workspace_has_opened(context, &request.workspace, &id, app)
                .await?
        {
            return Err("Workspace has open files or pending/shelved changelists. Resolve them before deleting the workspace definition.".into());
        }
        Ok(spec)
    }
    pub async fn preflight_workspace_mutation(
        &self,
        request: WorkspaceMutationRequest,
        app: Option<&AppHandle>,
    ) -> Result<WorkspaceMutationPreview, String> {
        let (context, generation) = self.contexts.snapshot();
        if generation != request.expected_generation {
            return Err("Connection changed.".into());
        }
        let spec = self
            .inspect_workspace_mutation(&request, &context, app)
            .await?;
        if self.contexts.snapshot().1 != generation {
            return Err("Connection changed.".into());
        }
        let now = Utc::now().timestamp_millis();
        let expires = now + 120_000;
        let root = spec.root.clone();
        let stream = spec.stream.clone();
        let token = self.workspace_tokens.issue(
            WorkspaceToken {
                request: request.clone(),
                context,
                spec,
                expires,
            },
            now,
        );
        Ok(WorkspaceMutationPreview {
            token,
            request,
            root,
            stream,
            expires_at: expires,
        })
    }
    /// Compatibility entry used only by the feature-gated e2e harness.
    /// Production IPC uses confirm_workspace_mutation_admitted.
    #[allow(dead_code)]
    pub async fn confirm_workspace_mutation(
        &self,
        token: String,
        app: Option<&AppHandle>,
    ) -> Result<WorkspaceMutationResult, String> {
        let record = self.consume_workspace_token(&token)?;
        let guard = self.setup.lock_mutations(&record.context.server).await;
        self.confirm_workspace_record(record, Some(&guard), app)
            .await
    }

    pub async fn confirm_workspace_mutation_admitted(
        &self,
        token: String,
        guard: &crate::p4::runner::MutationGuard,
        app: Option<&AppHandle>,
    ) -> Result<WorkspaceMutationResult, String> {
        let record = self.consume_workspace_token(&token)?;
        self.confirm_workspace_record(record, Some(guard), app)
            .await
    }

    fn consume_workspace_token(&self, token: &str) -> Result<WorkspaceToken, String> {
        let record = self
            .workspace_tokens
            .consume(token)
            .ok_or("Confirmation expired or already consumed.")?;
        if record.expires <= Utc::now().timestamp_millis() {
            return Err("Confirmation expired.".into());
        }
        Ok(record)
    }

    async fn confirm_workspace_record(
        &self,
        record: WorkspaceToken,
        admitted: Option<&crate::p4::runner::MutationGuard>,
        app: Option<&AppHandle>,
    ) -> Result<WorkspaceMutationResult, String> {
        let owned_guard;
        let guard = match admitted {
            Some(guard) => guard,
            None => {
                owned_guard = self.setup.lock_mutations(&record.context.server).await;
                &owned_guard
            }
        };
        if self.contexts.snapshot().1 != record.request.expected_generation {
            return Err("Connection changed.".into());
        }
        let spec = self
            .inspect_workspace_mutation(&record.request, &record.context, app)
            .await?;
        if spec != record.spec || self.contexts.snapshot().1 != record.request.expected_generation {
            return Err("Workspace or connection changed; review again.".into());
        }
        let action = record.request.action.clone();
        let workspace = record.request.workspace.clone();
        let write = self
            .setup
            .mutate_workspace(
                &record.context,
                &record.request,
                &format!("workspace-write-{}", Uuid::new_v4()),
                app,
                guard,
            )
            .await;
        let (outcome, failure, verified, observed_exists, message) = match write {
            Ok(_) => {
                let observed = self.observed_workspace_exists(&record, app).await;
                let verified = match action {
                    WorkspaceMutationAction::Delete => observed == Some(false),
                    WorkspaceMutationAction::Rename => {
                        let new_present = match record.request.new_name.as_deref() {
                            Some(name) => {
                                self.observed_workspace_named(&record.context, name, app)
                                    .await
                                    == Some(true)
                            }
                            None => false,
                        };
                        observed == Some(false) && new_present
                    }
                };
                if verified {
                    (WorkflowOutcome::Succeeded, None, true, observed, "Workspace definition change verified from a post-write workspace readback.".to_string())
                } else {
                    (WorkflowOutcome::Unknown, Some("The workspace command may have applied but the post-write workspace list readback did not confirm the requested state; refresh before retrying.".to_string()), false, observed, "Workspace operation outcome is uncertain; no retry with a new ID.".to_string())
                }
            }
            Err(SpecWriteError::Unknown) => (WorkflowOutcome::Unknown, Some("Workspace operation outcome is uncertain. Inspect the operation log and refresh before attempting another change.".to_string()), false, None, "Workspace operation outcome is uncertain.".to_string()),
            Err(SpecWriteError::Rejected(_)) => (WorkflowOutcome::Rejected, Some("Server rejected the operation. Open files, permissions or server policy may block it; no force or migration fallback was attempted. See operation log.".to_string()), false, None, "Server rejected the workspace operation.".to_string()),
        };
        Ok(WorkspaceMutationResult {
            outcome,
            failure,
            message,
            workspace,
            action,
            verified,
            observed_exists,
        })
    }

    async fn observed_workspace_exists(
        &self,
        record: &WorkspaceToken,
        app: Option<&AppHandle>,
    ) -> Option<bool> {
        self.observed_workspace_named(&record.context, &record.request.workspace, app)
            .await
    }

    async fn observed_workspace_named(
        &self,
        context: &P4Context,
        name: &str,
        app: Option<&AppHandle>,
    ) -> Option<bool> {
        self.setup
            .workspace_exists(
                context,
                name,
                &format!("workspace-exists-{}", Uuid::new_v4()),
                app,
            )
            .await
            .ok()
            .map(|(exists, _)| exists)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn request(action: WorkspaceMutationAction) -> WorkspaceMutationRequest {
        WorkspaceMutationRequest {
            expected_generation: 1,
            workspace: "other".into(),
            action,
            new_name: None,
        }
    }
    #[test]
    fn blocks_current_and_invalid_rename() {
        assert!(validate_mutation(&request(WorkspaceMutationAction::Delete), "other").is_err());
        assert!(validate_mutation(&request(WorkspaceMutationAction::Rename), "active").is_err());
    }
    #[test]
    fn version_gate_is_conservative() {
        assert!(supports_rename(Some("P4D/NTX64/2022.2/123")));
        assert!(!supports_rename(Some("P4D/NTX64/2021.1/123")));
        assert!(!supports_rename(None));
    }
    #[test]
    fn commands_never_force_delete_or_emulate_rename() {
        let mut r = request(WorkspaceMutationAction::Delete);
        assert_eq!(
            crate::p4::connection_setup::workspace_mutation_command(&r),
            ("client", vec!["-d".into(), "other".into()])
        );
        r.action = WorkspaceMutationAction::Rename;
        r.new_name = Some("new".into());
        assert_eq!(
            crate::p4::connection_setup::workspace_mutation_command(&r),
            (
                "renameclient",
                vec!["--from=other".into(), "--to=new".into()]
            )
        );
    }
}
