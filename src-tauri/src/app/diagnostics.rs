use crate::{
    domain::{DiagnosticExportRequest, DiagnosticExportResult, LogEntry, LogQuery},
    persistence::{
        log_store::LogStore,
        operation_journal::{OperationJournal, OperationJournalQuery, OperationRecord},
    },
};
use chrono::Utc;
use serde::Serialize;
use std::{fs::OpenOptions, io::Write, path::PathBuf, sync::Arc};

const MAX_EXPORT_BYTES: usize = 128 * 1024;
const MAX_LOGS: usize = 500;
const MAX_OPERATIONS: usize = 500;

pub struct DiagnosticService {
    directory: PathBuf,
    logs: Arc<LogStore>,
    journal: Arc<OperationJournal>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    version: String,
    created_at: String,
    platform: String,
    format: String,
    included: Vec<String>,
    omitted: Vec<String>,
    redaction: String,
    truncated: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SafeLog {
    timestamp: String,
    level: String,
    operation_id: String,
    source: String,
    server: String,
    workspace: String,
    command: String,
    message: String,
    duration_ms: Option<u64>,
    repeat_count: u32,
}
#[derive(Serialize)]
struct Bundle {
    manifest: Manifest,
    logs: Vec<SafeLog>,
    operations: Vec<OperationRecord>,
}

impl DiagnosticService {
    pub fn new(directory: PathBuf, logs: Arc<LogStore>, journal: Arc<OperationJournal>) -> Self {
        Self {
            directory,
            logs,
            journal,
        }
    }
    pub fn export(
        &self,
        request: DiagnosticExportRequest,
    ) -> Result<DiagnosticExportResult, String> {
        std::fs::create_dir_all(&self.directory).map_err(|e| e.to_string())?;
        let log_limit = request.max_log_entries.unwrap_or(200).clamp(1, MAX_LOGS);
        let operation_limit = request
            .max_operation_entries
            .unwrap_or(200)
            .clamp(1, MAX_OPERATIONS);
        let logs = self
            .logs
            .query_page(&LogQuery {
                limit: Some(log_limit),
                ..Default::default()
            })
            .entries
            .into_iter()
            .map(safe_log)
            .collect();
        let mut operations = Vec::new();
        let mut cursor = None;
        while operations.len() < operation_limit {
            let page = self.journal.query(&OperationJournalQuery {
                connection_id: None,
                cursor,
                limit: Some((operation_limit - operations.len()).min(100)),
            })?;
            operations.extend(page.records);
            let Some(next) = page.next_cursor else { break };
            cursor = Some(next);
        }
        let mut bundle = Bundle {
            manifest: Manifest {
                version: env!("CARGO_PKG_VERSION").into(),
                created_at: Utc::now().to_rfc3339(),
                platform: std::env::consts::OS.into(),
                format: "p4deck-diagnostic-json-v1".into(),
                included: vec![
                    "manifest".into(),
                    "redactedLogs".into(),
                    "operationSummaries".into(),
                ],
                omitted: vec![
                    "passwords".into(),
                    "ticketContents".into(),
                    "stdin".into(),
                    "workspaceFiles".into(),
                    "rawCommandArguments".into(),
                ],
                redaction:
                    "Paths and credential markers are replaced; messages and counts are bounded."
                        .into(),
                truncated: false,
            },
            logs,
            operations,
        };
        let mut bytes = serde_json::to_vec_pretty(&bundle).map_err(|e| e.to_string())?;
        while bytes.len() > MAX_EXPORT_BYTES
            && (!bundle.logs.is_empty() || !bundle.operations.is_empty())
        {
            bundle.manifest.truncated = true;
            if bundle.logs.len() >= bundle.operations.len() {
                bundle.logs.pop();
            } else {
                bundle.operations.pop();
            }
            bytes = serde_json::to_vec_pretty(&bundle).map_err(|e| e.to_string())?;
        }
        if bytes.len() > MAX_EXPORT_BYTES {
            return Err("diagnostic manifest exceeds size limit".into());
        }
        let token = uuid::Uuid::new_v4();
        let final_path = self
            .directory
            .join(format!("p4deck-diagnostics-{token}.json"));
        let temporary = self
            .directory
            .join(format!(".p4deck-diagnostics-{token}.tmp"));
        let result = (|| {
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temporary)
                .map_err(|e| e.to_string())?;
            file.write_all(&bytes).map_err(|e| e.to_string())?;
            file.sync_all().map_err(|e| e.to_string())?;
            std::fs::rename(&temporary, &final_path).map_err(|e| e.to_string())?;
            Ok(DiagnosticExportResult {
                path: final_path.to_string_lossy().into_owned(),
                size_bytes: bytes.len() as u64,
                truncated: bundle.manifest.truncated,
                format: "json".into(),
            })
        })();
        if result.is_err() {
            let _ = std::fs::remove_file(&temporary);
        }
        result
    }
}

fn safe_log(entry: LogEntry) -> SafeLog {
    SafeLog {
        timestamp: entry.timestamp,
        level: format!("{:?}", entry.level).to_ascii_lowercase(),
        operation_id: scrub(&entry.operation_id, 128),
        source: format!("{:?}", entry.source).to_ascii_lowercase(),
        server: scrub_endpoint(&entry.server),
        workspace: scrub(&entry.workspace, 128),
        command: scrub_text(&entry.command),
        message: scrub_text(&entry.message),
        duration_ms: entry.duration_ms,
        repeat_count: entry.repeat_count,
    }
}
fn scrub(value: &str, max: usize) -> String {
    value
        .chars()
        .filter(|c| !c.is_control())
        .take(max)
        .collect()
}
fn scrub_endpoint(value: &str) -> String {
    if value.is_empty() {
        String::new()
    } else {
        "[SERVER]".into()
    }
}
fn scrub_text(value: &str) -> String {
    let mut redact_next = false;
    value
        .split_whitespace()
        .take(64)
        .map(|token| {
            let lower = token.to_ascii_lowercase();
            let credential = lower.contains("password")
                || lower.contains("p4passwd")
                || lower.contains("ticket:");
            let redact = redact_next
                || token.contains('/')
                || token.contains('\\')
                || (token.len() > 2 && token.as_bytes()[1] == b':')
                || credential;
            redact_next = credential && (token.ends_with(':') || token.ends_with('='));
            if redact {
                "[REDACTED]"
            } else {
                token
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(512)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{LogLevel, OperationSource};
    #[test]
    fn exports_bounded_redacted_manifest_without_workspace_files() {
        let base = std::env::temp_dir().join(format!("p4deck-diag-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&base).unwrap();
        let logs = Arc::new(LogStore::open(&base.join("logs.sqlite")).unwrap());
        let journal = Arc::new(OperationJournal::open(&base.join("ops.sqlite")).unwrap());
        logs.push(LogEntry {
            id: "1".into(),
            timestamp: Utc::now().to_rfc3339(),
            level: LogLevel::Error,
            operation_id: "op".into(),
            source: OperationSource::Gui,
            server: "ssl:secret-server".into(),
            workspace: "ws".into(),
            command: "p4 sync /Users/private/secret.txt".into(),
            message: "Password: hunter2 Ticket:abc prefix=/Users/private/file".into(),
            duration_ms: None,
            repeat_count: 1,
        })
        .unwrap();
        journal
            .start(
                "op",
                "conn",
                "ws",
                OperationSource::Gui,
                crate::persistence::operation_journal::OperationCategory::Query,
            )
            .unwrap();
        let service = DiagnosticService::new(base.join("exports"), logs, journal);
        let result = service.export(DiagnosticExportRequest::default()).unwrap();
        assert!(result.size_bytes < MAX_EXPORT_BYTES as u64);
        let text = std::fs::read_to_string(&result.path).unwrap();
        assert!(text.contains("p4deck-diagnostic-json-v1"));
        assert!(text.contains("workspaceFiles"));
        assert!(!text.contains("hunter2"));
        assert!(!text.contains("secret-server"));
        assert!(!text.contains("/Users/private"));
        assert_eq!(std::fs::read_dir(base.join("exports")).unwrap().count(), 1);
        drop(service);
        std::fs::remove_dir_all(base).unwrap();
    }
    #[test]
    fn rejects_unusable_export_directory_without_leaving_temporary_files() {
        let base = std::env::temp_dir().join(format!("p4deck-diag-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&base).unwrap();
        let blocker = base.join("blocked");
        std::fs::write(&blocker, "not a directory").unwrap();
        let logs = Arc::new(LogStore::open(&base.join("logs.sqlite")).unwrap());
        let journal = Arc::new(OperationJournal::open(&base.join("ops.sqlite")).unwrap());
        let service = DiagnosticService::new(blocker, logs, journal);
        assert!(service.export(DiagnosticExportRequest::default()).is_err());
        assert_eq!(
            std::fs::read_dir(&base)
                .unwrap()
                .filter_map(Result::ok)
                .filter(|e| e.file_name().to_string_lossy().contains(".tmp"))
                .count(),
            0
        );
        drop(service);
        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn truncates_synthetic_output_at_the_hard_size_limit() {
        let base = std::env::temp_dir().join(format!("p4deck-diag-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&base).unwrap();
        let logs = Arc::new(LogStore::open(&base.join("logs.sqlite")).unwrap());
        let journal = Arc::new(OperationJournal::open(&base.join("ops.sqlite")).unwrap());
        for index in 0..MAX_LOGS {
            logs.push(LogEntry {
                id: format!("log-{index}"),
                timestamp: Utc::now().to_rfc3339(),
                level: LogLevel::Warning,
                operation_id: format!("op-{index}"),
                source: OperationSource::Gui,
                server: "server".into(),
                workspace: "workspace".into(),
                command: "p4 synthetic".into(),
                message: format!("{index} {}", "bounded-data ".repeat(80)),
                duration_ms: None,
                repeat_count: 1,
            })
            .unwrap();
        }
        let service = DiagnosticService::new(base.join("exports"), logs, journal);
        let result = service
            .export(DiagnosticExportRequest {
                max_log_entries: Some(MAX_LOGS),
                max_operation_entries: Some(1),
            })
            .unwrap();
        assert!(result.truncated);
        assert!(result.size_bytes <= MAX_EXPORT_BYTES as u64);
        drop(service);
        std::fs::remove_dir_all(base).unwrap();
    }
}
