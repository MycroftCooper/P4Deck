use crate::{
    domain::{LogEntry, LogPage, LogPolicy, LogQuery},
    security,
};
use chrono::{DateTime, Utc};
use parking_lot::Mutex;
use std::{
    collections::VecDeque,
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    time::{Duration, Instant, SystemTime},
};

const HARD_MAX_ENTRIES: usize = 10_000;
const HARD_MAX_RETENTION_DAYS: u32 = 30;
const HARD_MAX_MIB: u32 = 50;
const MAX_PAGE_SIZE: usize = 500;

pub struct LogStore {
    directory: PathBuf,
    legacy_path: PathBuf,
    session: Mutex<LogSession>,
    frontend_events: Mutex<std::collections::BTreeMap<String, String>>,
}
struct LogSession {
    file: Option<File>,
    path: PathBuf,
    bytes: u64,
    memory: VecDeque<LogEntry>,
    policy: LogPolicy,
    last_prune: Instant,
}

impl LogStore {
    /// Keep the former database path only for explicit deletion. Opening a store
    /// creates a new session file; it never opens or reads any historical log.
    pub fn open(legacy_path: &Path) -> Result<Self, String> {
        let directory = legacy_path.with_extension("logs");
        fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
        let policy = fs::read(directory.join("policy.json"))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<LogPolicy>(&bytes).ok())
            .map(clamp_policy)
            .unwrap_or_else(default_policy);
        let (path, file) = new_file(&directory)?;
        Ok(Self {
            directory,
            legacy_path: legacy_path.to_owned(),
            frontend_events: Mutex::new(std::collections::BTreeMap::new()),
            session: Mutex::new(LogSession {
                file: Some(file),
                path,
                bytes: 0,
                memory: VecDeque::new(),
                policy,
                last_prune: Instant::now(),
            }),
        })
    }
    pub fn push_frontend_once(&self, entry: LogEntry) -> Result<bool, &'static str> {
        let facts = serde_json::to_string(&(&entry.operation_id, &entry.command, &entry.message))
            .map_err(|_| "logWriteFailed")?;
        let mut events = self.frontend_events.lock();
        frontend_once(&mut events, entry.id.clone(), facts, || {
            self.push(entry).map_err(|_| "logWriteFailed")
        })
    }
    pub fn directory(&self) -> &Path {
        &self.directory
    }

    pub fn push(&self, mut entry: LogEntry) -> Result<(), String> {
        entry.command = sanitize_redacted(&entry.command, 512);
        entry.message = sanitize_redacted(&entry.message, 4096);
        entry.server = sanitize_redacted(&entry.server, 256);
        entry.workspace = sanitize_redacted(&entry.workspace, 128);
        let mut line = serde_json::to_vec(&entry).map_err(|e| e.to_string())?;
        line.push(b'\n');
        let mut session = self.session.lock();
        let capacity = session.policy.max_mib as u64 * 1024 * 1024;
        let rotate = session.bytes + line.len() as u64 > capacity;
        if rotate || session.file.is_none() {
            let (path, file) = new_file(&self.directory)?;
            session.file = Some(file);
            session.path = path;
            session.bytes = 0;
        }
        session
            .file
            .as_mut()
            .unwrap()
            .write_all(&line)
            .map_err(|e| e.to_string())?;
        session.bytes += line.len() as u64;
        if let Some(previous) = session.memory.front_mut().filter(|previous| {
            previous.level == entry.level
                && previous.message == entry.message
                && previous.command == entry.command
                && previous.server == entry.server
                && previous.workspace == entry.workspace
                && within_dedupe_window(&previous.timestamp, &entry.timestamp)
        }) {
            previous.repeat_count += 1;
            previous.timestamp = entry.timestamp;
        } else {
            session.memory.push_front(entry);
        }
        session.memory.truncate(HARD_MAX_ENTRIES);
        // Cleanup inspects filenames/metadata only, off the startup path and at
        // most once a minute. No historical content is ever parsed into memory.
        if rotate || session.last_prune.elapsed() >= Duration::from_secs(60) {
            self.prune(&mut session);
        }
        Ok(())
    }
    pub fn query(&self, query: &LogQuery) -> Vec<LogEntry> {
        self.query_page(query).entries
    }

    pub fn query_page(&self, query: &LogQuery) -> LogPage {
        let keyword = query.keyword.as_deref().unwrap_or("").to_lowercase();
        let limit = query.limit.unwrap_or(100).clamp(1, MAX_PAGE_SIZE);
        let mut entries = self
            .session
            .lock()
            .memory
            .iter()
            .filter(|entry| {
                query
                    .levels
                    .as_ref()
                    .map(|v| v.contains(&entry.level))
                    .unwrap_or(true)
                    && query
                        .sources
                        .as_ref()
                        .map(|v| v.contains(&entry.source))
                        .unwrap_or(true)
                    && query
                        .server
                        .as_ref()
                        .map(|v| v == &entry.server)
                        .unwrap_or(true)
                    && query
                        .workspace
                        .as_ref()
                        .map(|v| v == &entry.workspace)
                        .unwrap_or(true)
                    && query
                        .command
                        .as_ref()
                        .map(|v| entry.command.contains(v))
                        .unwrap_or(true)
                    && query
                        .operation_id
                        .as_ref()
                        .map(|v| v == &entry.operation_id)
                        .unwrap_or(true)
                    && query
                        .cursor
                        .as_ref()
                        .map(|v| format!("{}|{}", entry.timestamp, entry.id) < *v)
                        .unwrap_or(true)
                    && (keyword.is_empty()
                        || format!("{} {}", entry.command, entry.message)
                            .to_lowercase()
                            .contains(&keyword))
            })
            .take(limit + 1)
            .cloned()
            .collect::<Vec<_>>();
        let more = entries.len() > limit;
        entries.truncate(limit);
        let next_cursor = more
            .then(|| entries.last().map(|e| format!("{}|{}", e.timestamp, e.id)))
            .flatten();
        LogPage {
            entries,
            next_cursor,
        }
    }

    pub fn policy(&self) -> LogPolicy {
        self.session.lock().policy.clone()
    }
    pub fn set_policy(&self, policy: LogPolicy) -> Result<LogPolicy, String> {
        let policy = clamp_policy(policy);
        let bytes = serde_json::to_vec(&policy).map_err(|e| e.to_string())?;
        let mut session = self.session.lock();
        fs::write(self.directory.join("policy.json"), bytes).map_err(|e| e.to_string())?;
        session.policy = policy.clone();
        self.prune(&mut session);
        Ok(policy)
    }
    pub fn clear_all(&self) -> Result<(), String> {
        let mut session = self.session.lock();
        // Close our handle before deleting on Windows. Serialize deletion and
        // writes under the same lock so an in-flight command cannot be lost.
        session.file.take();
        let result = self.delete_files();
        session.memory.clear();
        session.bytes = 0;
        let (path, file) = new_file(&self.directory)?;
        session.path = path;
        session.file = Some(file);
        session.last_prune = Instant::now();
        result
    }
    fn delete_files(&self) -> Result<(), String> {
        let mut failure = None;
        for entry in fs::read_dir(&self.directory).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            if is_session_file(&entry.path()) {
                if let Err(error) = fs::remove_file(entry.path()) {
                    failure = Some(error.to_string());
                }
            }
        }
        // Also remove the old SQLite log store and its sidecars, without ever
        // opening it. Connection settings and the operation journal are separate.
        for suffix in ["", "-wal", "-shm", "-journal"] {
            let mut path = self.legacy_path.as_os_str().to_owned();
            path.push(suffix);
            if let Err(error) = fs::remove_file(PathBuf::from(path)) {
                if error.kind() != std::io::ErrorKind::NotFound {
                    failure = Some(error.to_string());
                }
            }
        }
        failure.map_or(Ok(()), Err)
    }
    fn prune(&self, session: &mut LogSession) {
        session.last_prune = Instant::now();
        let cutoff = Utc::now() - chrono::Duration::days(session.policy.retention_days as i64);
        session.memory.retain(|entry| {
            DateTime::parse_from_rfc3339(&entry.timestamp)
                .map(|time| time.with_timezone(&Utc) >= cutoff)
                .unwrap_or(false)
        });
        let Ok(entries) = fs::read_dir(&self.directory) else {
            return;
        };
        let mut files = entries
            .filter_map(Result::ok)
            .filter_map(|entry| {
                let path = entry.path();
                if !is_session_file(&path) || !entry.file_type().ok()?.is_file() {
                    return None;
                }
                let metadata = entry.metadata().ok()?;
                Some((path, metadata.modified().ok()?, metadata.len()))
            })
            .collect::<Vec<_>>();
        files.sort_by_key(|(_, modified, _)| *modified);
        let mut total: u64 = files.iter().map(|(_, _, bytes)| bytes).sum();
        let max = session.policy.max_mib as u64 * 1024 * 1024;
        let age = Duration::from_secs(session.policy.retention_days as u64 * 86400);
        for (path, modified, bytes) in files {
            if path == session.path {
                continue;
            }
            let expired = SystemTime::now()
                .duration_since(modified)
                .unwrap_or_default()
                >= age;
            if (expired || total > max) && fs::remove_file(path).is_ok() {
                total = total.saturating_sub(bytes);
            }
        }
    }
}
fn new_file(directory: &Path) -> Result<(PathBuf, File), String> {
    let path = directory.join(format!(
        "p4deck-{}-{}.jsonl",
        Utc::now().format("%Y%m%d-%H%M%S"),
        uuid::Uuid::new_v4()
    ));
    let file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&path)
        .map_err(|e| e.to_string())?;
    Ok((path, file))
}
fn is_session_file(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.starts_with("p4deck-") && name.ends_with(".jsonl"))
}
fn clamp_policy(mut policy: LogPolicy) -> LogPolicy {
    policy.retention_days = policy.retention_days.clamp(1, HARD_MAX_RETENTION_DAYS);
    policy.max_mib = policy.max_mib.clamp(5, HARD_MAX_MIB);
    policy
}
fn default_policy() -> LogPolicy {
    LogPolicy {
        auto_expand_warning: true,
        auto_expand_error: true,
        retention_days: 14,
        max_mib: 50,
    }
}
fn sanitize(value: &str, max: usize) -> String {
    value
        .chars()
        .filter(|c| !c.is_control() || *c == '\n')
        .take(max)
        .collect()
}
fn sanitize_redacted(value: &str, max: usize) -> String {
    sanitize(&security::redact_text(value), max)
}

fn within_dedupe_window(previous: &str, next: &str) -> bool {
    let Ok(previous) = DateTime::parse_from_rfc3339(previous) else {
        return false;
    };
    let Ok(next) = DateTime::parse_from_rfc3339(next) else {
        return false;
    };
    (next.with_timezone(&Utc) - previous.with_timezone(&Utc))
        .num_seconds()
        .abs()
        <= 10
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{LogLevel, OperationSource};
    struct Fixture {
        root: PathBuf,
        path: PathBuf,
    }
    impl Fixture {
        fn new() -> Self {
            let root =
                std::env::temp_dir().join(format!("p4deck-session-logs-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&root).unwrap();
            Self {
                path: root.join("logs.sqlite"),
                root,
            }
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }
    fn entry(id: &str) -> LogEntry {
        LogEntry {
            id: id.into(),
            timestamp: Utc::now().to_rfc3339(),
            level: LogLevel::Info,
            operation_id: id.into(),
            source: OperationSource::Gui,
            server: "server".into(),
            workspace: "workspace".into(),
            command: "p4 info".into(),
            message: format!("message {id}"),
            duration_ms: Some(1),
            repeat_count: 1,
        }
    }
    #[test]
    fn starts_empty_without_reading_legacy_or_previous_session_contents() {
        let fixture = Fixture::new();
        // An invalid legacy database must not block startup or even be opened.
        fs::write(&fixture.path, b"not a database").unwrap();
        let store = LogStore::open(&fixture.path).unwrap();
        let old_path = store.session.lock().path.clone();
        store.push(entry("previous")).unwrap();
        drop(store);
        // No parser can read this as a log; startup must still work.
        fs::write(&old_path, b"unreadable historical data").unwrap();
        let reopened = LogStore::open(&fixture.path).unwrap();
        assert!(reopened.query(&LogQuery::default()).is_empty());
        assert_ne!(reopened.session.lock().path, old_path);
        assert_eq!(fs::read(&old_path).unwrap(), b"unreadable historical data");
        assert_eq!(fs::read(&fixture.path).unwrap(), b"not a database");
    }
    #[test]
    fn pages_filters_and_coalesces_only_the_current_session() {
        let fixture = Fixture::new();
        let store = LogStore::open(&fixture.path).unwrap();
        store.push(entry("one")).unwrap();
        let mut duplicate = entry("two");
        duplicate.message = "message one".into();
        store.push(duplicate).unwrap();
        store.push(entry("three")).unwrap();
        let first = store.query_page(&LogQuery {
            limit: Some(1),
            ..Default::default()
        });
        assert_eq!(first.entries[0].id, "three");
        let second = store.query_page(&LogQuery {
            cursor: first.next_cursor,
            limit: Some(1),
            ..Default::default()
        });
        assert_eq!(second.entries[0].repeat_count, 2);
        assert!(store
            .query(&LogQuery {
                keyword: Some("absent".into()),
                ..Default::default()
            })
            .is_empty());
        assert!(store
            .query(&LogQuery {
                sources: Some(vec![OperationSource::Terminal]),
                ..Default::default()
            })
            .is_empty());
        assert_eq!(
            fs::read_to_string(&store.session.lock().path)
                .unwrap()
                .lines()
                .count(),
            3
        );
    }
    #[test]
    fn redacts_before_both_memory_and_session_file() {
        const SECRET: &str = "P4DECK_SECRET_33e65bf1";
        let fixture = Fixture::new();
        let store = LogStore::open(&fixture.path).unwrap();
        let mut value = entry("secret");
        value.command = format!("p4 info -P{SECRET}");
        value.message = format!("Ticket: {SECRET}");
        store.push(value).unwrap();
        assert!(!serde_json::to_string(&store.query(&LogQuery::default()))
            .unwrap()
            .contains(SECRET));
        let text = fs::read_to_string(&store.session.lock().path).unwrap();
        assert!(!text.contains(SECRET));
        let saved: LogEntry = serde_json::from_str(text.trim()).unwrap();
        assert!(saved.message.contains("[REDACTED]"));
    }
    #[test]
    fn bounds_memory_while_retaining_the_session_file() {
        let fixture = Fixture::new();
        let store = LogStore::open(&fixture.path).unwrap();
        for index in 0..HARD_MAX_ENTRIES + 5 {
            store.push(entry(&index.to_string())).unwrap();
        }
        assert_eq!(store.session.lock().memory.len(), HARD_MAX_ENTRIES);
        assert!(!store
            .session
            .lock()
            .memory
            .iter()
            .any(|entry| entry.id == "0"));
        assert_eq!(
            fs::read_to_string(&store.session.lock().path)
                .unwrap()
                .lines()
                .count(),
            HARD_MAX_ENTRIES + 5
        );
    }
    #[test]
    fn persists_policy_and_prunes_archives_by_metadata_only() {
        let fixture = Fixture::new();
        let store = LogStore::open(&fixture.path).unwrap();
        let archive = store.directory().join("p4deck-old.jsonl");
        let archived = File::create(&archive).unwrap();
        archived.set_len(6 * 1024 * 1024).unwrap();
        drop(archived);
        let mut old = entry("old");
        old.timestamp = (Utc::now() - chrono::Duration::days(5)).to_rfc3339();
        store.push(old).unwrap();
        let policy = store
            .set_policy(LogPolicy {
                auto_expand_warning: false,
                auto_expand_error: true,
                retention_days: 1,
                max_mib: 5,
            })
            .unwrap();
        assert!(!archive.exists());
        assert!(store.query(&LogQuery::default()).is_empty());
        drop(store);
        let reopened = LogStore::open(&fixture.path).unwrap();
        assert_eq!(reopened.policy().retention_days, policy.retention_days);
        assert!(!reopened.policy().auto_expand_warning);
        assert_eq!(
            reopened
                .set_policy(LogPolicy {
                    max_mib: 999,
                    ..policy
                })
                .unwrap()
                .max_mib,
            HARD_MAX_MIB
        );
    }
    #[test]
    fn clear_deletes_all_sessions_and_legacy_logs_preserves_settings_and_keeps_writing() {
        let fixture = Fixture::new();
        let store = LogStore::open(&fixture.path).unwrap();
        fs::write(&fixture.path, b"legacy log data").unwrap();
        fs::write(fixture.path.with_extension("sqlite-wal"), b"legacy WAL").unwrap();
        let settings = fixture.root.join("connection-profiles.json");
        fs::write(&settings, b"settings").unwrap();
        let journal = fixture.root.join("operations.sqlite");
        fs::write(&journal, b"journal").unwrap();
        let unrelated = store.directory().join("keep.txt");
        fs::write(&unrelated, b"keep").unwrap();
        store.set_policy(default_policy()).unwrap();
        let previous = LogStore::open(&fixture.path).unwrap();
        previous.push(entry("old-session")).unwrap();
        drop(previous);
        store.push(entry("current-session")).unwrap();
        store.clear_all().unwrap();
        assert!(store.query(&LogQuery::default()).is_empty());
        assert!(!fixture.path.exists());
        assert!(!fixture.path.with_extension("sqlite-wal").exists());
        assert!(settings.exists() && journal.exists() && unrelated.exists());
        assert!(store.directory().join("policy.json").exists());
        let files = fs::read_dir(store.directory())
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| is_session_file(&entry.path()))
            .collect::<Vec<_>>();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].metadata().unwrap().len(), 0);
        store.push(entry("after-clear")).unwrap();
        assert_eq!(store.query(&LogQuery::default())[0].id, "after-clear");
        assert!(fs::read_to_string(&store.session.lock().path)
            .unwrap()
            .contains("after-clear"));
    }
    #[test]
    fn concurrent_writes_remain_valid_during_clear() {
        let fixture = Fixture::new();
        let store = std::sync::Arc::new(LogStore::open(&fixture.path).unwrap());
        let writer = store.clone();
        let thread = std::thread::spawn(move || {
            for index in 0..100 {
                writer.push(entry(&format!("concurrent-{index}"))).unwrap();
            }
        });
        store.clear_all().unwrap();
        thread.join().unwrap();
        store.push(entry("finished")).unwrap();
        let text = fs::read_to_string(&store.session.lock().path).unwrap();
        for line in text.lines() {
            serde_json::from_str::<LogEntry>(line).unwrap();
        }
        assert!(text.contains("finished"));
    }

    #[test]
    fn query_filters_and_persistence_cover_the_cancelled_level() {
        let fixture = Fixture::new();
        let store = LogStore::open(&fixture.path).unwrap();
        let mut cancelled = entry("cancelled-one");
        cancelled.level = LogLevel::Cancelled;
        cancelled.command = "p4 sync //depot/main/...".into();
        cancelled.message = "operation was cancelled".into();
        store.push(cancelled).unwrap();
        let mut failed = entry("failed-one");
        failed.level = LogLevel::Error;
        failed.command = "p4 submit -c 42".into();
        failed.message = "p4: submit failed".into();
        store.push(failed).unwrap();

        let cancelled_only = store.query(&LogQuery {
            levels: Some(vec![LogLevel::Cancelled]),
            ..Default::default()
        });
        assert_eq!(cancelled_only.len(), 1);
        assert_eq!(cancelled_only[0].id, "cancelled-one");
        assert_eq!(cancelled_only[0].level, LogLevel::Cancelled);

        let errors_only = store.query(&LogQuery {
            levels: Some(vec![LogLevel::Error]),
            ..Default::default()
        });
        assert_eq!(errors_only.len(), 1);
        assert_eq!(errors_only[0].level, LogLevel::Error);

        // The persisted session line carries the new wire value for later sessions/export.
        let text = fs::read_to_string(&store.session.lock().path).unwrap();
        assert!(text.contains("\"level\":\"cancelled\""));
    }
}

fn frontend_once(
    events: &mut std::collections::BTreeMap<String, String>,
    id: String,
    facts: String,
    write: impl FnOnce() -> Result<(), &'static str>,
) -> Result<bool, &'static str> {
    if let Some(previous) = events.get(&id) {
        return if previous == &facts {
            Ok(false)
        } else {
            Err("eventConflict")
        };
    }
    if events.len() >= 4096 {
        return Err("eventLimit");
    }
    write()?;
    events.insert(id, facts);
    Ok(true)
}
#[cfg(test)]
mod frontend_once_tests {
    use super::*;
    #[test]
    fn failed_write_does_not_claim_recorded_or_reserve_event() {
        let mut events = std::collections::BTreeMap::new();
        assert_eq!(
            frontend_once(&mut events, "id".into(), "facts".into(), || Err(
                "logWriteFailed"
            )),
            Err("logWriteFailed")
        );
        assert!(events.is_empty());
        assert_eq!(
            frontend_once(&mut events, "id".into(), "facts".into(), || Ok(())),
            Ok(true)
        );
        assert_eq!(
            frontend_once(&mut events, "id".into(), "facts".into(), || panic!(
                "duplicate write"
            )),
            Ok(false)
        );
    }
    #[test]
    fn capacity_refuses_new_events_without_evicting_ids() {
        let mut events = (0..4096).map(|i| (i.to_string(), "f".into())).collect();
        assert_eq!(
            frontend_once(&mut events, "new".into(), "f".into(), || panic!(
                "capacity write"
            )),
            Err("eventLimit")
        );
        assert_eq!(
            frontend_once(&mut events, "0".into(), "f".into(), || panic!(
                "duplicate write"
            )),
            Ok(false)
        );
    }
}
