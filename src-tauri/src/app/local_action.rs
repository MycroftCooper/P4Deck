//! One sequential local I/O batch; only acknowledged calls become succeeded.
use crate::domain::*;
use std::path::PathBuf;

/// Runs the requested local targets sequentially and reports every target.
///
/// A per-file state only comes from an actual callback outcome:
/// - `Succeeded` — the trash callback acknowledged this exact target;
/// - `Unknown` — the first failed target (its error is reported verbatim);
/// - `Blocked` — never dispatched, because of cancellation or an earlier
///   failure. Blocked is not a failure and does not prove anything about the
///   target.
///
/// This function never retries, never reorders, never sends I/O after the first
/// failure or cancellation, and never fabricates a per-file result.
/// `affected_paths` stays the requested scope even if nothing was dispatched.
pub fn run(
    id: &str,
    targets: &[(String, PathBuf)],
    mut active: impl FnMut() -> bool,
    mut trash: impl FnMut(&std::path::Path) -> Result<(), String>,
) -> FileActionResult {
    let mut stopped = false;
    let mut uncertain = false;
    let files = targets
        .iter()
        .map(|(path, target)| {
            let (state, message) = if stopped || !active() {
                stopped = true;
                (
                    WorkflowFileState::Blocked,
                    "Not dispatched after cancellation or earlier failure".to_string(),
                )
            } else {
                match trash(target) {
                    Ok(()) => (
                        WorkflowFileState::Succeeded,
                        "Moved to system trash; no automatic undo is implied".to_string(),
                    ),
                    Err(error) => {
                        stopped = true;
                        uncertain = true;
                        (WorkflowFileState::Unknown, error)
                    }
                }
            };
            WorkflowFileResult {
                depot_path: path.clone(),
                state,
                message,
                operation_id: Some(id.to_string()),
            }
        })
        .collect::<Vec<_>>();
    let any = files
        .iter()
        .any(|file| file.state == WorkflowFileState::Succeeded);
    let outcome = if uncertain {
        "unknown"
    } else if any {
        "commandCompleted"
    } else {
        "notDispatched"
    };
    FileActionResult {
        operation: None,
        affected_paths: targets.iter().map(|(path, _)| path.clone()).collect(),
        message: if uncertain {
            "Local I/O outcome uncertain; no automatic retry".to_string()
        } else if any {
            "Local batch finished; inspect per-file acknowledgements".to_string()
        } else {
            "Local batch was not dispatched".to_string()
        },
        execution: Some(FileActionExecution {
            operation_id: id.to_string(),
            outcome: outcome.to_string(),
            per_file_evidence: "localIoAcknowledgements".to_string(),
            files: Some(files),
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn targets() -> Vec<(String, PathBuf)> {
        (0..3)
            .map(|index| {
                (
                    format!("synthetic-{index}"),
                    PathBuf::from(format!("synthetic-{index}")),
                )
            })
            .collect()
    }

    fn execution(result: &FileActionResult) -> &FileActionExecution {
        result
            .execution
            .as_ref()
            .expect("local I/O always reports execution")
    }

    #[test]
    fn successes_are_only_actual_acknowledgements() {
        let mut calls = 0;
        let result = run(
            "id",
            &targets(),
            || true,
            |_| {
                calls += 1;
                Ok(())
            },
        );
        assert_eq!(calls, 3);
        let execution = execution(&result);
        assert_eq!(execution.outcome, "commandCompleted");
        assert_eq!(execution.per_file_evidence, "localIoAcknowledgements");
        let files = execution.files.as_ref().unwrap();
        assert_eq!(files.len(), 3);
        assert!(files
            .iter()
            .all(|file| file.state == WorkflowFileState::Succeeded));
        assert_eq!(result.affected_paths.len(), 3);
    }

    #[test]
    fn partial_failure_never_retries_or_claims_remaining_files_failed() {
        let mut calls = 0;
        let result = run(
            "id",
            &targets(),
            || true,
            |_| {
                calls += 1;
                if calls == 2 {
                    Err("synthetic error".to_string())
                } else {
                    Ok(())
                }
            },
        );
        assert_eq!(calls, 2, "no retry and no I/O after the failing target");
        let execution = execution(&result);
        assert_eq!(execution.outcome, "unknown");
        let states = execution
            .files
            .as_ref()
            .unwrap()
            .iter()
            .map(|file| file.state)
            .collect::<Vec<_>>();
        assert_eq!(
            states,
            vec![
                WorkflowFileState::Succeeded,
                WorkflowFileState::Unknown,
                WorkflowFileState::Blocked
            ]
        );
        assert_eq!(
            result.affected_paths,
            vec!["synthetic-0", "synthetic-1", "synthetic-2"]
        );
    }

    #[test]
    fn cancelled_before_io_dispatches_zero_calls() {
        let result = run("id", &targets(), || false, |_| panic!("unexpected I/O"));
        let execution = execution(&result);
        assert_eq!(execution.outcome, "notDispatched");
        assert!(execution
            .files
            .as_ref()
            .unwrap()
            .iter()
            .all(|file| file.state == WorkflowFileState::Blocked));
        assert_eq!(execution.files.as_ref().unwrap().len(), 3);
    }

    #[test]
    fn cancellation_between_files_preserves_prior_acknowledgement() {
        let mut checks = 0;
        let mut calls = 0;
        let result = run(
            "id",
            &targets(),
            || {
                checks += 1;
                checks == 1
            },
            |_| {
                calls += 1;
                Ok(())
            },
        );
        assert_eq!(calls, 1);
        let execution = execution(&result);
        assert_eq!(execution.outcome, "commandCompleted");
        assert_eq!(
            execution.files.as_ref().unwrap()[1].state,
            WorkflowFileState::Blocked
        );
    }

    #[test]
    fn empty_request_is_not_dispatched_without_io() {
        let result = run(
            "id",
            &[],
            || panic!("unexpected cancellation check"),
            |_| panic!("unexpected I/O"),
        );
        let execution = execution(&result);
        assert_eq!(execution.outcome, "notDispatched");
        assert!(execution.files.as_ref().unwrap().is_empty());
        assert!(result.affected_paths.is_empty());
    }
}
