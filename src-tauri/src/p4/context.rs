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

pub const CONNECTION_SCHEMA_VERSION: u32 = 3;
const PREVIOUS_CONNECTION_SCHEMA_VERSION: u32 = 2;

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
    /// Keep connection/configuration unchanged through launch reservation and spawn.
    pub(crate) fn with_custom_submit_context<T>(
        &self,
        action: impl FnOnce(Option<String>, u64, &P4Context) -> T,
    ) -> T {
        let state = self.state.read().unwrap_or_else(|error| error.into_inner());
        action(
            state.document.active_profile_id.clone(),
            state.generation,
            &state.runtime_context,
        )
    }
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

    pub fn swarm_snapshot(&self) -> (Option<String>, u64, P4Context) {
        let state = self.state.read().unwrap_or_else(|error| error.into_inner());
        (
            state.document.active_profile_id.clone(),
            state.generation,
            state.runtime_context.clone(),
        )
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

    /// Read-only lookup of any persisted profile, active or not.
    ///
    /// Profile-store writes must also work while the store has no active profile
    /// (first save, or after the active profile was deleted), so they cannot rely
    /// on `active_profile` for their journal scope.
    pub fn profile(&self, id: &str) -> Option<ConnectionProfile> {
        let state = self.state.read().unwrap_or_else(|error| error.into_inner());
        state
            .document
            .profiles
            .iter()
            .find(|profile| profile.id == id)
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
        self.update_with_generation(expected_revision, None, id, name, context)
    }

    pub fn update_if_context_unchanged(
        &self,
        expected_revision: u64,
        expected_generation: u64,
        id: &str,
        name: String,
        context: P4Context,
    ) -> Result<ConnectionProfiles, ConnectionProfileError> {
        self.update_with_generation(
            expected_revision,
            Some(expected_generation),
            id,
            name,
            context,
        )
    }

    fn update_with_generation(
        &self,
        expected_revision: u64,
        expected_generation: Option<u64>,
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
        if expected_generation.is_some_and(|expected| state.generation != expected) {
            return Err(profile_error(
                ConnectionProfileErrorCode::ContextChanged,
                "The active connection changed while its workspace Root was being verified.",
            ));
        }
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
        let active = next.active_profile_id.as_deref() == Some(id);
        if active {
            next.active_profile_id = None;
        }
        next.revision = next.revision.saturating_add(1);
        persist_document(&self.path, &next)?;
        state.document = next;
        if active {
            state.runtime_context = P4Context::default();
            state.generation = state.generation.saturating_add(1);
        }
        Ok(public_document(&state.document))
    }

    /// Compatibility path for the existing connection wizard. It updates (or creates) the active
    /// profile but does not assert that the context is connected or authenticated.
    #[cfg(test)]
    pub fn save(&self, context: P4Context) -> Result<P4Context, ConnectionProfileError> {
        let expected_generation = self.snapshot().1;
        self.save_if_unchanged(expected_generation, context)
    }

    pub fn save_if_unchanged(
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
                "The active connection changed while its workspace Root was being verified.",
            ));
        }
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

    pub fn activate_context_if_unchanged(
        &self,
        expected_revision: u64,
        expected_generation: u64,
        id: &str,
        context: P4Context,
    ) -> Result<P4Context, ConnectionProfileError> {
        let context = normalize_context(context)?;
        let mut state = self
            .state
            .write()
            .unwrap_or_else(|error| error.into_inner());
        check_revision(&state.document, expected_revision)?;
        if state.generation != expected_generation {
            return Err(profile_error(
                ConnectionProfileErrorCode::ContextChanged,
                "The active connection changed while the target profile was being verified.",
            ));
        }
        let profile_name = state
            .document
            .profiles
            .iter()
            .find(|profile| profile.id == id)
            .map(|profile| profile.name.clone())
            .ok_or_else(|| {
                profile_error(
                    ConnectionProfileErrorCode::NotFound,
                    "Connection profile was not found.",
                )
            })?;
        check_duplicates(&state.document, Some(id), &profile_name, &context)?;
        let mut next = state.document.clone();
        next.active_profile_id = Some(id.to_owned());
        next.profiles
            .iter_mut()
            .find(|profile| profile.id == id)
            .expect("profile was checked")
            .context = context.clone();
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

    /// Advances the runtime generation after an external mutation changes how the active
    /// workspace is interpreted without changing its connection fields (for example, a stream
    /// view switch). The compare-and-swap prevents an old operation from rebinding a newer
    /// profile or workspace.
    pub fn advance_generation_if_unchanged(
        &self,
        expected_generation: u64,
    ) -> Result<u64, ConnectionProfileError> {
        let mut state = self
            .state
            .write()
            .unwrap_or_else(|error| error.into_inner());
        if state.generation != expected_generation {
            return Err(profile_error(
                ConnectionProfileErrorCode::ContextChanged,
                "The active connection changed while the workspace stream was being switched.",
            ));
        }
        state.generation = state.generation.saturating_add(1);
        Ok(state.generation)
    }
}

fn default_custom_submit_field(value: &mut serde_json::Value) {
    if let Some(profiles) = value.get_mut("profiles").and_then(|v| v.as_array_mut()) {
        for profile in profiles {
            if let Some(context) = profile.get_mut("context").and_then(|v| v.as_object_mut()) {
                context
                    .entry("customSubmitExecutablePath")
                    .or_insert_with(|| serde_json::Value::String(String::new()));
            }
        }
    }
}

fn load_document(
    path: &Path,
    bytes: &[u8],
) -> Result<(PersistedProfiles, P4Context), ConnectionProfileError> {
    let mut value: serde_json::Value = serde_json::from_slice(bytes).map_err(|error| {
        profile_error(
            ConnectionProfileErrorCode::CorruptStore,
            format!("connection.json is invalid JSON and was left unchanged: {error}"),
        )
    })?;
    if value.get("schemaVersion").is_some() {
        // Add only the known optional field before the strict unknown-field check.
        // Existing v2/v3 profiles must remain readable without losing that check.
        default_custom_submit_field(&mut value);
        let document: PersistedProfiles =
            serde_json::from_value(value.clone()).map_err(|error| {
                profile_error(
                    ConnectionProfileErrorCode::CorruptStore,
                    format!(
                    "connection.json has an invalid profile schema and was left unchanged: {error}"
                ),
                )
            })?;
        if ![
            PREVIOUS_CONNECTION_SCHEMA_VERSION,
            CONNECTION_SCHEMA_VERSION,
        ]
        .contains(&document.schema_version)
        {
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
        let mut document = document;
        let mut changed = false;
        if document.schema_version == PREVIOUS_CONNECTION_SCHEMA_VERSION {
            for profile in &mut document.profiles {
                profile.context = normalize_context(profile.context.clone())?;
            }
            document.schema_version = CONNECTION_SCHEMA_VERSION;
            changed = true;
        }
        if normalize_document_paths(&mut document) {
            changed = true;
        }
        validate_document(&document)?;
        if changed {
            persist_document(path, &document)?;
        }
        // An explicitly disconnected store must stay disconnected after restart.
        let runtime = active_context(&document).unwrap_or_default();
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

pub(crate) fn validate_backup_document(bytes: &[u8]) -> Result<(), String> {
    let mut value: serde_json::Value =
        serde_json::from_slice(bytes).map_err(|error| error.to_string())?;
    if value.get("schemaVersion").is_some() {
        default_custom_submit_field(&mut value);
        let mut document: PersistedProfiles =
            serde_json::from_value(value.clone()).map_err(|error| error.to_string())?;
        if ![
            PREVIOUS_CONNECTION_SCHEMA_VERSION,
            CONNECTION_SCHEMA_VERSION,
        ]
        .contains(&document.schema_version)
        {
            return Err("unsupported connection schema version".into());
        }
        if serde_json::to_value(&document).map_err(|error| error.to_string())? != value {
            return Err("connection metadata contains unsupported fields".into());
        }
        for profile in &mut document.profiles {
            profile.context =
                normalize_context(profile.context.clone()).map_err(|error| error.message)?;
        }
        validate_document(&document).map_err(|error| error.message)?;
        return Ok(());
    }
    let legacy: P4Context = serde_json::from_value(value).map_err(|error| error.to_string())?;
    normalize_context(legacy)
        .map(|_| ())
        .map_err(|error| error.message)
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
    // A canonicalize() result (`\\?\E:\...`) must never be persisted: p4 rejects
    // the verbatim form in arguments and the UI would show or copy it verbatim.
    if let Some(cwd) = context.cwd.as_deref() {
        context.cwd = Some(crate::local_path::plain_local_path(cwd));
    }
    // These paths are handed to processes (p4 executable) or p4 env variables.
    for value in [
        &mut context.executable,
        &mut context.trust_path,
        &mut context.tickets_path,
    ]
    .into_iter()
    .flatten()
    {
        *value = crate::local_path::plain_local_path(value);
    }
    context.custom_submit_executable_path =
        crate::local_path::plain_local_path(&context.custom_submit_executable_path);
    context.swarm_base_url = context
        .swarm_base_url
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(normalize_swarm_base_url)
        .transpose()
        .map_err(|message| profile_error(ConnectionProfileErrorCode::InvalidInput, message))?;
    validate_persisted_context(&context)
        .map_err(|message| profile_error(ConnectionProfileErrorCode::InvalidInput, message))?;
    Ok(context)
}

/// Rewrites verbatim paths persisted before the normalization existed.
/// Returns true when the document changed and must be written back.
fn normalize_document_paths(document: &mut PersistedProfiles) -> bool {
    let mut changed = false;
    for profile in &mut document.profiles {
        let Some(cwd) = profile.context.cwd.clone() else {
            continue;
        };
        let plain = crate::local_path::plain_local_path(&cwd);
        if plain != cwd {
            profile.context.cwd = Some(plain);
            changed = true;
        }
    }
    changed
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
        replace_with_retry(&temp, path)?;
        sync_parent(path)?;
        Ok::<(), std::io::Error>(())
    })();
    if let Err(error) = result {
        let _ = std::fs::remove_file(&temp);
        return Err(profile_error(
            ConnectionProfileErrorCode::PersistenceFailed,
            format!(
                "Failed to atomically write connection store ({}): {error}",
                path.display()
            ),
        ));
    }
    Ok(())
}

/// Antivirus/EDR and other instances briefly lock `connection.json`; a short bounded retry is
/// safe because the replacement is atomic and the new bytes are fully fsynced first.
fn replace_with_retry(source: &Path, destination: &Path) -> std::io::Result<()> {
    let mut last = None;
    for attempt in 0..4u64 {
        match atomic_replace(source, destination) {
            Ok(()) => return Ok(()),
            Err(error) => {
                last = Some(error);
                std::thread::sleep(std::time::Duration::from_millis(40 * (attempt + 1)));
            }
        }
    }
    Err(last.unwrap_or_else(|| std::io::Error::other("atomic replace failed")))
}

#[cfg(windows)]
pub(crate) fn atomic_replace(source: &Path, destination: &Path) -> std::io::Result<()> {
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
pub(crate) fn atomic_replace(source: &Path, destination: &Path) -> std::io::Result<()> {
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
        custom_submit_executable_path: String::new(),
        server: std::env::var("P4PORT").unwrap_or_default(),
        user: std::env::var("P4USER").unwrap_or_default(),
        client: std::env::var("P4CLIENT").unwrap_or_default(),
        // The process directory is the application binary directory, not proof of a P4
        // workspace Root. Leave it unresolved until a server-owned client spec is verified.
        cwd: None,
        charset: std::env::var("P4CHARSET").ok(),
        trust_path: std::env::var("P4TRUST").ok(),
        tickets_path: std::env::var("P4TICKETS").ok(),
        swarm_base_url: None,
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
        context.swarm_base_url.as_deref(),
    ];
    if values
        .into_iter()
        .flatten()
        .any(|value| value.chars().any(char::is_control) || value.chars().count() > 4096)
    {
        return Err("Connection settings contain control characters or exceed limits".into());
    }
    if let Some(value) = context.swarm_base_url.as_deref() {
        normalize_swarm_base_url(value)?;
    }
    Ok(())
}

pub fn normalize_swarm_base_url(input: &str) -> Result<String, String> {
    if input != input.trim()
        || input.chars().any(char::is_control)
        || input.contains('\\')
        || regex::Regex::new("(?i)%(?:0[0-9a-f]|1[0-9a-f]|7f)")
            .expect("static encoded-control regex")
            .is_match(input)
        || regex::Regex::new("(?i)%(?:2e|2f|5c)")
            .expect("static encoded-path-syntax regex")
            .is_match(input)
        || input.len() > 2048
    {
        return Err("Swarm URL contains unsupported characters".into());
    }
    let mut url = url::Url::parse(input).map_err(|_| "Swarm URL is invalid")?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(
            "Swarm URL must be an http(s) base URL without credentials, query, or fragment".into(),
        );
    }
    let path = url.path().trim_end_matches('/').to_owned() + "/";
    url.set_path(&path);
    Ok(url.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn custom_submit_config_survives_profile_reload_and_old_schema3_defaults() {
        let mut context = configured("fixture-client");
        context.custom_submit_executable_path = "C:\\Synthetic Tool\\submit.exe".into();
        let document = PersistedProfiles {
            schema_version: 3,
            revision: 1,
            active_profile_id: Some("00000000-0000-4000-8000-000000000001".into()),
            profiles: vec![ConnectionProfile {
                id: "00000000-0000-4000-8000-000000000001".into(),
                name: "Fixture".into(),
                context: context.clone(),
            }],
        };
        // Current-schema load_document is a pure byte decode/validation path.
        let path = Path::new("unused-synthetic-profile-path");
        let (restored, runtime) =
            load_document(path, &serde_json::to_vec(&document).unwrap()).unwrap();
        assert_eq!(runtime, context);
        assert_eq!(restored.profiles[0].context, context);
        let mut old = serde_json::to_value(document).unwrap();
        old["profiles"][0]["context"]
            .as_object_mut()
            .unwrap()
            .remove("customSubmitExecutablePath");
        let (_, runtime) = load_document(path, &serde_json::to_vec(&old).unwrap()).unwrap();
        assert_eq!(runtime.custom_submit_executable_path, "");
        assert!(validate_backup_document(&serde_json::to_vec(&old).unwrap()).is_ok());
        old["profiles"][0]["context"]["unknownField"] = true.into();
        assert!(load_document(path, &serde_json::to_vec(&old).unwrap()).is_err());
    }

    #[test]
    fn custom_submit_context_holds_configuration_lock_through_action() {
        let context = configured("fixture-client");
        let store = ContextStore {
            path: PathBuf::from("unused-synthetic-path"),
            state: RwLock::new(StoreState {
                document: empty_document(),
                runtime_context: context.clone(),
                generation: 7,
            }),
        };
        store.with_custom_submit_context(|profile, generation, current| {
            assert_eq!(profile, None);
            assert_eq!(generation, 7);
            assert_eq!(current, &context);
            assert!(store.state.try_write().is_err());
        });
        assert!(store.state.try_write().is_ok());
    }

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
    fn environment_context_never_guesses_the_process_directory_as_workspace_root() {
        assert!(environment_context().cwd.is_none());
    }

    #[test]
    fn verbatim_workspace_roots_are_normalized_on_create_and_load() {
        let verbatim = P4Context {
            cwd: Some(r"\\?\E:\Project\Work".into()),
            ..configured("verbatim")
        };
        let normalized = normalize_context(verbatim.clone()).unwrap();
        assert_eq!(normalized.cwd.as_deref(), Some(r"E:\Project\Work"));
        assert!(!serde_json::to_string(&normalized)
            .unwrap()
            .contains(r"\\?\"));

        // A store written by an older build heals on load instead of leaking the
        // prefix into p4 arguments and the UI.
        let directory = directory();
        std::fs::create_dir_all(&directory).unwrap();
        let id = "00000000-0000-4000-8000-000000000002";
        let document = PersistedProfiles {
            schema_version: CONNECTION_SCHEMA_VERSION,
            revision: 1,
            active_profile_id: Some(id.into()),
            profiles: vec![ConnectionProfile {
                id: id.into(),
                name: "Legacy verbatim".into(),
                context: verbatim,
            }],
        };
        let path = directory.join("connection.json");
        std::fs::write(&path, serde_json::to_vec(&document).unwrap()).unwrap();
        let store = ContextStore::load(&directory).unwrap();
        let (runtime, _) = store.snapshot();
        assert_eq!(runtime.cwd.as_deref(), Some(r"E:\Project\Work"));
        let persisted = std::fs::read_to_string(&path).unwrap();
        assert!(!persisted.contains(r"\\?\"), "{persisted}");
        assert!(persisted.contains(r"E:\\Project\\Work"), "{persisted}");
        std::fs::remove_dir_all(&directory).unwrap();
    }

    #[test]
    fn active_update_rejects_generation_drift_even_when_revision_is_unchanged() {
        let directory = directory();
        let store = ContextStore::load(&directory).unwrap();
        let created = store
            .create(0, "Primary".into(), configured("primary"))
            .unwrap();
        let id = created.active_profile_id.clone().unwrap();
        let generation = store.snapshot().1;
        store.advance_generation_if_unchanged(generation).unwrap();
        let error = store
            .update_if_context_unchanged(
                created.revision,
                generation,
                &id,
                "Primary".into(),
                configured("replacement"),
            )
            .unwrap_err();
        assert_eq!(error.code, ConnectionProfileErrorCode::ContextChanged);
        assert_eq!(store.current().client, "primary");
        assert_eq!(store.profiles().revision, created.revision);
        std::fs::remove_dir_all(directory).unwrap();
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
        assert!(migrated.contains("\"schemaVersion\": 3"));
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
    fn migrates_schema_v2_to_v3_without_inventing_swarm_configuration() {
        let directory = directory();
        std::fs::create_dir_all(&directory).unwrap();
        let path = directory.join("connection.json");
        std::fs::write(
            &path,
            r#"{
  "schemaVersion": 2,
  "revision": 7,
  "activeProfileId": "550e8400-e29b-41d4-a716-446655440000",
  "profiles": [{
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "name": "Existing",
    "context": {
      "executable": null,
      "server": "ssl:test:1666",
      "user": "tester",
      "client": "main",
      "cwd": null,
      "charset": null,
      "trustPath": null,
      "ticketsPath": null
    }
  }]
}"#,
        )
        .unwrap();
        let store = ContextStore::load(&directory).unwrap();
        let document = store.profiles();
        assert_eq!(document.schema_version, 3);
        assert_eq!(document.revision, 7);
        assert_eq!(document.profiles[0].context.swarm_base_url, None);
        let persisted = std::fs::read_to_string(path).unwrap();
        assert!(persisted.contains("\"schemaVersion\": 3"));
        assert!(!persisted.contains("swarmBaseUrl"));
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn normalizes_and_rejects_unsafe_swarm_base_urls() {
        assert_eq!(
            normalize_swarm_base_url("https://swarm.example/team").unwrap(),
            "https://swarm.example/team/"
        );
        for value in [
            "javascript:alert(1)",
            "file:///tmp/a",
            "data:text/plain,x",
            "https://user:secret@swarm.example/",
            "https://swarm.example/?token=secret",
            "https://swarm.example/#fragment",
            "https://swarm.example/%0d%0aheader",
            "https://swarm.example/%2e%2e/other",
            "https://swarm.example/team%2fother",
            " https://swarm.example/",
        ] {
            assert!(normalize_swarm_base_url(value).is_err(), "{value}");
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
        let other = second
            .profiles
            .iter()
            .find(|profile| profile.id != active)
            .unwrap()
            .id
            .clone();
        let third = store.delete(second.revision, &other).unwrap();
        assert_eq!(third.profiles.len(), 1);
        let generation = store.snapshot().1;
        let empty = store.delete(third.revision, &active).unwrap();
        assert!(empty.profiles.is_empty());
        assert!(empty.active_profile_id.is_none());
        assert_eq!(store.current(), P4Context::default());
        assert!(store.snapshot().1 > generation);
        let reloaded = ContextStore::load(&directory).unwrap();
        assert_eq!(reloaded.current(), P4Context::default());
        assert!(reloaded.profiles().profiles.is_empty());
        let recreated = reloaded
            .create(empty.revision, "Recreated".into(), configured("new"))
            .unwrap();
        assert!(recreated.active_profile_id.is_some());
        assert_eq!(reloaded.current().client, "new");
        let persisted = std::fs::read_to_string(directory.join("connection.json")).unwrap();
        assert!(!persisted.contains("password"));
        assert!(!persisted.contains("fingerprint"));
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn deleting_active_profile_leaves_other_profiles_disconnected_after_reload() {
        let directory = directory();
        let store = ContextStore::load(&directory).unwrap();
        let first = store
            .create(0, "Primary".into(), configured("one"))
            .unwrap();
        let active = first.active_profile_id.unwrap();
        let second = store
            .create(first.revision, "Other".into(), configured("two"))
            .unwrap();
        let before = store.snapshot().1;
        assert!(store.delete(0, &active).is_err());
        assert_eq!(store.snapshot().1, before);
        let deleted = store.delete(second.revision, &active).unwrap();
        assert_eq!(deleted.profiles.len(), 1);
        assert!(deleted.active_profile_id.is_none());
        assert_eq!(store.current(), P4Context::default());
        assert_eq!(
            ContextStore::load(&directory).unwrap().current(),
            P4Context::default()
        );
        let other = deleted.profiles[0].id.clone();
        store
            .activate_context_if_unchanged(
                deleted.revision,
                store.snapshot().1,
                &other,
                configured("two"),
            )
            .unwrap();
        assert_eq!(store.current().client, "two");
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn profile_lookup_keeps_an_inactive_target_readable_without_an_active_profile() {
        let directory = directory();
        let store = ContextStore::load(&directory).unwrap();
        let first = store
            .create(0, "Primary".into(), configured("one"))
            .unwrap();
        let active = first.active_profile_id.clone().unwrap();
        let second = store
            .create(first.revision, "Other".into(), configured("two"))
            .unwrap();
        let other = second
            .profiles
            .iter()
            .find(|profile| profile.id != active)
            .unwrap()
            .id
            .clone();
        assert_eq!(store.profile(&other).unwrap().context.client, "two");
        let deleted = store.delete(second.revision, &active).unwrap();
        assert!(deleted.active_profile_id.is_none());
        // Profile-store reads still resolve the write target while disconnected.
        assert_eq!(store.profile(&other).unwrap().context.client, "two");
        assert!(store.profile("missing").is_none());
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
        let generation = store.snapshot().1;
        let active = store.active_profile_id().unwrap();
        assert!(store.delete(1, &active).is_err());
        assert_eq!(store.active_profile_id().as_deref(), Some(active.as_str()));
        assert_eq!(store.current().client, "one");
        assert_eq!(store.snapshot().1, generation);
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
