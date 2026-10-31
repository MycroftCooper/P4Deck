//! Single-file revision undo. Preview never changes files; confirmation is one-use and context bound.
use crate::{
    app::{
        confirmation::{ConfirmationStore, ExpiringConfirmation},
        status_cache::{InvalidationReason, StatusCache, StatusQueryKind},
    },
    domain::*,
    p4::{context::ContextStore, runner::P4Runner},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::sync::Arc;
use tauri::AppHandle;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UndoTarget {
    pub depot_path: String,
    pub revision: u32,
    pub changelist_id: u32,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UndoPreview {
    pub target: UndoTarget,
    pub token: String,
    pub expires_at: i64,
    pub messages: Vec<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UndoConfirmation {
    pub target: UndoTarget,
    pub token: String,
    #[serde(default)]
    pub operation_id: Option<String>,
}
struct Record {
    target: UndoTarget,
    context: P4Context,
    generation: u64,
    digest: String,
    expires_at: i64,
}
impl ExpiringConfirmation for Record {
    fn expires_at(&self) -> i64 {
        self.expires_at
    }
}
pub struct UndoService {
    runner: Arc<P4Runner>,
    contexts: Arc<ContextStore>,
    cache: Arc<StatusCache>,
    tokens: ConfirmationStore<Record>,
}
impl UndoService {
    pub fn new(
        runner: Arc<P4Runner>,
        contexts: Arc<ContextStore>,
        cache: Arc<StatusCache>,
    ) -> Self {
        Self {
            runner,
            contexts,
            cache,
            tokens: ConfirmationStore::default(),
        }
    }
    pub fn clear_confirmations(&self) {
        self.tokens.clear();
    }
    pub async fn preview(
        &self,
        target: UndoTarget,
        app: Option<&AppHandle>,
    ) -> Result<UndoPreview, String> {
        filespec(&target)?;
        let (context, generation) = self.contexts.snapshot();
        let (digest, messages) = self.inspect(&context, &target, app).await?;
        if self.contexts.snapshot() != (context.clone(), generation) {
            return Err("Connection changed during preview.".into());
        }
        let now = chrono::Utc::now().timestamp_millis();
        let expires_at = now + 120_000;
        let token = self.tokens.issue(
            Record {
                target: target.clone(),
                context,
                generation,
                digest,
                expires_at,
            },
            now,
        );
        Ok(UndoPreview {
            target,
            token,
            expires_at,
            messages,
        })
    }
    pub async fn confirm(
        &self,
        confirmation: UndoConfirmation,
        app: Option<&AppHandle>,
    ) -> Result<OperationResult, String> {
        let record = self
            .tokens
            .consume(&confirmation.token)
            .ok_or("Undo preview expired or was already used. Preview again.")?;
        if record.expires_at <= chrono::Utc::now().timestamp_millis()
            || confirmation.target != record.target
        {
            return Err("Undo preview expired or target changed.".into());
        }
        if self.contexts.snapshot() != (record.context.clone(), record.generation) {
            return Err("Connection changed. Preview Undo again.".into());
        }
        let guard = self.runner.lock_mutations(&record.context.server).await;
        let (digest, _) = self.inspect(&record.context, &record.target, app).await?;
        if digest != record.digest
            || self.contexts.snapshot() != (record.context.clone(), record.generation)
        {
            return Err("File, preview or connection changed. Preview Undo again.".into());
        }
        let result = self
            .runner
            .run_with_mutation_guard(
                request(&record.context, "undo", vec![filespec(&record.target)?]),
                app,
                Some(1),
                &guard,
            )
            .await;
        self.cache.invalidate(
            &record.context.server,
            &record.context.user,
            &record.context.client,
            &[record.target.depot_path],
            &[
                StatusQueryKind::WorkspaceStatus,
                StatusQueryKind::Opened,
                StatusQueryKind::Reconcile,
            ],
            InvalidationReason::FileMutation,
        );
        result.map_err(|_| {
            "Undo outcome is uncertain. Inspect workspace and operation log before retrying.".into()
        })
    }
    async fn query(
        &self,
        context: &P4Context,
        command: &str,
        args: Vec<String>,
        app: Option<&AppHandle>,
    ) -> Result<Vec<Value>, String> {
        let result = self
            .runner
            .run_with_progress(request(context, command, args), app, None, None)
            .await
            .map_err(|error| error.to_string())?;
        records(&result)
    }
    async fn inspect(
        &self,
        context: &P4Context,
        target: &UndoTarget,
        app: Option<&AppHandle>,
    ) -> Result<(String, Vec<String>), String> {
        if context.server.trim().is_empty()
            || context.user.trim().is_empty()
            || context.client.trim().is_empty()
        {
            return Err("An explicit server, user and workspace are required for Undo.".into());
        }
        let spec = filespec(target)?;
        let revision = self
            .query(context, "files", vec![spec.clone()], app)
            .await?;
        let entry = single_file(&revision, &target.depot_path)?;
        if number(entry, "rev") != Some(target.revision as u64)
            || number(entry, "change") != Some(target.changelist_id as u64)
        {
            return Err("History revision/CL no longer matches the server.".into());
        }
        if entry
            .get("action")
            .and_then(Value::as_str)
            .is_some_and(|a| a.starts_with("move/"))
        {
            return Err(
                "A move requires its paired files; this dialog only undoes one file revision."
                    .into(),
            );
        }
        let state = self
            .query(
                context,
                "fstat",
                vec!["-Ol".into(), target.depot_path.clone()],
                app,
            )
            .await?;
        let file = single_file(&state, &target.depot_path)?;
        if file.get("action").is_some() || number(file, "unresolved").unwrap_or(0) > 0 {
            return Err(
                "File is opened or unresolved. Finish or preserve the existing work before Undo."
                    .into(),
            );
        }
        let local = file
            .get("clientFile")
            .and_then(Value::as_str)
            .ok_or("File is not mapped to this workspace.")?;
        // No force, no implicit sync, and no overwrite of an edited unopened file.
        let changed = self
            .query(
                context,
                "diff",
                vec!["-se".into(), target.depot_path.clone()],
                app,
            )
            .await?;
        if !changed.is_empty() {
            return Err("Workspace file differs from its synced revision. Preserve local changes before Undo.".into());
        }
        let local_digest = match std::fs::read(local) {
            Ok(bytes) => format!("{:x}", Sha256::digest(bytes)),
            Err(e)
                if e.kind() == std::io::ErrorKind::NotFound
                    && number(file, "haveRev").unwrap_or(0) == 0 =>
            {
                "absent".into()
            }
            Err(_) => return Err("Cannot verify workspace file contents before Undo.".into()),
        };
        let preview = self
            .query(context, "undo", vec!["-n".into(), spec], app)
            .await?;
        single_file(&preview, &target.depot_path)?;
        let messages = preview
            .iter()
            .map(|row| {
                format!(
                    "{} · {}",
                    target.depot_path,
                    row.get("action").and_then(Value::as_str).unwrap_or("undo")
                )
            })
            .collect();
        let digest = format!(
            "{:x}",
            Sha256::digest(
                serde_json::to_vec(&(revision, state, preview, local_digest))
                    .map_err(|e| e.to_string())?
            )
        );
        Ok((digest, messages))
    }
}
fn request(context: &P4Context, command: &str, args: Vec<String>) -> P4CommandRequest {
    P4CommandRequest {
        operation_id: None,
        source: OperationSource::Gui,
        command: command.into(),
        args,
        context: context.clone(),
        output_mode: OutputMode::JsonLines,
        timeout_ms: Some(300_000),
        input: None,
    }
}
fn filespec(target: &UndoTarget) -> Result<String, String> {
    let path = &target.depot_path;
    if !path.starts_with("//")
        || path.len() < 4
        || path.contains("...")
        || path.chars().any(|c| c.is_control() || "*#@%".contains(c))
        || target.revision == 0
        || target.changelist_id == 0
    {
        return Err("Undo requires one literal depot file and a positive revision/CL.".into());
    }
    Ok(format!("{}#{}", path, target.revision))
}
fn number(value: &Value, key: &str) -> Option<u64> {
    value
        .get(key)
        .and_then(|v| v.as_u64().or_else(|| v.as_str()?.parse().ok()))
}
fn single_file<'a>(rows: &'a [Value], path: &str) -> Result<&'a Value, String> {
    if rows.len() != 1 || rows[0].get("depotFile").and_then(Value::as_str) != Some(path) {
        return Err(
            "Preview did not verify exactly the requested depot file. Nothing was executed.".into(),
        );
    }
    Ok(&rows[0])
}
fn records(result: &OperationResult) -> Result<Vec<Value>, String> {
    if result.exit_code != 0 {
        return Err("Undo preflight failed. Inspect the operation log.".into());
    }
    let mut rows = Vec::new();
    for event in &result.events {
        if matches!(
            event.kind,
            EventKind::Error | EventKind::Warning | EventKind::Cancelled | EventKind::Stderr
        ) {
            return Err(
                "Undo preflight reported a warning/error; review the operation log.".into(),
            );
        }
        if !matches!(event.kind, EventKind::Stdout) {
            continue;
        }
        let value: Value = serde_json::from_str(event.message.as_deref().unwrap_or(""))
            .map_err(|_| "Unrecognized Undo preflight output.")?;
        if number(&value, "severity").unwrap_or(0) > 0
            || value
                .get("code")
                .and_then(Value::as_str)
                .is_some_and(|s| s == "error" || s == "info")
        {
            return Err("Undo preflight could not verify the affected file.".into());
        }
        rows.push(value);
    }
    Ok(rows)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn revision_is_not_a_cl_or_range() {
        let t = UndoTarget {
            depot_path: "//depot/a.txt".into(),
            revision: 17,
            changelist_id: 900,
        };
        assert_eq!(filespec(&t).unwrap(), "//depot/a.txt#17");
        for path in [
            "//depot/...",
            "//depot/*",
            "//depot/a#42",
            "//depot/a@900",
            "//depot/%2a",
        ] {
            assert!(filespec(&UndoTarget {
                depot_path: path.into(),
                ..t.clone()
            })
            .is_err());
        }
    }
    #[test]
    fn rejects_extra_or_different_files() {
        assert!(single_file(&[], "//depot/a").is_err());
        assert!(single_file(&[serde_json::json!({"depotFile":"//depot/b"})], "//depot/a").is_err());
        assert!(single_file(
            &[
                serde_json::json!({"depotFile":"//depot/a"}),
                serde_json::json!({"depotFile":"//depot/b"})
            ],
            "//depot/a"
        )
        .is_err());
    }
    #[test]
    fn parser_rejects_failed_partial_or_ambiguous_results() {
        let make = |exit_code, kind, message: &str| OperationResult {
            operation_id: "test".into(),
            exit_code,
            duration_ms: 0,
            events: vec![OperationEvent {
                operation_id: "test".into(),
                kind,
                message: Some(message.into()),
                progress: None,
                timestamp: String::new(),
            }],
        };
        assert!(records(&make(1, EventKind::Stdout, r#"{"depotFile":"//depot/a"}"#)).is_err());
        assert!(records(&make(
            0,
            EventKind::Stdout,
            r#"{"severity":3,"data":"failed"}"#
        ))
        .is_err());
        assert!(records(&make(0, EventKind::Warning, "partial")).is_err());
        assert!(records(&make(0, EventKind::Stdout, "unexpected plain text")).is_err());
        assert_eq!(
            records(&make(
                0,
                EventKind::Stdout,
                r#"{"depotFile":"//depot/a","action":"edit"}"#
            ))
            .unwrap()
            .len(),
            1
        );
    }
    #[test]
    fn confirmation_tokens_are_one_use_and_expire() {
        let store = ConfirmationStore::default();
        let target = UndoTarget {
            depot_path: "//depot/a".into(),
            revision: 17,
            changelist_id: 901,
        };
        let record = || Record {
            target: target.clone(),
            context: P4Context::default(),
            generation: 2,
            digest: "content".into(),
            expires_at: 100,
        };
        let token = store.issue(record(), 0);
        assert_eq!(store.consume(&token).unwrap().target, target);
        assert!(store.consume(&token).is_none());
        let expired = store.issue(record(), 0);
        store.issue(record(), 101);
        assert!(store.consume(&expired).is_none());
    }
}
