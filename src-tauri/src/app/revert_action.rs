#[path = "revert_retention.rs"]
pub(crate) mod retention;
// Revert shares durable receipts/admission; this module only plans and interprets facts.
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
    result.exit_code == 0
        && !result.events.iter().any(|e| {
            matches!(
                e.kind,
                EventKind::Error | EventKind::Warning | EventKind::Cancelled | EventKind::Stderr
            ) || e
                .message
                .as_deref()
                .and_then(|s| serde_json::from_str::<serde_json::Value>(s).ok())
                .is_some_and(|v| {
                    v["code"] == "error"
                        || v["severity"]
                            .as_i64()
                            .or_else(|| v["severity"].as_str().and_then(|s| s.parse().ok()))
                            .unwrap_or(0)
                            >= 2
                })
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
    result_with_retention(request, write, observed, None)
}
pub fn result_with_retention(
    request: &FileActionRequest,
    write: Result<OperationResult, String>,
    observed: Result<OperationResult, String>,
    retention: Option<(&retention::Observation, &retention::Observation)>,
) -> WorkflowResult {
    let id = request.operation_id.clone().unwrap_or_default();
    let write_ok = write.as_ref().is_ok_and(clean);
    let facts = observed
        .as_ref()
        .ok()
        .filter(|r| clean(r))
        .map(|r| parser::file_facts(&r.events))
        .unwrap_or_default();
    let files=request.paths.iter().map(|path| {
        let matching=facts.iter().filter(|f|f.depot_path==*path).collect::<Vec<_>>();
        let state=if write_ok && matching.len()==1 && matching[0].action.is_empty() && matching[0].change_id.is_none() {WorkflowFileState::Succeeded} else if write_ok && request.action==FileAction::RevertUnchanged && matching.len()==1 && retention.is_some_and(|(before,after)|after.facts.iter().any(|f|f==matching[0]) && before.proves_retained(after,path,request.changelist_id)) {WorkflowFileState::Retained} else {WorkflowFileState::Unknown};
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
                    timestamp: String::new(),
                })
                .collect(),
        }
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
        assert_eq!(
            result(
                &request(1),
                Ok(op(vec![serde_json::json!({"code":"error","severity":2})])),
                Ok(op(vec![serde_json::json!({"depotFile":"//fixture/f0"})]))
            )
            .outcome,
            WorkflowOutcome::Unknown
        );
    }
}
