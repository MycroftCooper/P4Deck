//! User-click-only custom submit launcher. Tests inject both filesystem and process access.
//! No shell, CLI probing, environment rewriting, success inference, or automatic retry.
use super::company_submit::{self, ConnectionSnapshot, PlanRequest, ToolEvidence};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    process::{Child, Command, Stdio},
};

#[derive(Clone, Debug, Eq, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StartRequest {
    pub change_id: String,
    pub connection: ConnectionSnapshot,
    pub request_id: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum State {
    Started,
    NotStarted,
    OutcomeUnknown,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub request_id: String,
    pub change_id: String,
    pub state: State,
    pub executable_path: String,
    pub exit_code: Option<i32>,
    pub reason: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct LaunchPlan {
    executable: String,
    argv: Vec<String>,
    cwd: String,
}

trait Process: Send {
    // None = parent still running; Some = exited, submission/children remain unknown.
    fn poll(&mut self) -> Result<Option<Option<i32>>, ()>;
}
trait Platform {
    fn file(&self, path: &str) -> Result<bool, &'static str>;
    // Err is positive evidence that no process was created.
    fn spawn(&self, plan: &LaunchPlan) -> Result<Box<dyn Process>, &'static str>;
}
struct System;
impl Process for Child {
    fn poll(&mut self) -> Result<Option<Option<i32>>, ()> {
        self.try_wait()
            .map(|status| status.map(|s| s.code()))
            .map_err(|_| ())
    }
}
impl Platform for System {
    fn file(&self, path: &str) -> Result<bool, &'static str> {
        std::fs::metadata(path).map(|m| m.is_file()).map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                "toolMissing"
            } else {
                "toolMetadataUnavailable"
            }
        })
    }
    fn spawn(&self, plan: &LaunchPlan) -> Result<Box<dyn Process>, &'static str> {
        let mut command = Command::new(&plan.executable);
        command
            .args(&plan.argv)
            .current_dir(&plan.cwd)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        // Inherit environment unchanged. External tool owns its window and lifetime.
        // Do not attach to P4Runner's cancellation job, kill on drop, or run through a shell.
        command
            .spawn()
            .map(|child| Box::new(child) as Box<dyn Process>)
            .map_err(|_| "launchFailed")
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParentExited {
    pub request_id: String,
    pub change_id: String,
    pub connection: ConnectionSnapshot,
    pub exit_code: Option<i32>,
}

struct Entry {
    request: StartRequest,
    session: Session,
    process: Option<Box<dyn Process>>,
    exit_event: Option<ParentExited>,
    poll_error: bool,
    poll_error_reported: bool,
    admission: Option<crate::p4::runner::MutationGuard>,
}
#[derive(Default)]
struct Inner {
    entries: BTreeMap<String, Entry>,
    /// One session per changelist; different changelists may run concurrently.
    occupied: BTreeMap<String, String>,
    latest: Option<String>,
    watching: bool,
}
#[derive(Default)]
pub struct Host(Mutex<Inner>);

impl Host {
    pub fn prior(&self, request: &StartRequest) -> Result<Option<Session>, String> {
        let inner = self.0.lock();
        match inner.entries.get(&request.request_id) {
            Some(entry) if &entry.request != request => Err("requestIdConflict".into()),
            Some(entry) => Ok(Some(entry.session.clone())),
            None => Ok(None),
        }
    }
    pub fn start_admitted(
        &self,
        request: StartRequest,
        current: &ConnectionSnapshot,
        path: &str,
        guard: crate::p4::runner::MutationGuard,
    ) -> Result<Session, String> {
        let result = self.start(request.clone(), current, path);
        if result.as_ref().is_ok_and(|s| s.state == State::Started) {
            if let Some(entry) = self.0.lock().entries.get_mut(&request.request_id) {
                entry.admission = Some(guard);
            }
        } else {
            guard.finish(true)?;
        }
        result
    }
    pub fn release_ended_unknown(&self, request_id: &str) {
        let mut inner = self.0.lock();
        let ended = inner
            .entries
            .get(request_id)
            .is_some_and(|e| e.process.is_none() && e.session.state == State::OutcomeUnknown);
        if ended {
            if let Some(change_id) = inner
                .entries
                .get(request_id)
                .map(|e| e.session.change_id.clone())
            {
                if inner.occupied.get(&change_id).map(String::as_str) == Some(request_id) {
                    inner.occupied.remove(&change_id);
                }
            }
        }
    }
    pub fn start(
        &self,
        request: StartRequest,
        current: &ConnectionSnapshot,
        path: &str,
    ) -> Result<Session, String> {
        self.start_with(request, current, path, &System)
    }

    fn start_with(
        &self,
        request: StartRequest,
        current: &ConnectionSnapshot,
        path: &str,
        platform: &dyn Platform,
    ) -> Result<Session, String> {
        if request.request_id.is_empty()
            || request.request_id.len() > 128
            || !request
                .request_id
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_'))
        {
            return Err("invalidRequestId".into());
        }
        let mut inner = self.0.lock();
        if let Some(entry) = inner.entries.get_mut(&request.request_id) {
            if entry.request != request {
                return Err("requestIdConflict".into());
            }
            poll(entry);
            return Ok(entry.session.clone());
        }
        if let Some(existing) = inner.occupied.get(&change_key(&request.change_id)) {
            if existing != &request.request_id {
                return Err("duplicateChange".into());
            }
        }
        // Never evict an idempotency key and accidentally launch it again.
        if inner.entries.len() >= 1024 {
            return Err("requestLimitReached".into());
        }
        let mut session = Session {
            request_id: request.request_id.clone(),
            change_id: request.change_id.clone(),
            state: State::NotStarted,
            executable_path: path.into(),
            exit_code: None,
            reason: None,
        };
        let plan = make_plan(&request, current, path, platform);
        let mut process = None;
        match plan {
            Err(reason) => session.reason = Some(reason),
            Ok(plan) => {
                session.change_id = plan.argv[1].clone();
                // Reserve BEFORE crossing the process boundary. An unexpected unwind
                // must leave an unknown occupied session, never permit a second launch.
                session.state = State::OutcomeUnknown;
                session.reason = Some("launchOutcomeUnknown".into());
                inner
                    .occupied
                    .insert(session.change_id.clone(), request.request_id.clone());
                inner.latest = Some(request.request_id.clone());
                inner.entries.insert(
                    request.request_id.clone(),
                    Entry {
                        request: request.clone(),
                        session: session.clone(),
                        process: None,
                        exit_event: None,
                        poll_error: false,
                        poll_error_reported: false,
                        admission: None,
                    },
                );
                match platform.spawn(&plan) {
                    Ok(child) => {
                        session.state = State::Started;
                        session.reason = None;
                        process = Some(child);
                    }
                    Err(reason) => {
                        inner.occupied.remove(&session.change_id);
                        session.state = State::NotStarted;
                        session.reason = Some(reason.into());
                    }
                }
            }
        }
        inner.latest = Some(request.request_id.clone());
        inner.entries.insert(
            request.request_id.clone(),
            Entry {
                request,
                session: session.clone(),
                process,
                exit_event: None,
                poll_error: false,
                poll_error_reported: false,
                admission: None,
            },
        );
        Ok(session)
    }

    pub fn status(&self) -> Option<Session> {
        let mut inner = self.0.lock();
        let id = inner
            .latest
            .clone()
            .or_else(|| inner.occupied.values().next().cloned())?;
        let entry = inner.entries.get_mut(&id)?;
        poll(entry);
        let finished = entry.process.is_none();
        let session = entry.session.clone();
        if finished {
            release_occupancy(&mut inner, &id);
        }
        Some(session)
    }

    /// 供关闭路径接入（CLOSE/DIRECT）读取启动与未知事实；当前尚无调用点。
    #[allow(dead_code)]
    pub fn close_facts(&self) -> (bool, bool) {
        match self.status().map(|s| s.state) {
            Some(State::Started) => (true, true),
            Some(State::OutcomeUnknown) => (false, true),
            _ => (false, false),
        }
    }
}

fn poll(entry: &mut Entry) {
    let Some(child) = entry.process.as_mut() else {
        return;
    };
    match child.poll() {
        Ok(None) => {}
        Ok(Some(exit_code)) => {
            entry.session.state = State::OutcomeUnknown;
            entry.session.exit_code = exit_code;
            entry.session.reason = Some("submissionAndChildLifetimeUnknown".into());
            entry.exit_event = Some(ParentExited {
                request_id: entry.request.request_id.clone(),
                change_id: entry.session.change_id.clone(),
                connection: entry.request.connection.clone(),
                exit_code,
            });
            entry.process = None; // Child drop does not kill any process.
            entry.admission.take(); // Leave durable unknown; runtime occupancy has ended.
        }
        Err(()) => {
            entry.session.state = State::OutcomeUnknown;
            entry.session.reason = Some("parentStatusUnavailable".into());
            if !entry.poll_error_reported {
                entry.poll_error = true;
                entry.poll_error_reported = true;
            }
            // Keep process and admission: polling failure is not evidence of exit.
        }
    }
}

impl Host {
    fn begin_watch(&self) -> bool {
        let mut inner = self.0.lock();
        if inner.watching
            || !inner
                .entries
                .values()
                .any(|e| e.process.is_some() || e.exit_event.is_some() || e.poll_error)
        {
            return false;
        }
        inner.watching = true;
        true
    }
    fn observe(&self) -> (Vec<ParentExited>, Vec<String>, bool) {
        let mut inner = self.0.lock();
        let mut events = Vec::new();
        let mut errors = Vec::new();
        for entry in inner.entries.values_mut() {
            poll(entry);
            if let Some(event) = entry.exit_event.take() {
                events.push(event);
            }
            if std::mem::take(&mut entry.poll_error) {
                errors.push(entry.request.request_id.clone());
            }
        }
        let finished: Vec<String> = inner
            .entries
            .values()
            .filter(|entry| entry.process.is_none())
            .map(|entry| entry.request.request_id.clone())
            .collect();
        for request_id in finished {
            release_occupancy(&mut inner, &request_id);
        }
        let active = inner.entries.values().any(|e| e.process.is_some());
        if !active {
            inner.watching = false;
        }
        (events, errors, active)
    }
}

// Single runtime-owned observer, independent of any modal or status subscriber.
// No P4 calls; try_wait is nonblocking. Runtime shutdown drops this task without killing the tool.
pub fn watch(host: std::sync::Arc<Host>, app: tauri::AppHandle) {
    use tauri::{Emitter, Manager};
    if !host.begin_watch() {
        return;
    }
    tauri::async_runtime::spawn(async move {
        loop {
            let (events, mut errors, active) = host.observe();
            for event in events {
                if app.emit("custom-submit-parent-exited", &event).is_err() {
                    errors.push(event.request_id);
                }
            }
            for request_id in errors {
                if let Some(state) = app.try_state::<crate::AppState>() {
                    let _ = state.logs.push(crate::domain::LogEntry {
                        id: uuid::Uuid::new_v4().to_string(), timestamp: chrono::Utc::now().to_rfc3339(),
                        level: crate::domain::LogLevel::Error, operation_id: request_id,
                        source: crate::domain::OperationSource::Gui, server: String::new(), workspace: String::new(),
                        command: "custom-submit-parent-observer".into(),
                        message: "Parent status or exit notification unavailable; submission remains unknown; no automatic retry.".into(),
                        duration_ms: None, repeat_count: 1,
                    });
                }
            }
            if !active {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        }
    });
}

fn release_occupancy(inner: &mut Inner, request_id: &str) {
    let Some(change_id) = inner
        .entries
        .get(request_id)
        .map(|e| e.session.change_id.clone())
    else {
        return;
    };
    if inner.occupied.get(&change_id).map(String::as_str) == Some(request_id) {
        inner.occupied.remove(&change_id);
    }
}

fn change_key(value: &str) -> String {
    let trimmed = value.trim_start_matches('0');
    if trimmed.is_empty() {
        "0".into()
    } else {
        trimmed.into()
    }
}

fn make_plan(
    request: &StartRequest,
    current: &ConnectionSnapshot,
    path: &str,
    platform: &dyn Platform,
) -> Result<LaunchPlan, String> {
    if &request.connection != current {
        return Err("connectionChanged".into());
    }
    if path.trim().is_empty() {
        return Err("notConfigured".into());
    }
    if !company_submit::absolute_exe(path) {
        return Err("invalidExecutablePath".into());
    }
    if !platform.file(path).map_err(str::to_owned)? {
        return Err("toolNotFile".into());
    }
    let plan = company_submit::plan(
        &PlanRequest {
            change_ids: vec![request.change_id.clone()],
            executable_path: path.into(),
            connection: request.connection.clone(),
        },
        current,
        &ToolEvidence::File {
            path: path.into(),
            identity: "metadata-file".into(),
        },
    )
    .map_err(|e| {
        serde_json::to_value(e)
            .unwrap()
            .as_str()
            .unwrap()
            .to_owned()
    })?;
    let separator = path.rfind(['\\', '/']).ok_or("invalidExecutablePath")?;
    let cwd = if separator == 2 {
        path[..3].into()
    } else {
        path[..separator].into()
    };
    Ok(LaunchPlan {
        executable: path.into(),
        argv: plan.argv,
        cwd,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };
    struct Fake {
        count: Arc<AtomicUsize>,
        file: Result<bool, &'static str>,
        failure: bool,
        exit: Option<Option<i32>>,
    }
    struct FakeChild(Option<Option<i32>>);
    impl Process for FakeChild {
        fn poll(&mut self) -> Result<Option<Option<i32>>, ()> {
            Ok(self.0)
        }
    }
    impl Platform for Fake {
        fn file(&self, _: &str) -> Result<bool, &'static str> {
            self.file
        }
        fn spawn(&self, p: &LaunchPlan) -> Result<Box<dyn Process>, &'static str> {
            assert_eq!(p.executable, "C:\\Synthetic Tool\\submit.exe");
            assert_eq!(p.cwd, "C:\\Synthetic Tool");
            assert_eq!(
                p.argv,
                [
                    "-c",
                    "42",
                    "-p",
                    "fixture.invalid:1666",
                    "-u",
                    "mock-user",
                    "-C",
                    "mock-client"
                ]
            );
            self.count.fetch_add(1, Ordering::SeqCst);
            if self.failure {
                Err("launchFailed")
            } else {
                Ok(Box::new(FakeChild(self.exit)))
            }
        }
    }
    fn fixture() -> (Host, StartRequest, Fake) {
        (
            Host::default(),
            StartRequest {
                request_id: "click-1".into(),
                change_id: "00042".into(),
                connection: ConnectionSnapshot {
                    profile_id: "fixture-profile".into(),
                    generation: "9007199254740993".into(),
                    server: "fixture.invalid:1666".into(),
                    user: "mock-user".into(),
                    client: "mock-client".into(),
                },
            },
            Fake {
                count: Arc::new(AtomicUsize::new(0)),
                file: Ok(true),
                failure: false,
                exit: None,
            },
        )
    }
    const PATH: &str = "C:\\Synthetic Tool\\submit.exe";
    #[test]
    fn concurrent_windows_share_one_reservation() {
        let (h, r, f) = fixture();
        let barrier = std::sync::Barrier::new(2);
        let outcomes = std::thread::scope(|scope| {
            let run = |id: &str| {
                let mut request = r.clone();
                request.request_id = id.into();
                barrier.wait();
                h.start_with(request, &r.connection, PATH, &f)
            };
            let first = scope.spawn(move || run("window-1"));
            let second = scope.spawn(move || run("window-2"));
            [first.join().unwrap(), second.join().unwrap()]
        });
        assert_eq!(outcomes.iter().filter(|r| r.is_ok()).count(), 1);
        assert_eq!(f.count.load(Ordering::SeqCst), 1);
    }
    #[test]
    fn different_changelists_run_concurrently_same_change_stays_exclusive() {
        struct Any {
            count: Arc<AtomicUsize>,
        }
        impl Platform for Any {
            fn file(&self, _: &str) -> Result<bool, &'static str> {
                Ok(true)
            }
            fn spawn(&self, _: &LaunchPlan) -> Result<Box<dyn Process>, &'static str> {
                self.count.fetch_add(1, Ordering::SeqCst);
                Ok(Box::new(FakeChild(None)))
            }
        }
        let (h, r, _) = fixture();
        let platform = Any {
            count: Arc::new(AtomicUsize::new(0)),
        };
        let first = h
            .start_with(r.clone(), &r.connection, PATH, &platform)
            .unwrap();
        assert_eq!(first.state, State::Started);
        let mut other = r.clone();
        other.request_id = "click-43".into();
        other.change_id = "43".into();
        let second = h.start_with(other, &r.connection, PATH, &platform).unwrap();
        assert_eq!(second.state, State::Started);
        assert_eq!(second.change_id, "43");
        assert_eq!(platform.count.load(Ordering::SeqCst), 2);
        let mut duplicate = r.clone();
        duplicate.request_id = "click-42-again".into();
        assert_eq!(
            h.start_with(duplicate, &r.connection, PATH, &platform)
                .unwrap_err(),
            "duplicateChange"
        );
        assert_eq!(platform.count.load(Ordering::SeqCst), 2);
    }
    #[test]
    fn unexpected_launch_unwind_retains_unknown_reservation() {
        struct Uncertain;
        impl Platform for Uncertain {
            fn file(&self, _: &str) -> Result<bool, &'static str> {
                Ok(true)
            }
            fn spawn(&self, _: &LaunchPlan) -> Result<Box<dyn Process>, &'static str> {
                panic!("synthetic uncertain boundary");
            }
        }
        let (h, r, f) = fixture();
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            h.start_with(r.clone(), &r.connection, PATH, &Uncertain)
        }))
        .is_err());
        // Until observed/polled, the same CL stays reserved (no second window).
        let mut next = r.clone();
        next.request_id = "new-click".into();
        assert_eq!(
            h.start_with(next.clone(), &r.connection, PATH, &f)
                .unwrap_err(),
            "duplicateChange"
        );
        assert_eq!(h.status().unwrap().state, State::OutcomeUnknown);
        assert_eq!(h.close_facts(), (false, true));
        // Polling observed the end; the CL is free again (manual reopen, never auto-retry).
        assert_eq!(
            h.start_with(next, &r.connection, PATH, &f).unwrap().state,
            State::Started
        );
        assert_eq!(f.count.load(Ordering::SeqCst), 1);
    }
    #[test]
    fn duplicate_and_conflicting_requests_never_spawn_twice() {
        let (h, r, f) = fixture();
        let first = h.start_with(r.clone(), &r.connection, PATH, &f).unwrap();
        assert_eq!(first.state, State::Started);
        assert_eq!(
            h.start_with(r.clone(), &r.connection, PATH, &f).unwrap(),
            first
        );
        let mut other = r.clone();
        other.change_id = "43".into();
        assert_eq!(
            h.start_with(other, &r.connection, PATH, &f).unwrap_err(),
            "requestIdConflict"
        );
        let mut other = r.clone();
        other.request_id = "click-2".into();
        assert_eq!(
            h.start_with(other, &r.connection, PATH, &f).unwrap_err(),
            "duplicateChange"
        );
        assert_eq!(f.count.load(Ordering::SeqCst), 1);
        assert_eq!(h.close_facts(), (true, true));
    }
    #[test]
    fn absent_bad_path_metadata_and_bad_cl_do_not_spawn_or_fallback() {
        for (path, id, reason) in [
            ("  ", "42", "notConfigured"),
            ("relative.exe", "42", "invalidExecutablePath"),
            (PATH, "default", "invalidChangeId"),
            (PATH, "42,43", "invalidChangeId"),
            (PATH, "0", "invalidChangeId"),
            (PATH, "18446744073709551616", "invalidChangeId"),
        ] {
            let (h, mut r, f) = fixture();
            r.change_id = id.into();
            let result = h.start_with(r.clone(), &r.connection, path, &f).unwrap();
            assert_eq!(result.state, State::NotStarted);
            assert_eq!(result.reason.as_deref(), Some(reason));
            assert_eq!(f.count.load(Ordering::SeqCst), 0);
        }
        for evidence in [
            Ok(false),
            Err("toolMissing"),
            Err("toolMetadataUnavailable"),
        ] {
            let (h, r, mut f) = fixture();
            f.file = evidence;
            assert_eq!(
                h.start_with(r.clone(), &r.connection, PATH, &f)
                    .unwrap()
                    .state,
                State::NotStarted
            );
            assert_eq!(f.count.load(Ordering::SeqCst), 0);
        }
    }
    #[test]
    fn changed_connection_or_config_never_uses_click_supplied_path() {
        let (h, r, f) = fixture();
        let mut current = r.connection.clone();
        current.generation = "9007199254740994".into();
        assert_eq!(
            h.start_with(r.clone(), &current, PATH, &f)
                .unwrap()
                .reason
                .as_deref(),
            Some("connectionChanged")
        );
        assert_eq!(f.count.load(Ordering::SeqCst), 0);
        let (h, r, f) = fixture();
        assert_eq!(
            h.start_with(r.clone(), &r.connection, "changed-path", &f)
                .unwrap()
                .reason
                .as_deref(),
            Some("invalidExecutablePath")
        );
    }
    #[test]
    fn failed_creation_is_idempotent_but_fresh_click_can_retry() {
        let (h, mut r, mut f) = fixture();
        f.failure = true;
        assert_eq!(
            h.start_with(r.clone(), &r.connection, PATH, &f)
                .unwrap()
                .state,
            State::NotStarted
        );
        h.start_with(r.clone(), &r.connection, PATH, &f).unwrap();
        assert_eq!(f.count.load(Ordering::SeqCst), 1);
        r.request_id = "click-2".into();
        f.failure = false;
        assert_eq!(
            h.start_with(r.clone(), &r.connection, PATH, &f)
                .unwrap()
                .state,
            State::Started
        );
    }
    #[test]
    fn any_parent_exit_stays_unknown_but_frees_the_changelist() {
        for code in [Some(0), Some(1), None] {
            let (h, r, mut f) = fixture();
            f.exit = Some(code);
            h.start_with(r.clone(), &r.connection, PATH, &f).unwrap();
            let state = h.status().unwrap();
            assert_eq!(state.state, State::OutcomeUnknown);
            assert_eq!(state.exit_code, code);
            assert_eq!(h.close_facts(), (false, true));
            let mut next = r.clone();
            next.request_id = "later-click".into();
            // status() observed the exit, so the same CL may be reopened manually.
            assert_eq!(
                h.start_with(next, &r.connection, PATH, &f).unwrap().state,
                State::Started
            );
        }
    }
    #[test]
    fn wire_rejects_caller_path_and_preserves_config_compatibility() {
        let (_, r, _) = fixture();
        let raw = serde_json::json!({"requestId":"click", "changeId":"42", "connection":r.connection, "executablePath":PATH});
        assert!(serde_json::from_value::<StartRequest>(raw).is_err());
        let old = serde_json::json!({"server":"fixture.invalid", "user":"mock", "client":"mock"});
        let mut context: crate::domain::P4Context = serde_json::from_value(old).unwrap();
        assert_eq!(context.custom_submit_executable_path, "");
        context.custom_submit_executable_path = PATH.into();
        let restored: crate::domain::P4Context =
            serde_json::from_slice(&serde_json::to_vec(&context).unwrap()).unwrap();
        assert_eq!(restored, context);
    }
    #[test]
    fn exit_event_is_once_and_uses_original_connection_even_after_status_poll() {
        let (host, request, mut fake) = fixture();
        fake.exit = Some(Some(0));
        host.start_with(request.clone(), &request.connection, PATH, &fake)
            .unwrap();
        assert!(host.begin_watch());
        assert!(!host.begin_watch());
        assert_eq!(host.status().unwrap().state, State::OutcomeUnknown);
        let (events, errors, active) = host.observe();
        assert!(!active);
        assert!(errors.is_empty());
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].connection, request.connection);
        assert_eq!(events[0].request_id, request.request_id);
        assert_eq!(events[0].change_id, "42");
        assert_eq!(events[0].exit_code, Some(0));
        assert!(host.observe().0.is_empty());
        host.status();
        assert!(!host.begin_watch());
        let mut next = request.clone();
        next.request_id = "second".into();
        // observe() saw the exit: the CL is free for a manual reopen.
        assert_eq!(
            host.start_with(next, &request.connection, PATH, &fake)
                .unwrap()
                .state,
            State::Started
        );
        assert_eq!(fake.count.load(Ordering::SeqCst), 2);
    }
    #[test]
    fn running_and_failed_launch_never_emit_exit() {
        let (host, request, mut fake) = fixture();
        host.start_with(request.clone(), &request.connection, PATH, &fake)
            .unwrap();
        assert!(host.begin_watch());
        for _ in 0..3 {
            let (e, errors, active) = host.observe();
            assert!(e.is_empty() && errors.is_empty() && active);
        }
        let other = Host::default();
        fake.failure = true;
        other
            .start_with(request.clone(), &request.connection, PATH, &fake)
            .unwrap();
        assert!(!other.begin_watch());
        assert!(other.observe().0.is_empty());
    }
    #[test]
    fn poll_error_is_logged_once_and_never_claims_parent_exit() {
        struct Broken;
        impl Process for Broken {
            fn poll(&mut self) -> Result<Option<Option<i32>>, ()> {
                Err(())
            }
        }
        let (host, request, fake) = fixture();
        host.start_with(request.clone(), &request.connection, PATH, &fake)
            .unwrap();
        host.0
            .lock()
            .entries
            .get_mut(&request.request_id)
            .unwrap()
            .process = Some(Box::new(Broken));
        assert!(host.begin_watch());
        let (events, errors, active) = host.observe();
        assert!(events.is_empty());
        assert_eq!(errors, vec![request.request_id]);
        assert!(
            active,
            "poll failure must retain runtime occupancy until observed exit"
        );
        assert!(host.observe().1.is_empty());
        assert_eq!(host.status().unwrap().state, State::OutcomeUnknown);
    }
    #[test]
    fn unknown_exit_code_is_still_parent_exit_not_submit_success() {
        let (host, request, mut fake) = fixture();
        fake.exit = Some(None);
        host.start_with(request.clone(), &request.connection, PATH, &fake)
            .unwrap();
        let (events, _, active) = host.observe();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].exit_code, None);
        assert!(!active);
        assert_eq!(host.status().unwrap().state, State::OutcomeUnknown);
    }
}
