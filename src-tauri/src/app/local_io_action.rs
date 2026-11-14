//! S4a: unified durable lifecycle for local/IO actions
//! (`rename-move-path`, `sync-revision`, `undo-change`).
//!
//! Admission is enforced by the IPC commands (`_admission` argument) before any
//! business call. This module adds the durable part of the lifecycle:
//! - exact operation scope (`ConnectionSnapshot` incl. generation) + one operationId
//! - persistent action receipt reserved before the business write and settled with a
//!   per-file `WorkflowResult`-shaped result after a bounded post-write recheck
//! - same-ID/same-payload reuse, conflicting payload rejection, running/interrupted
//!   receipts are never replayed (caller must query `workflow_action_lookup`)
//! - per-file authority comes from fstat facts, never from `affectedPaths`
//! - unknown stays unknown (no automatic retry, no "not applied" claim)
use crate::app::action_evidence::{self, OpenedEvidence};
use crate::domain::*;
use crate::p4::runner::P4Runner;
use crate::p4::workflows::{command as workflow_command, parser};
use serde::{Deserialize, Serialize};

pub const KIND_RENAME_MOVE: &str = "renameMove";
pub const KIND_SYNC_REVISION: &str = "syncRevision";
pub const KIND_UNDO_CHANGE: &str = "undoChange";

const RECHECK_FIELDS: &str = "depotFile,clientFile,action,change,haveRev,headRev,fileType,digest";

/// Bounded `p4 fstat` recheck. `read_failed` says the read itself is
/// untrustworthy (runner/transport event, a `severity >= 3` diagnostic, or a
/// fatal exit status); a trustworthy read with no fact for a path means the path
/// has no depot record (a locally added or just-removed file), which is
/// evidence, not a read failure. A benign `no such file(s)` answer is a
/// `severity: 2` diagnostic that may still exit non-zero, so the exit code alone
/// never decides this.
pub struct RecheckFacts {
    pub facts: Vec<parser::WorkflowFileFact>,
    pub read_failed: bool,
}

impl Default for RecheckFacts {
    /// No recheck was performed: a value that was never read must not be
    /// treated as evidence.
    fn default() -> Self {
        Self {
            facts: Vec::new(),
            read_failed: true,
        }
    }
}

/// Response for the three migrated confirm commands. The legacy typed result is
/// preserved verbatim under `legacy` so FE can migrate incrementally.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalIoActionResult {
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub operation_id: Option<String>,
    /// `committed` | `unknown` | `rejected` | `legacy`
    pub state: String,
    pub outcome: WorkflowOutcome,
    /// Per-file facts. Empty for legacy (no operationId) calls.
    pub files: Vec<WorkflowFileResult>,
    pub message: String,
    pub legacy: serde_json::Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub receipt_revision: Option<String>,
}

fn file_result(
    path: &str,
    state: WorkflowFileState,
    message: &str,
    operation_id: Option<&str>,
) -> WorkflowFileResult {
    WorkflowFileResult {
        depot_path: path.to_owned(),
        state,
        message: message.to_owned(),
        operation_id: operation_id.map(|id| id.to_owned()),
    }
}

/// Bounded post-write recheck; read-only fstat over the exact depot scope.
pub async fn recheck_facts(
    runner: &P4Runner,
    context: &P4Context,
    depot_paths: &[String],
    operation_id: &str,
    app: Option<&tauri::AppHandle>,
) -> Result<RecheckFacts, String> {
    let mut paths = depot_paths.to_vec();
    paths.sort();
    paths.dedup();
    if paths.is_empty() {
        return Err("emptyRecheckScope".into());
    }
    let mut query = workflow_command::fstat(&paths, None)?;
    // fstat -Ol -T <fields> <paths>: replace the default field template (index 2).
    if query.args.len() >= 3 {
        query.args[2] = RECHECK_FIELDS.into();
    }
    let request = P4CommandRequest {
        bound: crate::p4::bounds::IoBound::ReadLong,
        operation_id: Some(format!("{operation_id}:recheck")),
        source: OperationSource::Gui,
        command: query.command.into(),
        args: query.args,
        context: context.clone(),
        output_mode: OutputMode::JsonLines,
        timeout_ms: None,
        input: None,
    };
    let result = runner
        .run_with_progress(request, app, None, query.argument_input)
        .await
        .map_err(|error| error.to_string())?;
    Ok(RecheckFacts {
        read_failed: action_evidence::read_failed(&result),
        facts: parser::file_facts(&result.events),
    })
}

fn legacy_value<T: Serialize>(value: &T) -> serde_json::Value {
    serde_json::to_value(value).unwrap_or(serde_json::Value::Null)
}

fn outcome_from(value: &serde_json::Value) -> WorkflowOutcome {
    match value.as_str() {
        Some("succeeded") => WorkflowOutcome::Succeeded,
        Some("partial") => WorkflowOutcome::Partial,
        Some("failed") => WorkflowOutcome::Failed,
        Some("cancelled") => WorkflowOutcome::Cancelled,
        Some("rejected") => WorkflowOutcome::Rejected,
        _ => WorkflowOutcome::Unknown,
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

fn state_for(outcome: WorkflowOutcome, has_receipt: bool) -> &'static str {
    if !has_receipt {
        return "legacy";
    }
    match outcome {
        WorkflowOutcome::Succeeded | WorkflowOutcome::Partial => "committed",
        WorkflowOutcome::Rejected | WorkflowOutcome::Cancelled => "rejected",
        _ => "unknown",
    }
}

/// rename-move-path projection: target must be present in fstat facts and the
/// source must carry a move/delete action. A rename confirmation result alone
/// never proves per-file success.
pub fn project_rename(
    operation_id: Option<String>,
    legacy: &RenameMoveResult,
    facts: &[parser::WorkflowFileFact],
    opened: &OpenedEvidence,
    source_depot: &str,
    target_depot: &str,
) -> LocalIoActionResult {
    let legacy_outcome = outcome_from(&legacy_value(&legacy.outcome));
    let legacy_ok = legacy_outcome == WorkflowOutcome::Succeeded;
    let mut files = Vec::new();
    if operation_id.is_some() {
        let target_fact = facts.iter().find(|fact| fact.depot_path == target_depot);
        let source_fact = facts.iter().find(|fact| fact.depot_path == source_depot);
        // A moved target is a pending branch/move-add that has no depot record
        // yet; the opened list proves it exists, a bare fstat would call it
        // unknown and block the next write.
        let target_state = if legacy_ok
            && (target_fact.is_some()
                || action_evidence::opened_with(opened, target_depot, &["move", "add", "branch"]))
        {
            WorkflowFileState::Succeeded
        } else {
            WorkflowFileState::Unknown
        };
        let source_state = if legacy_ok
            && (source_fact
                .is_some_and(|fact| fact.action.contains("move") || fact.action.contains("delete"))
                || action_evidence::opened_with(opened, source_depot, &["move", "delete"]))
        {
            WorkflowFileState::Succeeded
        } else {
            WorkflowFileState::Unknown
        };
        files.push(file_result(
            target_depot,
            target_state,
            "Moved target confirmed by bounded post-write facts; opened state and later edits require investigation.",
            operation_id.as_deref(),
        ));
        files.push(file_result(
            source_depot,
            source_state,
            "Moved source confirmed by bounded post-write facts; local content is not restored by this action.",
            operation_id.as_deref(),
        ));
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
    LocalIoActionResult {
        kind: KIND_RENAME_MOVE.into(),
        operation_id: operation_id.clone(),
        state: state_for(outcome, operation_id.is_some()).into(),
        outcome,
        files,
        message: legacy.message.clone(),
        legacy: legacy_value(legacy),
        receipt_revision: None,
    }
}

/// How a sync revision can be proven from bounded post-write facts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SyncRevisionProof {
    Head,
    Revision(i64),
    /// change/date/label selectors cannot be proven by have/head comparison.
    Unprovable,
}

pub fn sync_revision_proof(spec: &SyncRevisionSpec) -> SyncRevisionProof {
    match spec.kind {
        SyncRevisionKind::Head => SyncRevisionProof::Head,
        SyncRevisionKind::Revision => spec
            .value
            .as_deref()
            .and_then(|value| value.parse::<i64>().ok())
            .map_or(SyncRevisionProof::Unprovable, SyncRevisionProof::Revision),
        _ => SyncRevisionProof::Unprovable,
    }
}

fn sync_fact_proves(fact: &parser::WorkflowFileFact, proof: SyncRevisionProof) -> bool {
    if !fact.action.is_empty() {
        return false;
    }
    match (proof, fact.have_revision, fact.head_revision) {
        (SyncRevisionProof::Revision(revision), Some(have), _) => have == revision,
        (SyncRevisionProof::Head, Some(have), Some(head)) => have == head,
        _ => false,
    }
}

/// sync-revision projection: a path is `Succeeded` only when the bounded post-write
/// fstat fact shows it unopened at the requested revision (or current head for
/// head sync). `affectedPaths`/counts never substitute for per-file facts.
pub fn project_sync(
    operation_id: Option<String>,
    legacy: &SyncResult,
    facts: &RecheckFacts,
    opened: &OpenedEvidence,
    paths: &[String],
    proof: SyncRevisionProof,
) -> LocalIoActionResult {
    let legacy_outcome = outcome_from(&legacy_value(&legacy.outcome));
    let mut files = Vec::new();
    if operation_id.is_some() {
        for path in paths {
            let matching: Vec<&parser::WorkflowFileFact> = facts
                .facts
                .iter()
                .filter(|fact| fact.depot_path == *path)
                .collect();
            // A file removed by the sync has no fstat record at the requested
            // revision, and a real `p4 opened <path>` answers it with empty
            // output: that successful empty answer proves the path is no longer
            // open, so a clean sync that deleted it is success, not unknown.
            // The proof is only usable when the fstat read itself was
            // trustworthy and had no record for the path: a stale have/head fact
            // means the sync did not take effect and must stay Unknown.
            let state = if matches!(
                legacy_outcome,
                WorkflowOutcome::Succeeded | WorkflowOutcome::Partial
            ) && proof != SyncRevisionProof::Unprovable
                && ((matching.len() == 1 && sync_fact_proves(matching[0], proof))
                    || (matching.is_empty()
                        && !facts.read_failed
                        && action_evidence::proves_unopened(opened, paths, path)))
            {
                WorkflowFileState::Succeeded
            } else {
                WorkflowFileState::Unknown
            };
            files.push(file_result(
                path,
                state,
                if state == WorkflowFileState::Succeeded {
                    "File confirmed unopened at the requested revision by bounded post-write facts."
                } else {
                    "Per-file revision effect is unconfirmed; no automatic retry."
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
    LocalIoActionResult {
        kind: KIND_SYNC_REVISION.into(),
        operation_id: operation_id.clone(),
        state: state_for(outcome, operation_id.is_some()).into(),
        outcome,
        files,
        message: legacy.message.clone(),
        legacy: legacy_value(legacy),
        receipt_revision: None,
    }
}

fn clean_operation(result: &OperationResult) -> bool {
    crate::app::revert_action::clean(result)
}

/// undo-change projection: success requires a clean operation and an exact fstat
/// fact showing the file opened in the undo target changelist. Anything else stays
/// unknown (undo may have restored local content even when readback is incomplete).
pub fn project_undo(
    operation_id: Option<String>,
    legacy: Result<OperationResult, String>,
    facts: &[parser::WorkflowFileFact],
    opened: &OpenedEvidence,
    depot_path: &str,
    changelist_id: i64,
) -> LocalIoActionResult {
    let (legacy_outcome, legacy_json, message) = match &legacy {
        Ok(result) => (
            if clean_operation(result) {
                WorkflowOutcome::Succeeded
            } else {
                WorkflowOutcome::Unknown
            },
            legacy_value(result),
            if clean_operation(result) {
                "Undo command completed; file state below is bounded post-write evidence."
                    .to_owned()
            } else {
                "Undo command returned non-clean evidence; per-file effect is unconfirmed."
                    .to_owned()
            },
        ),
        Err(error) => (
            WorkflowOutcome::Unknown,
            serde_json::Value::String(error.clone()),
            "Undo failed before bounded evidence could prove the per-file effect.".to_owned(),
        ),
    };
    let mut files = Vec::new();
    if operation_id.is_some() {
        let matching: Vec<&parser::WorkflowFileFact> = facts
            .iter()
            .filter(|fact| fact.depot_path == depot_path)
            .collect();
        // Undo can restore a deleted file as a pending add/branch, which fstat
        // cannot see; the opened list carries the same action/change evidence.
        // An untrustworthy opened read (connection failure, real error
        // diagnostic) proves nothing, and an empty answer says only that the
        // path is not open - not that undo reopened it in the target CL.
        let in_target_change = |fact: &parser::WorkflowFileFact| {
            if changelist_id == 0 {
                fact.change_id.is_none()
            } else {
                fact.change_id == Some(changelist_id)
            }
        };
        let state = if legacy_outcome == WorkflowOutcome::Succeeded
            && ((matching.len() == 1 && in_target_change(matching[0]))
                || (!opened.read_failed
                    && opened
                        .opened
                        .iter()
                        .any(|fact| fact.depot_path == depot_path && in_target_change(fact))))
        {
            WorkflowFileState::Succeeded
        } else {
            WorkflowFileState::Unknown
        };
        files.push(file_result(
            depot_path,
            state,
            if state == WorkflowFileState::Succeeded {
                "Undo target confirmed opened in the target changelist by bounded post-write facts."
            } else {
                "Per-file undo effect is unconfirmed; no automatic retry."
            },
            operation_id.as_deref(),
        ));
    }
    let outcome = if operation_id.is_none() {
        legacy_outcome
    } else {
        summarize(&files, legacy_outcome)
    };
    LocalIoActionResult {
        kind: KIND_UNDO_CHANGE.into(),
        operation_id: operation_id.clone(),
        state: state_for(outcome, operation_id.is_some()).into(),
        outcome,
        files,
        message,
        legacy: legacy_json,
        receipt_revision: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::OperationEvent;

    fn fact(
        depot: &str,
        action: &str,
        change: Option<i64>,
        have: Option<i64>,
        head: Option<i64>,
    ) -> parser::WorkflowFileFact {
        parser::WorkflowFileFact {
            depot_path: depot.into(),
            client_path: None,
            action: action.into(),
            change_id: change,
            have_revision: have,
            head_revision: head,
            file_type: "text".into(),
            digest: "fixture".into(),
            shelved_digest: "fixture".into(),
            size: None,
            shelved_size: None,
            shelved_type: None,
            unresolved: 0,
            resolved: 0,
            other_open: 0,
            other_lock: 0,
            our_lock: 0,
        }
    }

    fn rename_legacy(outcome: &str) -> RenameMoveResult {
        serde_json::from_value(serde_json::json!({
            "outcome": outcome,
            "message": "fixture",
            "refresh": {"workspaceStatus": true, "pendingChanges": true, "depotPaths": [], "localPaths": [], "reason": "fixture"}
        }))
        .unwrap()
    }

    fn sync_legacy(outcome: &str) -> SyncResult {
        serde_json::from_value(serde_json::json!({
            "outcome": outcome,
            "message": "fixture",
            "affectedPaths": ["//fixture/a"],
            "counts": {"added": 0, "updated": 1, "deleted": 0, "upToDate": 0, "warnings": 0, "conflicts": 0},
            "refreshWorkspace": true,
            "refreshDepot": false
        }))
        .unwrap()
    }

    fn op(events: Vec<OperationEvent>, exit_code: i32) -> OperationResult {
        OperationResult {
            operation_id: "fixture".into(),
            exit_code,
            events,
            duration_ms: 1,
        }
    }

    fn event(kind: crate::domain::EventKind, message: &str) -> OperationEvent {
        OperationEvent {
            operation_id: "fixture".into(),
            kind,
            message: Some(message.into()),
            progress: None,
            progress_current: None,
            progress_total: None,
            timestamp: String::new(),
        }
    }

    /// One real `p4 -ztag -Mj` run: JSON records on stdout, plus stderr lines
    /// (connection/transport failures are the only diagnostics that leave
    /// stdout).
    fn stream(rows: Vec<serde_json::Value>, stderr: &[&str], exit_code: i32) -> OperationResult {
        let mut events = rows
            .into_iter()
            .map(|row| event(crate::domain::EventKind::Stdout, &row.to_string()))
            .collect::<Vec<_>>();
        events.extend(
            stderr
                .iter()
                .map(|line| event(crate::domain::EventKind::Stderr, line)),
        );
        op(events, exit_code)
    }

    /// Real `-ztag -Mj` benign diagnostic for a path with no depot record:
    /// single-line JSON on stdout, no `code` key, `severity: 2`,
    /// `severityformat:"warning"` (measured on P4/NTX64 2026.1).
    fn no_such_file(path: &str) -> serde_json::Value {
        serde_json::json!({
            "code0": 554768759,
            "data": format!("{path} - no such file(s).\n"),
            "fmt0": "[%argc% - no|No] such file(s).",
            "generic": 17,
            "severity": 2,
            "severityformat": "warning",
        })
    }

    /// Real `-ztag -Mj` failure diagnostic (auth/permission): stdout JSON with
    /// `severity: 3` and no `code` key.
    fn severity_error(message: &str) -> serde_json::Value {
        serde_json::json!({
            "code0": 554768759,
            "data": format!("{message}\n"),
            "fmt0": "%msg%",
            "generic": 17,
            "severity": 3,
            "severityformat": "error",
        })
    }

    fn recheck(facts: Vec<parser::WorkflowFileFact>) -> RecheckFacts {
        RecheckFacts {
            facts,
            read_failed: false,
        }
    }

    /// The production recheck path: facts and read trust are both derived from
    /// the same real result, exactly as `recheck_facts` does it.
    fn recheck_from(result: &OperationResult) -> RecheckFacts {
        RecheckFacts {
            facts: parser::file_facts(&result.events),
            read_failed: action_evidence::read_failed(result),
        }
    }

    fn opened_evidence(rows: Vec<serde_json::Value>) -> OpenedEvidence {
        action_evidence::opened_evidence(&stream(rows, &[], 0))
    }

    #[test]
    fn rename_requires_facts_and_never_claims_success_from_result_alone() {
        let id = Some("11111111-1111-4111-8111-111111111111".to_owned());
        let legacy = rename_legacy("succeeded");
        let none = project_rename(
            id.clone(),
            &legacy,
            &[],
            &OpenedEvidence::default(),
            "//fixture/src",
            "//fixture/dst",
        );
        assert_eq!(none.outcome, WorkflowOutcome::Unknown);
        assert_eq!(none.state, "unknown");
        assert!(none
            .files
            .iter()
            .all(|file| file.state == WorkflowFileState::Unknown));

        let partial = project_rename(
            id.clone(),
            &legacy,
            &[fact("//fixture/dst", "move/add", Some(41), None, None)],
            &OpenedEvidence::default(),
            "//fixture/src",
            "//fixture/dst",
        );
        assert_eq!(partial.outcome, WorkflowOutcome::Partial);

        let complete = project_rename(
            id,
            &legacy,
            &[
                fact("//fixture/dst", "move/add", Some(41), None, None),
                fact("//fixture/src", "move/delete", Some(41), None, None),
            ],
            &OpenedEvidence::default(),
            "//fixture/src",
            "//fixture/dst",
        );
        assert_eq!(complete.outcome, WorkflowOutcome::Succeeded);
        assert_eq!(complete.state, "committed");
        assert_eq!(complete.files.len(), 2);
    }

    #[test]
    fn rename_rejected_keeps_rejected_without_files() {
        let result = project_rename(
            Some("11111111-1111-4111-8111-111111111111".into()),
            &rename_legacy("rejected"),
            &[],
            &OpenedEvidence::default(),
            "//fixture/src",
            "//fixture/dst",
        );
        assert_eq!(result.outcome, WorkflowOutcome::Rejected);
        assert!(result
            .files
            .iter()
            .all(|file| file.state == WorkflowFileState::Unknown));
    }

    #[test]
    fn sync_projects_only_revision_proven_paths() {
        let id = Some("11111111-1111-4111-8111-111111111111".to_owned());
        let legacy = sync_legacy("succeeded");
        let paths = vec!["//fixture/a".to_owned(), "//fixture/b".to_owned()];
        let proven = project_sync(
            id,
            &legacy,
            &recheck(vec![fact("//fixture/a", "", None, Some(7), Some(7))]),
            &OpenedEvidence::default(),
            &paths,
            SyncRevisionProof::Head,
        );
        assert_eq!(proven.outcome, WorkflowOutcome::Partial);
        assert_eq!(proven.files[0].state, WorkflowFileState::Succeeded);
        assert_eq!(proven.files[1].state, WorkflowFileState::Unknown);

        let opened = project_sync(
            None,
            &legacy,
            &recheck(vec![fact(
                "//fixture/a",
                "edit",
                Some(41),
                Some(7),
                Some(7),
            )]),
            &OpenedEvidence::default(),
            &paths,
            SyncRevisionProof::Head,
        );
        assert_eq!(opened.outcome, WorkflowOutcome::Succeeded);
        assert!(opened.files.is_empty());
        assert_eq!(opened.state, "legacy");

        let mismatched = project_sync(
            Some("11111111-1111-4111-8111-111111111111".into()),
            &legacy,
            &recheck(vec![fact("//fixture/a", "", None, Some(6), Some(7))]),
            &OpenedEvidence::default(),
            &["//fixture/a".to_owned()],
            SyncRevisionProof::Revision(7),
        );
        assert_eq!(mismatched.outcome, WorkflowOutcome::Unknown);
    }

    #[test]
    fn undo_requires_body_facts_with_target_changelist() {
        let clean = op(vec![], 0);
        let id = Some("11111111-1111-4111-8111-111111111111".to_owned());
        let good = project_undo(
            id,
            Ok(clean.clone()),
            &[fact("//fixture/a", "edit", Some(41), None, None)],
            &OpenedEvidence::default(),
            "//fixture/a",
            41,
        );
        assert_eq!(good.outcome, WorkflowOutcome::Succeeded);
        let mismatch = project_undo(
            Some("11111111-1111-4111-8111-111111111111".into()),
            Ok(clean),
            &[fact("//fixture/a", "edit", Some(42), None, None)],
            &OpenedEvidence::default(),
            "//fixture/a",
            41,
        );
        assert_eq!(mismatch.outcome, WorkflowOutcome::Unknown);
        let failed = project_undo(
            Some("11111111-1111-4111-8111-111111111111".into()),
            Err("timeout".into()),
            &[],
            &OpenedEvidence::default(),
            "//fixture/a",
            41,
        );
        assert_eq!(failed.outcome, WorkflowOutcome::Unknown);
        assert_eq!(failed.state, "unknown");
    }

    #[test]
    fn rename_accepts_a_pending_move_target_from_the_opened_list() {
        // A moved target is a pending move/add with no depot record: fstat has no
        // fact, and treating that as unknown used to block the next write.
        let opened = opened_evidence(vec![
            serde_json::json!({"depotFile": "//fixture/dst", "action": "move/add", "change": "41"}),
            serde_json::json!({"depotFile": "//fixture/src", "action": "move/delete", "change": "41"}),
        ]);
        let result = project_rename(
            Some("11111111-1111-4111-8111-111111111111".into()),
            &rename_legacy("succeeded"),
            &[],
            &opened,
            "//fixture/src",
            "//fixture/dst",
        );
        assert_eq!(result.outcome, WorkflowOutcome::Succeeded);
        assert!(result
            .files
            .iter()
            .all(|file| file.state == WorkflowFileState::Succeeded));
    }

    #[test]
    fn sync_accepts_a_file_removed_at_the_requested_revision() {
        // Measured: a real `p4 opened <path>` answers a path that is not open
        // with empty output and exit 0. That successful empty answer - not a
        // "not opened" message - is what proves the sync removed the file.
        let opened = opened_evidence(vec![]);
        assert!(!opened.read_failed);
        let result = project_sync(
            Some("11111111-1111-4111-8111-111111111111".into()),
            &sync_legacy("succeeded"),
            &recheck(vec![]),
            &opened,
            &["//fixture/gone".to_owned()],
            SyncRevisionProof::Head,
        );
        assert_eq!(result.outcome, WorkflowOutcome::Succeeded);
        assert_eq!(result.files[0].state, WorkflowFileState::Succeeded);
    }

    #[test]
    fn sync_trusts_a_benign_fstat_answer_and_an_empty_opened_answer() {
        // Regression for the silent failure this task fixes: the fstat gap answer
        // is a benign severity-2 record (`severityformat:"warning"`) and the
        // opened answer is empty. Neither may be read as a failed read, whatever
        // exit status p4 reports for them (0 and 1 both occur in the field).
        for exit_code in [0, 1] {
            let facts = recheck_from(&stream(
                vec![no_such_file("//fixture/gone")],
                &[],
                exit_code,
            ));
            assert!(!facts.read_failed, "benign answer, exit {exit_code}");
            assert!(facts.facts.is_empty());
            let opened = action_evidence::opened_evidence(&stream(vec![], &[], exit_code));
            assert!(!opened.read_failed);
            let result = project_sync(
                Some("11111111-1111-4111-8111-111111111111".into()),
                &sync_legacy("succeeded"),
                &facts,
                &opened,
                &["//fixture/gone".to_owned()],
                SyncRevisionProof::Head,
            );
            assert_eq!(
                result.outcome,
                WorkflowOutcome::Succeeded,
                "exit {exit_code} is a benign answer, not a read failure"
            );
            assert_eq!(result.files[0].state, WorkflowFileState::Succeeded);
        }
    }

    #[test]
    fn sync_read_failures_never_project_success() {
        let opened = opened_evidence(vec![]);
        let paths = vec!["//fixture/gone".to_owned()];
        let id = Some("11111111-1111-4111-8111-111111111111".to_owned());
        let failures = [
            // Connection failure: the only diagnostics that reach stderr.
            recheck_from(&stream(
                vec![],
                &["Connect to server failed; check $P4PORT."],
                1,
            )),
            // Real auth failure: a severity-3 record on stdout.
            recheck_from(&stream(
                vec![severity_error("Access for user 'fixture' denied.")],
                &[],
                1,
            )),
            // Fatal exit status with no diagnostic at all.
            recheck_from(&stream(vec![], &[], 2)),
        ];
        for facts in &failures {
            assert!(facts.read_failed);
            let result = project_sync(
                id.clone(),
                &sync_legacy("succeeded"),
                facts,
                &opened,
                &paths,
                SyncRevisionProof::Head,
            );
            assert_eq!(result.outcome, WorkflowOutcome::Unknown);
            assert_eq!(result.files[0].state, WorkflowFileState::Unknown);
        }
        // A failed opened read is not evidence either, even with a clean fstat
        // read: an unread answer must not be mistaken for an empty one.
        let failed_opened = action_evidence::opened_evidence(&stream(
            vec![],
            &["Connect to server failed; check $P4PORT."],
            1,
        ));
        assert!(failed_opened.read_failed);
        let result = project_sync(
            id,
            &sync_legacy("succeeded"),
            &recheck(vec![]),
            &failed_opened,
            &paths,
            SyncRevisionProof::Head,
        );
        assert_eq!(result.outcome, WorkflowOutcome::Unknown);
        assert_eq!(result.files[0].state, WorkflowFileState::Unknown);
    }

    #[test]
    fn sync_does_not_treat_a_still_open_path_as_synced() {
        // An opened record refutes the "no record means removed" proof.
        let opened = opened_evidence(vec![serde_json::json!({
            "depotFile": "//fixture/gone",
            "action": "edit",
            "change": "41",
        })]);
        let result = project_sync(
            Some("11111111-1111-4111-8111-111111111111".into()),
            &sync_legacy("succeeded"),
            &recheck(vec![]),
            &opened,
            &["//fixture/gone".to_owned()],
            SyncRevisionProof::Head,
        );
        assert_eq!(result.outcome, WorkflowOutcome::Unknown);
        assert_eq!(result.files[0].state, WorkflowFileState::Unknown);
    }

    #[test]
    fn sync_keeps_a_stale_revision_unknown_even_when_the_file_is_not_open() {
        // "Not open" must never mask a have/head mismatch: the sync did not take
        // effect, so the stale fact - not the opened answer - decides.
        let opened = opened_evidence(vec![]);
        let result = project_sync(
            Some("11111111-1111-4111-8111-111111111111".into()),
            &sync_legacy("succeeded"),
            &recheck(vec![fact("//fixture/a", "", None, Some(6), Some(7))]),
            &opened,
            &["//fixture/a".to_owned()],
            SyncRevisionProof::Head,
        );
        assert_eq!(result.outcome, WorkflowOutcome::Unknown);
        assert_eq!(result.files[0].state, WorkflowFileState::Unknown);
    }

    #[test]
    fn undo_accepts_a_reopened_path_from_the_opened_list() {
        let opened = opened_evidence(vec![serde_json::json!({
            "depotFile": "//fixture/a",
            "action": "edit",
            "change": "41",
        })]);
        let result = project_undo(
            Some("11111111-1111-4111-8111-111111111111".into()),
            Ok(op(vec![], 0)),
            &[],
            &opened,
            "//fixture/a",
            41,
        );
        assert_eq!(result.outcome, WorkflowOutcome::Succeeded);
        assert_eq!(result.files[0].state, WorkflowFileState::Succeeded);
    }
}
