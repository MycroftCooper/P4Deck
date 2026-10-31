//! Restricted frontend failure facts; no free-form content or caller-selected log path/level.
use crate::{
    domain::{LogEntry, LogLevel, OperationSource},
    persistence::log_store::LogStore,
};
use serde::{Deserialize, Serialize};
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    pub event_id: String,
    pub operation_id: String,
    pub action: String,
    pub phase: String,
    pub outcome: String,
    pub code: String,
    pub target_count: u32,
    pub change_id: Option<String>,
}
#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Receipt {
    pub status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<&'static str>,
    /// Log persistence never authorizes replaying the business action.
    pub business_action_retry_allowed: bool,
}
fn identifier(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 128
        && s.bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
}
fn valid(r: &Request) -> bool {
    identifier(&r.event_id)
        && identifier(&r.operation_id)
        && r.target_count <= 1000
        && [
            "shelfDelete",
            "moveFiles",
            "customSubmit",
            "addressNavigation",
            "otherOperation",
        ]
        .contains(&r.action.as_str())
        && ["preflight", "execute", "refresh", "navigation"].contains(&r.phase.as_str())
        && ["failed", "partial", "unknown"].contains(&r.outcome.as_str())
        && [
            "preflightBlocked",
            "contextChanged",
            "targetMismatch",
            "expired",
            "transportError",
            "operationFailed",
            "uncertainOutcome",
            "refreshFailed",
            "pathNotFound",
            "invalidTarget",
        ]
        .contains(&r.code.as_str())
        && r.change_id
            .as_ref()
            .is_none_or(|s| s.parse::<u64>().is_ok_and(|n| n > 0 && n.to_string() == *s))
}
pub fn record(store: &LogStore, r: Request) -> Receipt {
    if !valid(&r) {
        return Receipt {
            status: "rejected",
            reason: Some("invalidInput"),
            business_action_retry_allowed: false,
        };
    }
    let entry = LogEntry {
        id: format!("frontend-{}", r.event_id),
        timestamp: chrono::Utc::now().to_rfc3339(),
        level: LogLevel::Error,
        operation_id: r.operation_id,
        source: OperationSource::Gui,
        server: String::new(),
        workspace: String::new(),
        command: format!("frontend/{} / {} / {}", r.action, r.phase, r.event_id),
        message: format!(
            "outcome={} code={} targets={} change={}",
            r.outcome,
            r.code,
            r.target_count,
            r.change_id.as_deref().unwrap_or("none")
        ),
        duration_ms: None,
        repeat_count: 1,
    };
    match store.push_frontend_once(entry) {
        Ok(true) => Receipt {
            status: "recorded",
            reason: None,
            business_action_retry_allowed: false,
        },
        Ok(false) => Receipt {
            status: "duplicate",
            reason: None,
            business_action_retry_allowed: false,
        },
        Err("eventConflict") => Receipt {
            status: "rejected",
            reason: Some("eventConflict"),
            business_action_retry_allowed: false,
        },
        Err("eventLimit") => Receipt {
            status: "rejected",
            reason: Some("eventLimit"),
            business_action_retry_allowed: false,
        },
        Err(_) => {
            eprintln!("Frontend operation log persistence unavailable; business action must not be replayed.");
            Receipt {
                status: "unavailable",
                reason: Some("logWriteFailed"),
                business_action_retry_allowed: false,
            }
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn request() -> Request {
        Request {
            event_id: "event-1".into(),
            operation_id: "operation-1".into(),
            action: "shelfDelete".into(),
            phase: "execute".into(),
            outcome: "unknown".into(),
            code: "uncertainOutcome".into(),
            target_count: 2,
            change_id: Some("42".into()),
        }
    }
    #[test]
    fn rejects_unbounded_sensitive_and_invalid_fields() {
        let mut r = request();
        assert!(valid(&r));
        r.event_id = "x".repeat(129);
        assert!(!valid(&r));
        r = request();
        r.code = "password=secret".into();
        assert!(!valid(&r));
        r = request();
        r.operation_id = "line\nsecret".into();
        assert!(!valid(&r));
        r = request();
        r.target_count = 1001;
        assert!(!valid(&r));
        r = request();
        r.change_id = Some("042".into());
        assert!(!valid(&r));
        assert!(serde_json::from_value::<Request>(serde_json::json!({"eventId":"e","operationId":"o","action":"shelfDelete","phase":"execute","outcome":"failed","code":"operationFailed","targetCount":1,"password":"secret"})).is_err());
    }
    #[test]
    fn real_store_is_queryable_and_phase_events_are_not_swallowed() {
        let dir =
            std::env::temp_dir().join(format!("p4deck-frontend-log-{}", uuid::Uuid::new_v4()));
        let store = LogStore::open(&dir.join("logs.sqlite")).unwrap();
        assert_eq!(record(&store, request()).status, "recorded");
        assert_eq!(record(&store, request()).status, "duplicate");
        let mut r = request();
        r.outcome = "failed".into();
        assert_eq!(record(&store, r).reason, Some("eventConflict"));
        let mut r = request();
        r.event_id = "event-2".into();
        r.phase = "refresh".into();
        assert_eq!(record(&store, r).status, "recorded");
        let rows = store.query(&crate::domain::LogQuery::default());
        assert_eq!(rows.len(), 2);
        assert!(rows.iter().all(|e| e.operation_id == "operation-1"));
        drop(store);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
