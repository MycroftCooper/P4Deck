//! Versioned, non-secret P4 connection profiles and active runtime context.
//!
//! Authentication deliberately lives outside this module. Persisted values are an allowlisted
//! `P4Context`: passwords, ticket contents and server fingerprints have no field to land in.

use crate::domain::{
    ConnectionProfile, ConnectionProfileError, ConnectionProfileErrorCode, ConnectionProfiles,
    P4Context,
};
use serde::{Deserialize, Serialize};
use std::{
    fs::OpenOptions,
    io::Write,
    path::{Path, PathBuf},
    sync::RwLock,
};
use uuid::Uuid;

pub const CONNECTION_SCHEMA_VERSION: u32 = 2;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PersistedProfiles {
    schema_version: u32,
    revision: u64,
    active_profile_id: Option<String>,
    profiles: Vec<ConnectionProfile>,
}

struct StoreState {
    document: PersistedProfiles,
    runtime_context: P4Context,
    generation: u64,
}

pub struct ContextStore {
    path: PathBuf,
    state: RwLock<StoreState>,
}

impl ContextStore {
    pub fn load(directory: &Path) -> Result<Self, ConnectionProfileError> {
        let path = directory.join("connection.json");
        let environment = environment_context();
        let (document, runtime_context) = match std::fs::read(&path) {
            Ok(bytes) => load_document(&path, &bytes)?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                (empty_document(), environment)
            }
            Err(error) => return Err(persistence_error("read connection store", error)),
        };
        Ok(Self {
            path,
            state: RwLock::new(StoreState {
                document,
                runtime_context,
                generation: 1,
            }),
        })
    }

    pub fn current(&self) -> P4Context {
        self.state
            .read()
            .unwrap_or_else(|error| error.into_inner())
            .runtime_context
            .clone()
    }

    pub fn snapshot(&self) -> (P4Context, u64) {
        let state = self.state.read().unwrap_or_else(|error| error.into_inner());
        (state.runtime_context.clone(), state.generation)
    }

    pub fn active_profile_id(&self) -> Option<String> {
        self.state
            .read()
            .unwrap_or_else(|error| error.into_inner())
            .document
            .active_profile_id
            .clone()
    }

    pub fn active_profile(&self) -> Option<ConnectionProfile> {
        let state = self.state.read().unwrap_or_else(|error| error.into_inner());
        let active = state.document.active_profile_id.as_deref()?;
        state
            .document
            .profiles
            .iter()
            .find(|profile| profile.id == active)
            .cloned()
    }

    pub fn profiles(&self) -> ConnectionProfiles {
        let state = self.state.read().unwrap_or_else(|error| error.into_inner());
        public_document(&state.document)
    }

    pub fn profile_at_revision(
        &self,
        expected_revision: u64,
        id: &str,
    ) -> Result<ConnectionProfile, ConnectionProfileError> {
        let state = self.state.read().unwrap_or_else(|error| error.into_inner());
        check_revision(&state.document, expected_revision)?;
        state
            .document
            .profiles
            .iter()
            .find(|profile| profile.id == id)
            .cloned()
            .ok_or_else(|| {
                profile_error(
                    ConnectionProfileErrorCode::NotFound,
                    "Connection profile was not found.",
                )
            })
    }

    pub fn create(
        &self,
        expected_revision: u64,
        name: String,
        context: P4Context,
    ) -> Result<ConnectionProfiles, ConnectionProfileError> {
        let name = normalize_name(&name)?;
        let context = normalize_context(context)?;
        let mut state = self
            .state
            .write()
            .unwrap_or_else(|error| error.into_inner());
        check_revision(&state.document, expected_revision)?;
        check_duplicates(&state.document, None, &name, &context)?;
        let mut next = state.document.clone();
        let profile = ConnectionProfile {
            id: Uuid::new_v4().to_string(),
            name,
            context: context.clone(),
        };
        next.profiles.push(profile.clone());
        if next.active_profile_id.is_none() {
            next.active_profile_id = Some(profile.id);
        }
        next.revision = next.revision.saturating_add(1);
        persist_document(&self.path, &next)?;
        let became_active = state.document.active_profile_id.is_none();
        state.document = next;
        if became_active {
            state.runtime_context = context;
            state.generation = state.generation.saturating_add(1);
        }
        Ok(public_document(&state.document))
    }

    pub fn update(
        &self,
        expected_revision: u64,
        id: &str,
        name: String,
        context: P4Context,
    ) -> Result<ConnectionProfiles, ConnectionProfileError> {
        let name = normalize_name(&name)?;
        let context = normalize_context(context)?;
        let mut state = self
            .state
            .write()
            .unwrap_or_else(|error| error.into_inner());
        check_revision(&state.document, expected_revision)?;
        check_duplicates(&state.document, Some(id), &name, &context)?;
        let mut next = state.document.clone();
        let profile = next
            .profiles
            .iter_mut()
            .find(|profile| profile.id == id)
            .ok_or_else(|| {
                profile_error(
                    ConnectionProfileErrorCode::NotFound,
                    "Connection profile was not found.",
                )
            })?;
        profile.name = name;
        profile.context = context.clone();
        next.revision = next.revision.saturating_add(1);
        persist_document(&self.path, &next)?;
        let active = next.active_profile_id.as_deref() == Some(id);
        state.document = next;
        if active {
            state.runtime_context = context;
            state.generation = state.generation.saturating_add(1);
        }
        Ok(public_document(&state.document))
    }

    pub fn delete(
        &self,
        expected_revision: u64,
        id: &str,
    ) -> Result<ConnectionProfiles, ConnectionProfileError> {
        let mut state = self
            .state
            .write()
            .unwrap_or_else(|error| error.into_inner());
        check_revision(&state.document, expected_revision)?;
        if state.document.profiles.len() == 1
            && state
                .document
                .profiles
                .iter()
                .any(|profile| profile.id == id)
        {
            return Err(profile_error(
                ConnectionProfileErrorCode::LastProfileDelete,
                "The last connection profile cannot be deleted.",
            ));
        }
        if state.document.active_profile_id.as_deref() == Some(id) {
            return Err(profile_error(
                ConnectionProfileErrorCode::ActiveProfileDelete,
                "Switch to another profile before deleting the active profile.",
            ));
        }
        if !state
            .document
            .profiles
            .iter()
            .any(|profile| profile.id == id)
        {
            return Err(profile_error(
                ConnectionProfileErrorCode::NotFound,
                "Connection profile was not found.",
            ));
        }
        let mut next = state.document.clone();
        next.profiles.retain(|profile| profile.id != id);
        next.revision = next.revision.saturating_add(1);
        persist_document(&self.path, &next)?;
        state.document = next;
        Ok(public_document(&state.document))
    }

    /// Compatibility path for the existing connection wizard. It updates (or creates) the active
    /// profile but does not assert that the context is connected or authenticated.
    pub fn save(&self, context: P4Context) -> Result<P4Context, ConnectionProfileError> {
        let context = normalize_context(context)?;
        let mut state = self
            .state
            .write()
            .unwrap_or_else(|error| error.into_inner());
        let mut next = state.document.clone();
        if let Some(active_id) = next.active_profile_id.clone() {
            let active_name = next
                .profiles
                .iter()
                .find(|profile| profile.id == active_id)
                .map(|profile| profile.name.clone())
                .ok_or_else(|| {
                    profile_error(
                        ConnectionProfileErrorCode::CorruptStore,
                        "The active profile is missing.",
                    )
                })?;
            check_duplicates(&next, Some(&active_id), &active_name, &context)?;
            let profile = next
                .profiles
                .iter_mut()
                .find(|profile| profile.id == active_id)
                .expect("active profile was checked");
            profile.context = context.clone();
        } else {
            let profile = ConnectionProfile {
                id: Uuid::new_v4().to_string(),
                name: unique_default_name(&next),
                context: context.clone(),
            };
            next.active_profile_id = Some(profile.id.clone());
            next.profiles.push(profile);
        }
        next.revision = next.revision.saturating_add(1);
        persist_document(&self.path, &next)?;
        state.document = next;
        state.runtime_context = context.clone();
        state.generation = state.generation.saturating_add(1);
        Ok(context)
    }

    pub fn activate_if_unchanged(
        &self,
        expected_revision: u64,
        id: &str,
    ) -> Result<P4Context, ConnectionProfileError> {
        let mut state = self
            .state
            .write()
            .unwrap_or_else(|error| error.into_inner());
        check_revision(&state.document, expected_revision)?;
        let context = state
            .document
            .profiles
            .iter()
            .find(|profile| profile.id == id)
            .map(|profile| profile.context.clone())
            .ok_or_else(|| {
                profile_error(
                    ConnectionProfileErrorCode::NotFound,
                    "Connection profile was not found.",
                )
            })?;
        let mut next = state.document.clone();
        next.active_profile_id = Some(id.to_owned());
        next.revision = next.revision.saturating_add(1);
        persist_document(&self.path, &next)?;
        state.document = next;
        state.runtime_context = context.clone();
        state.generation = state.generation.saturating_add(1);
        Ok(context)
    }

    pub fn switch_workspace_if_unchanged(
        &self,
        expected_generation: u64,
        context: P4Context,
    ) -> Result<P4Context, ConnectionProfileError> {
        let context = normalize_context(context)?;
        let mut state = self
            .state
            .write()
            .unwrap_or_else(|error| error.into_inner());
        if state.generation != expected_generation {
            return Err(profile_error(
                ConnectionProfileErrorCode::ContextChanged,
                "The active connection changed while the workspace was being verified.",
            ));
        }
        let active_id = state.document.active_profile_id.clone().ok_or_else(|| {
            profile_error(
                ConnectionProfileErrorCode::NotFound,
                "No active connection profile exists.",
            )
        })?;
        let active_name = state
            .document
            .profiles
            .iter()
            .find(|profile| profile.id == active_id)
            .map(|profile| profile.name.clone())
            .ok_or_else(|| {
                profile_error(
                    ConnectionProfileErrorCode::CorruptStore,
                    "The active profile is missing.",
                )
            })?;
        check_duplicates(&state.document, Some(&active_id), &active_name, &context)?;
        let mut next = state.document.clone();
        let profile = next
            .profiles
            .iter_mut()
            .find(|profile| profile.id == active_id)
            .expect("active profile was checked");
        profile.context = context.clone();
        next.revision = next.revision.saturating_add(1);
        persist_document(&self.path, &next)?;
        state.document = next;
        state.runtime_context = context.clone();
        state.generation = state.generation.saturating_add(1);
        Ok(context)
    }
}

fn load_document(
    path: &Path,
    bytes: &[u8],
) -> Result<(PersistedProfiles, P4Context), ConnectionProfileError> {
    let value: serde_json::Value = serde_json::from_slice(bytes).map_err(|error| {
        profile_error(
            ConnectionProfileErrorCode::CorruptStore,
            format!("connection.json is invalid JSON and was left unchanged: {error}"),
        )
    })?;
    if value.get("schemaVersion").is_some() {
        let document: PersistedProfiles =
            serde_json::from_value(value.clone()).map_err(|error| {
                profile_error(
                    ConnectionProfileErrorCode::CorruptStore,
                    format!(
                    "connection.json has an invalid profile schema and was left unchanged: {error}"
                ),
                )
            })?;
        if document.schema_version != CONNECTION_SCHEMA_VERSION {
            return Err(profile_error(
                ConnectionProfileErrorCode::UnsupportedSchema,
                format!(
                    "Unsupported connection schema version {}. The file was left unchanged.",
                    document.schema_version
                ),
            ));
        }
        if serde_json::to_value(&document).ok().as_ref() != Some(&value) {
            return Err(profile_error(
                ConnectionProfileErrorCode::CorruptStore,
                "connection.json contains unsupported fields and was left unchanged.",
            ));
        }
        validate_document(&document)?;
        let runtime = active_context(&document).unwrap_or_else(environment_context);
        return Ok((document, runtime));
    }

    let legacy: P4Context = serde_json::from_value(value).map_err(|error| {
        profile_error(
            ConnectionProfileErrorCode::CorruptStore,
            format!("Legacy connection.json is invalid and was left unchanged: {error}"),
        )
    })?;
    let legacy = normalize_context(legacy)?;
    let profile = ConnectionProfile {
        id: Uuid::new_v4().to_string(),
        name: "Migrated connection".into(),
        context: legacy.clone(),
    };
    let document = PersistedProfiles {
        schema_version: CONNECTION_SCHEMA_VERSION,
        revision: 1,
        active_profile_id: Some(profile.id.clone()),
        profiles: vec![profile],
    };
    let backup = serde_json::to_vec_pretty(&legacy).map_err(|error| {
        profile_error(
            ConnectionProfileErrorCode::PersistenceFailed,
            format!("Failed to serialize the allowlisted legacy backup: {error}"),
        )
    })?;
    write_legacy_backup(path, &backup)?;
    persist_document(path, &document)?;
    Ok((document, legacy))
}

fn validate_document(document: &PersistedProfiles) -> Result<(), ConnectionProfileError> {
    let mut ids = std::collections::HashSet::new();
    for profile in &document.profiles {
        Uuid::parse_str(&profile.id).map_err(|_| {
            profile_error(
                ConnectionProfileErrorCode::CorruptStore,
                "A connection profile ID is invalid.",
            )
        })?;
        if !ids.insert(profile.id.as_str()) {
            return Err(profile_error(
                ConnectionProfileErrorCode::CorruptStore,
                "Connection profile IDs must be unique.",
            ));
        }
        normalize_name(&profile.name)?;
        normalize_context(profile.context.clone())?;
    }
    if let Some(active) = document.active_profile_id.as_deref() {
        if !document.profiles.iter().any(|profile| profile.id == active) {
            return Err(profile_error(
                ConnectionProfileErrorCode::CorruptStore,
                "The active connection profile is missing.",
            ));
        }
    } else if !document.profiles.is_empty() {
        return Err(profile_error(
            ConnectionProfileErrorCode::CorruptStore,
            "A non-empty connection store requires an active profile.",
        ));
    }
    for (index, profile) in document.profiles.iter().enumerate() {
        if document.profiles[..index].iter().any(|other| {
            names_equal(&other.name, &profile.name) || other.context == profile.context
        }) {
            return Err(profile_error(
                ConnectionProfileErrorCode::CorruptStore,
                "The connection store contains duplicate profiles.",
            ));
        }
    }
    Ok(())
}

fn active_context(document: &PersistedProfiles) -> Option<P4Context> {
    let active = document.active_profile_id.as_deref()?;
    document
        .profiles
        .iter()
        .find(|profile| profile.id == active)
        .map(|profile| profile.context.clone())
}

fn empty_document() -> PersistedProfiles {
    PersistedProfiles {
        schema_version: CONNECTION_SCHEMA_VERSION,
        revision: 0,
        active_profile_id: None,
        profiles: Vec::new(),
    }
}

fn public_document(document: &PersistedProfiles) -> ConnectionProfiles {
    ConnectionProfiles {
        schema_version: document.schema_version,
        revision: document.revision,
        active_profile_id: document.active_profile_id.clone(),
        profiles: document.profiles.clone(),
    }
}

fn check_revision(
    document: &PersistedProfiles,
    expected: u64,
) -> Result<(), ConnectionProfileError> {
    if document.revision != expected {
        return Err(profile_error(
            ConnectionProfileErrorCode::RevisionConflict,
            format!(
                "Connection profiles changed (expected revision {expected}, current {}). Reload and retry.",
                document.revision
            ),
        ));
    }
    Ok(())
}

fn check_duplicates(
    document: &PersistedProfiles,
    except_id: Option<&str>,
    name: &str,
    context: &P4Context,
) -> Result<(), ConnectionProfileError> {
    for profile in document
        .profiles
        .iter()
        .filter(|profile| Some(profile.id.as_str()) != except_id)
    {
        if names_equal(&profile.name, name) {
            return Err(profile_error(
                ConnectionProfileErrorCode::DuplicateName,
                "Connection profile names must be unique.",
            ));
        }
        if profile.context == *context {
            return Err(profile_error(
                ConnectionProfileErrorCode::DuplicateContext,
                "An identical connection context already exists.",
            ));
        }
    }
    Ok(())
}

fn names_equal(left: &str, right: &str) -> bool {
    left.trim().eq_ignore_ascii_case(right.trim())
}

fn normalize_name(value: &str) -> Result<String, ConnectionProfileError> {
    let value = value.trim();
    if value.is_empty() || value.chars().count() > 128 || value.chars().any(char::is_control) {
        return Err(profile_error(
            ConnectionProfileErrorCode::InvalidInput,
            "Profile name must contain 1 to 128 non-control characters.",
        ));
    }
    Ok(value.to_owned())
}

fn normalize_context(mut context: P4Context) -> Result<P4Context, ConnectionProfileError> {
    context.server = context.server.trim().to_owned();
    context.user = context.user.trim().to_owned();
    context.client = context.client.trim().to_owned();
    validate_persisted_context(&context)
        .map_err(|message| profile_error(ConnectionProfileErrorCode::InvalidInput, message))?;
    Ok(context)
}

fn unique_default_name(document: &PersistedProfiles) -> String {
    let mut suffix = 1_u64;
    loop {
        let candidate = if suffix == 1 {
            "Default".into()
        } else {
            format!("Default {suffix}")
        };
        if !document
            .profiles
            .iter()
            .any(|profile| names_equal(&profile.name, &candidate))
        {
            return candidate;
        }
        suffix += 1;
    }
}

fn write_legacy_backup(path: &Path, bytes: &[u8]) -> Result<(), ConnectionProfileError> {
    let backup = path.with_file_name("connection.json.legacy.bak");
    if backup.exists() {
        let existing = std::fs::read(&backup)
            .map_err(|error| persistence_error("read legacy backup", error))?;
        if existing == bytes {
            return Ok(());
        }
        return Err(profile_error(
            ConnectionProfileErrorCode::PersistenceFailed,
            "A different connection.json.legacy.bak already exists; migration was not attempted.",
        ));
    }
    let temp = path.with_file_name(format!(".connection-backup.{}.tmp", Uuid::new_v4()));
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        // A same-directory hard link publishes the fully synced bytes without an overwrite race.
        std::fs::hard_link(&temp, &backup)?;
        std::fs::remove_file(&temp)?;
        sync_parent(path)
    })();
    if let Err(error) = result {
        let _ = std::fs::remove_file(&temp);
        return Err(persistence_error("atomically write legacy backup", error));
    }
    Ok(())
}

fn persist_document(
    path: &Path,
    document: &PersistedProfiles,
) -> Result<(), ConnectionProfileError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| persistence_error("create connection directory", error))?;
    }
    let bytes = serde_json::to_vec_pretty(document).map_err(|error| {
        profile_error(
            ConnectionProfileErrorCode::PersistenceFailed,
            error.to_string(),
        )
    })?;
    let temp = path.with_file_name(format!(".connection.{}.tmp", Uuid::new_v4()));
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        atomic_replace(&temp, path)?;
        sync_parent(path)?;
        Ok::<(), std::io::Error>(())
    })();
    if let Err(error) = result {
        let _ = std::fs::remove_file(&temp);
        return Err(persistence_error(
            "atomically write connection store",
            error,
        ));
    }
    Ok(())
}

#[cfg(windows)]
fn atomic_replace(source: &Path, destination: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };
    let source = source
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let destination = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let result = unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if result == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn atomic_replace(source: &Path, destination: &Path) -> std::io::Result<()> {
    std::fs::rename(source, destination)
}

#[cfg(unix)]
fn sync_parent(path: &Path) -> std::io::Result<()> {
    std::fs::File::open(path.parent().unwrap_or_else(|| Path::new(".")))?.sync_all()
}

#[cfg(not(unix))]
fn sync_parent(_path: &Path) -> std::io::Result<()> {
    Ok(())
}

fn persistence_error(action: &str, error: std::io::Error) -> ConnectionProfileError {
    profile_error(
        ConnectionProfileErrorCode::PersistenceFailed,
        format!("Failed to {action}: {error}"),
    )
}

fn profile_error(
    code: ConnectionProfileErrorCode,
    message: impl Into<String>,
) -> ConnectionProfileError {
    ConnectionProfileError {
        code,
        message: message.into(),
    }
}

fn environment_context() -> P4Context {
    P4Context {
        executable: None,
        server: std::env::var("P4PORT").unwrap_or_default(),
        user: std::env::var("P4USER").unwrap_or_default(),
        client: std::env::var("P4CLIENT").unwrap_or_default(),
        cwd: std::env::current_dir()
            .ok()
            .map(|path| path.to_string_lossy().into_owned()),
        charset: std::env::var("P4CHARSET").ok(),
        trust_path: std::env::var("P4TRUST").ok(),
        tickets_path: std::env::var("P4TICKETS").ok(),
    }
}

pub fn validate_connection_context(context: &P4Context) -> Result<(), String> {
    if context.server.trim().is_empty() || context.user.trim().is_empty() {
        return Err("Server and user are required".into());
    }
    validate_values(context)
}

fn validate_persisted_context(context: &P4Context) -> Result<(), String> {
    if context.server.trim().is_empty()
        || context.user.trim().is_empty()
        || context.client.trim().is_empty()
    {
        return Err("Server, user and workspace are required".into());
    }
    validate_values(context)
}

fn validate_values(context: &P4Context) -> Result<(), String> {
    let values = [
        Some(context.server.as_str()),
        Some(context.user.as_str()),
        Some(context.client.as_str()),
        context.executable.as_deref(),
        context.cwd.as_deref(),
        context.charset.as_deref(),
        context.trust_path.as_deref(),
        context.tickets_path.as_deref(),
    ];
    if values
        .into_iter()
        .flatten()
        .any(|value| value.chars().any(char::is_control) || value.chars().count() > 4096)
    {
        return Err("Connection settings contain control characters or exceed limits".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn configured(client: &str) -> P4Context {
        P4Context {
            server: "ssl:test:1666".into(),
            user: "tester".into(),
            client: client.into(),
            tickets_path: Some("/credentials/tickets".into()),
            trust_path: Some("/credentials/trust".into()),
            ..Default::default()
        }
    }

    fn directory() -> PathBuf {
        std::env::temp_dir().join(format!("p4deck-context-{}", Uuid::new_v4()))
    }

    #[test]
    fn migrates_legacy_atomically_and_preserves_allowlisted_backup_without_secrets() {
        let directory = directory();
        std::fs::create_dir_all(&directory).unwrap();
        let legacy = br#"{"server":"ssl:test:1666","user":"tester","client":"legacy","password":"must-not-survive","ticketsPath":"/credentials/tickets"}"#;
        std::fs::write(directory.join("connection.json"), legacy).unwrap();
        let store = ContextStore::load(&directory).unwrap();
        assert_eq!(store.current().client, "legacy");
        let backup = std::fs::read_to_string(directory.join("connection.json.legacy.bak")).unwrap();
        assert!(backup.contains("\"client\": \"legacy\""));
        assert!(!backup.contains("password"));
        assert!(!backup.contains("must-not-survive"));
        let migrated = std::fs::read_to_string(directory.join("connection.json")).unwrap();
        assert!(migrated.contains("\"schemaVersion\": 2"));
        assert!(!migrated.contains("password"));
        assert!(!migrated.contains("must-not-survive"));
        assert!(!migrated.to_ascii_lowercase().contains("\"ticket\":"));
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn corrupt_and_unknown_versions_fail_without_rewriting() {
        for content in [
            "not-json",
            r#"{"schemaVersion":999,"revision":1,"activeProfileId":null,"profiles":[]}"#,
        ] {
            let directory = directory();
            std::fs::create_dir_all(&directory).unwrap();
            let path = directory.join("connection.json");
            std::fs::write(&path, content).unwrap();
            assert!(ContextStore::load(&directory).is_err());
            assert_eq!(std::fs::read_to_string(&path).unwrap(), content);
            assert!(!directory.join("connection.json.legacy.bak").exists());
            std::fs::remove_dir_all(directory).unwrap();
        }
    }

    #[test]
    fn crud_is_revisioned_validated_and_never_persists_sensitive_fields() {
        let directory = directory();
        let store = ContextStore::load(&directory).unwrap();
        let first = store
            .create(0, "Primary".into(), configured("one"))
            .unwrap();
        assert_eq!(first.revision, 1);
        assert!(store.create(0, "stale".into(), configured("two")).is_err());
        assert!(store
            .create(1, "primary".into(), configured("two"))
            .is_err());
        assert!(store.create(1, "Other".into(), configured("one")).is_err());
        let second = store.create(1, "Other".into(), configured("two")).unwrap();
        let active = second.active_profile_id.clone().unwrap();
        assert!(store.delete(second.revision, &active).is_err());
        let other = second
            .profiles
            .iter()
            .find(|profile| profile.id != active)
            .unwrap()
            .id
            .clone();
        let third = store.delete(second.revision, &other).unwrap();
        assert_eq!(third.profiles.len(), 1);
        assert_eq!(
            store.delete(third.revision, &active).unwrap_err().code,
            ConnectionProfileErrorCode::LastProfileDelete
        );
        let persisted = std::fs::read_to_string(directory.join("connection.json")).unwrap();
        assert!(!persisted.contains("password"));
        assert!(!persisted.contains("fingerprint"));
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn failed_atomic_write_keeps_memory_unchanged() {
        let directory = directory();
        let store = ContextStore::load(&directory).unwrap();
        store
            .create(0, "Primary".into(), configured("one"))
            .unwrap();
        std::fs::remove_file(directory.join("connection.json")).unwrap();
        std::fs::create_dir(directory.join("connection.json")).unwrap();
        assert!(store.create(1, "Other".into(), configured("two")).is_err());
        assert_eq!(store.profiles().profiles.len(), 1);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn concurrent_crud_allows_one_revision_winner_without_lost_updates() {
        let directory = directory();
        let store = std::sync::Arc::new(ContextStore::load(&directory).unwrap());
        store
            .create(0, "Primary".into(), configured("one"))
            .unwrap();
        let attempts = (0..8)
            .map(|index| {
                let store = store.clone();
                std::thread::spawn(move || {
                    store.create(
                        1,
                        format!("Concurrent {index}"),
                        configured(&format!("client-{index}")),
                    )
                })
            })
            .collect::<Vec<_>>();
        let successes = attempts
            .into_iter()
            .map(|attempt| attempt.join().unwrap())
            .filter(Result::is_ok)
            .count();
        assert_eq!(successes, 1);
        let document = store.profiles();
        assert_eq!(document.revision, 2);
        assert_eq!(document.profiles.len(), 2);
        let reloaded = ContextStore::load(&directory).unwrap();
        assert_eq!(reloaded.profiles(), document);
        std::fs::remove_dir_all(directory).unwrap();
    }
}
