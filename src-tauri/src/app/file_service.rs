use crate::{
    app::status_cache::{
        CacheFreshness, CachedFileStatus, FileStatusKind, InvalidationReason, StatusCache,
        StatusCacheKey, StatusQueryKind, StatusSnapshot,
    },
    domain::*,
    p4::{files::command::ActionPlan, runner::P4Runner},
    persistence::operation_journal::{
        connection_id, JournalState, OperationCategory, OperationFailureKind, OperationJournal,
    },
};
use chrono::{DateTime, Utc};
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    sync::Arc,
};
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

pub struct FileService {
    runner: Arc<P4Runner>,
    status_cache: Arc<StatusCache>,
    journal: Arc<OperationJournal>,
}

struct RunOptions {
    output_mode: OutputMode,
    operation_id: Option<String>,
    progress_total: Option<usize>,
    argument_input: Option<Vec<String>>,
}

struct WorkspaceStatusLoad<'a> {
    context: &'a P4Context,
    filespec: &'a str,
    directory: &'a Path,
    local_entries: &'a [LocalEntry],
    local_truncated: bool,
    local_errors: &'a [WorkspaceStatusError],
    operation_prefix: Option<&'a str>,
    app: Option<&'a AppHandle>,
}

impl FileService {
    const WORKSPACE_LIST_SAFETY_LIMIT: usize = 10_000;

    pub fn new(
        runner: Arc<P4Runner>,
        status_cache: Arc<StatusCache>,
        journal: Arc<OperationJournal>,
    ) -> Self {
        Self {
            runner,
            status_cache,
            journal,
        }
    }

    #[cfg(test)]
    pub async fn workspace_children(
        &self,
        context: P4Context,
        path: Option<String>,
        force_refresh: bool,
        app: Option<&AppHandle>,
    ) -> Result<WorkspaceListing, String> {
        self.workspace_children_with_operation(context, path, force_refresh, None, app)
            .await
    }

    pub async fn workspace_children_with_operation(
        &self,
        context: P4Context,
        path: Option<String>,
        force_refresh: bool,
        operation_id: Option<String>,
        app: Option<&AppHandle>,
    ) -> Result<WorkspaceListing, String> {
        let root = canonical_root(&context)?;
        let directory = secure_path(&root, path.as_deref().unwrap_or(""), true)?;
        let local_scan =
            scan_workspace_directory(&root, &directory, Self::WORKSPACE_LIST_SAFETY_LIMIT);
        let filespec = client_child_filespec(&context.client, &root, &directory)?;
        let cache_key = StatusCacheKey::new(
            &context.server,
            &context.user,
            &context.client,
            StatusQueryKind::WorkspaceStatus,
            &display_path(&directory),
            2,
        );
        if force_refresh {
            self.status_cache.invalidate(
                &context.server,
                &context.user,
                &context.client,
                &[display_path(&directory)],
                &[StatusQueryKind::WorkspaceStatus],
                InvalidationReason::ManualRefresh,
            );
        }
        let cache_now = now_ms();
        let has_cached_fallback = self.status_cache.peek(&cache_key, cache_now).is_some();
        let local_entries = local_scan.entries.clone();
        let local_truncated = local_scan.truncated;
        let local_errors = local_scan.errors.clone();
        let snapshot = self
            .status_cache
            .get_or_load(cache_key, cache_now, has_cached_fallback, || async {
                self.load_workspace_status(WorkspaceStatusLoad {
                    context: &context,
                    filespec: &filespec,
                    directory: &directory,
                    local_entries: &local_entries,
                    local_truncated,
                    local_errors: &local_errors,
                    operation_prefix: operation_id.as_deref(),
                    app,
                })
                .await
            })
            .await?;
        let mut local_by_key = local_scan
            .entries
            .into_iter()
            .map(|entry| (local_path_key(&entry.absolute_path), entry))
            .collect::<HashMap<_, _>>();
        let mut nodes = snapshot
            .files
            .iter()
            .filter_map(|value| {
                let key = local_path_key(&value.path);
                let local = local_by_key.remove(&key);
                workspace_node(
                    &root,
                    value,
                    local.as_ref(),
                    snapshot.freshness,
                    !snapshot.errors.is_empty(),
                )
            })
            .collect::<Vec<_>>();
        // A fresh local entry without status evidence is unknown, never implicitly untracked.
        for (_, local) in local_by_key {
            if local.local_state == WorkspaceLocalState::Directory {
                let status = WorkspaceFileStatus {
                    primary: WorkspacePrimaryState::Controlled,
                    opened_action: None,
                    reconcile_action: None,
                    sync: WorkspaceSyncState::Unknown,
                    resolve: WorkspaceResolveState::None,
                    local: WorkspaceLocalState::Directory,
                    mapped: None,
                    moved_file: None,
                    ignore: None,
                    completeness: WorkspaceStatusCompleteness::Complete,
                    evidence: vec![WorkspaceStatusEvidence {
                        source: WorkspaceStatusSource::Filesystem,
                        summary:
                            "Directory is listed without inferring or recursively scanning child status"
                                .into(),
                    }],
                    errors: Vec::new(),
                };
                nodes.push(workspace_node_from_local(&root, local, status));
                continue;
            }
            let errors = vec![WorkspaceStatusError {
                source: WorkspaceStatusSource::Filesystem,
                message: "No authoritative P4 status evidence was returned for this path".into(),
            }];
            let status = WorkspaceFileStatus {
                primary: WorkspacePrimaryState::Unknown,
                opened_action: None,
                reconcile_action: None,
                sync: WorkspaceSyncState::Unknown,
                resolve: WorkspaceResolveState::Unknown,
                local: local.local_state,
                mapped: None,
                moved_file: None,
                ignore: None,
                completeness: WorkspaceStatusCompleteness::Partial,
                evidence: vec![WorkspaceStatusEvidence {
                    source: WorkspaceStatusSource::Filesystem,
                    summary: "Path exists in the workspace".into(),
                }],
                errors,
            };
            nodes.push(workspace_node_from_local(&root, local, status));
        }
        nodes.sort_by_key(|node| (node.kind != "directory", node.name.to_lowercase()));
        let response_truncated = nodes.len() > Self::WORKSPACE_LIST_SAFETY_LIMIT;
        if response_truncated {
            nodes.truncate(Self::WORKSPACE_LIST_SAFETY_LIMIT);
        }
        let mut errors = snapshot.errors.clone();
        errors.extend(local_scan.errors);
        for error in nodes.iter().flat_map(|node| node.status.errors.iter()) {
            if !errors.contains(error) {
                errors.push(error.clone());
            }
        }
        let completeness = listing_completeness(
            &nodes,
            &errors,
            snapshot.truncated || local_scan.truncated || response_truncated,
            snapshot.freshness,
        );
        Ok(WorkspaceListing {
            items: nodes,
            completeness,
            errors,
            operation_ids: snapshot.operation_ids,
            truncated: snapshot.truncated || local_scan.truncated || response_truncated,
            safety_limit: Self::WORKSPACE_LIST_SAFETY_LIMIT,
            cache_freshness: cache_freshness_name(snapshot.freshness).into(),
        })
    }

    async fn load_workspace_status(
        &self,
        request: WorkspaceStatusLoad<'_>,
    ) -> Result<StatusSnapshot, String> {
        let WorkspaceStatusLoad {
            context,
            filespec,
            directory,
            local_entries,
            local_truncated,
            local_errors,
            operation_prefix,
            app,
        } = request;
        let fstat = self
            .run_status(
                context,
                "fstat",
                vec![
                    "-Op".into(),
                    "-Or".into(),
                    "-m".into(),
                    (Self::WORKSPACE_LIST_SAFETY_LIMIT + 1).to_string(),
                    "-T".into(),
                    "path,clientFile,depotFile,isMapped,haveRev,headRev,headAction,action,change,movedFile,unresolved,resolved".into(),
                    filespec.into(),
                ],
                status_operation_id(operation_prefix, "fstat"),
                true,
                app,
            )
            .await?;
        let opened = self
            .run_status(
                context,
                "opened",
                vec![
                    "-m".into(),
                    (Self::WORKSPACE_LIST_SAFETY_LIMIT + 1).to_string(),
                    filespec.into(),
                ],
                status_operation_id(operation_prefix, "opened"),
                true,
                app,
            )
            .await?;
        let resolve = self
            .run_status(
                context,
                "resolve",
                vec!["-n".into(), "-N".into(), filespec.into()],
                status_operation_id(operation_prefix, "resolve"),
                true,
                app,
            )
            .await?;
        let reconcile_filespec = local_child_filespec(directory);
        let reconcile = self
            .run_status(
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
                status_operation_id(operation_prefix, "reconcile"),
                true,
                app,
            )
            .await?;
        let mut snapshot = status_snapshot(
            &fstat,
            &opened,
            &resolve,
            &reconcile,
            local_entries,
            local_truncated,
            local_errors,
        );
        let known = snapshot
            .files
            .iter()
            .map(|status| local_path_key(&status.path))
            .collect::<HashSet<_>>();
        let ignore_candidates = local_entries
            .iter()
            .filter(|entry| !known.contains(&local_path_key(&entry.absolute_path)))
            .collect::<Vec<_>>();
        for (batch_index, batch) in ignore_batches(&ignore_candidates).into_iter().enumerate() {
            let mut args = vec!["-v".into(), "-i".into()];
            args.extend(batch.iter().map(|entry| entry.absolute_path.clone()));
            let result = self
                .run_status(
                    context,
                    "ignores",
                    args,
                    status_operation_id(operation_prefix, &format!("ignore-{batch_index}")),
                    false,
                    app,
                )
                .await?;
            snapshot.operation_ids.push(result.operation_id.clone());
            let errors = command_errors(&result, WorkspaceStatusSource::Ignore);
            if !errors.is_empty() {
                snapshot.errors.extend(errors);
                continue;
            }
            let matches = parse_ignore_matches(&result, batch.as_slice());
            for entry in batch {
                let key = local_path_key(&entry.absolute_path);
                if let Some(ignore) = matches.get(&key) {
                    snapshot.files.push(CachedFileStatus {
                        path: entry.absolute_path.clone(),
                        depot_path: None,
                        status: FileStatusKind::Ignored,
                        have_revision: None,
                        head_revision: None,
                        changelist_id: None,
                        opened_action: None,
                        reconcile_action: None,
                        sync: WorkspaceSyncState::Unknown,
                        resolve: WorkspaceResolveState::None,
                        local: WorkspaceLocalState::Ignored,
                        mapped: None,
                        moved_file: None,
                        ignore: Some(ignore.clone()),
                        evidence: vec![WorkspaceStatusEvidence {
                            source: WorkspaceStatusSource::Ignore,
                            summary: format!(
                                "Matched ignore rule {} from {}",
                                ignore.rule, ignore.source
                            ),
                        }],
                        errors: Vec::new(),
                    });
                }
            }
            if batch_index > Self::WORKSPACE_LIST_SAFETY_LIMIT / 64 {
                break;
            }
        }
        snapshot
            .files
            .sort_by_key(|status| local_path_key(&status.path));
        if snapshot.files.len() > Self::WORKSPACE_LIST_SAFETY_LIMIT {
            snapshot.files.truncate(Self::WORKSPACE_LIST_SAFETY_LIMIT);
            snapshot.truncated = true;
        }
        Ok(snapshot)
    }

    pub async fn depot_children(
        &self,
        context: P4Context,
        path: Option<String>,
        app: Option<&AppHandle>,
    ) -> Result<Vec<DepotNode>, String> {
        let base = path.unwrap_or_else(|| "//...".into());
        let prefix = base.trim_end_matches("...").trim_end_matches('/');
        let dirs = self
            .run(&context, "dirs", vec![format!("{}/*", prefix)], true, app)
            .await?;
        let files = self
            .run(
                &context,
                "files",
                vec!["-e".into(), format!("{}/*", prefix)],
                true,
                app,
            )
            .await?;
        let mut nodes = Vec::new();
        for value in json_values(&dirs) {
            if let Some(path) = value.get("dir").and_then(Value::as_str) {
                nodes.push(DepotNode {
                    id: path.into(),
                    name: path.rsplit('/').next().unwrap_or(path).into(),
                    kind: "directory".into(),
                    depot_path: path.into(),
                    head_revision: None,
                    head_action: None,
                    has_children: Some(true),
                });
            }
        }
        for value in json_values(&files) {
            if let Some(path) = value.get("depotFile").and_then(Value::as_str) {
                nodes.push(DepotNode {
                    id: path.into(),
                    name: path.rsplit('/').next().unwrap_or(path).into(),
                    kind: "file".into(),
                    depot_path: path.into(),
                    head_revision: number(&value, "rev"),
                    head_action: value
                        .get("action")
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                    has_children: Some(false),
                });
            }
        }
        Ok(nodes)
    }

    pub async fn resolve_path(
        &self,
        context: P4Context,
        request: PathResolveRequest,
        app: Option<&AppHandle>,
    ) -> Result<PathResolveResult, String> {
        let root = canonical_root(&context)?;
        let input = request.input.trim();
        if input.starts_with("//") {
            let result = self
                .run(&context, "where", vec![input.into()], true, app)
                .await?;
            let value = json_values(&result).into_iter().next();
            let local = value
                .as_ref()
                .and_then(|v| v.get("path"))
                .and_then(Value::as_str)
                .map(str::to_owned);
            return Ok(PathResolveResult {
                found: local.is_some(),
                input_kind: "depot".into(),
                absolute_path: local.clone(),
                relative_path: local
                    .as_ref()
                    .and_then(|path| Path::new(path).strip_prefix(&root).ok())
                    .map(|path| path.to_string_lossy().to_string()),
                depot_path: Some(input.into()),
                reason: local
                    .is_none()
                    .then(|| "Path is outside the current client view".into()),
            });
        }
        let absolute_input = Path::new(input).is_absolute();
        let candidate = secure_path(&root, input, false).ok();
        Ok(PathResolveResult {
            found: candidate.is_some(),
            input_kind: if absolute_input {
                "absolute"
            } else {
                "relative"
            }
            .into(),
            absolute_path: candidate.as_ref().map(|p| p.to_string_lossy().to_string()),
            relative_path: candidate
                .as_ref()
                .and_then(|p| p.strip_prefix(&root).ok())
                .map(|p| p.to_string_lossy().to_string()),
            depot_path: None,
            reason: candidate
                .is_none()
                .then(|| "Path is outside the current workspace".into()),
        })
    }

    pub async fn perform(
        &self,
        context: P4Context,
        request: FileActionRequest,
        app: Option<&AppHandle>,
    ) -> Result<FileActionResult, String> {
        if matches!(
            request.action,
            FileAction::GetLatest | FileAction::GetRevision | FileAction::RemoveFromWorkspace
        ) {
            return Err("Sync mutations must use the preview_sync and confirm_sync APIs".into());
        }
        let invalidation_reason = if request.action == FileAction::Refresh {
            InvalidationReason::ManualRefresh
        } else {
            InvalidationReason::FileMutation
        };
        let operation_id = request
            .operation_id
            .clone()
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        let progress_total = request.paths.len().max(1);
        let affected_paths = request.paths.clone();
        let plan = crate::p4::files::command::plan(&request)?;
        let ActionPlan::P4(invocation) = plan else {
            let ActionPlan::DeleteLocal { paths } = plan else {
                unreachable!();
            };
            let root = canonical_root(&context)?;
            let targets = paths
                .iter()
                .map(|path| secure_path(&root, path, true))
                .collect::<Result<Vec<_>, _>>()?;
            let app = app.cloned();
            let local_operation_id = operation_id.clone();
            let _ = self.journal.start(
                &operation_id,
                &connection_id(&context.server, &context.user, &context.client),
                &context.client,
                OperationSource::Gui,
                OperationCategory::LocalFile,
            );
            emit_progress(app.as_ref(), &local_operation_id, EventKind::Queued, 0.0);
            let local_result = tokio::task::spawn_blocking(move || {
                emit_progress(app.as_ref(), &local_operation_id, EventKind::Started, 2.0);
                let total = targets.len().max(1);
                for (index, target) in targets.into_iter().enumerate() {
                    trash::delete(target).map_err(|error| error.to_string())?;
                    let percent = 2.0 + ((index + 1) as f32 / total as f32) * 93.0;
                    emit_progress(
                        app.as_ref(),
                        &local_operation_id,
                        EventKind::Progress,
                        percent,
                    );
                }
                emit_progress(
                    app.as_ref(),
                    &local_operation_id,
                    EventKind::Completed,
                    100.0,
                );
                Ok::<_, String>(())
            })
            .await
            .map_err(|error| error.to_string())?;
            match local_result {
                Ok(()) => {
                    let _ = self
                        .journal
                        .finish(&operation_id, JournalState::Succeeded, None);
                }
                Err(error) => {
                    let _ = self.journal.finish(
                        &operation_id,
                        JournalState::Failed,
                        Some(OperationFailureKind::CommandFailure),
                    );
                    return Err(error);
                }
            }
            self.invalidate_status(&context, &affected_paths, invalidation_reason);
            return Ok(FileActionResult {
                operation: None,
                affected_paths,
                message: "Moved local files to system trash".into(),
            });
        };
        let operation = self
            .run_mode(
                &context,
                invocation.command,
                invocation.args,
                RunOptions {
                    output_mode: invocation.output_mode,
                    operation_id: Some(operation_id),
                    progress_total: Some(progress_total),
                    argument_input: invocation.argument_input,
                },
                app,
            )
            .await?;
        if operation.exit_code != 0 {
            return Err(event_text(&operation));
        }
        self.invalidate_status(&context, &affected_paths, invalidation_reason);
        Ok(FileActionResult {
            operation: Some(operation),
            affected_paths,
            message: format!("{} completed", invocation.command),
        })
    }

    fn invalidate_status(&self, context: &P4Context, paths: &[String], reason: InvalidationReason) {
        let local_paths = if paths.iter().any(|path| path.starts_with("//")) {
            Vec::new()
        } else {
            paths.to_vec()
        };
        self.status_cache.invalidate(
            &context.server,
            &context.user,
            &context.client,
            &local_paths,
            &[
                StatusQueryKind::WorkspaceStatus,
                StatusQueryKind::Opened,
                StatusQueryKind::Reconcile,
            ],
            reason,
        );
    }

    pub async fn diff(
        &self,
        context: P4Context,
        path: String,
        app: Option<&AppHandle>,
    ) -> Result<DiffResult, String> {
        let operation = self
            .run(
                &context,
                "diff",
                vec!["-du".into(), path.clone()],
                false,
                app,
            )
            .await?;
        Ok(DiffResult {
            path,
            left_label: "Have".into(),
            right_label: "Workspace".into(),
            unified: event_text(&operation),
            binary: false,
        })
    }
    pub async fn history(
        &self,
        context: P4Context,
        path: String,
        app: Option<&AppHandle>,
    ) -> Result<Vec<FileRevision>, String> {
        let result = self
            .run(
                &context,
                "filelog",
                vec!["-l".into(), "-t".into(), path],
                true,
                app,
            )
            .await?;
        Ok(json_values(&result)
            .into_iter()
            .flat_map(crate::p4::history::parse)
            .collect())
    }

    pub async fn graph(
        &self,
        context: P4Context,
        path: String,
        app: Option<&AppHandle>,
    ) -> Result<RevisionGraph, String> {
        let revisions = self
            .history_with_integrations(context, path.clone(), app)
            .await?;
        let nodes = revisions
            .iter()
            .enumerate()
            .map(|(index, revision)| RevisionGraphNode {
                id: format!("r{}", revision.revision),
                depot_path: path.clone(),
                revision: revision.revision,
                changelist_id: revision.changelist_id,
                label: format!("#{}", revision.revision),
                x: 70 + index as i64 * 105,
                y: 75,
            })
            .collect::<Vec<_>>();
        let edges = nodes
            .windows(2)
            .enumerate()
            .map(|(index, pair)| RevisionGraphEdge {
                id: format!("e{index}"),
                source: pair[0].id.clone(),
                target: pair[1].id.clone(),
                kind: "revision".into(),
            })
            .collect();
        Ok(RevisionGraph { nodes, edges })
    }
    async fn history_with_integrations(
        &self,
        context: P4Context,
        path: String,
        app: Option<&AppHandle>,
    ) -> Result<Vec<FileRevision>, String> {
        let result = self
            .run(
                &context,
                "filelog",
                vec!["-i".into(), "-l".into(), "-t".into(), path],
                true,
                app,
            )
            .await?;
        Ok(json_values(&result)
            .into_iter()
            .filter_map(|v| {
                Some(FileRevision {
                    revision: number(&v, "rev")?,
                    changelist_id: number(&v, "change").unwrap_or(0),
                    user: text(&v, "user"),
                    action: text(&v, "action"),
                    time: text(&v, "time"),
                    description: text(&v, "desc"),
                })
            })
            .collect())
    }
    async fn run(
        &self,
        context: &P4Context,
        command: &str,
        args: Vec<String>,
        json: bool,
        app: Option<&AppHandle>,
    ) -> Result<OperationResult, String> {
        self.run_mode(
            context,
            command,
            args,
            RunOptions {
                output_mode: if json {
                    OutputMode::JsonLines
                } else {
                    OutputMode::Text
                },
                operation_id: None,
                progress_total: None,
                argument_input: None,
            },
            app,
        )
        .await
    }

    async fn run_status(
        &self,
        context: &P4Context,
        command: &str,
        args: Vec<String>,
        operation_id: Option<String>,
        json: bool,
        app: Option<&AppHandle>,
    ) -> Result<OperationResult, String> {
        self.run_mode(
            context,
            command,
            args,
            RunOptions {
                output_mode: if json {
                    OutputMode::JsonLines
                } else {
                    OutputMode::Text
                },
                operation_id,
                progress_total: None,
                argument_input: None,
            },
            app,
        )
        .await
    }

    async fn run_mode(
        &self,
        context: &P4Context,
        command: &str,
        args: Vec<String>,
        options: RunOptions,
        app: Option<&AppHandle>,
    ) -> Result<OperationResult, String> {
        self.runner
            .run_with_progress(
                P4CommandRequest {
                    operation_id: options.operation_id,
                    source: OperationSource::Gui,
                    command: command.into(),
                    args,
                    context: context.clone(),
                    output_mode: options.output_mode,
                    timeout_ms: Some(300_000),
                    input: None,
                },
                app,
                options.progress_total,
                options.argument_input,
            )
            .await
            .map_err(|error| error.to_string())
    }
}

fn emit_progress(app: Option<&AppHandle>, operation_id: &str, kind: EventKind, progress: f32) {
    let Some(app) = app else {
        return;
    };
    let _ = app.emit(
        "operation-event",
        OperationEvent {
            operation_id: operation_id.into(),
            kind,
            message: None,
            progress: Some(progress),
            timestamp: Utc::now().to_rfc3339(),
        },
    );
}

#[derive(Clone, Debug)]
struct LocalEntry {
    absolute_path: String,
    relative_path: String,
    name: String,
    kind: String,
    modified_at: Option<String>,
    has_children: bool,
    local_state: WorkspaceLocalState,
}

#[derive(Debug)]
struct LocalDirectoryScan {
    entries: Vec<LocalEntry>,
    errors: Vec<WorkspaceStatusError>,
    truncated: bool,
}

fn status_snapshot(
    fstat: &OperationResult,
    opened: &OperationResult,
    resolve: &OperationResult,
    reconcile: &OperationResult,
    local_entries: &[LocalEntry],
    local_truncated: bool,
    local_errors: &[WorkspaceStatusError],
) -> StatusSnapshot {
    let local = local_entries
        .iter()
        .map(|entry| (local_path_key(&entry.absolute_path), entry))
        .collect::<HashMap<_, _>>();
    let mut files = HashMap::<String, CachedFileStatus>::new();
    let mut depot_paths = HashMap::<String, String>::new();
    let mut client_paths = HashMap::<String, String>::new();
    let mut fstat_count = 0usize;
    for value in json_values(fstat) {
        let Some(path) = value
            .get("path")
            .or_else(|| value.get("clientFile"))
            .and_then(Value::as_str)
            .filter(|path| Path::new(path).is_absolute())
            .map(str::to_owned)
        else {
            continue;
        };
        fstat_count += 1;
        let key = local_path_key(&path);
        let have = number(&value, "haveRev");
        let head = number(&value, "headRev");
        let opened_action = value
            .get("action")
            .and_then(Value::as_str)
            .map(opened_action);
        let unresolved = number(&value, "unresolved").unwrap_or(0) > 0;
        let local_state = local
            .get(&key)
            .map(|entry| entry.local_state)
            .unwrap_or(WorkspaceLocalState::Missing);
        let sync = sync_state(have, head);
        let resolve = if unresolved {
            WorkspaceResolveState::Unresolved
        } else {
            WorkspaceResolveState::None
        };
        let depot_path = value
            .get("depotFile")
            .and_then(Value::as_str)
            .map(str::to_owned);
        if let Some(depot_path) = depot_path.as_ref() {
            depot_paths.insert(depot_path.clone(), key.clone());
        }
        if let Some(client_path) = value.get("clientFile").and_then(Value::as_str) {
            client_paths.insert(client_path.to_owned(), key.clone());
        }
        let mut evidence = vec![WorkspaceStatusEvidence {
            source: WorkspaceStatusSource::Fstat,
            summary: fstat_summary(have, head, opened_action, unresolved),
        }];
        if local_state == WorkspaceLocalState::Missing {
            evidence.push(WorkspaceStatusEvidence {
                source: WorkspaceStatusSource::Filesystem,
                summary: "Path is absent from the workspace directory".into(),
            });
        }
        let mut cached = CachedFileStatus {
            path,
            depot_path,
            status: FileStatusKind::Unknown,
            have_revision: have,
            head_revision: head,
            changelist_id: number(&value, "change"),
            opened_action,
            reconcile_action: None,
            sync,
            resolve,
            local: local_state,
            mapped: Some(true),
            moved_file: value
                .get("movedFile")
                .and_then(Value::as_str)
                .map(str::to_owned),
            ignore: None,
            evidence,
            errors: Vec::new(),
        };
        cached.status = classify_cached_status(&cached);
        files.insert(key, cached);
    }

    for path in parse_resolve_targets(resolve) {
        let key = if Path::new(&path).is_absolute() {
            Some(local_path_key(&path))
        } else {
            client_paths
                .get(&path)
                .or_else(|| depot_paths.get(&path))
                .cloned()
        };
        let Some(key) = key else {
            continue;
        };
        let Some(status) = files.get_mut(&key) else {
            continue;
        };
        status.resolve = WorkspaceResolveState::Unresolved;
        status.evidence.push(WorkspaceStatusEvidence {
            source: WorkspaceStatusSource::ResolvePreview,
            summary: "Resolve preview reports unresolved integration work".into(),
        });
        status.status = FileStatusKind::Conflicted;
    }

    for value in json_values(opened) {
        let Some(action) = value
            .get("action")
            .and_then(Value::as_str)
            .map(opened_action)
        else {
            continue;
        };
        let absolute_path = value
            .get("clientFile")
            .and_then(Value::as_str)
            .filter(|path| Path::new(path).is_absolute())
            .map(str::to_owned);
        let key = value
            .get("depotFile")
            .and_then(Value::as_str)
            .and_then(|path| depot_paths.get(path))
            .cloned()
            .or_else(|| {
                value
                    .get("clientFile")
                    .and_then(Value::as_str)
                    .filter(|path| Path::new(path).is_absolute())
                    .map(local_path_key)
            });
        let Some(key) = key else {
            continue;
        };
        if !files.contains_key(&key) {
            let Some(path) = absolute_path else {
                continue;
            };
            let local_state = local
                .get(&key)
                .map(|entry| entry.local_state)
                .unwrap_or(WorkspaceLocalState::Missing);
            files.insert(
                key.clone(),
                CachedFileStatus {
                    path,
                    depot_path: value
                        .get("depotFile")
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                    status: FileStatusKind::Unknown,
                    have_revision: None,
                    head_revision: None,
                    changelist_id: None,
                    opened_action: Some(action),
                    reconcile_action: None,
                    sync: WorkspaceSyncState::Unknown,
                    resolve: WorkspaceResolveState::Unknown,
                    local: local_state,
                    mapped: Some(true),
                    moved_file: None,
                    ignore: None,
                    evidence: Vec::new(),
                    errors: Vec::new(),
                },
            );
        }
        let status = files.get_mut(&key).expect("inserted above");
        status.opened_action = Some(action);
        status.changelist_id = number(&value, "change").or(status.changelist_id);
        status.moved_file = value
            .get("movedFile")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .or_else(|| status.moved_file.clone());
        status.evidence.push(WorkspaceStatusEvidence {
            source: WorkspaceStatusSource::Opened,
            summary: format!(
                "Current client opened action is {}",
                opened_action_name(action)
            ),
        });
        status.status = classify_cached_status(status);
    }

    for candidate in parse_reconcile_candidates(reconcile) {
        let key = local_path_key(&candidate.path);
        let local_state = match candidate.action {
            WorkspaceReconcileAction::Add | WorkspaceReconcileAction::MoveAdd => {
                WorkspaceLocalState::Untracked
            }
            WorkspaceReconcileAction::Edit => WorkspaceLocalState::Modified,
            WorkspaceReconcileAction::Delete | WorkspaceReconcileAction::MoveDelete => {
                WorkspaceLocalState::Missing
            }
        };
        let status = files.entry(key).or_insert_with(|| CachedFileStatus {
            path: candidate.path.clone(),
            depot_path: None,
            status: FileStatusKind::Unknown,
            have_revision: None,
            head_revision: None,
            changelist_id: None,
            opened_action: None,
            reconcile_action: None,
            sync: WorkspaceSyncState::Unknown,
            resolve: WorkspaceResolveState::None,
            local: local_state,
            mapped: Some(true),
            moved_file: candidate.moved_file.clone(),
            ignore: None,
            evidence: Vec::new(),
            errors: Vec::new(),
        });
        status.reconcile_action = Some(candidate.action);
        status.local = local_state;
        status.mapped = Some(true);
        if candidate.moved_file.is_some() {
            status.moved_file = candidate.moved_file;
        }
        status.evidence.push(WorkspaceStatusEvidence {
            source: WorkspaceStatusSource::ReconcilePreview,
            summary: format!(
                "Safe reconcile preview proposes {}",
                reconcile_action_name(candidate.action)
            ),
        });
        status.status = classify_cached_status(status);
    }

    let mut errors = command_errors(fstat, WorkspaceStatusSource::Fstat);
    errors.extend(command_errors(opened, WorkspaceStatusSource::Opened));
    errors.extend(command_errors(
        resolve,
        WorkspaceStatusSource::ResolvePreview,
    ));
    errors.extend(command_errors(
        reconcile,
        WorkspaceStatusSource::ReconcilePreview,
    ));
    errors.extend_from_slice(local_errors);
    StatusSnapshot {
        files: files.into_values().collect(),
        freshness: CacheFreshness::Fresh,
        errors,
        operation_ids: vec![
            fstat.operation_id.clone(),
            opened.operation_id.clone(),
            resolve.operation_id.clone(),
            reconcile.operation_id.clone(),
        ],
        truncated: local_truncated || fstat_count > FileService::WORKSPACE_LIST_SAFETY_LIMIT,
    }
}

#[cfg(feature = "backend-perf")]
pub(crate) fn fstat_status_snapshot(result: &OperationResult) -> StatusSnapshot {
    let empty = OperationResult {
        operation_id: "status-empty".into(),
        exit_code: 0,
        events: Vec::new(),
        duration_ms: 0,
    };
    let mut snapshot = status_snapshot(result, &empty, &empty, &empty, &[], false, &[]);
    snapshot
        .files
        .sort_by_key(|status| local_path_key(&status.path));
    snapshot
}

fn parse_resolve_targets(result: &OperationResult) -> Vec<String> {
    json_values(result)
        .into_iter()
        .filter_map(|value| {
            value
                .get("clientFile")
                .or_else(|| value.get("depotFile"))
                .and_then(Value::as_str)
                .map(str::to_owned)
                .or_else(|| {
                    let message = value.get("data").and_then(Value::as_str)?;
                    let normalized = message.to_ascii_lowercase();
                    if !(normalized.contains(" - merging ")
                        || normalized.contains(" - resolving ")
                        || normalized.contains("must resolve"))
                    {
                        return None;
                    }
                    message
                        .split_once(" - ")
                        .map(|(path, _)| strip_revision_suffix(path))
                })
        })
        .collect()
}

#[derive(Debug)]
struct ReconcileCandidate {
    path: String,
    action: WorkspaceReconcileAction,
    moved_file: Option<String>,
}

fn parse_reconcile_candidates(result: &OperationResult) -> Vec<ReconcileCandidate> {
    let mut candidates = Vec::new();
    for value in json_values(result) {
        if let Some(action) = value
            .get("action")
            .and_then(Value::as_str)
            .and_then(reconcile_action)
        {
            if let Some(path) = value
                .get("localFile")
                .or_else(|| value.get("clientFile"))
                .and_then(Value::as_str)
            {
                candidates.push(ReconcileCandidate {
                    path: path.to_owned(),
                    action,
                    moved_file: value
                        .get("movedFile")
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                });
                continue;
            }
        }
        let Some(message) = value.get("data").and_then(Value::as_str) else {
            continue;
        };
        for line in message.lines() {
            let actions = [
                (" - opened for move/add", WorkspaceReconcileAction::MoveAdd),
                (
                    " - opened for move/delete",
                    WorkspaceReconcileAction::MoveDelete,
                ),
                (" - opened for add", WorkspaceReconcileAction::Add),
                (" - opened for edit", WorkspaceReconcileAction::Edit),
                (" - opened for delete", WorkspaceReconcileAction::Delete),
            ];
            if let Some((marker, action)) = actions
                .into_iter()
                .find(|(marker, _)| line.contains(marker))
            {
                let path = line.split_once(marker).map(|item| item.0).unwrap_or(line);
                candidates.push(ReconcileCandidate {
                    path: strip_revision_suffix(path),
                    action,
                    moved_file: None,
                });
            }
        }
    }
    candidates
}

fn reconcile_action(value: &str) -> Option<WorkspaceReconcileAction> {
    match value {
        "add" => Some(WorkspaceReconcileAction::Add),
        "edit" => Some(WorkspaceReconcileAction::Edit),
        "delete" => Some(WorkspaceReconcileAction::Delete),
        "move/add" => Some(WorkspaceReconcileAction::MoveAdd),
        "move/delete" => Some(WorkspaceReconcileAction::MoveDelete),
        _ => None,
    }
}

fn classify_cached_status(status: &CachedFileStatus) -> FileStatusKind {
    if status.resolve == WorkspaceResolveState::Unresolved {
        return FileStatusKind::Conflicted;
    }
    if let Some(action) = status.opened_action {
        return match action {
            WorkspaceOpenedAction::Add | WorkspaceOpenedAction::Branch => FileStatusKind::OpenedAdd,
            WorkspaceOpenedAction::Edit
            | WorkspaceOpenedAction::Integrate
            | WorkspaceOpenedAction::Import => FileStatusKind::OpenedEdit,
            WorkspaceOpenedAction::Delete
            | WorkspaceOpenedAction::Purge
            | WorkspaceOpenedAction::Archive => FileStatusKind::OpenedDelete,
            WorkspaceOpenedAction::MoveAdd => FileStatusKind::OpenedMoveAdd,
            WorkspaceOpenedAction::MoveDelete => FileStatusKind::OpenedMoveDelete,
            WorkspaceOpenedAction::Unknown => FileStatusKind::Unknown,
        };
    }
    if let Some(action) = status.reconcile_action {
        return match action {
            WorkspaceReconcileAction::Add | WorkspaceReconcileAction::MoveAdd => {
                FileStatusKind::ReconcileCandidate
            }
            WorkspaceReconcileAction::Edit => FileStatusKind::Modified,
            WorkspaceReconcileAction::Delete | WorkspaceReconcileAction::MoveDelete => {
                FileStatusKind::Missing
            }
        };
    }
    match status.sync {
        WorkspaceSyncState::OutOfDate => FileStatusKind::OutOfDate,
        WorkspaceSyncState::NotSynced => FileStatusKind::NotSynced,
        WorkspaceSyncState::Current => {
            if status.local == WorkspaceLocalState::Missing {
                FileStatusKind::Missing
            } else {
                FileStatusKind::Controlled
            }
        }
        WorkspaceSyncState::Unknown => FileStatusKind::Unknown,
    }
}

fn opened_action(value: &str) -> WorkspaceOpenedAction {
    match value {
        "add" => WorkspaceOpenedAction::Add,
        "edit" => WorkspaceOpenedAction::Edit,
        "delete" => WorkspaceOpenedAction::Delete,
        "move/add" => WorkspaceOpenedAction::MoveAdd,
        "move/delete" => WorkspaceOpenedAction::MoveDelete,
        "branch" => WorkspaceOpenedAction::Branch,
        "integrate" => WorkspaceOpenedAction::Integrate,
        "import" => WorkspaceOpenedAction::Import,
        "purge" => WorkspaceOpenedAction::Purge,
        "archive" => WorkspaceOpenedAction::Archive,
        _ => WorkspaceOpenedAction::Unknown,
    }
}

fn opened_action_name(value: WorkspaceOpenedAction) -> &'static str {
    match value {
        WorkspaceOpenedAction::Add => "add",
        WorkspaceOpenedAction::Edit => "edit",
        WorkspaceOpenedAction::Delete => "delete",
        WorkspaceOpenedAction::MoveAdd => "move/add",
        WorkspaceOpenedAction::MoveDelete => "move/delete",
        WorkspaceOpenedAction::Branch => "branch",
        WorkspaceOpenedAction::Integrate => "integrate",
        WorkspaceOpenedAction::Import => "import",
        WorkspaceOpenedAction::Purge => "purge",
        WorkspaceOpenedAction::Archive => "archive",
        WorkspaceOpenedAction::Unknown => "unknown",
    }
}

fn reconcile_action_name(value: WorkspaceReconcileAction) -> &'static str {
    match value {
        WorkspaceReconcileAction::Add => "add",
        WorkspaceReconcileAction::Edit => "edit",
        WorkspaceReconcileAction::Delete => "delete",
        WorkspaceReconcileAction::MoveAdd => "move/add",
        WorkspaceReconcileAction::MoveDelete => "move/delete",
    }
}

fn sync_state(have: Option<i64>, head: Option<i64>) -> WorkspaceSyncState {
    match (have, head) {
        (None | Some(0), Some(head)) if head > 0 => WorkspaceSyncState::NotSynced,
        (Some(have), Some(head)) if have < head => WorkspaceSyncState::OutOfDate,
        (Some(_), Some(_)) => WorkspaceSyncState::Current,
        (None, None) => WorkspaceSyncState::Unknown,
        _ => WorkspaceSyncState::Unknown,
    }
}

fn fstat_summary(
    have: Option<i64>,
    head: Option<i64>,
    opened: Option<WorkspaceOpenedAction>,
    unresolved: bool,
) -> String {
    let mut parts = vec![format!(
        "have revision {}, head revision {}",
        have.map(|value| value.to_string())
            .unwrap_or_else(|| "none".into()),
        head.map(|value| value.to_string())
            .unwrap_or_else(|| "none".into())
    )];
    if let Some(action) = opened {
        parts.push(format!("opened for {}", opened_action_name(action)));
    }
    if unresolved {
        parts.push("unresolved integration records exist".into());
    }
    parts.join(", ")
}

fn command_errors(
    result: &OperationResult,
    source: WorkspaceStatusSource,
) -> Vec<WorkspaceStatusError> {
    let mut errors = json_values(result)
        .into_iter()
        .filter(|value| number(value, "severity").unwrap_or(0) >= 3)
        .filter_map(|value| {
            value
                .get("data")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|message| !message.is_empty())
                .map(str::to_owned)
        })
        .map(|message| WorkspaceStatusError { source, message })
        .collect::<Vec<_>>();
    if result.exit_code != 0 && errors.is_empty() {
        let message = event_text(result).trim().to_owned();
        if !message.is_empty() && !message.contains("No file(s)") {
            errors.push(WorkspaceStatusError { source, message });
        }
    }
    errors
}

fn parse_ignore_matches(
    result: &OperationResult,
    candidates: &[&LocalEntry],
) -> HashMap<String, WorkspaceIgnoreMatch> {
    let candidate_keys = candidates
        .iter()
        .map(|entry| local_path_key(&entry.absolute_path))
        .collect::<HashSet<_>>();
    let mut matches = HashMap::new();
    for message in result
        .events
        .iter()
        .filter_map(|event| event.message.as_deref())
    {
        for line in message.lines() {
            let Some((path, detail)) = line.split_once(" ignored by ") else {
                continue;
            };
            let key = local_path_key(path.trim());
            if !candidate_keys.contains(&key) {
                continue;
            }
            let (source, line_number, rule) = parse_ignore_detail(detail.trim());
            matches.insert(
                key,
                WorkspaceIgnoreMatch {
                    rule,
                    source,
                    line: line_number,
                    explanation: line.trim().to_owned(),
                },
            );
        }
    }
    matches
}

fn parse_ignore_detail(detail: &str) -> (String, Option<u32>, String) {
    for (index, _) in detail.match_indices(':') {
        let after = &detail[index + 1..];
        let Some(next) = after.find(':') else {
            continue;
        };
        if let Ok(line) = after[..next].parse::<u32>() {
            return (
                detail[..index].to_owned(),
                Some(line),
                after[next + 1..].to_owned(),
            );
        }
    }
    (detail.to_owned(), None, detail.to_owned())
}

fn ignore_batches<'a>(entries: &'a [&'a LocalEntry]) -> Vec<Vec<&'a LocalEntry>> {
    let mut batches = Vec::new();
    let mut current = Vec::new();
    let mut bytes = 0usize;
    for entry in entries {
        let entry_bytes = entry.absolute_path.len() + 1;
        if !current.is_empty() && (current.len() >= 64 || bytes + entry_bytes > 16_000) {
            batches.push(std::mem::take(&mut current));
            bytes = 0;
        }
        current.push(*entry);
        bytes += entry_bytes;
    }
    if !current.is_empty() {
        batches.push(current);
    }
    batches
}

fn strip_revision_suffix(path: &str) -> String {
    let path = path.trim();
    if let Some((base, revision)) = path.rsplit_once('#') {
        if revision.chars().all(|character| character.is_ascii_digit()) {
            return base.to_owned();
        }
    }
    path.to_owned()
}

fn status_operation_id(prefix: Option<&str>, suffix: &str) -> Option<String> {
    prefix.map(|prefix| format!("{prefix}:{suffix}"))
}

fn scan_workspace_directory(root: &Path, directory: &Path, limit: usize) -> LocalDirectoryScan {
    let mut scan = LocalDirectoryScan {
        entries: Vec::new(),
        errors: Vec::new(),
        truncated: false,
    };
    let entries = match fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) => {
            scan.errors.push(WorkspaceStatusError {
                source: WorkspaceStatusSource::Filesystem,
                message: format!("Cannot read {}: {error}", display_path(directory)),
            });
            return scan;
        }
    };
    for result in entries {
        if scan.entries.len() >= limit {
            scan.truncated = true;
            break;
        }
        let entry = match result {
            Ok(entry) => entry,
            Err(error) => {
                scan.errors.push(WorkspaceStatusError {
                    source: WorkspaceStatusSource::Filesystem,
                    message: format!("Cannot enumerate a directory entry: {error}"),
                });
                continue;
            }
        };
        let path = entry.path();
        let absolute_path = display_path(&path);
        let relative_path = path
            .strip_prefix(root)
            .unwrap_or(&path)
            .to_string_lossy()
            .to_string();
        let metadata = fs::symlink_metadata(&path);
        let (kind, has_children, local_state, modified_at) = match metadata {
            Ok(metadata) => {
                let reparse = metadata.file_type().is_symlink() || is_reparse_point(&metadata);
                let directory = metadata.is_dir() && !reparse;
                let local_state = if reparse {
                    WorkspaceLocalState::Symlink
                } else if directory {
                    WorkspaceLocalState::Directory
                } else {
                    WorkspaceLocalState::Present
                };
                (
                    if directory { "directory" } else { "file" }.to_owned(),
                    directory,
                    local_state,
                    metadata
                        .modified()
                        .ok()
                        .map(|time| DateTime::<Utc>::from(time).to_rfc3339()),
                )
            }
            Err(error) => {
                scan.errors.push(WorkspaceStatusError {
                    source: WorkspaceStatusSource::Filesystem,
                    message: format!("Cannot inspect {absolute_path}: {error}"),
                });
                ("file".into(), false, WorkspaceLocalState::Unreadable, None)
            }
        };
        scan.entries.push(LocalEntry {
            absolute_path,
            relative_path,
            name: entry.file_name().to_string_lossy().to_string(),
            kind,
            modified_at,
            has_children,
            local_state,
        });
    }
    scan
}

#[cfg(windows)]
fn is_reparse_point(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    metadata.file_attributes() & 0x400 != 0
}

#[cfg(not(windows))]
fn is_reparse_point(_metadata: &fs::Metadata) -> bool {
    false
}

fn workspace_node(
    root: &Path,
    cached: &CachedFileStatus,
    local: Option<&LocalEntry>,
    freshness: CacheFreshness,
    aggregate_partial: bool,
) -> Option<WorkspaceNode> {
    let mut status = public_status(cached, freshness, aggregate_partial);
    if let Some(local) = local {
        if !matches!(
            status.local,
            WorkspaceLocalState::Modified
                | WorkspaceLocalState::Untracked
                | WorkspaceLocalState::Ignored
        ) {
            status.local = local.local_state;
        }
        let mut node = workspace_node_from_local(root, local.clone(), status);
        node.depot_path = cached.depot_path.clone();
        node.revision = cached.have_revision;
        node.head_revision = cached.head_revision;
        node.changelist_id = cached.changelist_id;
        return Some(node);
    }
    let path = Path::new(&cached.path);
    let display_root = display_path(root);
    let relative = path.strip_prefix(Path::new(&display_root)).ok()?;
    // A directory listing only returns direct children even when a server emits a broader row.
    if relative.components().count() == 0 {
        return None;
    }
    status.local = WorkspaceLocalState::Missing;
    if status.opened_action.is_none()
        && status.resolve != WorkspaceResolveState::Unresolved
        && cached.have_revision.is_some()
    {
        status.primary = WorkspacePrimaryState::Missing;
    }
    let absolute_path = display_path(path);
    Some(WorkspaceNode {
        id: local_path_key(&absolute_path),
        name: path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string(),
        kind: "file".into(),
        absolute_path,
        relative_path: relative.to_string_lossy().to_string(),
        depot_path: cached.depot_path.clone(),
        state: primary_state_name(status.primary).into(),
        revision: cached.have_revision,
        head_revision: cached.head_revision,
        changelist_id: cached.changelist_id,
        modified_at: None,
        has_children: Some(false),
        status,
    })
}

fn workspace_node_from_local(
    _root: &Path,
    local: LocalEntry,
    status: WorkspaceFileStatus,
) -> WorkspaceNode {
    WorkspaceNode {
        id: local_path_key(&local.absolute_path),
        name: local.name,
        kind: local.kind,
        absolute_path: local.absolute_path,
        relative_path: local.relative_path,
        depot_path: None,
        state: primary_state_name(status.primary).into(),
        revision: None,
        head_revision: None,
        changelist_id: None,
        modified_at: local.modified_at,
        has_children: Some(local.has_children),
        status,
    }
}

fn public_status(
    cached: &CachedFileStatus,
    freshness: CacheFreshness,
    aggregate_partial: bool,
) -> WorkspaceFileStatus {
    let mut evidence = cached.evidence.clone();
    let mut completeness = if cached.errors.is_empty() && !aggregate_partial {
        WorkspaceStatusCompleteness::Complete
    } else {
        WorkspaceStatusCompleteness::Partial
    };
    if freshness != CacheFreshness::Fresh {
        completeness = WorkspaceStatusCompleteness::Partial;
        evidence.push(WorkspaceStatusEvidence {
            source: WorkspaceStatusSource::Cache,
            summary: match freshness {
                CacheFreshness::Stale => "Status came from an expired cache entry",
                CacheFreshness::OfflineFallback => {
                    "Live status failed; showing the last trusted cached evidence"
                }
                CacheFreshness::Fresh => unreachable!(),
            }
            .into(),
        });
    }
    WorkspaceFileStatus {
        primary: primary_state(cached.status),
        opened_action: cached.opened_action,
        reconcile_action: cached.reconcile_action,
        sync: cached.sync,
        resolve: cached.resolve,
        local: cached.local,
        mapped: cached.mapped,
        moved_file: cached.moved_file.clone(),
        ignore: cached.ignore.clone(),
        completeness,
        evidence,
        errors: cached.errors.clone(),
    }
}

fn primary_state(status: FileStatusKind) -> WorkspacePrimaryState {
    match status {
        FileStatusKind::Controlled => WorkspacePrimaryState::Controlled,
        FileStatusKind::OpenedEdit => WorkspacePrimaryState::OpenedEdit,
        FileStatusKind::OpenedAdd => WorkspacePrimaryState::OpenedAdd,
        FileStatusKind::OpenedDelete => WorkspacePrimaryState::OpenedDelete,
        FileStatusKind::OpenedMoveAdd => WorkspacePrimaryState::OpenedMoveAdd,
        FileStatusKind::OpenedMoveDelete => WorkspacePrimaryState::OpenedMoveDelete,
        FileStatusKind::Modified => WorkspacePrimaryState::Modified,
        FileStatusKind::Missing => WorkspacePrimaryState::Missing,
        FileStatusKind::Ignored => WorkspacePrimaryState::Ignored,
        FileStatusKind::NotSynced => WorkspacePrimaryState::NotSynced,
        FileStatusKind::OutOfDate => WorkspacePrimaryState::OutOfDate,
        FileStatusKind::Conflicted => WorkspacePrimaryState::Conflicted,
        FileStatusKind::ReconcileCandidate => WorkspacePrimaryState::Untracked,
        FileStatusKind::Unknown => WorkspacePrimaryState::Unknown,
    }
}

fn primary_state_name(status: WorkspacePrimaryState) -> &'static str {
    match status {
        WorkspacePrimaryState::Controlled => "controlled",
        WorkspacePrimaryState::OpenedEdit => "openedEdit",
        WorkspacePrimaryState::OpenedAdd => "openedAdd",
        WorkspacePrimaryState::OpenedDelete => "openedDelete",
        WorkspacePrimaryState::OpenedMoveAdd => "openedMoveAdd",
        WorkspacePrimaryState::OpenedMoveDelete => "openedMoveDelete",
        WorkspacePrimaryState::Modified => "modified",
        WorkspacePrimaryState::Missing => "missing",
        WorkspacePrimaryState::Untracked => "untracked",
        WorkspacePrimaryState::Ignored => "ignored",
        WorkspacePrimaryState::OutOfDate => "outOfDate",
        WorkspacePrimaryState::NotSynced => "notSynced",
        WorkspacePrimaryState::Conflicted => "conflicted",
        WorkspacePrimaryState::Unknown => "unknown",
    }
}

fn listing_completeness(
    nodes: &[WorkspaceNode],
    errors: &[WorkspaceStatusError],
    truncated: bool,
    freshness: CacheFreshness,
) -> WorkspaceStatusCompleteness {
    if errors.is_empty()
        && !truncated
        && freshness == CacheFreshness::Fresh
        && nodes
            .iter()
            .all(|node| node.status.completeness == WorkspaceStatusCompleteness::Complete)
    {
        WorkspaceStatusCompleteness::Complete
    } else if nodes.is_empty() && !errors.is_empty() {
        WorkspaceStatusCompleteness::Error
    } else {
        WorkspaceStatusCompleteness::Partial
    }
}

fn cache_freshness_name(freshness: CacheFreshness) -> &'static str {
    match freshness {
        CacheFreshness::Fresh => "fresh",
        CacheFreshness::Stale => "stale",
        CacheFreshness::OfflineFallback => "offlineFallback",
    }
}

fn client_child_filespec(client: &str, root: &Path, directory: &Path) -> Result<String, String> {
    let relative = directory
        .strip_prefix(root)
        .map_err(|_| "workspace directory is outside the client root")?;
    let relative = relative.to_string_lossy().replace('\\', "/");
    let prefix = if relative.is_empty() {
        format!("//{}", escape_filespec_literal(client))
    } else {
        format!(
            "//{}/{}",
            escape_filespec_literal(client),
            escape_filespec_literal(&relative)
        )
    };
    Ok(format!("{prefix}/*"))
}

fn local_child_filespec(directory: &Path) -> String {
    let path = display_path(directory).replace('\\', "/");
    format!("{}/*", escape_filespec_literal(path.trim_end_matches('/')))
}

fn escape_filespec_literal(value: impl AsRef<str>) -> String {
    value
        .as_ref()
        .replace('%', "%25")
        .replace('@', "%40")
        .replace('#', "%23")
        .replace('*', "%2A")
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn canonical_root(context: &P4Context) -> Result<PathBuf, String> {
    PathBuf::from(context.cwd.as_deref().unwrap_or("."))
        .canonicalize()
        .map_err(|error| error.to_string())
}
fn display_path(path: &Path) -> String {
    let value = path.to_string_lossy();
    if let Some(value) = value.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{value}")
    } else {
        value.strip_prefix(r"\\?\").unwrap_or(&value).to_owned()
    }
}
fn local_path_key(path: &str) -> String {
    let normalized = display_path(Path::new(path)).replace('\\', "/");
    if cfg!(windows) {
        normalized.to_ascii_lowercase()
    } else {
        normalized
    }
}
fn secure_path(root: &Path, input: &str, must_exist: bool) -> Result<PathBuf, String> {
    let raw = Path::new(input);
    let joined = if raw.is_absolute() {
        raw.to_owned()
    } else {
        root.join(raw)
    };
    let candidate = if must_exist {
        joined.canonicalize().map_err(|error| error.to_string())?
    } else {
        let parent = joined
            .parent()
            .unwrap_or(root)
            .canonicalize()
            .map_err(|error| error.to_string())?;
        parent.join(joined.file_name().unwrap_or_default())
    };
    if !candidate.starts_with(root) {
        return Err("path escapes workspace root".into());
    }
    Ok(candidate)
}
fn json_values(result: &OperationResult) -> Vec<Value> {
    result
        .events
        .iter()
        .filter_map(|event| event.message.as_deref())
        .filter_map(|line| serde_json::from_str(line).ok())
        .collect()
}
fn number(value: &Value, key: &str) -> Option<i64> {
    value.get(key).and_then(Value::as_i64).or_else(|| {
        value
            .get(key)
            .and_then(Value::as_str)
            .and_then(|v| v.parse().ok())
    })
}
fn text(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .into()
}
fn event_text(result: &OperationResult) -> String {
    result
        .events
        .iter()
        .filter_map(|event| event.message.as_deref())
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn operation(id: &str, messages: &[&str]) -> OperationResult {
        OperationResult {
            operation_id: id.into(),
            exit_code: 0,
            events: messages
                .iter()
                .map(|message| OperationEvent {
                    operation_id: id.into(),
                    kind: EventKind::Stdout,
                    message: Some((*message).into()),
                    progress: None,
                    timestamp: "2026-10-09T00:00:00Z".into(),
                })
                .collect(),
            duration_ms: 1,
        }
    }

    #[test]
    fn parses_structured_and_legacy_reconcile_preview_without_mutation_assumptions() {
        let result = operation(
            "reconcile",
            &[
                r#"{"action":"edit","clientFile":"C:/ws/space 世界.txt","depotFile":"//depot/space 世界.txt"}"#,
                r#"{"data":"C:/ws/special@#%.txt#1 - opened for add","level":0}"#,
            ],
        );
        let candidates = parse_reconcile_candidates(&result);
        assert_eq!(candidates.len(), 2);
        assert_eq!(candidates[0].action, WorkspaceReconcileAction::Edit);
        assert_eq!(candidates[1].action, WorkspaceReconcileAction::Add);
        assert_eq!(candidates[1].path, "C:/ws/special@#%.txt");
    }

    #[test]
    fn partial_server_failure_keeps_trusted_reconcile_evidence() {
        let fstat = operation(
            "fstat",
            &[r#"{"data":"permission denied","severity":3,"generic":6}"#],
        );
        let reconcile = operation(
            "reconcile",
            &[r#"{"action":"add","clientFile":"C:/ws/local.txt"}"#],
        );
        let empty = operation("empty", &[]);
        let local = vec![LocalEntry {
            absolute_path: "C:/ws/local.txt".into(),
            relative_path: "local.txt".into(),
            name: "local.txt".into(),
            kind: "file".into(),
            modified_at: None,
            has_children: false,
            local_state: WorkspaceLocalState::Present,
        }];
        let snapshot = status_snapshot(&fstat, &empty, &empty, &reconcile, &local, false, &[]);
        assert_eq!(snapshot.files.len(), 1);
        assert_eq!(snapshot.files[0].status, FileStatusKind::ReconcileCandidate);
        assert_eq!(
            snapshot.files[0].reconcile_action,
            Some(WorkspaceReconcileAction::Add)
        );
        assert!(!snapshot.errors.is_empty());
    }

    #[test]
    fn parses_ignore_rule_source_and_line_for_unicode_paths() {
        let entry = LocalEntry {
            absolute_path: r"C:\ws\ignored 世界.txt".into(),
            relative_path: "ignored 世界.txt".into(),
            name: "ignored 世界.txt".into(),
            kind: "file".into(),
            modified_at: None,
            has_children: false,
            local_state: WorkspaceLocalState::Present,
        };
        let result = operation(
            "ignores",
            &[r"C:\ws\ignored 世界.txt ignored by C:\ws\.p4ignore:7:ignored*.txt"],
        );
        let matches = parse_ignore_matches(&result, &[&entry]);
        let matched = matches
            .get(&local_path_key(&entry.absolute_path))
            .expect("ignore match");
        assert_eq!(matched.rule, "ignored*.txt");
        assert_eq!(matched.line, Some(7));
        assert!(matched.source.ends_with(".p4ignore"));
    }

    #[test]
    fn escapes_literal_filespec_characters_and_keeps_single_level_scope() {
        assert_eq!(
            local_child_filespec(Path::new("C:/ws/space @#%")),
            "C:/ws/space %40%23%25/*"
        );
        assert_eq!(
            client_child_filespec("client", Path::new("C:/ws"), Path::new("C:/ws/目录")).unwrap(),
            "//client/目录/*"
        );
    }

    #[test]
    fn local_scan_is_single_level_and_reports_its_hard_limit() {
        let root =
            std::env::temp_dir().join(format!("p4deck-status-scan-{}", uuid::Uuid::new_v4()));
        let nested = root.join("node_modules").join("deep");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::write(nested.join("never-scanned.txt"), b"x").unwrap();
        std::fs::write(root.join("one.txt"), b"1").unwrap();
        std::fs::write(root.join("two.txt"), b"2").unwrap();
        let scan = scan_workspace_directory(&root, &root, 2);
        assert_eq!(scan.entries.len(), 2);
        assert!(scan.truncated);
        assert!(scan
            .entries
            .iter()
            .all(|entry| entry.name != "never-scanned.txt"));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn normalizes_verbatim_drive_paths_for_p4_and_cache_matching() {
        let verbatim = Path::new(r"\\?\D:\Workspace\Main\File.txt");
        assert_eq!(display_path(verbatim), r"D:\Workspace\Main\File.txt");
        assert_eq!(
            local_path_key(&display_path(verbatim)),
            local_path_key(r"d:/workspace/main/file.txt")
        );
    }

    #[cfg(windows)]
    #[test]
    fn normalizes_verbatim_unc_paths_without_losing_the_share_prefix() {
        assert_eq!(
            display_path(Path::new(r"\\?\UNC\server\share\file.txt")),
            r"\\server\share\file.txt"
        );
    }
}
