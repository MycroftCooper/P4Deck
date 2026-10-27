use crate::{
    domain::*,
    persistence::{
        log_store::LogStore,
        operation_journal::{
            connection_id, JournalState, OperationCategory, OperationFailureKind, OperationJournal,
        },
    },
    security::{self, CredentialRedactor, RedactionState},
};
use chrono::Utc;
use parking_lot::Mutex;
use std::{
    collections::HashMap,
    path::PathBuf,
    process::Stdio,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter};
use thiserror::Error;
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::Command,
    sync::{OwnedSemaphorePermit, Semaphore},
};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

#[derive(Debug, Error)]
pub enum RunnerError {
    #[error("p4 CLI was not found; configure its path in Settings")]
    NotFound,
    #[error("invalid P4 command: {0}")]
    InvalidCommand(String),
    #[error("failed to launch p4")]
    Launch(#[from] std::io::Error),
    #[error("operation timed out")]
    Timeout,
    #[error("operation was cancelled while waiting to run")]
    Cancelled,
}

const MAX_P4_PROCESSES_PER_SERVER: usize = 4;
const MAX_CAPTURE_BYTES: usize = 64 * 1024 * 1024;

struct ServerLimits {
    all: Arc<Semaphore>,
    mutations: Arc<Semaphore>,
}

/// Holds the per-server mutation lane across a read/revalidate/write transaction.
pub struct MutationGuard {
    server: String,
    _permit: OwnedSemaphorePermit,
}

/// Keeps a logical multi-command operation cancellable between child P4
/// processes and until its caller has committed the final result.
pub struct OperationGroup {
    operation_id: String,
    generation: usize,
    token: CancellationToken,
    runner: Arc<P4Runner>,
}

impl OperationGroup {
    pub fn ensure_active(&self) -> Result<(), String> {
        if self.token.is_cancelled() {
            Err("operation was cancelled".into())
        } else {
            Ok(())
        }
    }
}

impl Drop for OperationGroup {
    fn drop(&mut self) {
        let mut operations = self.runner.operations.lock();
        let mut groups = self.runner.operation_groups.lock();
        if groups.get(&self.operation_id) == Some(&self.generation) {
            operations.remove(&self.operation_id);
            groups.remove(&self.operation_id);
            self.runner
                .pending_cancellations
                .lock()
                .remove(&self.operation_id);
        }
    }
}

impl ServerLimits {
    fn new() -> Self {
        Self {
            all: Arc::new(Semaphore::new(MAX_P4_PROCESSES_PER_SERVER)),
            mutations: Arc::new(Semaphore::new(1)),
        }
    }
}

pub struct P4Runner {
    operations: Mutex<HashMap<String, CancellationToken>>,
    operation_groups: Mutex<HashMap<String, usize>>,
    operation_group_sequence: AtomicUsize,
    pending_cancellations: Mutex<HashMap<String, Instant>>,
    server_limits: Mutex<HashMap<String, Arc<ServerLimits>>>,
    child_job: super::process::ChildProcessJob,
    logs: Arc<LogStore>,
    journal: Arc<OperationJournal>,
}

impl P4Runner {
    pub fn new(logs: Arc<LogStore>, journal: Arc<OperationJournal>) -> Self {
        Self {
            operations: Mutex::new(HashMap::new()),
            operation_groups: Mutex::new(HashMap::new()),
            operation_group_sequence: AtomicUsize::new(0),
            pending_cancellations: Mutex::new(HashMap::new()),
            server_limits: Mutex::new(HashMap::new()),
            child_job: super::process::ChildProcessJob::new()
                .expect("failed to create the P4 child process lifetime job"),
            logs,
            journal,
        }
    }

    pub fn cancel(&self, id: &str) {
        let operations = self.operations.lock();
        let prefix = format!("{id}:");
        for (operation_id, token) in operations.iter() {
            if operation_id == id || operation_id.starts_with(&prefix) {
                token.cancel();
            }
        }
        drop(operations);
        let mut pending = self.pending_cancellations.lock();
        pending.retain(|_, recorded| recorded.elapsed() < Duration::from_secs(60));
        if pending.len() >= 1_024 && !pending.contains_key(id) {
            if let Some(oldest) = pending
                .iter()
                .max_by_key(|(_, recorded)| recorded.elapsed())
                .map(|(operation_id, _)| operation_id.clone())
            {
                pending.remove(&oldest);
            }
        }
        pending.insert(id.to_owned(), Instant::now());
    }

    pub fn cancel_all(&self) -> usize {
        let operations = self.operations.lock();
        let count = operations.len();
        for token in operations.values() {
            token.cancel();
        }
        count
    }

    pub fn begin_operation_group(self: &Arc<Self>, operation_id: String) -> OperationGroup {
        let token = CancellationToken::new();
        let generation = self
            .operation_group_sequence
            .fetch_add(1, Ordering::Relaxed)
            .saturating_add(1);
        self.operations
            .lock()
            .insert(operation_id.clone(), token.clone());
        if self
            .pending_cancellations
            .lock()
            .remove(&operation_id)
            .is_some()
        {
            token.cancel();
        }
        self.operation_groups
            .lock()
            .insert(operation_id.clone(), generation);
        OperationGroup {
            operation_id,
            generation,
            token,
            runner: self.clone(),
        }
    }

    /// Records a local filesystem mutation without putting file content in the
    /// command log. Callers must finish the same id on every path.
    pub fn start_local_file_operation(
        &self,
        operation_id: &str,
        context: &P4Context,
    ) -> Result<(), String> {
        self.journal.start(
            operation_id,
            &crate::persistence::operation_journal::connection_id(
                &context.server,
                &context.user,
                &context.client,
            ),
            context.cwd.as_deref().unwrap_or_default(),
            OperationSource::Gui,
            OperationCategory::LocalFile,
        )
    }

    pub fn finish_local_file_operation(
        &self,
        operation_id: &str,
        succeeded: bool,
    ) -> Result<(), String> {
        self.journal.finish(
            operation_id,
            if succeeded {
                JournalState::Succeeded
            } else {
                JournalState::Failed
            },
            (!succeeded).then_some(OperationFailureKind::CommandFailure),
        )
    }

    fn token_for_operation(&self, operation_id: &str) -> CancellationToken {
        let operations = self.operations.lock();
        operations
            .iter()
            .filter(|(parent_id, _)| operation_id.starts_with(&format!("{parent_id}:")))
            .max_by_key(|(parent_id, _)| parent_id.len())
            .map(|(_, token)| token.child_token())
            .unwrap_or_default()
    }

    pub async fn run(
        &self,
        request: P4CommandRequest,
        app: Option<&AppHandle>,
    ) -> Result<OperationResult, RunnerError> {
        self.run_with_progress(request, app, None, None).await
    }

    pub async fn run_with_progress(
        &self,
        mut request: P4CommandRequest,
        app: Option<&AppHandle>,
        progress_total: Option<usize>,
        argument_input: Option<Vec<String>>,
    ) -> Result<OperationResult, RunnerError> {
        let id = request
            .operation_id
            .clone()
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        request.operation_id = Some(id.clone());
        let result = self
            .run_inner(request, app, progress_total, argument_input, false)
            .await;
        if result.is_err() {
            if let Some(token) = self.operations.lock().remove(&id) {
                token.cancel();
            }
            // Spawn/timeout/read errors must also finish the global progress indicator.
            emit(app, &event(&id, EventKind::Completed, Some("-1".into())));
        }
        result
    }

    pub async fn lock_mutations(&self, server: &str) -> MutationGuard {
        let limits = self.limits_for(server);
        let permit = limits
            .mutations
            .clone()
            .acquire_owned()
            .await
            .expect("P4 mutation semaphores are never closed");
        MutationGuard {
            server: server.to_owned(),
            _permit: permit,
        }
    }

    pub async fn run_with_mutation_guard(
        &self,
        request: P4CommandRequest,
        app: Option<&AppHandle>,
        progress_total: Option<usize>,
        guard: &MutationGuard,
    ) -> Result<OperationResult, RunnerError> {
        self.run_with_mutation_guard_and_input(request, app, progress_total, None, guard)
            .await
    }

    pub async fn run_with_mutation_guard_and_input(
        &self,
        mut request: P4CommandRequest,
        app: Option<&AppHandle>,
        progress_total: Option<usize>,
        argument_input: Option<Vec<String>>,
        guard: &MutationGuard,
    ) -> Result<OperationResult, RunnerError> {
        if request.context.server != guard.server || is_read_only_request(&request) {
            return Err(RunnerError::InvalidCommand(
                "mutation guard does not match a modifying command".into(),
            ));
        }
        let id = request
            .operation_id
            .clone()
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        request.operation_id = Some(id.clone());
        let result = self
            .run_inner(request, app, progress_total, argument_input, true)
            .await;
        if result.is_err() {
            if let Some(token) = self.operations.lock().remove(&id) {
                token.cancel();
            }
            emit(app, &event(&id, EventKind::Completed, Some("-1".into())));
        }
        result
    }

    async fn run_inner(
        &self,
        request: P4CommandRequest,
        app: Option<&AppHandle>,
        progress_total: Option<usize>,
        argument_input: Option<Vec<String>>,
        mutation_already_locked: bool,
    ) -> Result<OperationResult, RunnerError> {
        validate(&request, argument_input.as_deref())?;
        let input_for_redaction = argument_input
            .as_ref()
            .map(|values| values.join("\n"))
            .or_else(|| request.input.clone());
        let redactor = Arc::new(CredentialRedactor::for_command(
            &request.command,
            &request.args,
            input_for_redaction.as_deref(),
        ));
        let operation_id = request
            .operation_id
            .clone()
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        let executable = request
            .context
            .executable
            .as_ref()
            .map(PathBuf::from)
            .or_else(discover_p4)
            .ok_or(RunnerError::NotFound)?;
        let read_only = is_read_only_request(&request);
        let category = if read_only {
            OperationCategory::Query
        } else if request.command == "submit" {
            OperationCategory::Submit
        } else if matches!(
            request.command.as_str(),
            "change" | "reopen" | "shelve" | "unshelve"
        ) {
            OperationCategory::ChangelistMutation
        } else {
            OperationCategory::FileMutation
        };
        let connection = connection_id(
            &request.context.server,
            &request.context.user,
            &request.context.client,
        );
        let _ = self.journal.start(
            &operation_id,
            &connection,
            &request.context.client,
            request.source,
            category,
        );
        let token = self.token_for_operation(&operation_id);
        self.operations
            .lock()
            .insert(operation_id.clone(), token.clone());
        let started_at = Instant::now();
        let label = security::redact_command(&request.command, &request.args);
        let label = label.chars().take(512).collect::<String>();
        let queued = event_with_progress(
            &operation_id,
            EventKind::Queued,
            Some(label.clone()),
            Some(0.0),
        );
        emit(app, &queued);
        let mut events = vec![queued];

        let limits = self.limits_for(&request.context.server);
        let _mutation_permit = if read_only || mutation_already_locked {
            None
        } else {
            Some(
                match acquire(limits.mutations.clone(), &token, &operation_id, app).await {
                    Ok(permit) => permit,
                    Err(error) => {
                        self.operations.lock().remove(&operation_id);
                        let _ = self.journal.finish(
                            &operation_id,
                            JournalState::Cancelled,
                            Some(OperationFailureKind::Cancelled),
                        );
                        return Err(error);
                    }
                },
            )
        };
        let _process_permit = match acquire(limits.all.clone(), &token, &operation_id, app).await {
            Ok(permit) => permit,
            Err(error) => {
                self.operations.lock().remove(&operation_id);
                let _ = self.journal.finish(
                    &operation_id,
                    JournalState::Cancelled,
                    Some(OperationFailureKind::Cancelled),
                );
                return Err(error);
            }
        };

        let started =
            event_with_progress(&operation_id, EventKind::Started, Some(label), Some(2.0));
        emit(app, &started);
        events.push(started);
        let mut command = Command::from(super::process::command(executable));
        if !request.context.server.is_empty() {
            command.args(["-p", &request.context.server]);
        }
        if !request.context.user.is_empty() {
            command.args(["-u", &request.context.user]);
        }
        if !request.context.client.is_empty() {
            command.args(["-c", &request.context.client]);
        }
        if let Some(charset) = &request.context.charset {
            if !charset.is_empty() {
                command.args(["-C", charset]);
            }
        }
        if let Some(cwd) = &request.context.cwd {
            command.args(["-d", cwd]);
        }
        if matches!(request.output_mode, OutputMode::JsonLines) {
            command.args(["-ztag", "-Mj"]);
        }
        if argument_input.is_some() {
            command.args(["-b", "128", "-x", "-"]);
        }
        command
            .arg(&request.command)
            .args(&request.args)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .stdin(Stdio::piped())
            .kill_on_drop(true);
        apply_credential_environment(&mut command, &request.context);
        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(error) => {
                self.operations.lock().remove(&operation_id);
                let _ = self.journal.finish(
                    &operation_id,
                    JournalState::Failed,
                    Some(OperationFailureKind::CommandFailure),
                );
                return Err(RunnerError::Launch(error));
            }
        };
        if let Err(error) = self.child_job.assign(&child) {
            let _ = child.kill().await;
            let _ = child.wait().await;
            self.operations.lock().remove(&operation_id);
            let _ = self.journal.finish(
                &operation_id,
                JournalState::Failed,
                Some(OperationFailureKind::CommandFailure),
            );
            return Err(RunnerError::Launch(error));
        }
        let stdin_input = argument_input
            .map(|arguments| arguments.join("\n") + "\n")
            .or_else(|| request.input.clone());
        if let Some(input) = &stdin_input {
            if let Some(mut stdin) = child.stdin.take() {
                stdin.write_all(input.as_bytes()).await?;
                stdin.shutdown().await?;
            }
        }
        let stdout = child.stdout.take().expect("stdout piped");
        let stderr = child.stderr.take().expect("stderr piped");
        let progress = progress_total.map(|total| ProgressReporter::new(total, &operation_id, app));
        let output_budget = OutputBudget::new(token.clone());
        let stdout_id = operation_id.clone();
        let stdout_app = app.cloned();
        let stdout_budget = output_budget.clone();
        let stdout_redactor = redactor.clone();
        let stdout_task = tokio::spawn(async move {
            read_stream(
                stdout,
                stdout_id,
                EventKind::Stdout,
                stdout_app,
                progress,
                stdout_budget,
                stdout_redactor,
            )
            .await
        });
        let stderr_id = operation_id.clone();
        let stderr_app = app.cloned();
        let stderr_redactor = redactor.clone();
        let stderr_task = tokio::spawn(async move {
            read_stream(
                stderr,
                stderr_id,
                EventKind::Stderr,
                stderr_app,
                None,
                output_budget,
                stderr_redactor,
            )
            .await
        });
        let timeout = Duration::from_millis(request.timeout_ms.unwrap_or(120_000).min(600_000));
        let (status, was_cancelled) = tokio::select! {
            _ = token.cancelled() => {
                let _ = child.kill().await;
                let cancelled = event(&operation_id, EventKind::Cancelled, None);
                emit(app, &cancelled);
                events.push(cancelled);
                (child.wait().await?, true)
            }
            result = tokio::time::timeout(timeout, child.wait()) => match result {
                Ok(value) => (value?, false),
                Err(_) => {
                    let _ = child.kill().await;
                    let _ = child.wait().await;
                    self.operations.lock().remove(&operation_id);
                    let failure = timeout_failure(read_only);
                    let _ = self.journal.finish(
                        &operation_id,
                        JournalState::Failed,
                        Some(failure),
                    );
                    return Err(RunnerError::Timeout);
                }
            }
        };
        let stdout_events = stdout_task.await.unwrap_or_else(|_| Ok(Vec::new()))?;
        let stderr_events = stderr_task.await.unwrap_or_else(|_| Ok(Vec::new()))?;
        let stdout_text = event_text(&stdout_events);
        let stderr_text = event_text(&stderr_events);
        events.extend(stdout_events);
        events.extend(stderr_events);
        let exit_code = status.code().unwrap_or(-1);
        let completed = event_with_progress(
            &operation_id,
            EventKind::Completed,
            Some(exit_code.to_string()),
            (!was_cancelled && exit_code == 0).then_some(100.0),
        );
        emit(app, &completed);
        events.push(completed);
        let duration_ms = started_at.elapsed().as_millis() as u64;
        self.operations.lock().remove(&operation_id);
        let level = if exit_code != 0 {
            LogLevel::Error
        } else if !stderr_text.is_empty() {
            LogLevel::Warning
        } else {
            LogLevel::Info
        };
        let message = if !stderr_text.is_empty() {
            &stderr_text
        } else {
            &stdout_text
        };
        let _ = self.logs.push(LogEntry {
            id: Uuid::new_v4().to_string(),
            timestamp: Utc::now().to_rfc3339(),
            level: level.clone(),
            operation_id: operation_id.clone(),
            source: request.source,
            server: request.context.server.clone(),
            workspace: request.context.client.clone(),
            command: security::redact_command(&request.command, &request.args),
            message: redactor.redact(message.trim()),
            duration_ms: Some(duration_ms),
            repeat_count: 1,
        });
        if matches!(level, LogLevel::Warning | LogLevel::Error) {
            if let Some(app) = app {
                let _ = app.emit(
                    "diagnostic-alert",
                    serde_json::json!({
                        "operationId": operation_id,
                        "level": if level == LogLevel::Error { "error" } else { "warning" }
                    }),
                );
            }
        }
        let (journal_state, failure) = if was_cancelled {
            (
                JournalState::Cancelled,
                Some(OperationFailureKind::Cancelled),
            )
        } else if exit_code == 0 {
            (JournalState::Succeeded, None)
        } else {
            (JournalState::Failed, Some(journal_failure(&stderr_text)))
        };
        let _ = self.journal.finish(&operation_id, journal_state, failure);
        Ok(OperationResult {
            operation_id,
            exit_code,
            events,
            duration_ms,
        })
    }

    fn limits_for(&self, server: &str) -> Arc<ServerLimits> {
        self.server_limits
            .lock()
            .entry(server.to_owned())
            .or_insert_with(|| Arc::new(ServerLimits::new()))
            .clone()
    }
}

fn journal_failure(stderr: &str) -> OperationFailureKind {
    match crate::p4::connection::classify_connection_error(stderr) {
        ConnectionErrorCode::Disconnected => OperationFailureKind::Offline,
        ConnectionErrorCode::NetworkError | ConnectionErrorCode::CliMissing => {
            OperationFailureKind::ServerUnreachable
        }
        ConnectionErrorCode::AuthRequired | ConnectionErrorCode::TicketExpired => {
            OperationFailureKind::AuthExpired
        }
        ConnectionErrorCode::PermissionDenied => OperationFailureKind::PermissionDenied,
        _ => OperationFailureKind::CommandFailure,
    }
}

fn timeout_failure(read_only: bool) -> OperationFailureKind {
    if read_only {
        OperationFailureKind::ServerUnreachable
    } else {
        OperationFailureKind::Unknown
    }
}

fn apply_credential_environment(command: &mut Command, context: &P4Context) {
    // Never inherit ambient credential material. Explicit path-only context is
    // restored below, while passwords are reserved for ConnectionAdapter.
    command.env_remove("P4PASSWD");
    command.env_remove("P4TICKETS");
    command.env_remove("P4TRUST");
    if let Some(path) = &context.trust_path {
        command.env("P4TRUST", path);
    }
    if let Some(path) = &context.tickets_path {
        command.env("P4TICKETS", path);
    }
}

async fn acquire(
    semaphore: Arc<Semaphore>,
    token: &CancellationToken,
    operation_id: &str,
    app: Option<&AppHandle>,
) -> Result<OwnedSemaphorePermit, RunnerError> {
    tokio::select! {
        permit = semaphore.acquire_owned() => Ok(permit.expect("P4 semaphores are never closed")),
        _ = token.cancelled() => {
            let cancelled = event(operation_id, EventKind::Cancelled, None);
            emit(app, &cancelled);
            Err(RunnerError::Cancelled)
        },
    }
}

#[derive(Clone)]
struct ProgressReporter {
    // P4 CLI has no universal byte-level progress API. File actions therefore report
    // monotonic completed-work-item progress and reserve 95..100 for process teardown.
    expected: usize,
    seen: Arc<AtomicUsize>,
    last_percent: Arc<AtomicUsize>,
    operation_id: String,
    app: Option<AppHandle>,
}

#[derive(Clone)]
struct OutputBudget {
    bytes: Arc<AtomicUsize>,
    tripped: Arc<AtomicBool>,
    token: CancellationToken,
}

impl OutputBudget {
    fn new(token: CancellationToken) -> Self {
        Self {
            bytes: Arc::new(AtomicUsize::new(0)),
            tripped: Arc::new(AtomicBool::new(false)),
            token,
        }
    }

    fn accept(&self, bytes: usize) -> bool {
        let total = self.bytes.fetch_add(bytes, Ordering::Relaxed) + bytes;
        if total <= MAX_CAPTURE_BYTES {
            return true;
        }
        if !self.tripped.swap(true, Ordering::Relaxed) {
            self.token.cancel();
        }
        false
    }
}

impl ProgressReporter {
    fn new(total: usize, operation_id: &str, app: Option<&AppHandle>) -> Self {
        Self {
            expected: total.max(1),
            seen: Arc::new(AtomicUsize::new(0)),
            last_percent: Arc::new(AtomicUsize::new(2)),
            operation_id: operation_id.into(),
            app: app.cloned(),
        }
    }

    fn next_event(&self) -> Option<OperationEvent> {
        let seen = self.seen.fetch_add(1, Ordering::Relaxed) + 1;
        let percent = (2 + seen.saturating_mul(93) / self.expected).min(95);
        let previous = self.last_percent.fetch_max(percent, Ordering::Relaxed);
        if percent <= previous {
            return None;
        }
        let value = event_with_progress(
            &self.operation_id,
            EventKind::Progress,
            None,
            Some(percent as f32),
        );
        emit(self.app.as_ref(), &value);
        Some(value)
    }
}

async fn read_stream<R>(
    reader: R,
    operation_id: String,
    kind: EventKind,
    app: Option<AppHandle>,
    progress: Option<ProgressReporter>,
    output_budget: OutputBudget,
    redactor: Arc<CredentialRedactor>,
) -> std::io::Result<Vec<OperationEvent>>
where
    R: tokio::io::AsyncRead + Unpin,
{
    let mut lines = BufReader::new(reader).lines();
    let mut events: Vec<OperationEvent> = Vec::new();
    let mut redaction_state = RedactionState::default();
    while let Some(line) = lines.next_line().await? {
        if !output_budget.accept(line.len()) {
            if !events
                .iter()
                .any(|event| matches!(event.kind, EventKind::Error))
            {
                let value = event(
                    &operation_id,
                    EventKind::Error,
                    Some("P4 output exceeded the 64 MiB safety limit".into()),
                );
                emit(app.as_ref(), &value);
                events.push(value);
            }
            break;
        }
        let value = event(
            &operation_id,
            kind,
            Some(redactor.redact_line(&line, &mut redaction_state)),
        );
        if let Some(app) = &app {
            let _ = app.emit("operation-event", &value);
        }
        events.push(value);
        if let Some(value) = progress.as_ref().and_then(ProgressReporter::next_event) {
            events.push(value);
        }
    }
    Ok(events)
}

fn event_text(events: &[OperationEvent]) -> String {
    events
        .iter()
        .filter_map(|event| event.message.as_deref())
        .collect::<Vec<_>>()
        .join("\n")
}

fn validate(
    request: &P4CommandRequest,
    argument_input: Option<&[String]>,
) -> Result<(), RunnerError> {
    security::validate_generic_command(
        &request.command,
        &request.args,
        request.input.as_deref(),
        argument_input,
    )
    .map_err(|error| RunnerError::InvalidCommand(error.to_string()))?;
    if request.command.is_empty()
        || request.command.starts_with('-')
        || !request
            .command
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(RunnerError::InvalidCommand(request.command.clone()));
    }
    Ok(())
}

fn is_read_only(command: &str) -> bool {
    matches!(
        command,
        "branches"
            | "changes"
            | "clients"
            | "depots"
            | "describe"
            | "diff"
            | "diff2"
            | "dirs"
            | "filelog"
            | "files"
            | "fixes"
            | "fstat"
            | "have"
            | "help"
            | "info"
            | "jobs"
            | "opened"
            | "print"
            | "protects"
            | "sizes"
            | "streams"
            | "users"
            | "where"
    )
}

fn is_read_only_request(request: &P4CommandRequest) -> bool {
    is_read_only(&request.command)
        || (request.command == "change"
            && request
                .args
                .first()
                .is_some_and(|argument| argument == "-o"))
        || (request.command == "branch"
            && request
                .args
                .first()
                .is_some_and(|argument| argument == "-o"))
        || (request.command == "client"
            && request
                .args
                .first()
                .is_some_and(|argument| argument == "-o"))
        || (request.command == "user"
            && request
                .args
                .first()
                .is_some_and(|argument| argument == "-o"))
        || (request.command == "stream"
            && request
                .args
                .first()
                .is_some_and(|argument| argument == "-o"))
        || (matches!(request.command.as_str(), "unshelve" | "resolve" | "undo")
            && request.args.iter().any(|argument| argument == "-n"))
        || (request.command == "reconcile" && request.args.iter().any(|argument| argument == "-n"))
        || (request.command == "sync" && request.args.iter().any(|argument| argument == "-n"))
        || (request.command == "integrate" && request.args.iter().any(|argument| argument == "-n"))
}

fn event(id: &str, kind: EventKind, message: Option<String>) -> OperationEvent {
    event_with_progress(id, kind, message, None)
}

fn event_with_progress(
    id: &str,
    kind: EventKind,
    message: Option<String>,
    progress: Option<f32>,
) -> OperationEvent {
    OperationEvent {
        operation_id: id.into(),
        kind,
        message: message.map(|value| security::redact_text(&value)),
        progress,
        timestamp: Utc::now().to_rfc3339(),
    }
}

fn emit(app: Option<&AppHandle>, event: &OperationEvent) {
    if let Some(app) = app {
        let _ = app.emit("operation-event", event);
    }
}
fn discover_p4() -> Option<PathBuf> {
    let name = if cfg!(windows) { "p4.exe" } else { "p4" };
    std::env::split_paths(&std::env::var_os("PATH")?)
        .map(|dir| dir.join(name))
        .find(|path| path.is_file())
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        app::diagnostics::DiagnosticService, persistence::operation_journal::OperationJournalQuery,
    };
    #[test]
    fn rejects_password_arguments() {
        let request = P4CommandRequest {
            operation_id: None,
            source: OperationSource::Terminal,
            command: "info".into(),
            args: vec!["-P".into(), "secret".into()],
            context: P4Context::default(),
            output_mode: OutputMode::Text,
            timeout_ms: None,
            input: None,
        };
        assert!(validate(&request, None).is_err());
    }
    #[test]
    fn redacts_sensitive_output() {
        assert_eq!(
            security::redact_text("Ticket:abc123 P4PASSWD=next\npassword:second line"),
            "Ticket:[REDACTED] P4PASSWD=[REDACTED]\npassword:[REDACTED] line"
        );
    }

    #[test]
    fn blocks_authentication_commands_from_the_generic_runner() {
        let request = P4CommandRequest {
            operation_id: None,
            source: OperationSource::Gui,
            command: "trust".into(),
            args: vec!["-y".into()],
            context: P4Context::default(),
            output_mode: OutputMode::Text,
            timeout_ms: None,
            input: None,
        };
        assert!(validate(&request, None).is_err());
    }

    #[test]
    fn branch_reads_and_preview_are_read_only_but_branch_writes_are_not() {
        let request = |command: &str, args: &[&str]| P4CommandRequest {
            operation_id: None,
            source: OperationSource::Gui,
            command: command.into(),
            args: args.iter().map(|value| (*value).into()).collect(),
            context: P4Context::default(),
            output_mode: OutputMode::JsonLines,
            timeout_ms: None,
            input: None,
        };
        assert!(is_read_only_request(&request(
            "branches",
            &["-m", "5001", "-t"]
        )));
        assert!(is_read_only_request(&request(
            "branch",
            &["-o", "release-map"]
        )));
        assert!(is_read_only_request(&request(
            "integrate",
            &["-n", "-m", "101", "-b", "release-map"],
        )));
        assert!(!is_read_only_request(&request("branch", &["-i"])));
        assert!(!is_read_only_request(&request(
            "branch",
            &["-d", "release-map"]
        )));
        assert!(!is_read_only_request(&request(
            "integrate",
            &["-b", "release-map"],
        )));
    }

    #[test]
    fn strips_ambient_password_and_only_restores_explicit_credential_paths() {
        let mut command = Command::new("p4");
        apply_credential_environment(
            &mut command,
            &P4Context {
                tickets_path: Some("C:\\isolated\\tickets".into()),
                trust_path: Some("C:\\isolated\\trust".into()),
                ..Default::default()
            },
        );
        let environment = command
            .as_std()
            .get_envs()
            .map(|(key, value)| {
                (
                    key.to_string_lossy().into_owned(),
                    value.map(|value| value.to_string_lossy().into_owned()),
                )
            })
            .collect::<std::collections::HashMap<_, _>>();
        assert_eq!(environment.get("P4PASSWD"), Some(&None));
        assert_eq!(
            environment.get("P4TICKETS"),
            Some(&Some("C:\\isolated\\tickets".into()))
        );
        assert_eq!(
            environment.get("P4TRUST"),
            Some(&Some("C:\\isolated\\trust".into()))
        );
    }

    #[tokio::test]
    async fn credential_sentinel_never_crosses_events_results_or_persistence_boundaries() {
        const SENTINEL: &str = "P4DECK_SECRET_runner_e2e_50d3";
        let base = std::env::temp_dir().join(format!(
            "p4deck-credential-boundary-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&base).unwrap();
        let logs = Arc::new(LogStore::open(&base.join("logs.sqlite")).unwrap());
        let journal = Arc::new(OperationJournal::open(&base.join("journal.sqlite")).unwrap());
        let redactor = Arc::new(CredentialRedactor::for_command(
            "info",
            &["-P".into(), SENTINEL.into()],
            None,
        ));

        let (mut stdout_writer, stdout_reader) = tokio::io::duplex(4096);
        let stdout = format!(
            "Ticket: {SENTINEL}\n{{\"password\":\"{SENTINEL}\",\"digest\":\"0123456789abcdef0123456789abcdef\"}}\nAuthorization: Bearer {SENTINEL}\n"
        );
        stdout_writer.write_all(stdout.as_bytes()).await.unwrap();
        drop(stdout_writer);
        let token = CancellationToken::new();
        let stdout_events = read_stream(
            stdout_reader,
            "sentinel-op".into(),
            EventKind::Stdout,
            None,
            None,
            OutputBudget::new(token.clone()),
            redactor.clone(),
        )
        .await
        .unwrap();

        let (mut stderr_writer, stderr_reader) = tokio::io::duplex(4096);
        stderr_writer
            .write_all(format!("Password:\n{SENTINEL}\nP4TICKETS={SENTINEL}\n").as_bytes())
            .await
            .unwrap();
        drop(stderr_writer);
        let stderr_events = read_stream(
            stderr_reader,
            "sentinel-op".into(),
            EventKind::Stderr,
            None,
            None,
            OutputBudget::new(token),
            redactor.clone(),
        )
        .await
        .unwrap();

        let mut events = stdout_events;
        events.extend(stderr_events);
        let result = OperationResult {
            operation_id: "sentinel-op".into(),
            exit_code: 1,
            events,
            duration_ms: 1,
        };
        let result_json = serde_json::to_string(&result).unwrap();
        assert!(!result_json.contains(SENTINEL));
        assert!(result_json.contains("0123456789abcdef0123456789abcdef"));

        logs.push(LogEntry {
            id: "sentinel-log".into(),
            timestamp: Utc::now().to_rfc3339(),
            level: LogLevel::Error,
            operation_id: result.operation_id.clone(),
            source: OperationSource::Terminal,
            server: "fixture".into(),
            workspace: "workspace".into(),
            command: format!("p4 info -P{SENTINEL}"),
            message: format!("ticket={SENTINEL}"),
            duration_ms: Some(1),
            repeat_count: 1,
        })
        .unwrap();
        assert!(!serde_json::to_string(&logs.query(&LogQuery::default()))
            .unwrap()
            .contains(SENTINEL));
        let mut log_text = String::new();
        for entry in std::fs::read_dir(logs.directory()).unwrap() {
            let path = entry.unwrap().path();
            if path
                .extension()
                .is_some_and(|extension| extension == "jsonl")
            {
                log_text.push_str(&std::fs::read_to_string(path).unwrap());
            }
        }
        assert!(!log_text.contains(SENTINEL));

        journal
            .start(
                "sentinel-op",
                "connection",
                &format!("password={SENTINEL}"),
                OperationSource::Terminal,
                OperationCategory::Query,
            )
            .unwrap();
        let page = journal.query(&OperationJournalQuery::default()).unwrap();
        assert!(!serde_json::to_string(&page).unwrap().contains(SENTINEL));

        let diagnostics = DiagnosticService::new(base.join("exports"), logs, journal);
        let export = diagnostics
            .export(DiagnosticExportRequest::default())
            .unwrap();
        let exported = std::fs::read_to_string(export.path).unwrap();
        assert!(!exported.contains(SENTINEL));
        drop(diagnostics);
        std::fs::remove_dir_all(base).unwrap();
    }

    #[tokio::test]
    async fn blocked_commands_fail_before_executable_resolution_or_process_start() {
        let base = std::env::temp_dir().join(format!(
            "p4deck-block-before-spawn-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&base).unwrap();
        let logs = Arc::new(LogStore::open(&base.join("logs.sqlite")).unwrap());
        let journal = Arc::new(OperationJournal::open(&base.join("journal.sqlite")).unwrap());
        let runner = P4Runner::new(logs.clone(), journal.clone());
        let request = P4CommandRequest {
            operation_id: Some("blocked-op".into()),
            source: OperationSource::Terminal,
            command: "TiCkEtS".into(),
            args: vec![],
            context: P4Context {
                executable: Some(
                    base.join("does-not-exist.exe")
                        .to_string_lossy()
                        .into_owned(),
                ),
                ..Default::default()
            },
            output_mode: OutputMode::Text,
            timeout_ms: Some(10),
            input: None,
        };
        let error = runner.run(request, None).await.unwrap_err().to_string();
        assert!(error.contains("blocked in Terminal"));
        assert!(logs.query(&LogQuery::default()).is_empty());
        assert!(journal
            .query(&OperationJournalQuery::default())
            .unwrap()
            .records
            .is_empty());
        drop((runner, logs, journal));
        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn limits_each_server_and_serializes_mutations() {
        let limits = ServerLimits::new();
        let process_permits = (0..MAX_P4_PROCESSES_PER_SERVER)
            .map(|_| limits.all.clone().try_acquire_owned().unwrap())
            .collect::<Vec<_>>();
        assert!(limits.all.clone().try_acquire_owned().is_err());

        let mutation = limits.mutations.clone().try_acquire_owned().unwrap();
        assert!(limits.mutations.clone().try_acquire_owned().is_err());
        drop((process_permits, mutation));
    }

    #[test]
    fn unknown_commands_are_treated_as_mutations() {
        assert!(is_read_only("fstat"));
        assert!(!is_read_only("sync"));
        assert!(!is_read_only("some-future-command"));
    }

    #[test]
    fn timeout_after_a_mutation_starts_is_unknown_not_a_safe_retry() {
        assert_eq!(
            timeout_failure(false),
            OperationFailureKind::Unknown,
            "a timed-out mutation may have reached the server"
        );
        assert_eq!(
            timeout_failure(true),
            OperationFailureKind::ServerUnreachable
        );
    }

    #[test]
    fn change_spec_reads_do_not_block_the_submit_revalidation_lane() {
        let mut request = P4CommandRequest {
            operation_id: None,
            source: OperationSource::Gui,
            command: "change".into(),
            args: vec!["-o".into(), "42".into()],
            context: P4Context::default(),
            output_mode: OutputMode::JsonLines,
            timeout_ms: None,
            input: None,
        };
        assert!(is_read_only_request(&request));
        request.args[0] = "-d".into();
        assert!(!is_read_only_request(&request));
        request.command = "undo".into();
        request.args = vec!["-n".into(), "//depot/main/a#17".into()];
        assert!(is_read_only_request(&request));
        request.args.remove(0);
        assert!(!is_read_only_request(&request));
        request.command = "sync".into();
        request.args = vec!["-n".into(), "//depot/main/...#head".into()];
        assert!(is_read_only_request(&request));
        request.args.remove(0);
        assert!(!is_read_only_request(&request));
    }

    #[test]
    fn progress_is_monotonic_and_capped_before_completion() {
        let reporter = ProgressReporter::new(2, "op-1", None);
        assert_eq!(reporter.next_event().unwrap().progress, Some(48.0));
        assert_eq!(reporter.next_event().unwrap().progress, Some(95.0));
        assert!(reporter.next_event().is_none());
    }

    #[test]
    fn output_budget_cancels_oversized_commands() {
        let token = CancellationToken::new();
        let budget = OutputBudget::new(token.clone());
        assert!(budget.accept(MAX_CAPTURE_BYTES));
        assert!(!budget.accept(1));
        assert!(token.is_cancelled());
    }

    #[test]
    fn grouped_cancel_and_context_switch_cancel_registered_operations() {
        let directory =
            std::env::temp_dir().join(format!("p4deck-runner-cancel-all-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        let logs = Arc::new(LogStore::open(&directory.join("logs.sqlite")).unwrap());
        let journal =
            Arc::new(OperationJournal::open(&directory.join("operations.sqlite")).unwrap());
        let runner = P4Runner::new(logs, journal);
        let first = CancellationToken::new();
        let second = CancellationToken::new();
        runner
            .operations
            .lock()
            .insert("workspace-status:fstat".into(), first.clone());
        runner
            .operations
            .lock()
            .insert("second".into(), second.clone());
        runner.cancel("workspace-status");
        assert!(first.is_cancelled());
        assert!(!second.is_cancelled());
        assert_eq!(runner.cancel_all(), 2);
        assert!(second.is_cancelled());
        drop(runner);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn operation_group_cancels_current_and_future_children_until_commit() {
        let directory = std::env::temp_dir().join(format!(
            "p4deck-runner-operation-group-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&directory).unwrap();
        let logs = Arc::new(LogStore::open(&directory.join("logs.sqlite")).unwrap());
        let journal =
            Arc::new(OperationJournal::open(&directory.join("operations.sqlite")).unwrap());
        let runner = Arc::new(P4Runner::new(logs, journal));
        let group = runner.begin_operation_group("review-request".into());
        let first = runner.token_for_operation("review-request:fstat");
        runner.cancel("review-request");
        let later = runner.token_for_operation("review-request:print");
        assert!(first.is_cancelled());
        assert!(later.is_cancelled());
        assert_eq!(
            group.ensure_active().unwrap_err(),
            "operation was cancelled"
        );
        drop(group);
        assert!(!runner.operations.lock().contains_key("review-request"));
        runner.cancel("cancel-before-registration");
        let pre_cancelled = runner.begin_operation_group("cancel-before-registration".into());
        assert_eq!(
            pre_cancelled.ensure_active().unwrap_err(),
            "operation was cancelled"
        );
        drop(pre_cancelled);
        drop(runner);
        std::fs::remove_dir_all(directory).unwrap();
    }
}
