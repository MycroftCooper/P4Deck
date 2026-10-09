use crate::{
    app::confirmation::{ConfirmationStore, ExpiringConfirmation},
    domain::*,
    p4::{context::ContextStore, runner::P4Runner},
};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{collections::BTreeSet, path::Path, sync::Arc};
use tauri::AppHandle;
use tokio::sync::Mutex as AsyncMutex;
use uuid::Uuid;

const DEFAULT_TOKEN_TTL_MS: u64 = 120_000;
const MAX_REPORTED_PATHS: usize = 100;

#[derive(Clone)]
struct TokenRecord {
    target: StreamSwitchTargetSnapshot,
    preview_digest: String,
    has_warnings: bool,
    expires_at: i64,
}

impl ExpiringConfirmation for TokenRecord {
    fn expires_at(&self) -> i64 {
        self.expires_at
    }
}

#[derive(Debug, Clone)]
struct Inspection {
    current_stream: Option<String>,
    target_stream: String,
    target_type: String,
    target_parent: Option<String>,
    client_spec: Value,
    stream_spec: Value,
    risks: StreamSwitchRiskSummary,
    blockers: Vec<StreamSwitchIssue>,
    warnings: Vec<StreamSwitchIssue>,
    risk_digest: String,
    operation_ids: Vec<String>,
}

pub struct StreamSwitchService {
    runner: Arc<P4Runner>,
    contexts: Arc<ContextStore>,
    tokens: ConfirmationStore<TokenRecord>,
    confirmation_gate: AsyncMutex<()>,
    ttl_ms: u64,
}

impl StreamSwitchService {
    pub fn new(runner: Arc<P4Runner>, contexts: Arc<ContextStore>) -> Self {
        Self::with_ttl(runner, contexts, DEFAULT_TOKEN_TTL_MS)
    }

    pub(crate) fn with_ttl(
        runner: Arc<P4Runner>,
        contexts: Arc<ContextStore>,
        ttl_ms: u64,
    ) -> Self {
        Self {
            runner,
            contexts,
            tokens: ConfirmationStore::default(),
            confirmation_gate: AsyncMutex::new(()),
            ttl_ms: ttl_ms.max(1),
        }
    }

    pub fn clear_confirmations(&self) {
        self.tokens.clear();
    }

    pub async fn preflight(
        self: &Arc<Self>,
        request: StreamSwitchPreflightRequest,
        app: Option<&AppHandle>,
    ) -> StreamSwitchPreflight {
        let (context, generation) = self.contexts.snapshot();
        let profile_id = self.contexts.active_profile_id();
        let operation_id = valid_operation_id(request.operation_id.clone())
            .unwrap_or_else(|| format!("stream-preflight-{}", Uuid::new_v4()));
        let group = self.runner.begin_operation_group(operation_id.clone());
        let target_input = match validate_stream_path(&request.target_stream) {
            Ok(value) => value,
            Err(message) => {
                return blocked_preflight(
                    request,
                    issue(StreamSwitchIssueCode::InvalidTarget, message, Vec::new()),
                    self.ttl_ms,
                    vec![operation_id],
                )
            }
        };
        let inspection = self
            .inspect(
                &context,
                &target_input,
                request.mode,
                &operation_id,
                &group,
                app,
            )
            .await;
        let inspection = match inspection {
            Ok(value) => value,
            Err(message) => {
                return blocked_preflight(
                    request,
                    issue(
                        inspection_issue_code(&message),
                        format!(
                        "Stream switch preflight could not establish a safe snapshot: {message}"
                    ),
                        Vec::new(),
                    ),
                    self.ttl_ms,
                    vec![operation_id],
                )
            }
        };
        let target = snapshot(&context, generation, profile_id, request.mode, &inspection);
        let preview_digest = preview_digest(&target, &inspection.blockers, &inspection.warnings);
        let (current_context, current_generation) = self.contexts.snapshot();
        let identity_current = context_matches(
            &target,
            &current_context,
            current_generation,
            self.contexts.active_profile_id(),
        );
        let mut blockers = inspection.blockers;
        if !identity_current {
            blockers.push(issue(
                StreamSwitchIssueCode::ConnectionUnavailable,
                "The active profile, connection, or workspace changed during preflight.",
                Vec::new(),
            ));
        }
        let ready = blockers.is_empty();
        let expires_at = now_ms().saturating_add(self.ttl_ms as i64);
        let token = ready.then(|| {
            self.tokens.issue(
                TokenRecord {
                    target: target.clone(),
                    preview_digest: preview_digest.clone(),
                    has_warnings: !inspection.warnings.is_empty(),
                    expires_at,
                },
                now_ms(),
            )
        });
        StreamSwitchPreflight {
            ready,
            current_stream: inspection.current_stream,
            target_stream: inspection.target_stream,
            target_type: Some(inspection.target_type),
            target_parent: inspection.target_parent,
            mode: request.mode,
            sync_required: target.current_stream.as_deref() != Some(&target.target_stream),
            risks: inspection.risks,
            blockers,
            warnings: inspection.warnings,
            target_snapshot: Some(target),
            preview_digest,
            token,
            expires_at,
            ttl_ms: self.ttl_ms,
            log_reference: inspection.operation_ids.first().cloned(),
            operation_ids: inspection.operation_ids,
        }
    }

    pub async fn confirm(
        self: &Arc<Self>,
        confirmation: StreamSwitchConfirmation,
        app: Option<&AppHandle>,
    ) -> StreamSwitchResult {
        let _gate = self.confirmation_gate.lock().await;
        let Some(record) = self.tokens.consume(&confirmation.token) else {
            return rejected(
                StreamSwitchFailureCode::TokenUnknown,
                "The stream switch token is unknown or was already used.",
            );
        };
        if record.expires_at <= now_ms() {
            return rejected(
                StreamSwitchFailureCode::TokenExpired,
                "The stream switch preflight expired. Run preflight again.",
            );
        }
        if record.target != confirmation.target
            || record.preview_digest != confirmation.preview_digest
        {
            return rejected(
                StreamSwitchFailureCode::TargetMismatch,
                "The confirmation does not match the reviewed stream switch snapshot.",
            );
        }
        if record.has_warnings && !confirmation.acknowledge_warnings {
            return rejected(
                StreamSwitchFailureCode::WarningAcknowledgementRequired,
                "The reviewed warnings require explicit acknowledgement.",
            );
        }
        let (context, generation) = self.contexts.snapshot();
        if !context_matches(
            &record.target,
            &context,
            generation,
            self.contexts.active_profile_id(),
        ) {
            return rejected(
                StreamSwitchFailureCode::ContextChanged,
                "The profile, connection, workspace, or runtime generation changed after preflight.",
            );
        }

        let operation_id = valid_operation_id(confirmation.operation_id)
            .unwrap_or_else(|| format!("stream-switch-{}", Uuid::new_v4()));
        let group = self.runner.begin_operation_group(operation_id.clone());
        let mutation_guard = self.runner.lock_mutations(&context.server).await;
        if let Err(message) = group.ensure_active() {
            return cancelled_result(operation_id, message, false, false);
        }
        let reinspection = self
            .inspect(
                &context,
                &record.target.target_stream,
                record.target.mode,
                &operation_id,
                &group,
                app,
            )
            .await;
        let reinspection = match reinspection {
            Ok(value) => value,
            Err(message) => {
                return rejected_with_operation(
                    StreamSwitchFailureCode::PreflightBlocked,
                    format!("The workspace could not be revalidated safely: {message}"),
                    operation_id,
                )
            }
        };
        let rechecked = snapshot(
            &context,
            generation,
            self.contexts.active_profile_id(),
            record.target.mode,
            &reinspection,
        );
        if !reinspection.blockers.is_empty() {
            return rejected_with_operation(
                StreamSwitchFailureCode::PreflightBlocked,
                "Workspace risks now block the stream switch. Review a fresh preflight.",
                operation_id,
            );
        }
        if rechecked != record.target
            || preview_digest(&rechecked, &reinspection.blockers, &reinspection.warnings)
                != record.preview_digest
        {
            return rejected_with_operation(
                StreamSwitchFailureCode::PreflightChanged,
                "The client spec, target stream, or workspace file state changed after preflight.",
                operation_id,
            );
        }
        if record.expires_at <= now_ms() {
            return rejected_with_operation(
                StreamSwitchFailureCode::TokenExpired,
                "The preflight expired while waiting for the mutation lane.",
                operation_id,
            );
        }
        let (latest_context, latest_generation) = self.contexts.snapshot();
        if !context_matches(
            &record.target,
            &latest_context,
            latest_generation,
            self.contexts.active_profile_id(),
        ) {
            return rejected_with_operation(
                StreamSwitchFailureCode::ContextChanged,
                "The active runtime changed during confirmation.",
                operation_id,
            );
        }

        let needs_switch =
            record.target.current_stream.as_deref() != Some(record.target.target_stream.as_str());
        let mut stream_changed = false;
        if needs_switch {
            let switch_id = format!("{operation_id}:client-switch");
            let switched = self
                .runner
                .run_with_mutation_guard(
                    command_request(
                        &context,
                        "client",
                        vec![
                            "-s".into(),
                            "-S".into(),
                            record.target.target_stream.clone(),
                            record.target.client.clone(),
                        ],
                        switch_id.clone(),
                        120_000,
                    ),
                    app,
                    Some(1),
                    &mutation_guard,
                )
                .await;
            match switched {
                Ok(result) if result.exit_code == 0 => stream_changed = true,
                Ok(result) if was_cancelled(&result) => {
                    let observed = self
                        .read_client_spec(
                            &context,
                            &format!("{operation_id}:verify-after-cancel"),
                            app,
                        )
                        .await
                        .ok()
                        .and_then(|value| client_stream(&value));
                    let changed = observed.as_deref() == Some(&record.target.target_stream);
                    return if changed {
                        finish_after_change(
                            &self.contexts,
                            &record.target,
                            StreamSwitchOutcome::Cancelled,
                            Some(StreamSwitchFailureCode::Cancelled),
                            "Cancellation arrived after the server changed the client Stream. Files were not synced or rolled back; run a fresh recovery preflight.",
                            operation_id,
                            true,
                            false,
                            false,
                            observed,
                        )
                    } else {
                        cancelled_result(
                            operation_id,
                            "Stream switch was cancelled before a target Stream change could be verified.",
                            false,
                            false,
                        )
                    };
                }
                Ok(_) => {
                    let observed = self
                        .read_client_spec(
                            &context,
                            &format!("{operation_id}:verify-after-rejection"),
                            app,
                        )
                        .await
                        .ok()
                        .and_then(|value| client_stream(&value));
                    let changed = observed.as_deref() == Some(&record.target.target_stream);
                    return if changed {
                        finish_after_change(
                            &self.contexts,
                            &record.target,
                            StreamSwitchOutcome::Unknown,
                            Some(StreamSwitchFailureCode::UncertainOutcome),
                            "The client command reported failure, but the target Stream is now active. Files were not synced or rolled back; run a fresh recovery preflight.",
                            operation_id,
                            true,
                            false,
                            false,
                            observed,
                        )
                    } else {
                        failed_result(
                            StreamSwitchFailureCode::SwitchFailed,
                            "The server rejected the client stream switch. No forced switch was attempted.",
                            operation_id,
                            false,
                            false,
                            false,
                            observed,
                        )
                    };
                }
                Err(error) => {
                    let message = error.to_string();
                    let observed = self
                        .read_client_spec(
                            &context,
                            &format!("{operation_id}:verify-after-error"),
                            app,
                        )
                        .await
                        .ok()
                        .and_then(|value| client_stream(&value));
                    let changed = observed.as_deref() == Some(&record.target.target_stream);
                    return if changed {
                        finish_after_change(
                            &self.contexts,
                            &record.target,
                            if message.to_ascii_lowercase().contains("cancel") {
                                StreamSwitchOutcome::Cancelled
                            } else {
                                StreamSwitchOutcome::Unknown
                            },
                            Some(if message.to_ascii_lowercase().contains("cancel") {
                                StreamSwitchFailureCode::Cancelled
                            } else {
                                StreamSwitchFailureCode::UncertainOutcome
                            }),
                            "The client command ended without a reliable response, but the target Stream is active. Files were not synced or rolled back; run a fresh recovery preflight.",
                            operation_id,
                            true,
                            false,
                            false,
                            observed,
                        )
                    } else {
                        uncertain_or_cancelled(operation_id, message, false, false)
                    };
                }
            }
        }

        let verified = self
            .read_client_spec(&context, &format!("{operation_id}:verify-client"), app)
            .await;
        let verified_stream = verified
            .as_ref()
            .ok()
            .and_then(client_stream)
            .filter(|value| value == &record.target.target_stream);
        if verified_stream.is_none() {
            return finish_after_change(
                &self.contexts,
                &record.target,
                StreamSwitchOutcome::Failed,
                Some(StreamSwitchFailureCode::VerificationFailed),
                "The client command completed, but the target Stream could not be verified. Files were not synced; refresh before recovery.",
                operation_id,
                stream_changed,
                false,
                false,
                verified.ok().and_then(|value| client_stream(&value)),
            );
        }

        let mut sync_performed = false;
        let mut sync_completed = false;
        if record.target.mode == StreamSwitchMode::Sync {
            if let Err(message) = group.ensure_active() {
                return cancelled_result(operation_id, message, stream_changed, false);
            }
            sync_performed = true;
            let sync_id = format!("{operation_id}:sync");
            let synced = self
                .runner
                .run_with_mutation_guard(
                    command_request(
                        &context,
                        "sync",
                        vec![format!("//{}/...#head", record.target.client)],
                        sync_id,
                        600_000,
                    ),
                    app,
                    None,
                    &mutation_guard,
                )
                .await;
            match synced {
                Ok(result) if result.exit_code == 0 => sync_completed = true,
                Ok(result) if was_cancelled(&result) => {
                    return finish_after_change(
                        &self.contexts,
                        &record.target,
                        StreamSwitchOutcome::Cancelled,
                        Some(StreamSwitchFailureCode::Cancelled),
                        "The stream view changed, but sync was cancelled. Already transferred files were not rolled back; run a fresh preflight to recover.",
                        operation_id,
                        stream_changed,
                        true,
                        false,
                        verified_stream,
                    )
                }
                Ok(_) => {
                    return finish_after_change(
                        &self.contexts,
                        &record.target,
                        StreamSwitchOutcome::Failed,
                        Some(StreamSwitchFailureCode::SyncFailed),
                        "The stream view changed, but sync did not complete. Local files were not cleaned or reverted; run a fresh sync preflight to recover.",
                        operation_id,
                        stream_changed,
                        true,
                        false,
                        verified_stream,
                    )
                }
                Err(error) => {
                    let cancelled = error.to_string().to_ascii_lowercase().contains("cancel");
                    return finish_after_change(
                        &self.contexts,
                        &record.target,
                        if cancelled { StreamSwitchOutcome::Cancelled } else { StreamSwitchOutcome::Unknown },
                        Some(if cancelled { StreamSwitchFailureCode::Cancelled } else { StreamSwitchFailureCode::UncertainOutcome }),
                        "The stream view changed, but the sync outcome is incomplete or unknown. Refresh before retrying; no automatic rollback was attempted.",
                        operation_id,
                        stream_changed,
                        true,
                        false,
                        verified_stream,
                    )
                }
            }
        }

        if let Err(message) = group.ensure_active() {
            return finish_after_change(
                &self.contexts,
                &record.target,
                StreamSwitchOutcome::Cancelled,
                Some(StreamSwitchFailureCode::Cancelled),
                message,
                operation_id,
                stream_changed,
                sync_performed,
                sync_completed,
                verified_stream,
            );
        }
        finish_after_change(
            &self.contexts,
            &record.target,
            StreamSwitchOutcome::Succeeded,
            None,
            if sync_completed {
                "The client Stream was verified and the workspace sync completed."
            } else if stream_changed {
                "The client Stream was verified. Workspace files were left unchanged by explicit choice."
            } else {
                "The client already used this Stream and the requested workspace sync completed."
            },
            operation_id,
            stream_changed,
            sync_performed,
            sync_completed,
            verified_stream,
        )
    }

    async fn inspect(
        &self,
        context: &P4Context,
        target_stream: &str,
        mode: StreamSwitchMode,
        operation_id: &str,
        group: &crate::p4::runner::OperationGroup,
        app: Option<&AppHandle>,
    ) -> Result<Inspection, String> {
        if context.server.trim().is_empty()
            || context.user.trim().is_empty()
            || context.client.trim().is_empty()
        {
            return Err("A connected server, user, and client are required.".into());
        }
        let workspace = context.cwd.as_deref().unwrap_or_default().trim();
        let mut blockers = Vec::new();
        let mut warnings = Vec::new();
        if workspace.is_empty() || !Path::new(workspace).is_dir() {
            blockers.push(issue(
                StreamSwitchIssueCode::MissingWorkspaceRoot,
                "The current workspace Root is missing or is not a directory.",
                Vec::new(),
            ));
        }

        let mut operation_ids = Vec::new();
        let info_id = format!("{operation_id}:info");
        let info = self
            .run(context, "info", Vec::new(), info_id.clone(), 30_000, app)
            .await?;
        operation_ids.push(info_id);
        group.ensure_active()?;
        ensure_success(&info, "Connection/authentication inspection failed")?;

        let client_id = format!("{operation_id}:client");
        let client_spec = self.read_client_spec(context, &client_id, app).await?;
        operation_ids.push(client_id);
        group.ensure_active()?;
        let spec_client = field(&client_spec, &["Client", "client"]).unwrap_or_default();
        if spec_client != context.client {
            return Err("The server returned a different client specification.".into());
        }
        let owner = field(&client_spec, &["Owner", "owner"]).unwrap_or_default();
        if !owner.is_empty() && !owner.eq_ignore_ascii_case(&context.user) {
            blockers.push(issue(
                StreamSwitchIssueCode::ClientOwnerMismatch,
                "The current user does not own this client workspace.",
                Vec::new(),
            ));
        }
        let options = field(&client_spec, &["Options", "options"])
            .unwrap_or_default()
            .to_ascii_lowercase();
        if options.split_whitespace().any(|value| value == "locked") {
            warnings.push(issue(
                StreamSwitchIssueCode::LockedClient,
                "The client is locked; only its owner can change the Stream field.",
                Vec::new(),
            ));
        }
        let current_stream = client_stream(&client_spec);
        if current_stream.is_none() {
            warnings.push(issue(
                StreamSwitchIssueCode::ClassicWorkspace,
                "The current client is a classic (non-stream) workspace. Switching will replace its View with the target stream view, but files remain unchanged until sync.",
                Vec::new(),
            ));
        }

        let stream_id = format!("{operation_id}:stream");
        let stream_result = self
            .run(
                context,
                "stream",
                vec!["-o".into(), target_stream.into()],
                stream_id.clone(),
                30_000,
                app,
            )
            .await?;
        operation_ids.push(stream_id);
        group.ensure_active()?;
        ensure_success(&stream_result, "Target stream inspection failed")?;
        let stream_spec = first_record(&stream_result)
            .ok_or_else(|| "The target stream does not exist or is not visible.".to_owned())?;
        let canonical_stream = field(&stream_spec, &["Stream", "stream"])
            .filter(|value| !value.is_empty())
            .ok_or_else(|| "The server did not return a target Stream field.".to_owned())?;
        let target_type = field(&stream_spec, &["Type", "type"])
            .unwrap_or_default()
            .to_ascii_lowercase();
        let target_parent = field(&stream_spec, &["Parent", "parent"])
            .filter(|value| !value.is_empty() && value != "none");
        if !supported_stream_type(&target_type) {
            blockers.push(issue(
                StreamSwitchIssueCode::UnsupportedStreamType,
                format!(
                    "Stream type '{target_type}' is not supported by this safe switch workflow."
                ),
                Vec::new(),
            ));
        } else if target_type == "virtual" {
            warnings.push(issue(
                StreamSwitchIssueCode::VirtualStream,
                "The target is a virtual stream. Its generated view may be read-only or restricted by the server.",
                Vec::new(),
            ));
        }
        if current_stream.as_deref() == Some(canonical_stream.as_str())
            && mode == StreamSwitchMode::ViewOnly
        {
            blockers.push(issue(
                StreamSwitchIssueCode::SameStream,
                "The client already uses this Stream. Choose sync only when recovering an incomplete workspace update.",
                Vec::new(),
            ));
        }

        let protects_id = format!("{operation_id}:protects");
        let protects = self
            .run(
                context,
                "protects",
                vec![
                    "-m".into(),
                    format!("{}/...", canonical_stream.trim_end_matches('/')),
                ],
                protects_id.clone(),
                30_000,
                app,
            )
            .await?;
        operation_ids.push(protects_id);
        group.ensure_active()?;
        if protects.exit_code != 0 {
            blockers.push(issue(
                permission_or_auth(&event_text(&protects)),
                "Read permission for the target stream could not be verified.",
                Vec::new(),
            ));
        } else if !canonical_records(&protects).iter().any(|record| {
            field(record, &["perm", "permMax", "permission"])
                .is_some_and(|permission| permission_allows_read(&permission))
        }) {
            blockers.push(issue(
                StreamSwitchIssueCode::PermissionDenied,
                "The current user does not have verified read permission for the target stream.",
                Vec::new(),
            ));
        }

        let opened_id = format!("{operation_id}:opened");
        let opened = self
            .run(
                context,
                "opened",
                vec!["//...".into()],
                opened_id.clone(),
                60_000,
                app,
            )
            .await?;
        operation_ids.push(opened_id);
        group.ensure_active()?;
        ensure_success_or_empty(&opened, &["not opened", "file(s) not opened"])?;
        let opened_paths = record_paths(&opened, &["depotFile", "clientFile", "path"]);

        let resolve_id = format!("{operation_id}:resolve");
        let resolve = self
            .run(
                context,
                "resolve",
                vec!["-n".into(), "-N".into(), "//...".into()],
                resolve_id.clone(),
                60_000,
                app,
            )
            .await?;
        operation_ids.push(resolve_id);
        group.ensure_active()?;
        ensure_success_or_empty(&resolve, &["no file(s) to resolve", "no files to resolve"])?;
        let unresolved_paths =
            record_paths(&resolve, &["fromFile", "toFile", "clientFile", "path"]);

        let reconcile_id = format!("{operation_id}:reconcile");
        let reconcile_filespec = format!(
            "{}{}...",
            workspace.trim_end_matches(['/', '\\']),
            std::path::MAIN_SEPARATOR
        );
        let reconcile = self
            .run(
                context,
                "reconcile",
                vec![
                    "-n".into(),
                    "-e".into(),
                    "-a".into(),
                    "-d".into(),
                    "-f".into(),
                    "-l".into(),
                    reconcile_filespec,
                ],
                reconcile_id.clone(),
                180_000,
                app,
            )
            .await?;
        operation_ids.push(reconcile_id);
        group.ensure_active()?;
        ensure_success_or_empty(
            &reconcile,
            &["no file(s) to reconcile", "no files to reconcile"],
        )?;
        let reconcile_paths = record_paths(&reconcile, &["clientFile", "depotFile", "path"]);

        let sizes_id = format!("{operation_id}:sizes");
        let sizes = self
            .run(
                context,
                "sizes",
                vec![
                    "-sh".into(),
                    format!("{}/...", canonical_stream.trim_end_matches('/')),
                ],
                sizes_id.clone(),
                60_000,
                app,
            )
            .await?;
        operation_ids.push(sizes_id);
        group.ensure_active()?;
        let (target_file_count, target_file_bytes) = if sizes.exit_code == 0 {
            sizes_summary(&sizes)
        } else {
            warnings.push(issue(
                StreamSwitchIssueCode::InspectionUnavailable,
                "Target stream size could not be estimated; the sync impact count is unavailable.",
                Vec::new(),
            ));
            (None, None)
        };

        if !opened_paths.is_empty() {
            blockers.push(issue(
                StreamSwitchIssueCode::OpenedFiles,
                "The workspace has opened files. P4Deck never uses the force switch option; submit, shelve, or revert them explicitly first.",
                report_paths(&opened_paths),
            ));
        }
        if !unresolved_paths.is_empty() {
            blockers.push(issue(
                StreamSwitchIssueCode::UnresolvedFiles,
                "The workspace has unresolved files. Resolve them before switching streams.",
                report_paths(&unresolved_paths),
            ));
        }
        if !reconcile_paths.is_empty() {
            let item = issue(
                StreamSwitchIssueCode::LocalChanges,
                if mode == StreamSwitchMode::Sync {
                    "Unopened local modifications, missing files, or untracked files would be exposed to sync. Sync is blocked to prevent overwrite or deletion."
                } else {
                    "Unopened local modifications, missing files, or untracked files exist. View-only switching will not touch them, but review them before a later sync."
                },
                report_paths(&reconcile_paths),
            );
            if mode == StreamSwitchMode::Sync {
                blockers.push(item);
            } else {
                warnings.push(item);
            }
        }
        if mode == StreamSwitchMode::Sync {
            warnings.push(issue(
                StreamSwitchIssueCode::SyncChangesWorkspace,
                "After the Stream field is verified, a normal non-force sync to #head will add, update, or remove files to match the target stream. Cancellation does not roll back transferred files.",
                Vec::new(),
            ));
        }

        let risks = StreamSwitchRiskSummary {
            opened_files: opened_paths.len(),
            unresolved_files: unresolved_paths.len(),
            reconcile_files: reconcile_paths.len(),
            target_file_count,
            target_file_bytes,
        };
        let risk_digest = hash_json(&serde_json::json!({
            "protects": canonical_records(&protects),
            "opened": canonical_records(&opened),
            "resolve": canonical_records(&resolve),
            "reconcile": canonical_records(&reconcile),
            "risks": risks,
        }));
        Ok(Inspection {
            current_stream,
            target_stream: canonical_stream,
            target_type,
            target_parent,
            client_spec,
            stream_spec,
            risks,
            blockers,
            warnings,
            risk_digest,
            operation_ids,
        })
    }

    async fn read_client_spec(
        &self,
        context: &P4Context,
        operation_id: &str,
        app: Option<&AppHandle>,
    ) -> Result<Value, String> {
        let result = self
            .run(
                context,
                "client",
                vec!["-o".into(), context.client.clone()],
                operation_id.into(),
                30_000,
                app,
            )
            .await?;
        ensure_success(&result, "Client specification inspection failed")?;
        first_record(&result).ok_or_else(|| "The client specification was empty.".into())
    }

    async fn run(
        &self,
        context: &P4Context,
        command: &str,
        args: Vec<String>,
        operation_id: String,
        timeout_ms: u64,
        app: Option<&AppHandle>,
    ) -> Result<OperationResult, String> {
        self.runner
            .run(
                command_request(context, command, args, operation_id, timeout_ms),
                app,
            )
            .await
            .map_err(|error| error.to_string())
    }
}

fn snapshot(
    context: &P4Context,
    generation: u64,
    active_profile_id: Option<String>,
    mode: StreamSwitchMode,
    inspection: &Inspection,
) -> StreamSwitchTargetSnapshot {
    StreamSwitchTargetSnapshot {
        server: context.server.clone(),
        user: context.user.clone(),
        client: context.client.clone(),
        workspace: context.cwd.clone().unwrap_or_default(),
        active_profile_id,
        context_generation: generation,
        current_stream: inspection.current_stream.clone(),
        target_stream: inspection.target_stream.clone(),
        target_type: inspection.target_type.clone(),
        target_parent: inspection.target_parent.clone(),
        mode,
        client_spec_digest: spec_digest(&inspection.client_spec),
        stream_spec_digest: spec_digest(&inspection.stream_spec),
        risk_digest: inspection.risk_digest.clone(),
    }
}

fn command_request(
    context: &P4Context,
    command: &str,
    args: Vec<String>,
    operation_id: String,
    timeout_ms: u64,
) -> P4CommandRequest {
    P4CommandRequest {
        operation_id: Some(operation_id),
        source: OperationSource::Gui,
        command: command.into(),
        args,
        context: context.clone(),
        output_mode: OutputMode::JsonLines,
        timeout_ms: Some(timeout_ms),
        input: None,
    }
}

fn first_record(result: &OperationResult) -> Option<Value> {
    canonical_records(result).into_iter().find(|value| {
        value.get("code").and_then(Value::as_str) != Some("error")
            && value.as_object().is_some_and(|map| map.len() > 1)
    })
}

fn canonical_records(result: &OperationResult) -> Vec<Value> {
    result
        .events
        .iter()
        .filter(|event| matches!(event.kind, EventKind::Stdout | EventKind::Stderr))
        .filter_map(|event| event.message.as_deref())
        .flat_map(str::lines)
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .collect()
}

fn field(value: &Value, names: &[&str]) -> Option<String> {
    names.iter().find_map(|name| {
        value.get(*name).and_then(|value| {
            value
                .as_str()
                .map(str::to_owned)
                .or_else(|| Some(value.to_string()))
        })
    })
}

fn client_stream(value: &Value) -> Option<String> {
    field(value, &["Stream", "stream"]).filter(|value| !value.trim().is_empty())
}

fn supported_stream_type(value: &str) -> bool {
    matches!(
        value,
        "mainline" | "development" | "release" | "task" | "virtual" | "sparsedev" | "sparserel"
    )
}

fn record_paths(result: &OperationResult, fields: &[&str]) -> Vec<String> {
    canonical_records(result)
        .iter()
        .filter_map(|record| field(record, fields))
        .filter(|value| !value.is_empty() && !value.eq_ignore_ascii_case("none"))
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

fn report_paths(paths: &[String]) -> Vec<String> {
    paths.iter().take(MAX_REPORTED_PATHS).cloned().collect()
}

fn sizes_summary(result: &OperationResult) -> (Option<u64>, Option<u64>) {
    let mut files = None;
    let mut bytes = None;
    for value in canonical_records(result) {
        files = files.or_else(|| numeric_field(&value, &["fileCount", "filecount"]));
        bytes = bytes.or_else(|| numeric_field(&value, &["fileSize", "filesize"]));
    }
    (files, bytes)
}

fn numeric_field(value: &Value, names: &[&str]) -> Option<u64> {
    names.iter().find_map(|name| {
        value
            .get(*name)
            .and_then(|value| value.as_u64().or_else(|| value.as_str()?.parse().ok()))
    })
}

fn ensure_success(result: &OperationResult, prefix: &str) -> Result<(), String> {
    if result.exit_code == 0 {
        Ok(())
    } else {
        Err(format!("{prefix}: {}", event_text(result)))
    }
}

fn ensure_success_or_empty(result: &OperationResult, empty: &[&str]) -> Result<(), String> {
    if result.exit_code == 0 {
        return Ok(());
    }
    let text = event_text(result).to_ascii_lowercase();
    if empty.iter().any(|pattern| text.contains(pattern)) {
        Ok(())
    } else {
        Err(text)
    }
}

fn was_cancelled(result: &OperationResult) -> bool {
    result
        .events
        .iter()
        .any(|event| matches!(event.kind, EventKind::Cancelled))
}

fn event_text(result: &OperationResult) -> String {
    result
        .events
        .iter()
        .filter_map(|event| event.message.as_deref())
        .collect::<Vec<_>>()
        .join("\n")
}

fn validate_stream_path(value: &str) -> Result<String, String> {
    let value = value.trim();
    if !value.starts_with("//")
        || value.len() > 1024
        || value.chars().any(char::is_control)
        || value.chars().any(|character| "@#%*?".contains(character))
        || value[2..]
            .split('/')
            .filter(|segment| !segment.is_empty())
            .count()
            < 2
    {
        return Err("A literal stream path like //depot/stream is required.".into());
    }
    Ok(value.trim_end_matches('/').to_owned())
}

fn hash_json(value: &Value) -> String {
    hash_bytes(&serde_json::to_vec(value).expect("JSON digest input is serializable"))
}

fn spec_digest(value: &Value) -> String {
    let mut stable = value.clone();
    if let Some(fields) = stable.as_object_mut() {
        fields.retain(|name, _| {
            !name.eq_ignore_ascii_case("access") && !name.eq_ignore_ascii_case("update")
        });
    }
    hash_json(&stable)
}

fn preview_digest(
    target: &StreamSwitchTargetSnapshot,
    blockers: &[StreamSwitchIssue],
    warnings: &[StreamSwitchIssue],
) -> String {
    let bytes = serde_json::to_vec(&serde_json::json!({
        "target": target,
        "blockers": blockers,
        "warnings": warnings,
    }))
    .expect("stream preview digest input is serializable");
    hash_bytes(&bytes)
}

fn hash_bytes(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn context_matches(
    target: &StreamSwitchTargetSnapshot,
    context: &P4Context,
    generation: u64,
    active_profile_id: Option<String>,
) -> bool {
    target.server == context.server
        && target.user == context.user
        && target.client == context.client
        && target.workspace == context.cwd.clone().unwrap_or_default()
        && target.context_generation == generation
        && target.active_profile_id == active_profile_id
}

fn permission_or_auth(text: &str) -> StreamSwitchIssueCode {
    let lower = text.to_ascii_lowercase();
    if lower.contains("password") || lower.contains("ticket") || lower.contains("login") {
        StreamSwitchIssueCode::AuthenticationRequired
    } else {
        StreamSwitchIssueCode::PermissionDenied
    }
}

fn permission_allows_read(value: &str) -> bool {
    matches!(
        value
            .trim()
            .trim_start_matches('=')
            .to_ascii_lowercase()
            .as_str(),
        "read" | "open" | "write" | "admin" | "super"
    )
}

fn inspection_issue_code(text: &str) -> StreamSwitchIssueCode {
    let lower = text.to_ascii_lowercase();
    if lower.contains("password") || lower.contains("ticket") || lower.contains("login") {
        StreamSwitchIssueCode::AuthenticationRequired
    } else if lower.contains("permission") || lower.contains("protections") {
        StreamSwitchIssueCode::PermissionDenied
    } else if lower.contains("connect") || lower.contains("offline") || lower.contains("timed out")
    {
        StreamSwitchIssueCode::ConnectionUnavailable
    } else {
        StreamSwitchIssueCode::InspectionUnavailable
    }
}

fn issue(
    code: StreamSwitchIssueCode,
    message: impl Into<String>,
    paths: Vec<String>,
) -> StreamSwitchIssue {
    StreamSwitchIssue {
        code,
        message: message.into(),
        paths,
    }
}

fn blocked_preflight(
    request: StreamSwitchPreflightRequest,
    blocker: StreamSwitchIssue,
    ttl_ms: u64,
    operation_ids: Vec<String>,
) -> StreamSwitchPreflight {
    StreamSwitchPreflight {
        ready: false,
        current_stream: None,
        target_stream: request.target_stream,
        target_type: None,
        target_parent: None,
        mode: request.mode,
        sync_required: false,
        risks: StreamSwitchRiskSummary {
            opened_files: 0,
            unresolved_files: 0,
            reconcile_files: 0,
            target_file_count: None,
            target_file_bytes: None,
        },
        blockers: vec![blocker],
        warnings: Vec::new(),
        target_snapshot: None,
        preview_digest: String::new(),
        token: None,
        expires_at: now_ms().saturating_add(ttl_ms as i64),
        ttl_ms,
        log_reference: operation_ids.first().cloned(),
        operation_ids,
    }
}

fn rejected(failure: StreamSwitchFailureCode, message: impl Into<String>) -> StreamSwitchResult {
    StreamSwitchResult {
        outcome: StreamSwitchOutcome::Rejected,
        failure: Some(failure),
        message: message.into(),
        stream_changed: false,
        sync_performed: false,
        sync_completed: false,
        verified_stream: None,
        operation_id: None,
        log_reference: None,
        runtime: None,
        refresh: refresh("Run a fresh stream switch preflight."),
    }
}

fn rejected_with_operation(
    failure: StreamSwitchFailureCode,
    message: impl Into<String>,
    operation_id: String,
) -> StreamSwitchResult {
    StreamSwitchResult {
        operation_id: Some(operation_id.clone()),
        log_reference: Some(operation_id),
        ..rejected(failure, message)
    }
}

fn failed_result(
    failure: StreamSwitchFailureCode,
    message: impl Into<String>,
    operation_id: String,
    stream_changed: bool,
    sync_performed: bool,
    sync_completed: bool,
    verified_stream: Option<String>,
) -> StreamSwitchResult {
    StreamSwitchResult {
        outcome: StreamSwitchOutcome::Failed,
        failure: Some(failure),
        message: message.into(),
        stream_changed,
        sync_performed,
        sync_completed,
        verified_stream,
        operation_id: Some(operation_id.clone()),
        log_reference: Some(operation_id),
        runtime: None,
        refresh: refresh("Refresh all workspace-dependent data before recovery."),
    }
}

fn cancelled_result(
    operation_id: String,
    message: impl Into<String>,
    stream_changed: bool,
    sync_performed: bool,
) -> StreamSwitchResult {
    failed_result(
        StreamSwitchFailureCode::Cancelled,
        message,
        operation_id,
        stream_changed,
        sync_performed,
        false,
        None,
    )
    .with_outcome(StreamSwitchOutcome::Cancelled)
}

fn uncertain_or_cancelled(
    operation_id: String,
    message: String,
    stream_changed: bool,
    sync_performed: bool,
) -> StreamSwitchResult {
    let cancelled = message.to_ascii_lowercase().contains("cancel");
    failed_result(
        if cancelled {
            StreamSwitchFailureCode::Cancelled
        } else {
            StreamSwitchFailureCode::UncertainOutcome
        },
        message,
        operation_id,
        stream_changed,
        sync_performed,
        false,
        None,
    )
    .with_outcome(if cancelled {
        StreamSwitchOutcome::Cancelled
    } else {
        StreamSwitchOutcome::Unknown
    })
}

trait StreamSwitchResultOutcome {
    fn with_outcome(self, outcome: StreamSwitchOutcome) -> Self;
}

impl StreamSwitchResultOutcome for StreamSwitchResult {
    fn with_outcome(mut self, outcome: StreamSwitchOutcome) -> Self {
        self.outcome = outcome;
        self
    }
}

#[allow(clippy::too_many_arguments)]
fn finish_after_change(
    contexts: &ContextStore,
    target: &StreamSwitchTargetSnapshot,
    mut outcome: StreamSwitchOutcome,
    mut failure: Option<StreamSwitchFailureCode>,
    message: impl Into<String>,
    operation_id: String,
    stream_changed: bool,
    sync_performed: bool,
    sync_completed: bool,
    verified_stream: Option<String>,
) -> StreamSwitchResult {
    let mut message = message.into();
    if stream_changed {
        if let Err(error) = contexts.advance_generation_if_unchanged(target.context_generation) {
            outcome = StreamSwitchOutcome::Unknown;
            failure = Some(StreamSwitchFailureCode::ContextChanged);
            message = format!(
                "The old client may have switched streams, but the active runtime changed before the result could be committed: {error}"
            );
        }
    }
    StreamSwitchResult {
        outcome,
        failure,
        message,
        stream_changed,
        sync_performed,
        sync_completed,
        verified_stream,
        operation_id: Some(operation_id.clone()),
        log_reference: Some(operation_id),
        runtime: None,
        refresh: refresh(
            "The stream/client mapping changed; refresh every workspace-dependent view.",
        ),
    }
}

fn refresh(reason: impl Into<String>) -> StreamSwitchRefreshAdvice {
    StreamSwitchRefreshAdvice {
        workspace: true,
        streams: true,
        pending_changes: true,
        submitted_changes: true,
        search: true,
        depot: true,
        reason: reason.into(),
    }
}

fn valid_operation_id(value: Option<String>) -> Option<String> {
    value.filter(|value| {
        !value.trim().is_empty() && value.len() <= 256 && !value.chars().any(char::is_control)
    })
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn target() -> StreamSwitchTargetSnapshot {
        StreamSwitchTargetSnapshot {
            server: "localhost:1666".into(),
            user: "alice".into(),
            client: "workspace".into(),
            workspace: "C:/work/项目".into(),
            active_profile_id: Some("profile-a".into()),
            context_generation: 7,
            current_stream: Some("//depot/main".into()),
            target_stream: "//depot/开发 @ safe".replace('@', "at"),
            target_type: "development".into(),
            target_parent: Some("//depot/main".into()),
            mode: StreamSwitchMode::ViewOnly,
            client_spec_digest: "client".into(),
            stream_spec_digest: "stream".into(),
            risk_digest: "risk".into(),
        }
    }

    #[test]
    fn snapshot_identity_binds_profile_generation_workspace_and_stream() {
        let target = target();
        let context = P4Context {
            server: target.server.clone(),
            user: target.user.clone(),
            client: target.client.clone(),
            cwd: Some(target.workspace.clone()),
            ..Default::default()
        };
        assert!(context_matches(
            &target,
            &context,
            7,
            Some("profile-a".into())
        ));
        assert!(!context_matches(
            &target,
            &context,
            8,
            Some("profile-a".into())
        ));
        assert!(!context_matches(
            &target,
            &context,
            7,
            Some("profile-b".into())
        ));
    }

    #[test]
    fn preview_digest_detects_toctou_risk_and_target_changes() {
        let mut target = target();
        let warning = issue(
            StreamSwitchIssueCode::LocalChanges,
            "modified",
            vec!["C:/work/项目/文件.txt".into()],
        );
        let first = preview_digest(&target, &[], std::slice::from_ref(&warning));
        target.risk_digest = "changed".into();
        assert_ne!(first, preview_digest(&target, &[], &[warning]));
        target.risk_digest = "risk".into();
        target.target_stream = "//depot/release".into();
        assert_ne!(first, preview_digest(&target, &[], &[]));
    }

    #[test]
    fn confirmation_tokens_are_one_time_and_wrong_binding_is_detectable() {
        let store = ConfirmationStore::default();
        let target = target();
        let token = store.issue(
            TokenRecord {
                target: target.clone(),
                preview_digest: "digest".into(),
                has_warnings: true,
                expires_at: 50,
            },
            0,
        );
        let record = store.consume(&token).unwrap();
        assert_eq!(record.target, target);
        assert!(record.has_warnings);
        assert!(store.consume(&token).is_none());

        let expired = store.issue(
            TokenRecord {
                target,
                preview_digest: "old".into(),
                has_warnings: false,
                expires_at: 1,
            },
            0,
        );
        let _fresh = store.issue(
            TokenRecord {
                target: target_for("//depot/other"),
                preview_digest: "new".into(),
                has_warnings: false,
                expires_at: 100,
            },
            2,
        );
        assert!(store.consume(&expired).is_none());
    }

    fn target_for(stream: &str) -> StreamSwitchTargetSnapshot {
        StreamSwitchTargetSnapshot {
            target_stream: stream.into(),
            ..target()
        }
    }

    #[test]
    fn client_spec_json_round_trip_preserves_unknown_fields_and_binds_them() {
        let value = serde_json::json!({
            "Client": "workspace",
            "Root": "C:/work/项目",
            "Stream": "//depot/main",
            "FutureServerField": { "nested": ["保留", 7] },
            "View0": "//depot/main/... //workspace/..."
        });
        let encoded = serde_json::to_vec(&value).unwrap();
        let decoded: Value = serde_json::from_slice(&encoded).unwrap();
        assert_eq!(decoded, value);
        let before = spec_digest(&decoded);
        let mut changed = decoded;
        changed["FutureServerField"]["nested"][1] = Value::from(8);
        assert_ne!(before, spec_digest(&changed));
    }

    #[test]
    fn path_validation_accepts_unicode_and_spaces_but_rejects_filespec_syntax() {
        assert_eq!(
            validate_stream_path("//产品/开发 分支/").unwrap(),
            "//产品/开发 分支"
        );
        assert!(validate_stream_path("//depot/main@42").is_err());
        assert!(validate_stream_path("//depot/*").is_err());
        assert!(validate_stream_path("main").is_err());
    }

    #[test]
    fn all_supported_stream_types_remain_switchable() {
        for kind in [
            "mainline",
            "development",
            "release",
            "task",
            "virtual",
            "sparsedev",
            "sparserel",
        ] {
            assert!(supported_stream_type(kind), "{kind}");
        }
        assert!(!supported_stream_type("future-unknown"));
    }

    #[test]
    fn target_permissions_require_real_file_read_access() {
        for permission in ["read", "open", "write", "admin", "super", "=read"] {
            assert!(permission_allows_read(permission), "{permission}");
        }
        for permission in ["", "list", "review", "branch"] {
            assert!(!permission_allows_read(permission), "{permission}");
        }
    }

    #[test]
    fn failures_never_claim_automatic_rollback() {
        let result = failed_result(
            StreamSwitchFailureCode::SyncFailed,
            "sync incomplete",
            "operation".into(),
            true,
            true,
            false,
            Some("//depot/dev".into()),
        );
        assert!(result.stream_changed);
        assert!(!result.sync_completed);
        assert!(result.refresh.workspace && result.refresh.pending_changes);
    }
}
