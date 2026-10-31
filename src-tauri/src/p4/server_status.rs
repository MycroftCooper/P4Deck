//! Passive client observations only. No CLI calls, timers, credentials or persistence.
use crate::domain::{OperationSource, P4CommandRequest, P4Context};
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;

pub const TTL: u64 = 60_000;
const MIN_SAMPLES: usize = 5;
const MAX_SAMPLES: usize = 8;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Scope {
    pub profile_id: Option<String>,
    pub generation: String,
    pub server: String,
    pub user: String,
    pub client: String,
}
impl Scope {
    pub fn new(profile_id: Option<String>, generation: u64, c: &P4Context) -> Self {
        Self {
            profile_id,
            generation: generation.to_string(),
            server: c.server.clone(),
            user: c.user.clone(),
            client: c.client.clone(),
        }
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub scope: Scope,
    pub revision: String,
    pub observed_at: Option<u64>,
    pub expires_at: Option<u64>,
    pub connection: &'static str,
    pub access: &'static str,
    pub quality: &'static str,
    pub sample_count: usize,
    /// Most recent completed remote request duration, independent of bucketed samples.
    pub last_elapsed_ms: Option<u64>,
    pub reason_code: &'static str,
    pub source: &'static str,
    pub connection_source: &'static str,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    Success,
    Login,
    Permission,
    Network,
    Timeout,
    Other,
}
#[derive(Default)]
struct Bucket {
    samples: VecDeque<(u64, u64)>,
    timeouts: VecDeque<u64>,
    quality: Option<&'static str>,
}
impl Bucket {
    fn expire(&mut self, now: u64) {
        self.samples.retain(|(at, _)| now.saturating_sub(*at) < TTL);
        self.timeouts.retain(|at| now.saturating_sub(*at) < TTL);
        if self.samples.len() < MIN_SAMPLES {
            self.quality = None;
        }
    }
    fn observe(&mut self, now: u64, elapsed: u64, result: Outcome) {
        self.expire(now);
        if result == Outcome::Timeout {
            self.timeouts.push_back(now);
            while self.timeouts.len() > 3 {
                self.timeouts.pop_front();
            }
            return;
        }
        self.timeouts.clear();
        if result != Outcome::Success {
            return;
        }
        self.samples.push_back((now, elapsed));
        while self.samples.len() > MAX_SAMPLES {
            self.samples.pop_front();
        }
        if self.samples.len() < MIN_SAMPLES {
            return;
        }
        let mut sorted: Vec<_> = self.samples.iter().map(|(_, ms)| *ms).collect();
        sorted.sort_unstable();
        let median = sorted[sorted.len() / 2];
        if median >= 2000 {
            self.quality = Some("slow");
        } else if median <= 1000 {
            self.quality = Some("smooth");
        }
    }
}
#[derive(Default)]
pub struct Store {
    scope: Option<Scope>,
    revision: u64,
    connection: Option<(u64, &'static str)>,
    access: Option<(u64, &'static str)>,
    buckets: [Bucket; 3],
    last: Option<Snapshot>,
    connection_source: Option<&'static str>,
    last_timing: Option<(u64, u64)>,
}
impl Store {
    pub fn select(&mut self, scope: Scope) {
        if self.scope.as_ref() != Some(&scope) {
            self.scope = Some(scope);
            self.connection = None;
            self.connection_source = None;
            self.access = None;
            self.buckets = Default::default();
            self.last_timing = None;
        }
    }
    pub fn observe(
        &mut self,
        scope: &Scope,
        now: u64,
        elapsed: u64,
        bucket: Option<usize>,
        outcome: Outcome,
        access_success: bool,
    ) {
        if self.scope.as_ref() != Some(scope) {
            return;
        }
        if matches!(
            outcome,
            Outcome::Success | Outcome::Login | Outcome::Permission | Outcome::Network
        ) {
            self.connection_source = Some("passive");
        }
        match outcome {
            Outcome::Success | Outcome::Login | Outcome::Permission => {
                self.connection = Some((now, "reachable"))
            }
            Outcome::Network => self.connection = Some((now, "failed")),
            _ => {}
        }

        match outcome {
            Outcome::Login => self.access = Some((now, "loginRequired")),
            Outcome::Permission => self.access = Some((now, "permissionDenied")),
            Outcome::Success if access_success => self.access = Some((now, "ok")),
            _ => {}
        }
        if let Some(i) = bucket.filter(|i| *i < 3) {
            self.buckets[i].observe(now, elapsed, outcome);
        }
        // Every completed remote request contributes a visible "last request" number.
        self.last_timing = Some((now, elapsed));
    }
    pub fn snapshot(&mut self, scope: Scope, now: u64) -> Snapshot {
        self.select(scope.clone());
        let ever = self.connection.is_some()
            || self.access.is_some()
            || self.last_timing.is_some()
            || self
                .buckets
                .iter()
                .any(|b| !b.samples.is_empty() || !b.timeouts.is_empty());
        for b in &mut self.buckets {
            b.expire(now);
        }
        let fresh =
            |f: Option<(u64, &'static str)>| f.filter(|(at, _)| now.saturating_sub(*at) < TTL);
        let connection = fresh(self.connection);
        let access = fresh(self.access);
        let last_timing = self
            .last_timing
            .filter(|(at, _)| now.saturating_sub(*at) < TTL);
        let mut quality = "unknown";
        let mut sample_count = 0;
        let mut times = Vec::new();
        for (at, _) in connection.into_iter().chain(access) {
            times.push(at);
        }
        if let Some((at, _)) = last_timing {
            times.push(at);
        }
        for b in &self.buckets {
            sample_count += b.samples.len();
            times.extend(b.samples.iter().map(|(at, _)| *at));
            times.extend(b.timeouts.iter().copied());
            let q = if b.timeouts.len() >= 3 {
                "persistentTimeout"
            } else {
                b.quality.unwrap_or("unknown")
            };
            if rank(q) > rank(quality) {
                quality = q;
            }
        }
        let conn = connection.map_or("unknown", |(_, v)| v);
        let access = access.map_or("unknown", |(_, v)| v);
        let reason = match (conn, access, quality) {
            ("failed", _, _) => "networkFailure",
            (_, "loginRequired", _) => "loginRequired",
            (_, "permissionDenied", _) => "permissionDenied",
            (_, _, "persistentTimeout") => "repeatedTimeout",
            (_, _, "slow") => "slowResponses",
            (_, _, "smooth") => "normalResponses",
            _ if sample_count > 0 => "insufficientSamples",
            _ if !times.is_empty() => "responseObserved",
            _ if ever => "expired",
            _ => "noSamples",
        };
        let mut snapshot = Snapshot {
            scope,
            revision: String::new(),
            observed_at: times.iter().max().copied(),
            expires_at: times.iter().min().map(|at| at.saturating_add(TTL)),
            connection: conn,
            access,
            quality,
            sample_count,
            last_elapsed_ms: last_timing.map(|(_, ms)| ms),
            reason_code: reason,
            source: "passive",
            connection_source: if connection.is_some() {
                self.connection_source.unwrap_or("passive")
            } else {
                "unknown"
            },
        };
        let mut previous = self.last.clone();
        if let Some(p) = previous.as_mut() {
            p.revision.clear();
        }
        if previous.as_ref() != Some(&snapshot) {
            self.revision = self.revision.saturating_add(1);
        }
        snapshot.revision = self.revision.to_string();
        self.last = Some(snapshot.clone());
        snapshot
    }
}
fn rank(q: &str) -> u8 {
    match q {
        "persistentTimeout" => 3,
        "slow" => 2,
        "smooth" => 1,
        _ => 0,
    }
}

pub struct Observer {
    contexts: std::sync::Arc<super::context::ContextStore>,
    store: parking_lot::Mutex<Store>,
    app: tauri::AppHandle,
    pub manual: ManualGate,
}

/// One observation to fold into its scope. Grouped because a partial observation is not
/// meaningful: either the whole tuple is recorded for the active scope, or nothing is.
pub struct Observation<'a> {
    pub scope: &'a Scope,
    pub request: &'a P4Context,
    pub elapsed: u64,
    pub bucket: Option<usize>,
    pub outcome: Outcome,
    pub access_success: bool,
    pub manual: bool,
}
fn checked_launch<T>(
    expected: &Scope,
    current: &Scope,
    request: &P4Context,
    context: &P4Context,
    launch: impl FnOnce() -> T,
) -> Option<T> {
    (expected == current && request == context).then(launch)
}
impl Observer {
    /// Holds the context read lock through actual synchronous process creation.
    pub fn launch_manual<T>(
        &self,
        expected: &Scope,
        request: &P4Context,
        launch: impl FnOnce() -> T,
    ) -> Option<T> {
        self.contexts.with_custom_submit_context(|p, g, c| {
            checked_launch(expected, &Scope::new(p, g, c), request, c, launch)
        })
    }
    pub fn new(
        contexts: std::sync::Arc<super::context::ContextStore>,
        app: tauri::AppHandle,
    ) -> Self {
        Self {
            contexts,
            store: Default::default(),
            app,
            manual: Default::default(),
        }
    }
    pub fn manual_context(&self, expected: &Scope) -> Option<P4Context> {
        self.contexts.with_custom_submit_context(|p, g, c| {
            (Scope::new(p, g, c) == *expected && !c.server.is_empty()).then(|| c.clone())
        })
    }
    pub fn capture(&self, request: &P4Context) -> Option<Scope> {
        self.contexts
            .with_custom_submit_context(|profile, generation, current| {
                if current != request {
                    return None;
                }
                let scope = Scope::new(profile, generation, current);
                self.store.lock().select(scope.clone());
                Some(scope)
            })
    }
    pub fn snapshot(&self) -> Snapshot {
        self.contexts
            .with_custom_submit_context(|profile, generation, current| {
                self.store
                    .lock()
                    .snapshot(Scope::new(profile, generation, current), now())
            })
    }
    pub fn record(&self, observation: Observation<'_>) {
        use tauri::Emitter;
        let Observation {
            scope,
            request,
            elapsed,
            bucket,
            outcome,
            access_success,
            manual,
        } = observation;
        let snapshot = self
            .contexts
            .with_custom_submit_context(|profile, generation, current| {
                let active = Scope::new(profile, generation, current);
                if &active != scope || current != request {
                    return None;
                }
                let mut store = self.store.lock();
                store.select(active.clone());
                let time = now();
                store.observe(scope, time, elapsed, bucket, outcome, access_success);
                if manual
                    && matches!(
                        outcome,
                        Outcome::Success | Outcome::Login | Outcome::Permission | Outcome::Network
                    )
                {
                    store.connection_source = Some("manual");
                }
                Some(store.snapshot(active, time))
            });
        if let Some(snapshot) = snapshot {
            let _ = self.app.emit("server-status-changed", snapshot);
        }
    }
}
fn now() -> u64 {
    chrono::Utc::now().timestamp_millis().max(0) as u64
}

/// Conservative workload buckets. Unknown/options-heavy commands are excluded.
pub fn bucket(request: &P4CommandRequest, argument_input: bool) -> Option<usize> {
    if request.source != OperationSource::Gui || request.input.is_some() || argument_input {
        return None;
    }
    let a = &request.args;
    if request.command == "fstat"
        && a.len() == 1
        && a[0].starts_with("//")
        && !a[0].contains(['*', '#', '@'])
        && !a[0].contains("...")
    {
        return Some(0);
    }
    if request.command == "changes" {
        let i = a.iter().position(|v| v == "-m")?;
        let count = a.get(i + 1)?.parse::<usize>().ok()?;
        // -l may return arbitrarily large descriptions; exclude it and unknown flags.
        if a.iter()
            .any(|v| v.starts_with('-') && !matches!(v.as_str(), "-m" | "-s" | "-u" | "-c"))
        {
            return None;
        }
        return match count {
            1..=10 => Some(1),
            11..=50 => Some(2),
            _ => None,
        };
    }
    None
}
pub fn outcome(exit: i32, text: &str) -> Outcome {
    let t = text
        .chars()
        .take(16_384)
        .collect::<String>()
        .to_ascii_lowercase();
    if t.contains("password invalid or unset")
        || t.contains("session has expired")
        || t.contains("please login")
    {
        return Outcome::Login;
    }
    if t.contains("you don't have permission")
        || t.contains("no permission for operation")
        || t.contains("access for user") && t.contains("has not been enabled")
    {
        return Outcome::Permission;
    }
    if t.contains("connect to server failed")
        || t.contains("tcp connect to")
            && (t.contains("connection refused") || t.contains("no such host"))
    {
        return Outcome::Network;
    }
    if exit == 0 {
        Outcome::Success
    } else {
        Outcome::Other
    }
}

pub fn remote(command: &str) -> bool {
    matches!(
        command,
        "info"
            | "login"
            | "changes"
            | "change"
            | "fstat"
            | "opened"
            | "describe"
            | "filelog"
            | "files"
            | "dirs"
            | "clients"
            | "client"
            | "streams"
            | "stream"
            | "sync"
            | "print"
            | "reopen"
            | "shelve"
            | "unshelve"
            | "submit"
            | "edit"
            | "add"
            | "delete"
            | "revert"
            | "integrated"
            | "where"
    )
}
pub fn classify(exit: i32, stdout: &str, stderr: &str) -> Outcome {
    // JSON diagnostic records only: arbitrary file contents cannot forge status.
    for line in stdout.lines().take(128).filter(|line| line.len() <= 8192) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(line) {
            if v.get("code").and_then(|x| x.as_str()) == Some("error")
                || v.get("severity")
                    .and_then(|x| x.as_u64())
                    .is_some_and(|n| n >= 3)
            {
                let result = outcome(-1, v.get("data").and_then(|x| x.as_str()).unwrap_or(""));
                if result != Outcome::Other {
                    return result;
                }
                return Outcome::Other;
            }
        }
    }
    if exit != 0 {
        outcome(exit, stderr)
    } else {
        Outcome::Success
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManualReceipt {
    pub status: &'static str,
    pub snapshot: Option<Snapshot>,
}
pub struct ManualGuard<'a>(pub &'a std::sync::atomic::AtomicBool);
#[derive(Default)]
pub struct ManualGate {
    busy: std::sync::atomic::AtomicBool,
    seen: parking_lot::Mutex<std::collections::HashSet<String>>,
}
impl ManualGate {
    pub fn reserve(&self, id: &str) -> Result<ManualGuard<'_>, &'static str> {
        use std::sync::atomic::Ordering;
        if id.is_empty()
            || id.len() > 128
            || !id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
        {
            return Err("invalidRequest");
        }
        let mut seen = self.seen.lock();
        if self.busy.load(Ordering::SeqCst) {
            return Err("inFlight");
        }
        if seen.contains(id) {
            return Err("duplicate");
        }
        if seen.len() >= 4096 {
            return Err("unavailable");
        }
        seen.insert(id.to_owned());
        self.busy.store(true, Ordering::SeqCst);
        Ok(ManualGuard(&self.busy))
    }
}
impl Drop for ManualGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, std::sync::atomic::Ordering::SeqCst);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn changed_while_queued_never_launches_or_retries() {
        let old = scope(1);
        let new = scope(2);
        let context = P4Context::default();
        let mut calls = 0;
        assert!(checked_launch(&old, &new, &context, &context, || calls += 1).is_none());
        assert_eq!(calls, 0);
        assert!(checked_launch(&new, &new, &context, &context, || calls += 1).is_some());
        assert_eq!(calls, 1);
        let other = P4Context {
            charset: Some("utf8".into()),
            ..Default::default()
        };
        assert!(checked_launch(&new, &new, &context, &other, || calls += 1).is_none());
        assert_eq!(calls, 1);
    }
    fn scope(g: u64) -> Scope {
        Scope::new(
            Some("synthetic".into()),
            g,
            &P4Context {
                server: "fake:1666".into(),
                user: "tester".into(),
                client: "workspace".into(),
                ..Default::default()
            },
        )
    }
    fn request(cmd: &str, args: &[&str]) -> P4CommandRequest {
        P4CommandRequest {
            operation_id: None,
            source: OperationSource::Gui,
            command: cmd.into(),
            args: args.iter().map(|s| s.to_string()).collect(),
            context: Default::default(),
            output_mode: crate::domain::OutputMode::JsonLines,
            timeout_ms: None,
            input: None,
        }
    }
    #[test]
    fn insufficient_expired_and_independent_fact_ttl() {
        let mut s = Store::default();
        let k = scope(1);
        s.select(k.clone());
        s.observe(&k, 1, 10, Some(0), Outcome::Success, true);
        assert_eq!(s.snapshot(k.clone(), 2).quality, "unknown");
        s.observe(&k, 59_000, 10, None, Outcome::Success, false);
        let r = s.snapshot(k.clone(), 60_001);
        assert_eq!(r.connection, "reachable");
        assert_eq!(r.access, "unknown");
        assert_eq!(r.sample_count, 0);
        assert_eq!(s.snapshot(k, 120_000).connection, "unknown");
    }
    #[test]
    fn five_samples_median_hysteresis_and_recovery() {
        let mut s = Store::default();
        let k = scope(1);
        s.select(k.clone());
        for n in 1..=5 {
            s.observe(&k, n, 2400, Some(0), Outcome::Success, true);
        }
        assert_eq!(s.snapshot(k.clone(), 6).quality, "slow");
        for n in 7..=14 {
            s.observe(&k, n, 1500, Some(0), Outcome::Success, true);
        }
        assert_eq!(s.snapshot(k.clone(), 15).quality, "slow");
        for n in 16..=23 {
            s.observe(&k, n, 200, Some(0), Outcome::Success, true);
        }
        let r = s.snapshot(k, 24);
        assert_eq!(r.quality, "smooth");
        assert_eq!(r.sample_count, 8);
    }
    #[test]
    fn single_timeout_not_disconnect_and_info_never_clears_quality() {
        let mut s = Store::default();
        let k = scope(1);
        s.select(k.clone());
        s.observe(&k, 1, 1, None, Outcome::Permission, false);
        s.observe(&k, 2, 10000, Some(1), Outcome::Timeout, false);
        assert_eq!(s.snapshot(k.clone(), 3).connection, "reachable");
        assert_eq!(s.snapshot(k.clone(), 3).quality, "unknown");
        s.observe(&k, 4, 10000, Some(1), Outcome::Timeout, false);
        s.observe(&k, 5, 10000, Some(1), Outcome::Timeout, false);
        s.observe(&k, 6, 2, None, Outcome::Success, false);
        let r = s.snapshot(k.clone(), 7);
        assert_eq!(r.quality, "persistentTimeout");
        assert_eq!(r.access, "permissionDenied");
        assert_eq!(s.snapshot(k, 60_005).quality, "unknown");
    }
    #[test]
    fn old_generation_discarded_and_decimal_precision_retained() {
        let mut s = Store::default();
        let old = scope(1);
        let new = scope(9_007_199_254_740_993);
        s.select(new.clone());
        s.observe(&old, 1, 1, Some(0), Outcome::Success, true);
        let r = s.snapshot(new, 2);
        assert_eq!(r.connection, "unknown");
        assert_eq!(r.scope.generation, "9007199254740993");
    }
    #[test]
    fn read_many_windows_is_stable_and_zero_samples() {
        let mut s = Store::default();
        let k = scope(1);
        let a = s.snapshot(k.clone(), 1);
        for _ in 0..100 {
            assert_eq!(s.snapshot(k.clone(), 2), a);
        }
    }
    #[test]
    fn auth_permission_transport_and_arbitrary_output() {
        assert_eq!(
            outcome(1, "Your session has expired, please login."),
            Outcome::Login
        );
        assert_eq!(
            outcome(1, "You don't have permission for this operation."),
            Outcome::Permission
        );
        assert_eq!(
            outcome(1, "Connect to server failed; connection refused"),
            Outcome::Network
        );
        assert_eq!(outcome(1, "operation timed out"), Outcome::Other);
        assert_eq!(classify(0, "please login", ""), Outcome::Success);
        assert_eq!(
            classify(
                1,
                r#"{"code":"error","data":"Password invalid or unset"}"#,
                ""
            ),
            Outcome::Login
        );
        assert!(!remote("set"));
        assert!(!remote("help"));
        assert!(remote("info"));
    }
    #[test]
    fn bounded_workload_excludes_interaction_transfers_and_info() {
        assert_eq!(
            bucket(&request("fstat", &["//fixture/file"]), false),
            Some(0)
        );
        assert_eq!(bucket(&request("fstat", &["//fixture/..."]), false), None);
        assert_eq!(
            bucket(&request("changes", &["-m", "10", "-s", "submitted"]), false),
            Some(1)
        );
        assert_eq!(bucket(&request("changes", &["-m", "50"]), false), Some(2));
        assert_eq!(bucket(&request("changes", &["-m", "51"]), false), None);
        assert_eq!(
            bucket(&request("changes", &["-m", "10", "-l"]), false),
            None
        );
        for c in ["info", "sync", "login", "submit", "opened", "print"] {
            assert_eq!(bucket(&request(c, &[]), false), None);
        }
        let mut r = request("fstat", &["//fixture/file"]);
        r.input = Some("synthetic".into());
        assert_eq!(bucket(&r, false), None);
        r.input = None;
        r.source = OperationSource::Terminal;
        assert_eq!(bucket(&r, false), None);
        assert_eq!(bucket(&request("fstat", &["//fixture/file"]), true), None);
    }
    #[test]
    fn workload_bucket_does_not_clear_other_slow_bucket() {
        let mut s = Store::default();
        let k = scope(1);
        s.select(k.clone());
        for n in 1..=5 {
            s.observe(&k, n, 3000, Some(0), Outcome::Success, true);
            s.observe(&k, n, 10, Some(1), Outcome::Success, true);
        }
        assert_eq!(s.snapshot(k, 6).quality, "slow");
    }
    #[test]
    fn manual_guard_coalesces_and_releases_without_retry() {
        let gate = ManualGate::default();
        let first = gate.reserve("request-1").unwrap();
        assert_eq!(gate.reserve("request-2").err(), Some("inFlight"));
        drop(first);
        assert_eq!(gate.reserve("request-1").err(), Some("duplicate"));
        assert!(gate.reserve("request-2").is_ok());
        assert_eq!(gate.reserve("bad id").err(), Some("invalidRequest"));
    }
}
