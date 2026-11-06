//! Single-file revision undo. Preview never changes files; confirmation is one-use and context bound.
use crate::{
    app::{
        confirmation::{ConfirmationTicket, DEFAULT_CONFIRMATION_TTL_MS},
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
/// The non-target half of an Undo review: the context/generation it was made
/// against and the server digest it bound. It rides in the shared ticket's
/// digest slot, while the reviewed `UndoTarget` is the ticket's snapshot.
#[derive(Debug, Clone)]
struct UndoReview {
    context: P4Context,
    generation: u64,
    digest: String,
}
pub struct UndoService {
    runner: Arc<P4Runner>,
    contexts: Arc<ContextStore>,
    cache: Arc<StatusCache>,
    timeline: ConfirmationTicket<UndoTarget, UndoReview>,
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
            timeline: ConfirmationTicket::new(DEFAULT_CONFIRMATION_TTL_MS),
        }
    }
    pub async fn clear_confirmations(&self) {
        // Await the clear so a context switch serialises against any in-flight
        // confirmation of this family; blocking inside the async runtime would
        // stall the command that performs the switch.
        self.timeline.clear().await;
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
        let (expires_at, token) = self
            .timeline
            .issue(
                true,
                target.clone(),
                UndoReview {
                    context,
                    generation,
                    digest,
                },
            )
            .expect("a resolved review always issues a token");
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
            .timeline
            .take(&confirmation.token)
            .ok_or("Undo preview expired or was already used. Preview again.")?;
        if record.expires_at <= crate::app::confirmation::now_ms()
            || confirmation.target != record.target
        {
            return Err("Undo preview expired or target changed.".into());
        }
        let context = record.digest.context.clone();
        let generation = record.digest.generation;
        let reviewed_digest = record.digest.digest.clone();
        if self.contexts.snapshot() != (context.clone(), generation) {
            return Err("Connection changed. Preview Undo again.".into());
        }
        let guard = self.runner.lock_mutations(&context.server).await;
        let (recheck_digest, _) = self.inspect(&context, &record.target, app).await?;
        if recheck_digest != reviewed_digest
            || self.contexts.snapshot() != (context.clone(), generation)
        {
            return Err("File, preview or connection changed. Preview Undo again.".into());
        }
        let result = self
            .runner
            .run_with_mutation_guard(
                // The real write: `p4 undo` rewrites the client file.
                request(
                    &context,
                    "undo",
                    vec![filespec(&record.target)?],
                    crate::p4::bounds::IoBound::Command,
                ),
                app,
                Some(1),
                &guard,
            )
            .await;
        self.cache.invalidate(
            &context.server,
            &context.user,
            &context.client,
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
        bound: crate::p4::bounds::IoBound,
        app: Option<&AppHandle>,
    ) -> Result<Vec<Value>, String> {
        let result = self
            .runner
            .run_with_progress(request(context, command, args, bound), app, None, None)
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
        // Read-only pre-checks. The dialog abandons them after 30 s, so a hung
        // server must fail the read fast instead of keeping a query alive for
        // the mutation family's full limit (the old R9 revision did exactly that,
        // which turned a read timeout into an "Unknown" outcome).
        let revision = self
            .query(
                context,
                "files",
                vec![spec.clone()],
                crate::p4::bounds::IoBound::Read,
                app,
            )
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
                crate::p4::bounds::IoBound::Read,
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
                crate::p4::bounds::IoBound::Read,
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
            .query(
                context,
                "undo",
                vec!["-n".into(), spec],
                // `undo -n` only previews; it must not wait like the real write.
                crate::p4::bounds::IoBound::Read,
                app,
            )
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
fn request(
    context: &P4Context,
    command: &str,
    args: Vec<String>,
    bound: crate::p4::bounds::IoBound,
) -> P4CommandRequest {
    P4CommandRequest {
        bound,
        operation_id: None,
        source: OperationSource::Gui,
        command: command.into(),
        args,
        context: context.clone(),
        output_mode: OutputMode::JsonLines,
        timeout_ms: None,
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
        // Undo now uses the shared ticket: the same one-use, expiry and
        // pruning guarantees apply to its reviews.
        let ticket: ConfirmationTicket<UndoTarget, UndoReview> = ConfirmationTicket::new(100);
        let target = UndoTarget {
            depot_path: "//depot/a".into(),
            revision: 17,
            changelist_id: 901,
        };
        let review = || UndoReview {
            context: P4Context::default(),
            generation: 2,
            digest: "content".into(),
        };
        let (_, token) = ticket.issue(true, target.clone(), review()).unwrap();
        assert_eq!(ticket.take(&token).unwrap().target, target);
        assert!(ticket.take(&token).is_none(), "a review is one-use");
        // A blocked review never issues a token at all.
        assert!(ticket.issue(false, target.clone(), review()).is_none());
        // An already-expired record is refused by the caller's TTL check.
        let (expires_at, token) = ticket.issue(true, target, review()).unwrap();
        assert!(expires_at > crate::app::confirmation::now_ms());
        assert!(ticket.take(&token).is_some());
    }
}
