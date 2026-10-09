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

impl FileService {
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

    pub async fn workspace_children(
        &self,
        context: P4Context,
        path: Option<String>,
        app: Option<&AppHandle>,
    ) -> Result<Vec<WorkspaceNode>, String> {
        let root = canonical_root(&context)?;
        let directory = secure_path(&root, path.as_deref().unwrap_or(""), true)?;
        let filespec = format!("{}/...", display_path(&directory).trim_end_matches('/'));
        let cache_key = StatusCacheKey::new(
            &context.server,
            &context.user,
            &context.client,
            StatusQueryKind::WorkspaceStatus,
            &display_path(&directory),
            1,
        );
        let cache_now = now_ms();
        let has_cached_fallback = self.status_cache.peek(&cache_key, cache_now).is_some();
        let snapshot = self
            .status_cache
            .get_or_load(cache_key, cache_now, has_cached_fallback, || async {
                let result = self
                    .run(
                        &context,
                        "fstat",
                        vec![
                            "-Ol".into(),
                            "-T".into(),
                            "clientFile,depotFile,haveRev,headRev,action,change,unresolved".into(),
                            filespec,
                        ],
                        true,
                        app,
                    )
                    .await?;
                Ok(status_snapshot(&result))
            })
            .await
            .ok();
        let p4 = snapshot
            .as_ref()
            .map(|snapshot| {
                snapshot
                    .files
                    .iter()
                    .map(|status| (local_path_key(&status.path), status))
                    .collect::<std::collections::HashMap<_, _>>()
            })
            .unwrap_or_default();
        let mut nodes = Vec::new();
        for entry in std::fs::read_dir(&directory).map_err(|error| error.to_string())? {
            let entry = entry.map_err(|error| error.to_string())?;
            let candidate = entry.path();
            let canonical = candidate
                .canonicalize()
                .map_err(|error| error.to_string())?;
            if !canonical.starts_with(&root) {
                continue;
            }
            let metadata = entry.metadata().map_err(|error| error.to_string())?;
            let absolute = display_path(&canonical);
            let value = p4.get(&local_path_key(&absolute));
            let have = value.and_then(|value| value.have_revision);
            let head = value.and_then(|value| value.head_revision);
            let state = value
                .map(|value| status_name(value.status))
                .unwrap_or("untracked");
            nodes.push(WorkspaceNode {
                id: Uuid::new_v4().to_string(),
                name: entry.file_name().to_string_lossy().to_string(),
                kind: if metadata.is_dir() {
                    "directory"
                } else {
                    "file"
                }
                .into(),
                absolute_path: absolute,
                relative_path: canonical
                    .strip_prefix(&root)
                    .unwrap_or(&canonical)
                    .to_string_lossy()
                    .to_string(),
                depot_path: value.and_then(|value| value.depot_path.clone()),
                state: state.into(),
                revision: have,
                head_revision: head,
                changelist_id: value.and_then(|value| value.changelist_id),
                modified_at: metadata
                    .modified()
                    .ok()
                    .map(|time| DateTime::<Utc>::from(time).to_rfc3339()),
                has_children: Some(metadata.is_dir()),
            });
        }
        nodes.sort_by_key(|node| (node.kind != "directory", node.name.to_lowercase()));
        Ok(nodes)
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

pub(crate) fn status_snapshot(result: &OperationResult) -> StatusSnapshot {
    let files = json_values(result)
        .into_iter()
        .filter_map(|value| {
            let path = value.get("clientFile")?.as_str()?.to_owned();
            let have = number(&value, "haveRev");
            let head = number(&value, "headRev");
            let unresolved = number(&value, "unresolved").unwrap_or(0) > 0;
            let status = if unresolved {
                FileStatusKind::Conflicted
            } else {
                match value.get("action").and_then(Value::as_str) {
                    Some("edit") => FileStatusKind::OpenedEdit,
                    Some("add") => FileStatusKind::OpenedAdd,
                    Some("delete") => FileStatusKind::OpenedDelete,
                    _ if head > have => FileStatusKind::OutOfDate,
                    _ => FileStatusKind::Controlled,
                }
            };
            Some(CachedFileStatus {
                path,
                depot_path: value
                    .get("depotFile")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                status,
                have_revision: have,
                head_revision: head,
                changelist_id: number(&value, "change"),
            })
        })
        .collect();
    StatusSnapshot {
        files,
        freshness: CacheFreshness::Fresh,
    }
}

fn status_name(status: FileStatusKind) -> &'static str {
    match status {
        FileStatusKind::Controlled => "controlled",
        FileStatusKind::OpenedEdit => "openedEdit",
        FileStatusKind::OpenedAdd => "openedAdd",
        FileStatusKind::OpenedDelete => "openedDelete",
        FileStatusKind::OutOfDate => "outOfDate",
        FileStatusKind::Conflicted => "conflicted",
        FileStatusKind::ReconcileCandidate => "untracked",
    }
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
