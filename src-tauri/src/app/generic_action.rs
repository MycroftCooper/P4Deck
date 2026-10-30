use crate::domain::*;
use crate::p4::files::command::{self, ActionPlan, P4FileInvocation};
pub fn migrated(action: FileAction) -> bool {
    matches!(
        action,
        FileAction::Checkout
            | FileAction::CheckoutAndOpen
            | FileAction::Add
            | FileAction::AddRecursive
            | FileAction::MarkForDelete
            | FileAction::Delete
            | FileAction::ChangeFiletype
            | FileAction::Reconcile
            | FileAction::Integrate
            | FileAction::Copy
            | FileAction::Branch
            | FileAction::Clean
            | FileAction::TagWithLabel
    )
}
pub fn plan(request: &FileActionRequest) -> Result<P4FileInvocation, String> {
    if !migrated(request.action) {
        return Err("Action requires its dedicated lifecycle".into());
    }
    match command::plan(request)? {
        ActionPlan::P4(p) => Ok(p),
        ActionPlan::DeleteLocal { .. } => Err("Local trash uses its separate I/O lifecycle".into()),
    }
}
pub fn result(
    request: &FileActionRequest,
    result: Result<OperationResult, String>,
) -> FileActionResult {
    let completed = result.as_ref().is_ok_and(crate::app::revert_action::clean);
    let message =
        if completed {
            "Command completed; requested paths are not per-file success evidence.".into()
        } else {
            result.as_ref().err().cloned().unwrap_or_else(|| {
                "Operation outcome is uncertain; do not automatically retry.".into()
            })
        };
    let mut affected_paths = request.paths.clone();
    if matches!(
        request.action,
        FileAction::Integrate | FileAction::Copy | FileAction::Branch
    ) {
        if let Some(target) = &request.target_path {
            if !affected_paths.contains(target) {
                affected_paths.push(target.clone());
            }
        }
    }
    FileActionResult {
        execution: Some(FileActionExecution {
            operation_id: request.operation_id.clone().unwrap_or_default(),
            outcome: if completed {
                "commandCompleted"
            } else {
                "unknown"
            }
            .into(),
            per_file_evidence: "notCollected".into(),
            files: None,
        }),
        operation: result.ok(),
        affected_paths,
        message,
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn request() -> FileActionRequest {
        serde_json::from_value(serde_json::json!({"operationId":"11111111-1111-4111-8111-111111111111","action":"checkout","paths":["//fixture/a"]})).unwrap()
    }
    #[test]
    fn excludes_dedicated_lifecycles_and_local_io() {
        for action in [
            FileAction::Revert,
            FileAction::RevertUnchanged,
            FileAction::MoveToChangelist,
            FileAction::Shelve,
            FileAction::Resolve,
            FileAction::Undo,
            FileAction::Lock,
            FileAction::Unlock,
            FileAction::GetLatest,
            FileAction::DeleteLocal,
            FileAction::Refresh,
        ] {
            assert!(!migrated(action));
        }
    }
    #[test]
    fn failure_preserves_request_scope_without_claiming_failed_files() {
        let r = result(&request(), Err("synthetic failure".into()));
        assert_eq!(r.affected_paths, vec!["//fixture/a"]);
        assert_eq!(r.execution.unwrap().outcome, "unknown");
        assert!(r.operation.is_none());
    }
    #[test]
    fn clean_command_is_not_per_file_success() {
        let r = result(
            &request(),
            Ok(OperationResult {
                operation_id: "id".into(),
                exit_code: 0,
                events: vec![],
                duration_ms: 1,
            }),
        );
        let e = r.execution.unwrap();
        assert_eq!(e.outcome, "commandCompleted");
        assert_eq!(e.per_file_evidence, "notCollected");
    }
    #[test]
    fn all_migrated_actions_use_real_planner() {
        let mut r = request();
        for action in [
            FileAction::Checkout,
            FileAction::CheckoutAndOpen,
            FileAction::Add,
            FileAction::AddRecursive,
            FileAction::MarkForDelete,
            FileAction::Reconcile,
            FileAction::Clean,
        ] {
            r.action = action;
            assert!(plan(&r).is_ok());
        }
        r.action = FileAction::Delete;
        r.states = Some(vec!["untracked".into()]);
        assert!(plan(&r).is_err());
    }
    #[test]
    fn two_path_and_typed_actions_preserve_target_and_legacy_results_decode() {
        let mut r = request();
        r.target_path = Some("//fixture/destination".into());
        for action in [FileAction::Integrate, FileAction::Copy, FileAction::Branch] {
            r.action = action;
            assert!(plan(&r).is_ok());
            assert_eq!(
                result(&r, Err("unknown".into())).affected_paths,
                vec!["//fixture/a", "//fixture/destination"]
            );
        }
        r.action = FileAction::ChangeFiletype;
        r.file_type = Some("text".into());
        assert!(plan(&r).is_ok());
        r.action = FileAction::TagWithLabel;
        r.label = Some("fixture-label".into());
        assert!(plan(&r).is_ok());
        let legacy: FileActionResult = serde_json::from_value(
            serde_json::json!({"operation":null,"affectedPaths":[],"message":"old"}),
        )
        .unwrap();
        assert!(legacy.execution.is_none());
    }
}
