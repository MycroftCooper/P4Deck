#[path = "revert_retention.rs"]
pub(crate) mod retention;
// Revert shares durable receipts/admission; this module only plans and interprets facts.
use crate::app::action_evidence::{is_error_diagnostic, opened_evidence, proves_unopened};
use crate::domain::*;
use crate::p4::{
    files::command::{self, ActionPlan, P4FileInvocation},
    workflows::parser,
};

pub fn plan(request: &FileActionRequest) -> Result<P4FileInvocation, String> {
    if !matches!(
        request.action,
        FileAction::Revert | FileAction::RevertUnchanged
    ) {
        return Err("Expected revert action".into());
    }
    crate::p4::workflows::command::validate_exact_paths(&request.paths)?;
    match command::plan(request)? {
        ActionPlan::P4(p) => Ok(p),
        _ => Err("Expected P4 revert".into()),
    }
}
pub(crate) fn clean(result: &OperationResult) -> bool {
    // P4 `-ztag -Mj` reports benign no-op diagnostics at severity 2 (measured:
    // `no such file(s)` is `{"code0":…,"generic":17,"severity":2,
    // "severityformat":"warning"}` on stdout): `file(s) not opened in that
    // changelist`, `no such file(s)`, `file(s) not in client view`. A
    // whole-changelist revert (`p4 revert -c <CL> //...`) always emits the former
    // for every workspace file outside that CL, and a repeat revert of an
    // already-empty CL emits it too; neither is a failure. Real records carry no
    // `code` key, so `is_error_diagnostic` decides from the real fields -
    // `severityformat == "error"` together with `severity >= 3` - and keeps the
    // synthetic `code:"error"` branch for older fixtures only.
    result.exit_code == 0
        && !result.events.iter().any(|e| {
            matches!(
                e.kind,
                EventKind::Error | EventKind::Warning | EventKind::Cancelled | EventKind::Stderr
            ) || e
                .message
                .as_deref()
                .and_then(|s| serde_json::from_str::<serde_json::Value>(s).ok())
                .is_some_and(|v| is_error_diagnostic(&v))
        })
}
/// Test-only convenience wrapper: production callers pass retention evidence explicitly so
/// they cannot silently drop it; tests exercise the plain path.
#[cfg(test)]
pub fn result(
    request: &FileActionRequest,
    write: Result<OperationResult, String>,
    observed: Result<OperationResult, String>,
) -> WorkflowResult {
    result_with_retention(request, write, observed, None, None)
}
pub fn result_with_retention(
    request: &FileActionRequest,
    write: Result<OperationResult, String>,
    observed: Result<OperationResult, String>,
    retention: Option<(&retention::Observation, &retention::Observation)>,
    opened: Option<&OperationResult>,
) -> WorkflowResult {
    let id = request.operation_id.clone().unwrap_or_default();
    let write_ok = write.as_ref().is_ok_and(clean);
    let facts = observed
        .as_ref()
        .ok()
        .filter(|r| clean(r))
        .map(|r| parser::file_facts(&r.events))
        .unwrap_or_default();
    // A plain `p4 fstat` cannot see a file that was added locally and then
    // reverted (the depot has no record yet), so absence from the facts is not
    // enough. A real `p4 opened <path>` answers such an unopened path with empty
    // output and exit 0; that successful empty answer is the proof that the path
    // is no longer open. It is only usable when the fstat read itself was
    // trustworthy and had no record for the path: an fstat fact with an action
    // still means the path is open, and must stay Unknown.
    let evidence = opened.map(opened_evidence).unwrap_or_default();
    let files=request.paths.iter().map(|path| {
        let matching=facts.iter().filter(|f|f.depot_path==*path).collect::<Vec<_>>();
        let unopened_fact = matching.len()==1 && matching[0].action.is_empty() && matching[0].change_id.is_none();
        let state = if write_ok && (unopened_fact || (matching.is_empty() && proves_unopened(&evidence, &request.paths, path))) {
            WorkflowFileState::Succeeded
        } else if write_ok && request.action==FileAction::RevertUnchanged && (
            (matching.len()==1 && retention.is_some_and(|(before,after)|after.facts.iter().any(|f|f==matching[0]) && before.proves_retained(after,path,request.changelist_id)))
            || (!evidence.read_failed && evidence.opened.iter().any(|f| f.depot_path == *path)
                && (matching.is_empty()
                    || (matching.len()==1 && matching[0].action.contains("add"))))
        ) {
            // `revert -a` deliberately leaves added files open: nothing was
            // reverted, but that is a known retained state, not an unknown write.
            WorkflowFileState::Retained
        } else {
            WorkflowFileState::Unknown
        };
        WorkflowFileResult{depot_path:path.clone(),state,message:if state==WorkflowFileState::Succeeded {"Command completed and file is currently unopened; discarded content is not recoverable by this action."} else if state==WorkflowFileState::Retained {"Modified file retained by revert -a; content was not restored."} else {"Per-file effect is unconfirmed; no automatic retry."}.into(),operation_id:Some(id.clone())}
    }).collect::<Vec<_>>();
    let successes = files
        .iter()
        .filter(|f| {
            matches!(
                f.state,
                WorkflowFileState::Succeeded | WorkflowFileState::Retained
            )
        })
        .count();
    let outcome = if successes == files.len() {
        WorkflowOutcome::Succeeded
    } else if successes > 0 {
        WorkflowOutcome::Partial
    } else {
        WorkflowOutcome::Unknown
    };
    WorkflowResult{execution:None,outcome,failure:if successes==files.len(){None}else{Some(WorkflowFailureCode::UncertainOutcome)},message:"Revert outcome is based on bounded post-state evidence.".into(),files,operation_ids:if request.action==FileAction::RevertUnchanged {vec![format!("{id}:before:facts"),format!("{id}:before:changed"),id.clone(),format!("{id}:after:facts"),format!("{id}:after:changed")]}else{vec![id.clone(),format!("{id}:reconcile")]},log_reference:Some(id),refresh:WorkflowRefreshAdvice{pending_changes:false,workspace_status:false,depot_paths:request.paths.clone(),reason:"Apply returned per-file facts; unknown paths require explicit investigation, not write retry.".into()}}
}

#[cfg(test)]
mod tests {
    use super::*;
    fn request(n: usize) -> FileActionRequest {
        serde_json::from_value(serde_json::json!({"operationId":"11111111-1111-4111-8111-111111111111","action":"revert","paths":(0..n).map(|i|format!("//fixture/f{i}")).collect::<Vec<_>>(),"changelistId":41,"revertWholeChangelist":true})).unwrap()
    }
    fn op(values: Vec<serde_json::Value>) -> OperationResult {
        OperationResult {
            operation_id: "fixture".into(),
            exit_code: 0,
            duration_ms: 1,
            events: values
                .into_iter()
                .map(|v| OperationEvent {
                    operation_id: "fixture".into(),
                    kind: EventKind::Stdout,
                    message: Some(v.to_string()),
                    progress: None,
                    progress_current: None,
                    progress_total: None,
                    timestamp: String::new(),
                })
                .collect(),
        }
    }
    /// One real `p4 -ztag -Mj` diagnostic record: single-line JSON on stdout
    /// with `severity`/`severityformat` and **no `code` key**. Measured: benign
    /// no-ops are `severity: 2` with `severityformat:"warning"`
    /// (`no such file(s)`), real failures are `severity: 3` with
    /// `severityformat:"error"`.
    fn diagnostic(message: &str, severity: i64) -> serde_json::Value {
        serde_json::json!({
            "code0": 554768759,
            "data": format!("{message}\n"),
            "fmt0": "%msg%",
            "generic": 17,
            "severity": severity,
            "severityformat": if severity >= 3 { "error" } else { "warning" },
        })
    }

    /// A run whose failure signal is below stdout: connection failures and
    /// runner errors are the only events that are not `-Mj` JSON.
    fn failed_op(stderr: &[&str], exit_code: i32) -> OperationResult {
        let mut result = op(vec![]);
        result.exit_code = exit_code;
        result.events = stderr
            .iter()
            .map(|line| OperationEvent {
                operation_id: "fixture".into(),
                kind: EventKind::Stderr,
                message: Some((*line).to_owned()),
                progress: None,
                progress_current: None,
                progress_total: None,
                timestamp: String::new(),
            })
            .collect();
        result
    }
    #[test]
    fn exact_batch_plan_preserves_all_paths_and_never_expands_to_workspace() {
        // Exact-path revert (not whole-changelist): every requested path must be
        // carried verbatim by the real invocation channel - inline argv when small,
        // or the `-x` arguments-file payload when the path set is streamed - and
        // must never be expanded to a workspace wildcard.
        for n in [1, 128, 129, 1000] {
            let mut r = request(n);
            r.revert_whole_changelist = false;
            let p = plan(&r).unwrap();
            assert_eq!(p.command, "revert");
            let (carried, channel) = match &p.argument_input {
                Some(input) => (input.clone(), "arguments-file"),
                None => (p.args.clone(), "inline-argv"),
            };
            assert_eq!(
                carried, r.paths,
                "migrated -x contract must preserve exact paths on the {channel} channel"
            );
            assert!(
                !carried
                    .iter()
                    .any(|path| path == "//..." || path.ends_with("/...")),
                "exact-path plan must not expand to a wildcard"
            );
        }
        // Whole-changelist revert is an explicit `revert -c <CL>` plan; the migrated
        // contract uses the deliberate `//...` sentinel scoped by `-c <CL>`, which is
        // P4 whole-changelist semantics and not an accidental workspace wildcard.
        let r = request(1);
        let p = plan(&r).unwrap();
        assert_eq!(p.command, "revert");
        assert_eq!(&p.args[..2], &["-c", "41"]);
        assert_eq!(p.args.last().map(String::as_str), Some("//..."));
        // Wildcard input stays rejected regardless of plan shape.
        let mut wildcard = request(1);
        wildcard.paths[0] = "//fixture/...".into();
        assert!(plan(&wildcard).is_err());
    }
    #[test]
    fn clean_exit_without_per_file_facts_is_not_success() {
        let r = result(&request(2), Ok(op(vec![])), Ok(op(vec![])));
        assert_eq!(r.outcome, WorkflowOutcome::Unknown);
        assert!(r
            .files
            .iter()
            .all(|f| f.state == WorkflowFileState::Unknown));
    }
    #[test]
    fn only_exact_unopened_facts_project_success() {
        let r = result(
            &request(2),
            Ok(op(vec![])),
            Ok(op(vec![
                serde_json::json!({"depotFile":"//fixture/f0"}),
                serde_json::json!({"depotFile":"//fixture/unselected"}),
            ])),
        );
        assert_eq!(r.outcome, WorkflowOutcome::Partial);
        assert_eq!(r.files[0].state, WorkflowFileState::Succeeded);
        assert_eq!(r.files[1].state, WorkflowFileState::Unknown);
    }
    #[test]
    fn failed_write_or_read_and_still_open_files_remain_unknown() {
        let fact = serde_json::json!({"depotFile":"//fixture/f0"});
        assert_eq!(
            result(&request(1), Err("timeout".into()), Ok(op(vec![fact]))).outcome,
            WorkflowOutcome::Unknown
        );
        assert_eq!(
            result(&request(1), Ok(op(vec![])), Err("denied".into())).outcome,
            WorkflowOutcome::Unknown
        );
        assert_eq!(
            result(
                &request(1),
                Ok(op(vec![])),
                Ok(op(vec![
                    serde_json::json!({"depotFile":"//fixture/f0","action":"edit","change":"41"})
                ]))
            )
            .outcome,
            WorkflowOutcome::Unknown
        );
    }
    #[test]
    fn duplicate_or_warning_evidence_cannot_become_success() {
        let f = serde_json::json!({"depotFile":"//fixture/f0"});
        assert_eq!(
            result(&request(1), Ok(op(vec![])), Ok(op(vec![f.clone(), f]))).outcome,
            WorkflowOutcome::Unknown
        );
        // A real severity-3 diagnostic (no `code` key) is a real error.
        assert_eq!(
            result(
                &request(1),
                Ok(op(vec![diagnostic("Access for user 'fixture' denied.", 3)])),
                Ok(op(vec![serde_json::json!({"depotFile":"//fixture/f0"})]))
            )
            .outcome,
            WorkflowOutcome::Unknown
        );
    }
    #[test]
    fn benign_noop_warning_does_not_fail_a_whole_changelist_revert() {
        // `p4 revert -c <CL> //...` emits `file(s) not opened in that changelist`
        // (generic 17, severity 2, severityformat warning) for every workspace
        // file outside that CL, and a repeat revert of an already-empty CL emits
        // it too. That warning must not turn an otherwise-clean revert into an
        // unknown/blocked outcome.
        let warning = diagnostic("//... - file(s) not opened in that changelist.", 2);
        let r = result(
            &request(1),
            Ok(op(vec![warning])),
            Ok(op(vec![serde_json::json!({"depotFile": "//fixture/f0"})])),
        );
        assert_eq!(r.outcome, WorkflowOutcome::Succeeded);
        assert_eq!(r.files[0].state, WorkflowFileState::Succeeded);
        assert!(r.failure.is_none());
    }
    #[test]
    fn severity_three_error_still_fails_revert() {
        let error = diagnostic("Access for user 'fixture' denied.", 3);
        let r = result(
            &request(1),
            Ok(op(vec![error])),
            Ok(op(vec![serde_json::json!({"depotFile": "//fixture/f0"})])),
        );
        assert_eq!(r.outcome, WorkflowOutcome::Unknown);
        assert_eq!(r.files[0].state, WorkflowFileState::Unknown);
    }
    #[test]
    fn real_benign_diagnostic_is_clean_and_a_real_error_is_not() {
        // Real `-ztag -Mj` records have no `code` key: severity 2 with
        // `severityformat:"warning"` is a benign no-op, severity 3 with
        // `severityformat:"error"` is a real failure.
        assert!(clean(&op(vec![diagnostic(
            "//fixture/f0 - no such file(s).",
            2
        )])));
        assert!(!clean(&op(vec![diagnostic(
            "Access for user 'fixture' denied.",
            3
        )])));
        // Synthetic fixtures keep the explicit `code:"error"` compatibility branch.
        assert!(!clean(&op(vec![serde_json::json!({
            "code": "error",
            "severity": 2,
        })])));
        // A severity-only record without `severityformat` (older fixture shape)
        // is still a real error.
        assert!(!clean(&op(vec![serde_json::json!({
            "severity": 3,
            "data": "denied",
        })])));
        // A non-zero exit is never clean, even with only benign diagnostics.
        let mut benign_but_nonzero = op(vec![diagnostic("//fixture/f0 - no such file(s).", 2)]);
        benign_but_nonzero.exit_code = 1;
        assert!(!clean(&benign_but_nonzero));
    }
    #[test]
    fn reverted_local_add_is_unopened_and_not_uncertain() {
        // A locally added file never appears in fstat after revert, so the old
        // verification called it unknown and the UI blocked the next write.
        // Measured: `p4 opened <path>` answers an unopened path with empty output
        // and exit 0, so that successful empty answer is the proof.
        let mut r = request(1);
        r.revert_whole_changelist = false;
        let opened = op(vec![]);
        let result = result_with_retention(&r, Ok(op(vec![])), Ok(op(vec![])), None, Some(&opened));
        assert_eq!(result.outcome, WorkflowOutcome::Succeeded);
        assert_eq!(result.files[0].state, WorkflowFileState::Succeeded);
        assert!(result.failure.is_none());
    }
    #[test]
    fn failed_opened_read_keeps_a_reverted_local_add_unknown() {
        // An unread answer must not be mistaken for an empty one: a connection
        // failure on stderr proves nothing, so the per-file effect stays Unknown.
        let mut r = request(1);
        r.revert_whole_changelist = false;
        let opened = failed_op(&["Connect to server failed; check $P4PORT."], 1);
        let result = result_with_retention(&r, Ok(op(vec![])), Ok(op(vec![])), None, Some(&opened));
        assert_eq!(result.outcome, WorkflowOutcome::Unknown);
        assert_eq!(result.files[0].state, WorkflowFileState::Unknown);
    }
    #[test]
    fn severity_three_opened_diagnostic_is_not_evidence() {
        // Real auth failure: a severity-3 stdout record, no `code` key. The
        // revert write is clean, but the read that should prove the path is
        // unopened failed, so it stays Unknown instead of claiming success.
        let mut r = request(1);
        r.revert_whole_changelist = false;
        let opened = op(vec![diagnostic("Access for user 'fixture' denied.", 3)]);
        let result = result_with_retention(&r, Ok(op(vec![])), Ok(op(vec![])), None, Some(&opened));
        assert_eq!(result.outcome, WorkflowOutcome::Unknown);
        assert_eq!(result.files[0].state, WorkflowFileState::Unknown);
    }
    #[test]
    fn an_fstat_fact_that_is_still_open_is_not_masked_by_an_empty_opened_answer() {
        // The empty opened answer only speaks for paths fstat has no record of;
        // a fact that still shows an open action must stay Unknown.
        let mut r = request(1);
        r.revert_whole_changelist = false;
        let observed = op(vec![serde_json::json!({
            "depotFile": "//fixture/f0",
            "action": "edit",
            "change": "41",
        })]);
        let opened = op(vec![]);
        let result = result_with_retention(&r, Ok(op(vec![])), Ok(observed), None, Some(&opened));
        assert_eq!(result.outcome, WorkflowOutcome::Unknown);
        assert_eq!(result.files[0].state, WorkflowFileState::Unknown);
    }
    #[test]
    fn revert_unchanged_keeps_a_local_add_open_as_retained() {
        let mut r = request(1);
        r.action = FileAction::RevertUnchanged;
        r.revert_whole_changelist = false;
        let opened = op(vec![serde_json::json!({
            "depotFile": "//fixture/f0",
            "action": "add",
            "change": "default",
        })]);
        let result = result_with_retention(&r, Ok(op(vec![])), Ok(op(vec![])), None, Some(&opened));
        assert_eq!(result.outcome, WorkflowOutcome::Succeeded);
        assert_eq!(result.files[0].state, WorkflowFileState::Retained);
        assert!(result.failure.is_none());
    }
    #[test]
    fn revert_unchanged_keeps_a_reported_add_fact_as_retained() {
        // Real `revert -a` runs report the still-open added file in fstat too;
        // that fact (action=add) must be retained knowledge, not uncertainty.
        let mut r = request(1);
        r.action = FileAction::RevertUnchanged;
        r.revert_whole_changelist = false;
        let opened = op(vec![serde_json::json!({
            "depotFile": "//fixture/f0",
            "action": "add",
            "change": "default",
        })]);
        let observed = op(vec![serde_json::json!({
            "depotFile": "//fixture/f0",
            "clientFile": "F:/Fixture/f0",
            "action": "add",
            "change": "default",
        })]);
        let result = result_with_retention(&r, Ok(op(vec![])), Ok(observed), None, Some(&opened));
        assert_eq!(result.outcome, WorkflowOutcome::Succeeded);
        assert_eq!(result.files[0].state, WorkflowFileState::Retained);
        assert!(result.failure.is_none());
    }
    #[test]
    fn plain_revert_of_a_still_open_path_stays_unknown() {
        let mut r = request(1);
        r.revert_whole_changelist = false;
        let opened = op(vec![serde_json::json!({
            "depotFile": "//fixture/f0",
            "action": "edit",
            "change": "41",
        })]);
        let result = result_with_retention(&r, Ok(op(vec![])), Ok(op(vec![])), None, Some(&opened));
        assert_eq!(result.outcome, WorkflowOutcome::Unknown);
        assert_eq!(result.files[0].state, WorkflowFileState::Unknown);
    }
}
