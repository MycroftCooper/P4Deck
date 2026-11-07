//! S4H: unified durable lifecycle for the external custom-submit tool.
//!
//! Optimistic policy (user boundary): an external company tool submit is
//! unpredictable/irreversible, so FE optimistic projection may only show
//! **intent/progress** (tool starting / running / occupied). It MUST NOT show
//! "submitted successfully" or a new CL number. The host can only observe:
//! - `Started`: parent process still running -> running (intent only);
//! - `NotStarted`: positive evidence no process was created -> rejected;
//! - `OutcomeUnknown`: parent exited / poll failed -> unknown. Exit code is
//!   command-level only; it never proves the submission succeeded.
//!
//! Authoritative submission result / new CL number must come from a later
//! submitted-CL readback (`query_changelists` etc.) or explicit tool output,
//! which is outside this slice. The client must never synthesize a CL number.
//!
//! Identity: `StartRequest.request_id` doubles as the durable operation id (the
//! legacy path already required it); no second id is introduced. Safety boundary
//! is unchanged: configured executable path, inherited env, no shell, no env
//! rewrite, stdio null, no P4 cancellation job attachment, no kill-on-drop.
use crate::app::custom_submit::{Session, State};
use crate::domain::*;
use serde::{Deserialize, Serialize};

pub const KIND_CUSTOM_SUBMIT: &str = "customSubmit";
pub const OPTIMISTIC_POLICY: &str = "intentOnly";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomSubmitToolFacts {
    pub request_id: String,
    pub change_id: String,
    pub executable_path: String,
    /// started | notStarted | outcomeUnknown
    pub tool_state: String,
    pub parent_running: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomSubmitActionResult {
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub operation_id: Option<String>,
    /// intent | running | rejected | unknown | legacy
    pub state: String,
    pub outcome: WorkflowOutcome,
    pub tool: CustomSubmitToolFacts,
    pub optimistic: String,
    pub message: String,
    pub legacy: serde_json::Value,
}

fn tool_state_name(state: State) -> &'static str {
    match state {
        State::Started => "started",
        State::NotStarted => "notStarted",
        State::OutcomeUnknown => "outcomeUnknown",
    }
}

/// Authoritative projection of the host's own tool observation.
///
/// `Started` is never success: only the parent process is alive. `OutcomeUnknown`
/// is explicitly unknown (exit code is command-level only). `NotStarted` is the
/// only rejected-by-host state (positive evidence that no process was created).
pub fn project(session: &Session, operation_id: Option<String>) -> CustomSubmitActionResult {
    let tool = CustomSubmitToolFacts {
        request_id: session.request_id.clone(),
        change_id: session.change_id.clone(),
        executable_path: session.executable_path.clone(),
        tool_state: tool_state_name(session.state).into(),
        parent_running: session.state == State::Started,
        exit_code: session.exit_code,
        reason: session.reason.clone(),
    };
    let (state, outcome, message) = match session.state {
        State::Started => (
            "running",
            WorkflowOutcome::Unknown,
            "Custom submit tool started; submission outcome is unknown and must be confirmed by later submitted-CL readback. Intent/progress only.",
        ),
        State::NotStarted => (
            "rejected",
            WorkflowOutcome::Rejected,
            "Custom submit tool was not started (positive evidence: no process created); nothing was submitted.",
        ),
        State::OutcomeUnknown => (
            "unknown",
            WorkflowOutcome::Unknown,
            "Custom submit parent process ended or could not be observed; submission outcome and any new CL are unknown. Never retry with a new id.",
        ),
    };
    CustomSubmitActionResult {
        kind: KIND_CUSTOM_SUBMIT.into(),
        operation_id: operation_id.or_else(|| Some(session.request_id.clone())),
        state: state.into(),
        outcome,
        tool,
        optimistic: OPTIMISTIC_POLICY.into(),
        message: message.into(),
        legacy: serde_json::to_value(session).unwrap_or(serde_json::Value::Null),
    }
}

/// Failure shape persisted when the launch path errors before a session exists
/// (unknown, never "not applied").
pub fn failed_result(
    operation_id: &str,
    request_change_id: &str,
    error: &str,
) -> CustomSubmitActionResult {
    CustomSubmitActionResult {
        kind: KIND_CUSTOM_SUBMIT.into(),
        operation_id: Some(operation_id.into()),
        state: "unknown".into(),
        outcome: WorkflowOutcome::Unknown,
        tool: CustomSubmitToolFacts {
            request_id: operation_id.into(),
            change_id: request_change_id.into(),
            executable_path: String::new(),
            tool_state: "launchFailed".into(),
            parent_running: false,
            exit_code: None,
            reason: Some(error.to_owned()),
        },
        optimistic: OPTIMISTIC_POLICY.into(),
        message: format!("Custom submit launch failed before a tool session existed: {error}"),
        legacy: serde_json::Value::Null,
    }
}

/// Terminal states may settle the durable receipt; `Started` stays running.
pub fn is_terminal(session: &Session) -> bool {
    session.state != State::Started
}

/// Persist the terminal projection so a finished tool never leaves the durable
/// receipt in `running`.
///
/// Called by the parent-exit watcher the moment it observes the tool exit, and
/// idempotently again by the `custom_submit_status` command: the receipt store
/// only accepts a `running` row, so the second settle is a harmless no-op and
/// the first one wins the durable result.
pub fn settle(
    journal: &crate::persistence::operation_journal::OperationJournal,
    session: &Session,
) -> bool {
    if !is_terminal(session) {
        return false;
    }
    let Ok(value) = serde_json::to_value(project(session, Some(session.request_id.clone()))) else {
        return false;
    };
    journal.finish_action(&session.request_id, &value).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session(state: State, exit_code: Option<i32>, reason: Option<&str>) -> Session {
        Session {
            request_id: "11111111-1111-4111-8111-111111111111".into(),
            change_id: "41".into(),
            state,
            executable_path: "C:/fixture/company-tool.exe".into(),
            exit_code,
            reason: reason.map(|r| r.to_owned()),
        }
    }

    #[test]
    fn started_is_intent_only_and_never_success() {
        let result = project(&session(State::Started, None, None), None);
        assert_eq!(result.state, "running");
        assert_eq!(result.outcome, WorkflowOutcome::Unknown);
        assert_eq!(result.optimistic, "intentOnly");
        assert!(result.tool.parent_running);
        assert_eq!(
            result.operation_id.as_deref(),
            Some("11111111-1111-4111-8111-111111111111")
        );
    }

    #[test]
    fn not_started_is_rejected_without_submission() {
        let result = project(&session(State::NotStarted, None, Some("toolMissing")), None);
        assert_eq!(result.state, "rejected");
        assert_eq!(result.outcome, WorkflowOutcome::Rejected);
        assert!(!result.tool.parent_running);
        assert_eq!(result.tool.reason.as_deref(), Some("toolMissing"));
    }

    #[test]
    fn exit_code_alone_is_unknown_not_submission_success() {
        let result = project(
            &session(
                State::OutcomeUnknown,
                Some(0),
                Some("submissionAndChildLifetimeUnknown"),
            ),
            Some("11111111-1111-4111-8111-111111111111".to_owned()),
        );
        assert_eq!(result.state, "unknown");
        assert_eq!(result.outcome, WorkflowOutcome::Unknown);
        assert_eq!(result.tool.exit_code, Some(0));
        assert!(!result.tool.parent_running);
    }

    #[test]
    fn failure_shape_and_terminal_helpers() {
        let failed = failed_result("11111111-1111-4111-8111-111111111111", "41", "launchFailed");
        assert_eq!(failed.state, "unknown");
        assert_eq!(failed.outcome, WorkflowOutcome::Unknown);
        assert!(!is_terminal(&session(State::Started, None, None)));
        assert!(is_terminal(&session(State::NotStarted, None, None)));
        assert!(is_terminal(&session(State::OutcomeUnknown, None, None)));
    }

    #[test]
    fn terminal_session_settles_its_receipt_once() {
        let base = std::env::temp_dir().join(format!(
            "p4deck-custom-submit-settle-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&base).unwrap();
        let journal = crate::persistence::operation_journal::OperationJournal::open(
            &base.join("operations.sqlite"),
        )
        .unwrap();
        // Production reserves the receipt before launching the tool; settle only
        // completes an existing `running` row.
        journal
            .reserve_action(
                KIND_CUSTOM_SUBMIT,
                "11111111-1111-4111-8111-111111111111",
                &crate::app::company_submit::ConnectionSnapshot {
                    profile_id: "profile".into(),
                    generation: "1".into(),
                    server: "ssl:fixture:1666".into(),
                    user: "user".into(),
                    client: "client".into(),
                },
                &serde_json::json!({ "changeId": "41" }),
            )
            .unwrap();
        // A live tool leaves the durable receipt in `running`.
        assert!(!settle(&journal, &session(State::Started, None, None)));
        let ended = session(
            State::OutcomeUnknown,
            Some(0),
            Some("submissionAndChildLifetimeUnknown"),
        );
        assert!(settle(&journal, &ended));
        // The receipt store only accepts a `running` row, so a second observer
        // (status polling or a duplicate exit notification) is a no-op.
        assert!(!settle(&journal, &ended));
        drop(journal);
        std::fs::remove_dir_all(base).unwrap();
    }
}
