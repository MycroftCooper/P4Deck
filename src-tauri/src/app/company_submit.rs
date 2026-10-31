//! CL-06-I1. Pure planning plus a process-free simulation. NOT a launch API.
//! Tool cwd, authentication inheritance and child-session lifetime are unknown.
//! Real activation remains disabled; no process/filesystem/network APIs here.
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConnectionSnapshot {
    pub profile_id: String,
    pub generation: String,
    pub server: String,
    pub user: String,
    pub client: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlanRequest {
    pub change_ids: Vec<String>,
    pub executable_path: String,
    pub connection: ConnectionSnapshot,
}

/// Host-owned evidence, not an FE assertion. I1 supplies only synthetic facts.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ToolEvidence {
    File { path: String, identity: String },
    Missing,
    NotFile,
    Unknown,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub change_id: String,
    pub executable_path: String,
    pub argv: Vec<String>,
    pub connection: ConnectionSnapshot,
    pub real_start_allowed: bool,
    pub blockers: Vec<String>,
    #[serde(skip)]
    tool: ToolEvidence,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Error {
    SingleNumberedChangeRequired,
    InvalidChangeId,
    InvalidExecutablePath,
    InvalidConnection,
    ConnectionChanged,
    ToolMissing,
    ToolNotFile,
    ToolUnverified,
    ToolChanged,
    Busy,
    StaleSession,
    InvalidTransition,
    RealStartDisabled,
}

fn positive_decimal(value: &str) -> Option<String> {
    if value.is_empty() || !value.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    // CL ids stay strings (including values beyond JS's safe integer range).
    let canonical = value.trim_start_matches('0');
    if canonical.is_empty() || canonical.len() > 20 {
        return None;
    }
    canonical.parse::<u64>().ok().map(|v| v.to_string())
}

pub(super) fn absolute_exe(path: &str) -> bool {
    let bytes = path.as_bytes();
    let drive = bytes.len() > 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && matches!(bytes[2], b'\\' | b'/');
    // Device paths and UNC are deliberately not accepted by this first local-tool contract.
    drive
        && path.trim() == path
        && path.to_ascii_lowercase().ends_with(".exe")
        && !path
            .chars()
            .any(|c| c.is_control() || matches!(c, '"' | '<' | '>' | '|' | '*' | '?' | '%'))
        && !path[2..].contains(':')
        && !path[3..]
            .split(['/', '\\'])
            .any(|s| s.is_empty() || s == "." || s == ".." || s.ends_with([' ', '.']))
}

fn valid_connection_fields(c: &ConnectionSnapshot) -> bool {
    !c.generation.is_empty()
        && c.generation.bytes().all(|b| b.is_ascii_digit())
        && c.generation.parse::<u64>().is_ok()
        && [&c.server, &c.user, &c.client].iter().all(|v| {
            !v.trim().is_empty() && !v.starts_with('-') && !v.chars().any(char::is_control)
        })
}

fn valid_connection(c: &ConnectionSnapshot) -> bool {
    !c.profile_id.trim().is_empty()
        && !c.profile_id.chars().any(char::is_control)
        && valid_connection_fields(c)
}

fn valid_profile_identity(profile_id: &str) -> bool {
    profile_id.is_empty()
        || (!profile_id.trim().is_empty() && !profile_id.chars().any(char::is_control))
}

/// Projection of ConnectionService::swarm_snapshot's one-lock host snapshot.
/// No runtime-info/CLI discovery, file access or credential fields are involved.
pub fn from_host_snapshot(
    profile_id: Option<String>,
    generation: u64,
    context: &crate::domain::P4Context,
) -> Result<ConnectionSnapshot, Error> {
    let value = ConnectionSnapshot {
        profile_id: profile_id.ok_or(Error::InvalidConnection)?,
        generation: generation.to_string(),
        server: context.server.clone(),
        user: context.user.clone(),
        client: context.client.clone(),
    };
    if valid_connection(&value) {
        Ok(value)
    } else {
        Err(Error::InvalidConnection)
    }
}

/// Journal scope for a local connection-store write (create/update/delete/activate).
///
/// Creating the first profile is legitimate while no profile is active, so an absent
/// active profile becomes the empty `profileId` the UI itself reports for "no active
/// profile" instead of rejecting the request. The connection tuple (generation plus
/// server/user/client) must still be well formed; P4 actions keep using
/// [`from_host_snapshot`], which does require an active profile.
pub fn from_profile_write(
    profile_id: Option<String>,
    generation: u64,
    context: &crate::domain::P4Context,
) -> Result<ConnectionSnapshot, Error> {
    let value = ConnectionSnapshot {
        profile_id: profile_id.unwrap_or_default(),
        generation: generation.to_string(),
        server: context.server.clone(),
        user: context.user.clone(),
        client: context.client.clone(),
    };
    if valid_profile_identity(&value.profile_id) && valid_connection_fields(&value) {
        Ok(value)
    } else {
        Err(Error::InvalidConnection)
    }
}

/// Current production evidence is Unknown. Pure validation never invents a file.
pub fn plan_unverified(request: &PlanRequest, current: &ConnectionSnapshot) -> Result<Plan, Error> {
    plan(request, current, &ToolEvidence::Unknown)
}

pub fn plan(
    request: &PlanRequest,
    current: &ConnectionSnapshot,
    evidence: &ToolEvidence,
) -> Result<Plan, Error> {
    if request.change_ids.len() != 1 {
        return Err(Error::SingleNumberedChangeRequired);
    }
    let change_id = positive_decimal(&request.change_ids[0]).ok_or(Error::InvalidChangeId)?;
    if !absolute_exe(&request.executable_path) {
        return Err(Error::InvalidExecutablePath);
    }
    if !valid_connection(&request.connection) {
        return Err(Error::InvalidConnection);
    }
    if &request.connection != current {
        return Err(Error::ConnectionChanged);
    }
    match evidence {
        ToolEvidence::File { path, identity }
            if path == &request.executable_path && !identity.is_empty() => {}
        ToolEvidence::File { .. } => return Err(Error::ToolChanged),
        ToolEvidence::Missing => return Err(Error::ToolMissing),
        ToolEvidence::NotFile => return Err(Error::ToolNotFile),
        ToolEvidence::Unknown => return Err(Error::ToolUnverified),
    }
    Ok(Plan {
        argv: vec![
            "-c".into(),
            change_id.clone(),
            "-p".into(),
            current.server.clone(),
            "-u".into(),
            current.user.clone(),
            "-C".into(),
            current.client.clone(),
        ],
        change_id,
        executable_path: request.executable_path.clone(),
        connection: current.clone(),
        real_start_allowed: false,
        blockers: vec![
            "cwdUnverified".into(),
            "authenticationUnverified".into(),
            "sessionLifetimeUnverified".into(),
            "dynamicExecutionNotAuthorized".into(),
        ],
        tool: evidence.clone(),
    })
}

pub fn real_start_disabled() -> Result<(), Error> {
    Err(Error::RealStartDisabled)
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(
    tag = "state",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum SessionState {
    Reserved,
    Running,
    /// The parent process exited; children and submission outcome remain unknown.
    OutcomeUnknown {
        exit_code: Option<i32>,
    },
    /// Positive evidence of no created process; only this failure permits a retry.
    NotStarted,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub session_id: String,
    pub state: SessionState,
    pub plan: Plan,
}

/// Private simulation transitions. There is intentionally no spawn implementation.
#[derive(Clone, Copy)]
enum MockEvent {
    Created,
    CreationFailedNoProcess,
    LaunchUncertain,
    Exited(Option<i32>),
}

#[derive(Default)]
struct Inner {
    sequence: u64,
    occupied: Option<Session>,
}

/// One host instance shared across windows. Occupancy is global, not per CL,
/// because the external tool's session/concurrency behavior is not established.
#[derive(Default)]
pub struct MockHost(Mutex<Inner>);

impl MockHost {
    pub fn reserve(
        &self,
        planned: &Plan,
        current: &ConnectionSnapshot,
        tool: &ToolEvidence,
    ) -> Result<Session, Error> {
        let mut inner = self.0.lock();
        if inner.occupied.is_some() {
            return Err(Error::Busy);
        }
        if &planned.connection != current {
            return Err(Error::ConnectionChanged);
        }
        if &planned.tool != tool {
            return Err(Error::ToolChanged);
        }
        inner.sequence = inner.sequence.checked_add(1).ok_or(Error::Busy)?;
        let session = Session {
            session_id: inner.sequence.to_string(),
            state: SessionState::Reserved,
            plan: planned.clone(),
        };
        inner.occupied = Some(session.clone());
        Ok(session)
    }

    // Only tests can synthesize launch/process events. Production has no caller.
    #[cfg(test)]
    fn event(&self, session_id: &str, event: MockEvent) -> Result<Session, Error> {
        let mut inner = self.0.lock();
        let session = inner
            .occupied
            .as_mut()
            .filter(|s| s.session_id == session_id)
            .ok_or(Error::StaleSession)?;
        session.state = match (&session.state, event) {
            (SessionState::Reserved, MockEvent::Created) => SessionState::Running,
            (SessionState::Reserved, MockEvent::CreationFailedNoProcess) => {
                SessionState::NotStarted
            }
            (SessionState::Reserved, MockEvent::LaunchUncertain) => {
                SessionState::OutcomeUnknown { exit_code: None }
            }
            (SessionState::Running, MockEvent::Exited(code)) => {
                SessionState::OutcomeUnknown { exit_code: code }
            }
            _ => return Err(Error::InvalidTransition),
        };
        let result = session.clone();
        if result.state == SessionState::NotStarted {
            inner.occupied = None;
        }
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn snapshot_wire_has_five_fields_and_preserves_large_generation_strings() {
        let context = crate::domain::P4Context {
            server: "ssl:fixture.invalid:1666".into(),
            user: "mock-user".into(),
            client: "mock-client".into(),
            executable: Some("synthetic-cli-never-read".into()),
            custom_submit_executable_path: String::new(),
            cwd: Some("synthetic-directory-never-read".into()),
            charset: Some("synthetic-charset".into()),
            trust_path: Some("synthetic-trust-never-read".into()),
            tickets_path: Some("synthetic-tickets-never-read".into()),
            swarm_base_url: Some("https://fixture.invalid".into()),
        };
        for generation in [9_007_199_254_740_993, u64::MAX] {
            let snapshot =
                from_host_snapshot(Some("fixture-profile".into()), generation, &context).unwrap();
            assert_eq!(
                serde_json::to_value(snapshot).unwrap(),
                serde_json::json!({
                    "profileId":"fixture-profile", "generation":generation.to_string(),
                    "server":"ssl:fixture.invalid:1666", "user":"mock-user", "client":"mock-client"
                })
            );
        }
        let missing = from_host_snapshot(None, 1, &context).unwrap_err();
        assert_eq!(serde_json::to_value(missing).unwrap(), "invalidConnection");
    }

    #[test]
    fn profile_write_scope_allows_a_clean_install_and_still_validates_the_connection() {
        let context = crate::domain::P4Context {
            server: "ssl:fixture.invalid:1666".into(),
            user: "mock-user".into(),
            client: "mock-client".into(),
            ..Default::default()
        };
        let scope = from_profile_write(None, 1, &context).unwrap();
        assert_eq!(scope.profile_id, "");
        assert_eq!(scope.generation, "1");
        assert_eq!(scope.server, "ssl:fixture.invalid:1666");
        assert_eq!(scope.user, "mock-user");
        assert_eq!(scope.client, "mock-client");
        // An existing active profile keeps its exact identity.
        assert_eq!(
            from_profile_write(Some("fixture-profile".into()), 9, &context)
                .unwrap()
                .profile_id,
            "fixture-profile"
        );
        // The connection tuple is still required even while no profile is active.
        assert_eq!(
            from_profile_write(None, 1, &crate::domain::P4Context::default()),
            Err(Error::InvalidConnection)
        );
        let invalid = crate::domain::P4Context {
            server: "-server".into(),
            user: "mock-user".into(),
            client: "mock-client".into(),
            ..Default::default()
        };
        assert_eq!(
            from_profile_write(None, 1, &invalid),
            Err(Error::InvalidConnection)
        );
    }

    #[test]
    fn shared_v1_golden_vectors_match_authoritative_planner() {
        let vectors: serde_json::Value =
            serde_json::from_str(include_str!("company_submit_golden_v1.json")).unwrap();
        assert_eq!(vectors["contractVersion"], 1);
        for case in vectors["cases"].as_array().unwrap() {
            let request: PlanRequest = serde_json::from_value(case["request"].clone()).unwrap();
            let current: ConnectionSnapshot =
                serde_json::from_value(case["currentConnection"].clone()).unwrap();
            let raw = &case["toolEvidence"];
            let evidence = match raw["kind"].as_str().unwrap() {
                "file" => ToolEvidence::File {
                    path: raw["path"].as_str().unwrap().into(),
                    identity: raw["identity"].as_str().unwrap().into(),
                },
                "missing" => ToolEvidence::Missing,
                "notFile" => ToolEvidence::NotFile,
                "unknown" => ToolEvidence::Unknown,
                _ => panic!("invalid test evidence"),
            };
            let actual = match plan(&request, &current, &evidence) {
                Ok(plan) => serde_json::json!({"ok":true,"plan":plan}),
                Err(error) => serde_json::json!({"ok":false,"error":error}),
            };
            assert_eq!(actual, case["expected"], "case {}", case["name"]);
        }
        assert_eq!(
            vectors["sessionStates"],
            serde_json::json!([
                SessionState::Reserved,
                SessionState::Running,
                SessionState::NotStarted,
                SessionState::OutcomeUnknown { exit_code: Some(0) },
                SessionState::OutcomeUnknown { exit_code: None }
            ])
        );
    }

    #[test]
    fn host_projection_keeps_u64_identity_exact_and_unverified_path_disabled() {
        let (r, _) = input();
        let context = crate::domain::P4Context {
            server: r.connection.server.clone(),
            user: r.connection.user.clone(),
            client: r.connection.client.clone(),
            ..Default::default()
        };
        assert_eq!(
            from_host_snapshot(None, 1, &context),
            Err(Error::InvalidConnection)
        );
        let current = from_host_snapshot(Some("fixture".into()), u64::MAX, &context).unwrap();
        assert_eq!(current.generation, "18446744073709551615");
        let request = PlanRequest {
            connection: current.clone(),
            ..r
        };
        assert_eq!(
            plan_unverified(&request, &current),
            Err(Error::ToolUnverified)
        );
    }
    fn input() -> (PlanRequest, ToolEvidence) {
        let path = r"C:\Synthetic Tools\submit.exe".to_owned();
        (
            PlanRequest {
                change_ids: vec!["00042".into()],
                executable_path: path.clone(),
                connection: ConnectionSnapshot {
                    profile_id: "fixture".into(),
                    generation: "3".into(),
                    server: "ssl:fixture.invalid:1666".into(),
                    user: "mock user".into(),
                    client: "工作区 & literal".into(),
                },
            },
            ToolEvidence::File {
                path,
                identity: "synthetic-file-v1".into(),
            },
        )
    }
    fn planned() -> (Plan, ToolEvidence) {
        let (r, e) = input();
        (plan(&r, &r.connection, &e).unwrap(), e)
    }

    #[test]
    fn fixed_argv_preserves_literals_without_a_shell_or_cwd_guess() {
        let (p, _) = planned();
        assert_eq!(
            p.argv,
            [
                "-c",
                "42",
                "-p",
                "ssl:fixture.invalid:1666",
                "-u",
                "mock user",
                "-C",
                "工作区 & literal"
            ]
        );
        assert!(!p.real_start_allowed);
        assert_eq!(real_start_disabled(), Err(Error::RealStartDisabled));
        assert_eq!(p.blockers.len(), 4);
    }

    #[test]
    fn single_numbered_cl_only_without_js_number_loss() {
        let (mut r, e) = input();
        for value in [
            "default",
            "0",
            "000",
            "-1",
            "+1",
            "1.0",
            "1e3",
            " 42",
            "42\n",
            "٤٢",
            "18446744073709551616",
        ] {
            r.change_ids = vec![value.into()];
            assert_eq!(
                plan(&r, &r.connection, &e),
                Err(Error::InvalidChangeId),
                "{value}"
            );
        }
        for ids in [vec![], vec!["1".into(), "2".into()]] {
            r.change_ids = ids;
            assert_eq!(
                plan(&r, &r.connection, &e),
                Err(Error::SingleNumberedChangeRequired)
            );
        }
        r.change_ids = vec!["9007199254740993".into()];
        assert_eq!(
            plan(&r, &r.connection, &e).unwrap().change_id,
            "9007199254740993"
        );
    }

    #[test]
    fn local_absolute_exe_only_and_missing_or_unknown_evidence_fail_closed() {
        let (mut r, e) = input();
        for path in [
            "submit.exe",
            r"C:submit.exe",
            r"\submit.exe",
            r"\\host\share\submit.exe",
            r"C:\x\..\submit.exe",
            r"C:\submit.exe:stream",
            r"C:\%TOOL%\submit.exe",
            r"C:\submit.cmd",
            "\"C:\\submit.exe\"",
        ] {
            r.executable_path = path.into();
            assert_eq!(
                plan(&r, &r.connection, &e),
                Err(Error::InvalidExecutablePath),
                "{path}"
            );
        }
        let (r, _) = input();
        for (e, error) in [
            (ToolEvidence::Missing, Error::ToolMissing),
            (ToolEvidence::NotFile, Error::ToolNotFile),
            (ToolEvidence::Unknown, Error::ToolUnverified),
        ] {
            assert_eq!(plan(&r, &r.connection, &e), Err(error));
        }
    }

    #[test]
    fn snapshots_are_revalidated_before_reservation() {
        let (p, e) = planned();
        let h = MockHost::default();
        let mut connection = p.connection.clone();
        connection.generation = "4".into();
        assert_eq!(
            h.reserve(&p, &connection, &e),
            Err(Error::ConnectionChanged)
        );
        let replacement = ToolEvidence::File {
            path: p.executable_path.clone(),
            identity: "replaced".into(),
        };
        assert_eq!(
            h.reserve(&p, &p.connection, &replacement),
            Err(Error::ToolChanged)
        );
        assert!(h.reserve(&p, &p.connection, &e).is_ok());
    }

    #[test]
    fn only_proven_no_process_failure_releases_and_old_completion_is_rejected() {
        let (p, e) = planned();
        let h = MockHost::default();
        let first = h.reserve(&p, &p.connection, &e).unwrap();
        assert_eq!(h.reserve(&p, &p.connection, &e), Err(Error::Busy));
        assert_eq!(
            h.event(&first.session_id, MockEvent::CreationFailedNoProcess)
                .unwrap()
                .state,
            SessionState::NotStarted
        );
        let second = h.reserve(&p, &p.connection, &e).unwrap();
        assert_ne!(first.session_id, second.session_id);
        assert_eq!(
            h.event(&first.session_id, MockEvent::Created),
            Err(Error::StaleSession)
        );
        assert_eq!(
            h.event(&second.session_id, MockEvent::Exited(Some(0))),
            Err(Error::InvalidTransition)
        );
    }

    #[test]
    fn zero_nonzero_and_missing_exit_code_never_mean_submitted_or_release_occupancy() {
        for code in [Some(0), Some(1), None] {
            let (p, e) = planned();
            let h = MockHost::default();
            let s = h.reserve(&p, &p.connection, &e).unwrap();
            h.event(&s.session_id, MockEvent::Created).unwrap();
            assert_eq!(
                h.event(&s.session_id, MockEvent::Exited(code))
                    .unwrap()
                    .state,
                SessionState::OutcomeUnknown { exit_code: code }
            );
            assert_eq!(h.reserve(&p, &p.connection, &e), Err(Error::Busy));
            assert_eq!(
                h.event(&s.session_id, MockEvent::CreationFailedNoProcess),
                Err(Error::InvalidTransition)
            );
        }
    }

    #[test]
    fn uncertain_launch_is_not_retried() {
        let (p, e) = planned();
        let h = MockHost::default();
        let s = h.reserve(&p, &p.connection, &e).unwrap();
        h.event(&s.session_id, MockEvent::LaunchUncertain).unwrap();
        assert_eq!(h.reserve(&p, &p.connection, &e), Err(Error::Busy));
    }

    #[test]
    fn concurrent_windows_only_reserve_once() {
        let (p, e) = planned();
        let h = std::sync::Arc::new(MockHost::default());
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(8));
        let tasks: Vec<_> = (0..8)
            .map(|_| {
                let (h, b, p, e) = (h.clone(), barrier.clone(), p.clone(), e.clone());
                std::thread::spawn(move || {
                    b.wait();
                    h.reserve(&p, &p.connection, &e)
                })
            })
            .collect();
        let results: Vec<_> = tasks.into_iter().map(|t| t.join().unwrap()).collect();
        assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 1);
        assert_eq!(
            results.iter().filter(|r| **r == Err(Error::Busy)).count(),
            7
        );
    }

    #[test]
    fn contract_serialization_excludes_host_file_identity_and_has_no_credentials() {
        let (p, _) = planned();
        let json = serde_json::to_value(p).unwrap();
        assert_eq!(json["realStartAllowed"], false);
        assert_eq!(json["changeId"], "42");
        assert!(json.get("tool").is_none());
        assert!(json["connection"].get("password").is_none());
        let (r, _) = input();
        let mut json = serde_json::to_value(r).unwrap();
        json["password"] = serde_json::json!("synthetic-not-accepted");
        assert!(serde_json::from_value::<PlanRequest>(json).is_err());
    }
}
