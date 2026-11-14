//! Post-write opened-state evidence shared by file-mutating actions.
//!
//! A `p4 fstat` post-check cannot see a path whose depot record is absent
//! (locally added files, or files a revert/sync just removed): the path is
//! reported as a benign `no such file(s)` diagnostic or omitted. The `p4 opened`
//! answer closes that evidence gap, but not through a "not opened" message: a
//! real `p4 opened <path>` answers a path that is not open with **empty output
//! and exit 0** (measured on P4/NTX64 2026.1), and only a path that is still
//! open appears as a record. Absence from a *successful* answer is therefore the
//! proof; a record means the path is still open. The explicit
//! `file(s) not opened on this client.` text is kept only as compatibility
//! evidence for p4 forms that do print it.
//!
//! ## Reading diagnostics
//!
//! Every `p4` call in this app runs with the global `-ztag -Mj` options: file
//! records and diagnostics are single-line JSON on **stdout**, and stderr stays
//! empty except for connection failures (unreachable server, SSL). A real benign
//! diagnostic looks like
//!
//! ```json
//! {"code0":554768759,"data":"//depot/x - no such file(s).\n","fmt0":"[%argc% - no|No] such file(s).","generic":17,"severity":2,"severityformat":"warning"}
//! ```
//!
//! with **no `code` key**; benign no-ops are `severity: 2` (formatted as
//! `"warning"`), real failures are `severity >= 3` (formatted as `"error"`).
//! Reads are judged by explicit failure signals - a stderr/runner event, a
//! `severity >= 3` record, or a fatal (`>= 2`) exit status - never by
//! `exit_code != 0` alone and never by empty output: p4 answers "nothing there"
//! with exit 0 and no output, while a benign diagnostic may still exit 1 on
//! versions that report the query status differently. A broken read must not be
//! reported as a failed write, and a missing answer must not be reported as an
//! empty one.
use crate::domain::{EventKind, OperationResult};
use crate::p4::workflows::parser;
use std::collections::BTreeSet;

pub struct OpenedEvidence {
    /// Open records the query returned (with action/change), exact depot paths.
    pub opened: Vec<parser::WorkflowFileFact>,
    /// Exact paths the server explicitly reports as not opened. Compatibility
    /// only: a real `p4 opened <path>` answers nothing at all for such a path.
    pub not_opened: BTreeSet<String>,
    /// True when the query itself is not trustworthy (connection/runner failure,
    /// `severity >= 3` diagnostic, or a fatal exit status). Empty output is a
    /// valid, successful answer and must not be mistaken for a failed read.
    pub read_failed: bool,
}

impl Default for OpenedEvidence {
    /// "No query happened" is not a trustworthy query: a value that was never
    /// read from the server proves nothing about any path.
    fn default() -> Self {
        Self {
            opened: Vec::new(),
            not_opened: BTreeSet::new(),
            read_failed: true,
        }
    }
}

fn diagnostic_severity(value: &serde_json::Value) -> Option<i64> {
    value.get("severity").and_then(|severity| {
        severity
            .as_i64()
            .or_else(|| severity.as_str().and_then(|text| text.parse().ok()))
    })
}

/// True for a real error diagnostic: a `severity >= 3` record (formatted as
/// `"error"` by p4; older synthetic fixtures omit `severityformat`, so its
/// absence is not a reason to ignore the severity) or the explicit
/// `code:"error"` that only synthetic fixtures carry. Benign no-ops are
/// `severity: 2` even when they are formatted as `"warning"`, so the severity
/// number is the discriminator and `severityformat` alone never is.
pub fn is_error_diagnostic(value: &serde_json::Value) -> bool {
    value.get("code").and_then(serde_json::Value::as_str) == Some("error")
        || diagnostic_severity(value).is_some_and(|severity| {
            severity >= 3
                && value
                    .get("severityformat")
                    .and_then(serde_json::Value::as_str)
                    .is_none_or(|format| format == "error")
        })
}

fn diagnostic_of(event: &crate::domain::OperationEvent) -> Option<serde_json::Value> {
    event
        .message
        .as_deref()
        .and_then(|message| serde_json::from_str::<serde_json::Value>(message).ok())
}

/// True when the read itself failed by an explicit signal: a non-stdout runner
/// event (connection failures are the only diagnostics that reach stderr),
/// a real error diagnostic, or a fatal exit status. A plain exit status of 1 is
/// deliberately not a failure: p4 may report a benign "nothing there" answer
/// that way, and discarding that answer would silently disable the very
/// evidence this module exists to provide.
pub fn read_failed(result: &OperationResult) -> bool {
    result.exit_code >= 2
        || result.events.iter().any(|event| {
            matches!(
                event.kind,
                EventKind::Stderr | EventKind::Error | EventKind::Cancelled
            ) || diagnostic_of(event).is_some_and(|value| is_error_diagnostic(&value))
        })
}

pub fn opened_evidence(result: &OperationResult) -> OpenedEvidence {
    let read_failed = read_failed(result);
    let opened = parser::file_facts(&result.events);
    let not_opened = result
        .events
        .iter()
        .filter_map(diagnostic_of)
        .filter_map(|value| {
            value
                .get("data")
                .and_then(serde_json::Value::as_str)
                .and_then(|data| {
                    data.trim()
                        .strip_suffix(" - file(s) not opened on this client.")
                })
                .map(|path| path.trim().to_owned())
        })
        .collect();
    OpenedEvidence {
        opened,
        not_opened,
        read_failed,
    }
}

fn has_open_record(evidence: &OpenedEvidence, path: &str) -> bool {
    evidence.opened.iter().any(|fact| fact.depot_path == path)
}

/// True when a trustworthy opened query that covered `path` returned no open
/// record for it: an unopened path produces no output at all, so absence from a
/// successful answer is the proof. `queried` is the exact path scope the query
/// was issued with - a path the query never covered proves nothing.
pub fn proves_unopened(evidence: &OpenedEvidence, queried: &[String], path: &str) -> bool {
    if evidence.read_failed {
        return false;
    }
    let covered = queried.iter().any(|candidate| candidate == path);
    covered && (evidence.not_opened.contains(path) || !has_open_record(evidence, path))
}

/// True when the opened list shows `path` opened with one of `actions`.
pub fn opened_with(evidence: &OpenedEvidence, path: &str, actions: &[&str]) -> bool {
    !evidence.read_failed
        && evidence.opened.iter().any(|fact| {
            fact.depot_path == path && actions.iter().any(|action| fact.action.contains(action))
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::OperationEvent;

    fn event(kind: EventKind, message: &str) -> OperationEvent {
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

    fn result(rows: &[serde_json::Value], stderr: &[&str], exit_code: i32) -> OperationResult {
        let mut events = rows
            .iter()
            .map(|row| event(EventKind::Stdout, &row.to_string()))
            .collect::<Vec<_>>();
        events.extend(stderr.iter().map(|line| event(EventKind::Stderr, line)));
        OperationResult {
            operation_id: "fixture".into(),
            exit_code,
            duration_ms: 1,
            events,
        }
    }

    /// Real `-ztag -Mj` benign diagnostic: single-line JSON on stdout, no `code`
    /// key, `severity: 2` and `severityformat:"warning"`.
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

    fn open_record(path: &str, action: &str) -> serde_json::Value {
        serde_json::json!({
            "depotFile": path,
            "clientFile": "F:/Fixture/x",
            "action": action,
            "change": "41",
        })
    }

    #[test]
    fn empty_answer_from_a_successful_query_proves_not_opened() {
        // Measured: `p4 opened <unopened path>` prints nothing and exits 0.
        let evidence = opened_evidence(&result(&[], &[], 0));
        assert!(!evidence.read_failed);
        assert!(proves_unopened(
            &evidence,
            &["//fixture/gone".to_owned()],
            "//fixture/gone"
        ));
        // A path the query never covered proves nothing.
        assert!(!proves_unopened(
            &evidence,
            &["//fixture/other".to_owned()],
            "//fixture/gone"
        ));
        assert!(!opened_with(&evidence, "//fixture/gone", &["edit"]));
    }

    #[test]
    fn an_open_record_refutes_not_opened() {
        let evidence = opened_evidence(&result(&[open_record("//fixture/f0", "edit")], &[], 0));
        assert!(!evidence.read_failed);
        assert!(!proves_unopened(
            &evidence,
            &["//fixture/f0".to_owned()],
            "//fixture/f0"
        ));
        assert!(opened_with(&evidence, "//fixture/f0", &["edit"]));
    }

    #[test]
    fn failed_reads_are_never_evidence() {
        // Real auth/permission failure: a severity-3 record on stdout.
        let error = opened_evidence(&result(
            &[severity_error("Access for user 'fixture' denied.")],
            &[],
            1,
        ));
        assert!(error.read_failed);
        assert!(!proves_unopened(
            &error,
            &["//fixture/f0".to_owned()],
            "//fixture/f0"
        ));
        assert!(!opened_with(&error, "//fixture/f0", &["edit"]));
        // Connection failures are the only diagnostics that reach stderr.
        let stderr = opened_evidence(&result(
            &[],
            &["Connect to server failed; check $P4PORT."],
            1,
        ));
        assert!(stderr.read_failed);
        assert!(!proves_unopened(
            &stderr,
            &["//fixture/f0".to_owned()],
            "//fixture/f0"
        ));
        // A fatal exit status with no diagnostic at all is not trustworthy.
        assert!(read_failed(&result(&[], &[], 2)));
        // A benign diagnostic with a non-zero (non-fatal) exit stays usable.
        assert!(!read_failed(&result(
            &[no_such_file("//fixture/f0")],
            &[],
            1
        )));
        // Empty output with exit 0 is success, never a failed read.
        assert!(!read_failed(&result(&[], &[], 0)));
        assert!(!read_failed(&result(&[], &[], 1)));
    }

    #[test]
    fn explicit_not_opened_text_is_still_accepted() {
        let record = serde_json::json!({
            "code0": 554768759,
            "data": "//fixture/f0 - file(s) not opened on this client.\n",
            "fmt0": "%argc% - file(s) not opened on this client.",
            "generic": 17,
            "severity": 2,
            "severityformat": "warning",
        });
        let evidence = opened_evidence(&result(&[record], &[], 0));
        assert!(!evidence.read_failed);
        assert!(proves_unopened(
            &evidence,
            &["//fixture/f0".to_owned()],
            "//fixture/f0"
        ));
    }

    #[test]
    fn benign_diagnostic_is_not_an_error_and_real_error_is() {
        assert!(!is_error_diagnostic(&no_such_file("//fixture/f0")));
        // `severityformat:"error"` on its own is not enough: it is the severity
        // number that separates benign no-ops from real failures.
        assert!(!is_error_diagnostic(&serde_json::json!({
            "severity": 2,
            "severityformat": "error",
        })));
        assert!(is_error_diagnostic(&severity_error("denied")));
        // Synthetic fixtures without `severityformat` keep the severity test.
        assert!(is_error_diagnostic(&serde_json::json!({"severity": 3})));
        // Legacy synthetic `code:"error"` stays an error.
        assert!(is_error_diagnostic(
            &serde_json::json!({"code": "error", "severity": 2})
        ));
    }
}
