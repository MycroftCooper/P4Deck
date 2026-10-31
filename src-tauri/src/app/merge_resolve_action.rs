//! S4c: unified durable lifecycle for resolve + manual-merge rows.
//!
//! Optimistic policy (user-confirmed boundary): FE optimistic projection is
//! limited to **intent/progress** (in-flight / occupied). It MUST NOT render
//! "resolve succeeded" or "merged content saved". Only the authoritative host
//! result below (persisted receipt + bounded fstat facts / CAS result digest)
//! may correct the UI. Reasons:
//! resolve may be partial/unknown per file; an optimistic success would hide
//! remaining conflicts and invite blind retries;
//! manual merge save writes local merged content under a CAS digest; a local
//! optimistic "saved" would race later validation/review and is not an
//! authoritative P4 fact.
//! Admission is enforced by the IPC command argument before business calls.
use crate::domain::*;
use crate::p4::workflows::parser;
use serde::{Deserialize, Serialize};

pub const KIND_RESOLVE: &str = "resolve";
pub const KIND_MANUAL_MERGE_SESSION: &str = "manualMergeSession";
pub const KIND_MANUAL_MERGE_SAVE: &str = "manualMergeSave";
pub const KIND_MANUAL_MERGE_RESOLVE: &str = "manualMergeResolve";

pub const OPTIMISTIC_POLICY: &str = "intentOnly";

const RECHECK_FIELDS: &str = "depotFile,clientFile,action,change,haveRev,headRev,fileType,digest";

/// Bounded post-write recheck: one read-only fstat over the exact depot scope.
/// (Kept local to this slice so S4c does not depend on S4a's module.)
pub async fn recheck_facts(
    runner: &crate::p4::runner::P4Runner,
    context: &P4Context,
    depot_paths: &[String],
    operation_id: &str,
    app: Option<&tauri::AppHandle>,
) -> Result<Vec<parser::WorkflowFileFact>, String> {
    let mut paths = depot_paths.to_vec();
    paths.sort();
    paths.dedup();
    if paths.is_empty() {
        return Err("emptyRecheckScope".into());
    }
    let mut query = crate::p4::workflows::command::fstat(&paths, None)?;
    if query.args.len() >= 3 {
        query.args[2] = RECHECK_FIELDS.into();
    }
    let request = P4CommandRequest {
        operation_id: Some(format!("{operation_id}:recheck")),
        source: OperationSource::Gui,
        command: query.command.into(),
        args: query.args,
        context: context.clone(),
        output_mode: OutputMode::JsonLines,
        timeout_ms: Some(300_000),
        input: None,
    };
    let result = runner
        .run_with_progress(request, app, None, query.argument_input)
        .await
        .map_err(|error| error.to_string())?;
    Ok(parser::file_facts(&result.events))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeResolveActionResult {
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub operation_id: Option<String>,
    /// intent | committed | unknown | rejected | legacy
    pub state: String,
    pub outcome: WorkflowOutcome,
    pub files: Vec<WorkflowFileResult>,
    pub message: String,
    /// Optimistic policy tag: always `intentOnly` in this slice.
    pub optimistic: String,
    /// Row-specific authoritative payload (sessionId/resultDigest/backupPath/...).
    pub details: serde_json::Value,
    pub legacy: serde_json::Value,
}

fn value_of<T: Serialize>(value: &T) -> serde_json::Value {
    serde_json::to_value(value).unwrap_or(serde_json::Value::Null)
}

fn outcome_of(value: &serde_json::Value) -> WorkflowOutcome {
    match value.as_str() {
        Some("succeeded") => WorkflowOutcome::Succeeded,
        Some("partial") => WorkflowOutcome::Partial,
        Some("rejected") => WorkflowOutcome::Rejected,
        Some("failed") => WorkflowOutcome::Failed,
        Some("cancelled") => WorkflowOutcome::Cancelled,
        _ => WorkflowOutcome::Unknown,
    }
}

fn file_state(
    path: &str,
    state: WorkflowFileState,
    message: &str,
    id: Option<&str>,
) -> WorkflowFileResult {
    WorkflowFileResult {
        depot_path: path.to_owned(),
        state,
        message: message.to_owned(),
        operation_id: id.map(|value| value.to_owned()),
    }
}

fn summarize(files: &[WorkflowFileResult], fallback: WorkflowOutcome) -> WorkflowOutcome {
    if files.is_empty() {
        return WorkflowOutcome::Unknown;
    }
    let succeeded = files
        .iter()
        .filter(|file| file.state == WorkflowFileState::Succeeded)
        .count();
    if succeeded == files.len() {
        WorkflowOutcome::Succeeded
    } else if succeeded > 0 {
        WorkflowOutcome::Partial
    } else if matches!(
        fallback,
        WorkflowOutcome::Rejected | WorkflowOutcome::Cancelled
    ) {
        fallback
    } else {
        WorkflowOutcome::Unknown
    }
}

fn committed_state(outcome: WorkflowOutcome) -> &'static str {
    match outcome {
        WorkflowOutcome::Succeeded | WorkflowOutcome::Partial => "committed",
        WorkflowOutcome::Rejected | WorkflowOutcome::Cancelled => "rejected",
        _ => "unknown",
    }
}

/// Per-file resolve/manual-merge-resolve proof: the exact path must be present in
/// bounded fstat facts with `unresolved == 0`. Legacy `WorkflowResult.outcome`
/// alone never proves per-file resolution.
pub fn project_resolve(
    kind: &str,
    operation_id: Option<String>,
    legacy: &WorkflowResult,
    facts: &[parser::WorkflowFileFact],
    paths: &[String],
) -> MergeResolveActionResult {
    let legacy_outcome = outcome_of(&value_of(&legacy.outcome));
    let write_ok = matches!(
        legacy_outcome,
        WorkflowOutcome::Succeeded | WorkflowOutcome::Partial
    );
    let mut files = Vec::new();
    if operation_id.is_some() {
        for path in paths {
            let matching: Vec<&parser::WorkflowFileFact> = facts
                .iter()
                .filter(|fact| fact.depot_path == *path)
                .collect();
            let proven = write_ok && matching.len() == 1 && matching[0].unresolved == 0;
            files.push(file_state(
                path,
                if proven { WorkflowFileState::Succeeded } else { WorkflowFileState::Unknown },
                if proven {
                    "Path confirmed unresolved-count 0 by bounded post-write facts; later edits require investigation."
                } else {
                    "Resolve effect is unconfirmed; remaining conflicts/unknown must be investigated, never auto-retried."
                },
                operation_id.as_deref(),
            ));
        }
    }
    let outcome = if operation_id.is_none()
        || matches!(
            legacy_outcome,
            WorkflowOutcome::Rejected | WorkflowOutcome::Cancelled
        ) {
        legacy_outcome
    } else {
        summarize(&files, legacy_outcome)
    };
    MergeResolveActionResult {
        kind: kind.to_owned(),
        operation_id: operation_id.clone(),
        state: if operation_id.is_none() {
            "legacy".into()
        } else {
            committed_state(outcome).into()
        },
        outcome,
        files,
        message: legacy.message.clone(),
        optimistic: OPTIMISTIC_POLICY.into(),
        details: serde_json::json!({
            "operationIds": legacy.operation_ids,
            "logReference": legacy.log_reference,
        }),
        legacy: value_of(legacy),
    }
}

/// Manual-merge session open: read-only. Optimistic projection is intent only;
/// no merged content is saved by opening a session.
pub fn project_session_open(
    operation_id: Option<String>,
    legacy: &crate::domain::ManualMergeSession,
) -> MergeResolveActionResult {
    let mut files = Vec::new();
    if operation_id.is_some() {
        files.push(file_state(
            &legacy.depot_path,
            WorkflowFileState::Unknown,
            "Manual merge session opened. Merge content is NOT saved; save requires explicit review + confirm.",
            operation_id.as_deref(),
        ));
    }
    MergeResolveActionResult {
        kind: KIND_MANUAL_MERGE_SESSION.into(),
        operation_id: operation_id.clone(),
        state: if operation_id.is_some() {
            "intent".into()
        } else {
            "legacy".into()
        },
        outcome: WorkflowOutcome::Unknown,
        files,
        message: "Manual merge session prepared. Optimistic projection is intent/progress only."
            .into(),
        optimistic: OPTIMISTIC_POLICY.into(),
        details: serde_json::json!({
            "sessionId": legacy.session_id,
            "depotPath": legacy.depot_path,
            "resolveDigest": legacy.resolve_digest,
            "target": legacy.target,
        }),
        legacy: value_of(legacy),
    }
}

/// Manual-merge validation: read-only digest/CAS check. Still intent/progress
/// only; saving requires the explicit save confirmation.
pub fn project_session_validation(
    operation_id: Option<String>,
    legacy: &crate::domain::ManualMergeValidation,
    session_id: &str,
) -> MergeResolveActionResult {
    MergeResolveActionResult {
        kind: KIND_MANUAL_MERGE_SESSION.into(),
        operation_id: operation_id.clone(),
        state: if operation_id.is_some() {
            "intent".into()
        } else {
            "legacy".into()
        },
        outcome: WorkflowOutcome::Unknown,
        files: Vec::new(),
        message: if legacy.valid {
            "Merged content validates locally; it is NOT saved until explicit save confirm.".into()
        } else {
            "Merged content does not validate yet; resolve remaining blocks before saving.".into()
        },
        optimistic: OPTIMISTIC_POLICY.into(),
        details: serde_json::json!({
            "sessionId": session_id,
            "valid": legacy.valid,
            "unresolvedBlocks": legacy.unresolved_blocks,
            "resultDigest": legacy.result_digest,
        }),
        legacy: value_of(legacy),
    }
}

/// Manual-merge save: authoritative success requires the service CAS result digest.
/// The digest (not exit code) is the proof that the reviewed content was written;
/// optimistic UI must not show "saved" before this result.
pub fn project_manual_merge_save(
    operation_id: Option<String>,
    legacy: &ManualMergeSaveResult,
) -> MergeResolveActionResult {
    let legacy_outcome = outcome_of(&value_of(&legacy.outcome));
    let digest_ok = !legacy.result_digest.is_empty();
    let outcome = if operation_id.is_none()
        || matches!(
            legacy_outcome,
            WorkflowOutcome::Rejected | WorkflowOutcome::Cancelled
        ) {
        legacy_outcome
    } else if legacy_outcome == WorkflowOutcome::Succeeded && digest_ok {
        WorkflowOutcome::Succeeded
    } else {
        WorkflowOutcome::Unknown
    };
    MergeResolveActionResult {
        kind: KIND_MANUAL_MERGE_SAVE.into(),
        operation_id: operation_id.clone(),
        state: if operation_id.is_none() {
            "legacy".into()
        } else {
            committed_state(outcome).into()
        },
        outcome,
        files: Vec::new(),
        message: if outcome == WorkflowOutcome::Succeeded {
            "Merged content saved under the reviewed CAS digest; authoritative result, optimistic UI must wait for it.".into()
        } else {
            "Merge save effect is unconfirmed; keep unknown and inspect (no automatic retry)."
                .into()
        },
        optimistic: OPTIMISTIC_POLICY.into(),
        details: serde_json::json!({
            "sessionId": legacy.operation_id,
            "resultDigest": legacy.result_digest,
            "backupPath": legacy.backup_path,
            "resolveTokenPresent": legacy.resolve_token.is_some(),
            "resolveExpiresAt": legacy.resolve_expires_at,
        }),
        legacy: value_of(legacy),
    }
}

/// Failure shape persisted when a durable operation errors (unknown, never
/// "not applied"). Legacy calls keep the old `Err` return without a receipt.
pub fn failed_result(kind: &str, operation_id: &str, error: &str) -> MergeResolveActionResult {
    MergeResolveActionResult {
        kind: kind.into(),
        operation_id: Some(operation_id.into()),
        state: "unknown".into(),
        outcome: WorkflowOutcome::Unknown,
        files: Vec::new(),
        message: format!(
            "Operation failed before an authoritative result could be proven: {error}"
        ),
        optimistic: OPTIMISTIC_POLICY.into(),
        details: serde_json::json!({"error": error}),
        legacy: serde_json::Value::Null,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fact(depot: &str, unresolved: usize) -> parser::WorkflowFileFact {
        parser::WorkflowFileFact {
            depot_path: depot.into(),
            client_path: None,
            action: "edit".into(),
            change_id: Some(41),
            have_revision: Some(7),
            head_revision: Some(7),
            file_type: "text".into(),
            digest: "fixture".into(),
            shelved_digest: "fixture".into(),
            size: None,
            shelved_size: None,
            shelved_type: None,
            unresolved,
            other_open: 0,
            other_lock: 0,
            our_lock: 0,
        }
    }

    fn workflow(outcome: &str, message: &str, paths: &[&str]) -> WorkflowResult {
        let files = paths
            .iter()
            .map(|path| WorkflowFileResult {
                depot_path: (*path).into(),
                state: WorkflowFileState::Unknown,
                message: String::new(),
                operation_id: None,
            })
            .collect();
        WorkflowResult {
            execution: None,
            outcome: outcome_of(&serde_json::Value::String(outcome.into())),
            failure: None,
            message: message.into(),
            operation_ids: vec!["11111111-1111-4111-8111-111111111111".into()],
            log_reference: None,
            files,
            refresh: WorkflowRefreshAdvice {
                pending_changes: true,
                workspace_status: true,
                depot_paths: vec!["//fixture/a".into()],
                reason: "fixture".into(),
            },
        }
    }

    #[test]
    fn resolve_requires_unresolved_zero_per_path() {
        let id = Some("11111111-1111-4111-8111-111111111111".to_owned());
        let legacy = workflow("succeeded", "fixture", &["//fixture/a", "//fixture/b"]);
        let proven = project_resolve(
            KIND_RESOLVE,
            id.clone(),
            &legacy,
            &[fact("//fixture/a", 0)],
            &["//fixture/a".into(), "//fixture/b".into()],
        );
        assert_eq!(proven.outcome, WorkflowOutcome::Partial);
        assert_eq!(proven.files[0].state, WorkflowFileState::Succeeded);
        assert_eq!(proven.files[1].state, WorkflowFileState::Unknown);
        assert_eq!(proven.optimistic, "intentOnly");

        let still_conflicted = project_resolve(
            KIND_RESOLVE,
            id,
            &legacy,
            &[fact("//fixture/a", 2), fact("//fixture/b", 0)],
            &["//fixture/a".into(), "//fixture/b".into()],
        );
        assert_eq!(still_conflicted.outcome, WorkflowOutcome::Partial);
        assert_eq!(still_conflicted.files[0].state, WorkflowFileState::Unknown);

        let unknown = project_resolve(
            KIND_RESOLVE,
            Some("11111111-1111-4111-8111-111111111111".into()),
            &workflow("succeeded", "fixture", &["//fixture/a"]),
            &[],
            &["//fixture/a".into()],
        );
        assert_eq!(unknown.outcome, WorkflowOutcome::Unknown);
        assert_eq!(unknown.state, "unknown");
    }

    fn save_result(outcome: &str, digest: &str) -> ManualMergeSaveResult {
        serde_json::from_value(serde_json::json!({
            "outcome": outcome,
            "message": "fixture",
            "resultDigest": digest,
            "backupPath": null,
            "resolveToken": null,
            "resolveExpiresAt": 0,
            "operationId": "11111111-1111-4111-8111-111111111111",
            "refresh": {"pendingChanges": true, "workspaceStatus": true, "depotPaths": ["//fixture/a"], "localPaths": [], "reason": "fixture"}
        }))
        .unwrap()
    }

    #[test]
    fn manual_merge_save_requires_cas_digest() {
        let id = Some("11111111-1111-4111-8111-111111111111".to_owned());
        let saved = project_manual_merge_save(id.clone(), &save_result("succeeded", "abc123"));
        assert_eq!(saved.outcome, WorkflowOutcome::Succeeded);
        assert_eq!(saved.state, "committed");
        assert_eq!(saved.optimistic, "intentOnly");
        let no_digest = project_manual_merge_save(id.clone(), &save_result("succeeded", ""));
        assert_eq!(no_digest.outcome, WorkflowOutcome::Unknown);
        let failed = project_manual_merge_save(id, &save_result("failed", "abc123"));
        assert_eq!(failed.outcome, WorkflowOutcome::Unknown);
    }

    #[test]
    fn failure_shape_is_unknown_and_never_claims_not_applied() {
        let failed = failed_result(
            KIND_RESOLVE,
            "11111111-1111-4111-8111-111111111111",
            "timeout",
        );
        assert_eq!(failed.state, "unknown");
        assert_eq!(failed.outcome, WorkflowOutcome::Unknown);
        assert_eq!(failed.optimistic, "intentOnly");
        assert!(failed.files.is_empty());
    }
}
