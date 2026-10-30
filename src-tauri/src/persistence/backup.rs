//! Self-contained, non-secret configuration backups and restart-safe restore.

use chrono::Utc;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};
use uuid::Uuid;

const BACKUP_SCHEMA_VERSION: u32 = 1;
const MAX_BUNDLE_BYTES: usize = 4 * 1024 * 1024;
const MAX_FILE_BYTES: usize = 2 * 1024 * 1024;
const MAX_LOCAL_STORAGE_VALUE_BYTES: usize = 256 * 1024;
const MAX_LOCAL_STORAGE_TOTAL_BYTES: usize = 2 * 1024 * 1024;
const MAX_LOCAL_STORAGE_ENTRIES: usize = 200;
const CONNECTION_FILE: &str = "connection.json";
const WINDOW_PLACEMENT_FILE: &str = "window-placement-v1.json";
const PENDING_RESTORE_FILE: &str = "pending-restore-v1.json";
const RESTORE_STATUS_FILE: &str = "restore-status-v1.json";
const BACKUP_PREFIX: &str = "p4deck-config-";

const ALLOWED_LOCAL_STORAGE_KEYS: &[&str] = &[
    "p4deck.ui",
    "p4deck.locale",
    "p4deck.theme",
    "p4deck.leftOpen",
    "p4deck.toolOpen",
    "p4deck.toolTab",
    "p4deck.toolHeight",
    "p4deck.dockLayout",
    "p4deck.nativePanels",
    "p4deck.pages",
    "p4deck.submitted.filters",
    "p4deck.pending-filter.v1",
    "p4deck.p4Log.view.v1",
];
const ALLOWED_LOCAL_STORAGE_PREFIXES: &[&str] = &["p4deck.panel.", "p4deck.toolPanel."];

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BackupLocalStorageEntry {
    pub key: String,
    pub value: String,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum BackupKind {
    Manual,
    PreRestore,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConfigBackupSummary {
    pub file_name: String,
    pub created_at: String,
    pub size_bytes: u64,
    pub kind: BackupKind,
    pub includes_connection: bool,
    pub includes_window_placement: bool,
    pub local_storage_keys: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConfigBackupRestoreStatus {
    pub state: RestoreState,
    pub source_file_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rollback_file_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum RestoreState {
    Pending,
    Succeeded,
    Failed,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConfigBackupPendingRestore {
    pub source_file_name: String,
    pub rollback_file_name: String,
    pub staged_at: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConfigBackupOverview {
    pub directory: String,
    pub backups: Vec<ConfigBackupSummary>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pending_restore: Option<ConfigBackupPendingRestore>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_restore: Option<ConfigBackupRestoreStatus>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConfigBackupCreateRequest {
    #[serde(default)]
    pub local_storage: Vec<BackupLocalStorageEntry>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConfigBackupCreateResult {
    pub backup: ConfigBackupSummary,
    pub omitted_local_storage_keys: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConfigBackupRestoreRequest {
    pub file_name: String,
    #[serde(default)]
    pub local_storage: Vec<BackupLocalStorageEntry>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConfigBackupRestoreResult {
    pub source_file_name: String,
    pub rollback_file_name: String,
    pub local_storage: Vec<BackupLocalStorageEntry>,
    pub restart_required: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BackupFile {
    name: String,
    content: String,
    sha256: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BackupBundle {
    schema_version: u32,
    created_at: String,
    app_version: String,
    kind: BackupKind,
    files: Vec<BackupFile>,
    local_storage: Vec<BackupLocalStorageEntry>,
    omitted: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PendingRestoreManifest {
    schema_version: u32,
    source_file_name: String,
    source_sha256: String,
    rollback_file_name: String,
    staged_at: String,
}

pub struct ConfigBackupService {
    data_dir: PathBuf,
    backup_dir: PathBuf,
}

impl ConfigBackupService {
    pub fn new(data_dir: PathBuf) -> Self {
        let backup_dir = data_dir.join("backups");
        Self {
            data_dir,
            backup_dir,
        }
    }

    pub fn directory(&self) -> PathBuf {
        self.backup_dir.clone()
    }

    pub fn create(
        &self,
        request: ConfigBackupCreateRequest,
    ) -> Result<ConfigBackupCreateResult, String> {
        let (local_storage, mut omitted) = sanitize_local_storage(request.local_storage)?;
        let token = Uuid::new_v4();
        let file_name = format!("{BACKUP_PREFIX}manual-{token}.json");
        let bundle = self.bundle(BackupKind::Manual, local_storage, omitted.clone())?;
        validate_bundle(&bundle)?;
        let path = self.backup_path(&file_name)?;
        let bytes = serde_json::to_vec_pretty(&bundle).map_err(|error| error.to_string())?;
        atomic_write(&path, &bytes)?;
        omitted.sort();
        Ok(ConfigBackupCreateResult {
            backup: summary(&file_name, bytes.len() as u64, &bundle),
            omitted_local_storage_keys: omitted,
        })
    }

    pub fn overview(&self) -> Result<ConfigBackupOverview, String> {
        fs::create_dir_all(&self.backup_dir).map_err(|error| error.to_string())?;
        let mut backups = Vec::new();
        for entry in fs::read_dir(&self.backup_dir).map_err(|error| error.to_string())? {
            let entry = match entry {
                Ok(entry) => entry,
                Err(_) => continue,
            };
            let name = entry.file_name().to_string_lossy().into_owned();
            if !looks_like_backup_file_name(&name) {
                continue;
            }
            let Ok(bytes) = read_limited(&entry.path(), MAX_BUNDLE_BYTES) else {
                continue;
            };
            let Ok(bundle) = parse_bundle(&bytes) else {
                continue;
            };
            backups.push(summary(&name, bytes.len() as u64, &bundle));
        }
        backups.sort_by(|left, right| right.created_at.cmp(&left.created_at));
        let pending_restore = self.read_pending_overview().ok().flatten();
        let last_restore = self.read_restore_status().ok().flatten();
        Ok(ConfigBackupOverview {
            directory: self.backup_dir.to_string_lossy().into_owned(),
            backups,
            pending_restore,
            last_restore,
        })
    }

    pub fn restore(
        &self,
        request: ConfigBackupRestoreRequest,
    ) -> Result<ConfigBackupRestoreResult, String> {
        let source_path = self.backup_path(&request.file_name)?;
        let source_bytes = read_limited(&source_path, MAX_BUNDLE_BYTES)?;
        let source_bundle = parse_bundle(&source_bytes)?;
        if self.pending_path().exists() {
            return Err(
                "Another configuration restore is already waiting for the next application start."
                    .into(),
            );
        }

        let (current_local_storage, _) = sanitize_local_storage(request.local_storage)?;
        let rollback_token = Uuid::new_v4();
        let rollback_file_name = format!("{BACKUP_PREFIX}pre-restore-{rollback_token}.json");
        let rollback_bundle =
            self.bundle(BackupKind::PreRestore, current_local_storage, Vec::new())?;
        validate_bundle(&rollback_bundle)?;
        let rollback_bytes =
            serde_json::to_vec_pretty(&rollback_bundle).map_err(|error| error.to_string())?;
        atomic_write(&self.backup_path(&rollback_file_name)?, &rollback_bytes)?;

        let staged_at = Utc::now().to_rfc3339();
        let manifest = PendingRestoreManifest {
            schema_version: BACKUP_SCHEMA_VERSION,
            source_file_name: request.file_name.clone(),
            source_sha256: sha256_hex(&source_bytes),
            rollback_file_name: rollback_file_name.clone(),
            staged_at: staged_at.clone(),
        };
        let manifest_bytes =
            serde_json::to_vec_pretty(&manifest).map_err(|error| error.to_string())?;
        atomic_write(&self.pending_path(), &manifest_bytes)?;
        write_restore_status(
            &self.status_path(),
            &ConfigBackupRestoreStatus {
                state: RestoreState::Pending,
                source_file_name: request.file_name.clone(),
                rollback_file_name: Some(rollback_file_name.clone()),
                completed_at: None,
                message: Some(
                    "Restore is staged and will be applied before the next connection store load."
                        .into(),
                ),
            },
        )?;

        Ok(ConfigBackupRestoreResult {
            source_file_name: request.file_name,
            rollback_file_name,
            local_storage: source_bundle.local_storage,
            restart_required: true,
        })
    }

    /// Applies a staged restore before `ContextStore::load`. A failure leaves the
    /// live files untouched when validation fails; failures during replacement
    /// keep the pending manifest and expose the pre-restore rollback in Settings.
    pub fn apply_pending(&self) -> Result<Option<ConfigBackupRestoreStatus>, String> {
        let pending_path = self.pending_path();
        let bytes = match read_limited(&pending_path, MAX_BUNDLE_BYTES) {
            Ok(bytes) => bytes,
            Err(_error) if !pending_path.exists() => return self.read_restore_status(),
            Err(error) => return Err(self.fail_pending("unreadable-pending.json", None, error)),
        };
        let manifest: PendingRestoreManifest = match serde_json::from_slice(&bytes) {
            Ok(value) => value,
            Err(error) => {
                return Err(self.fail_pending(
                    "unreadable-pending.json",
                    None,
                    format!("pending restore metadata is invalid: {error}"),
                ))
            }
        };
        if manifest.schema_version != BACKUP_SCHEMA_VERSION {
            return Err(self.fail_pending(
                &manifest.source_file_name,
                Some(&manifest.rollback_file_name),
                "pending restore metadata has an unsupported schema version".into(),
            ));
        }
        let source_path = match self.backup_path(&manifest.source_file_name) {
            Ok(path) => path,
            Err(error) => {
                return Err(self.fail_pending(
                    &manifest.source_file_name,
                    Some(&manifest.rollback_file_name),
                    error,
                ))
            }
        };
        let source_bytes = match read_limited(&source_path, MAX_BUNDLE_BYTES) {
            Ok(bytes) => bytes,
            Err(error) => {
                return Err(self.fail_pending(
                    &manifest.source_file_name,
                    Some(&manifest.rollback_file_name),
                    error,
                ))
            }
        };
        if sha256_hex(&source_bytes) != manifest.source_sha256 {
            return Err(self.fail_pending(
                &manifest.source_file_name,
                Some(&manifest.rollback_file_name),
                "backup digest changed after the restore was staged".into(),
            ));
        }
        let bundle = match parse_bundle(&source_bytes) {
            Ok(bundle) => bundle,
            Err(error) => {
                return Err(self.fail_pending(
                    &manifest.source_file_name,
                    Some(&manifest.rollback_file_name),
                    error,
                ))
            }
        };
        if let Err(error) = self.apply_bundle(&bundle) {
            return Err(self.fail_pending(
                &manifest.source_file_name,
                Some(&manifest.rollback_file_name),
                error,
            ));
        }
        let status = ConfigBackupRestoreStatus {
            state: RestoreState::Succeeded,
            source_file_name: manifest.source_file_name,
            rollback_file_name: Some(manifest.rollback_file_name),
            completed_at: Some(Utc::now().to_rfc3339()),
            message: Some(
                "Configuration restore completed before the application loaded its connection store."
                    .into(),
            ),
        };
        write_restore_status(&self.status_path(), &status)?;
        let _ = fs::remove_file(pending_path);
        Ok(Some(status))
    }

    fn fail_pending(
        &self,
        source_file_name: &str,
        rollback_file_name: Option<&str>,
        message: String,
    ) -> String {
        let status = ConfigBackupRestoreStatus {
            state: RestoreState::Failed,
            source_file_name: source_file_name.into(),
            rollback_file_name: rollback_file_name.map(str::to_owned),
            completed_at: Some(Utc::now().to_rfc3339()),
            message: Some(message.clone()),
        };
        let _ = write_restore_status(&self.status_path(), &status);
        let failed = self
            .backup_dir
            .join(format!("pending-restore-failed-{}.json", Uuid::new_v4()));
        if self.pending_path().exists() {
            let _ = fs::create_dir_all(&self.backup_dir);
            let _ = fs::rename(self.pending_path(), failed);
        }
        message
    }

    fn apply_bundle(&self, bundle: &BackupBundle) -> Result<(), String> {
        self.apply_bundle_with(bundle, atomic_write, |path| {
            if path.exists() {
                fs::remove_file(path).map_err(|error| error.to_string())?;
            }
            Ok(())
        })
    }

    fn apply_bundle_with(
        &self,
        bundle: &BackupBundle,
        mut write: impl FnMut(&Path, &[u8]) -> Result<(), String>,
        mut remove: impl FnMut(&Path) -> Result<(), String>,
    ) -> Result<(), String> {
        let files = bundle
            .files
            .iter()
            .map(|file| (file.name.as_str(), file))
            .collect::<BTreeMap<_, _>>();
        let previous = [CONNECTION_FILE, WINDOW_PLACEMENT_FILE]
            .into_iter()
            .map(|name| {
                let path = self.data_dir.join(name);
                if path.exists() {
                    Ok((name, Some(read_limited(&path, MAX_FILE_BYTES)?)))
                } else {
                    Ok((name, None))
                }
            })
            .collect::<Result<Vec<_>, String>>()?;
        let result: Result<(), String> = (|| {
            for name in [CONNECTION_FILE, WINDOW_PLACEMENT_FILE] {
                let destination = self.data_dir.join(name);
                if let Some(file) = files.get(name) {
                    write(&destination, file.content.as_bytes())?;
                } else {
                    remove(&destination)?;
                }
            }
            Ok(())
        })();
        if let Err(error) = result {
            let mut rollback_errors = Vec::new();
            for (name, bytes) in previous {
                let destination = self.data_dir.join(name);
                let result = match bytes {
                    Some(bytes) => write(&destination, &bytes),
                    None => remove(&destination),
                };
                if let Err(rollback_error) = result {
                    rollback_errors.push(format!("{name}: {rollback_error}"));
                }
            }
            if rollback_errors.is_empty() {
                return Err(format!(
                    "{error}; all previously live configuration files were restored"
                ));
            }
            return Err(format!(
                "{error}; rollback also failed for {}",
                rollback_errors.join(", ")
            ));
        }
        Ok(())
    }

    #[cfg(test)]
    fn apply_bundle_for_test(
        &self,
        bundle: &BackupBundle,
        reject_window_once: bool,
    ) -> Result<(), String> {
        let mut reject = reject_window_once;
        self.apply_bundle_with(
            bundle,
            |path, bytes| {
                if reject
                    && path.file_name().and_then(|value| value.to_str())
                        == Some(WINDOW_PLACEMENT_FILE)
                {
                    reject = false;
                    return Err("injected window placement write failure".into());
                }
                atomic_write(path, bytes)
            },
            |path| {
                if path.exists() {
                    fs::remove_file(path).map_err(|error| error.to_string())?;
                }
                Ok(())
            },
        )
    }

    fn bundle(
        &self,
        kind: BackupKind,
        local_storage: Vec<BackupLocalStorageEntry>,
        omitted: Vec<String>,
    ) -> Result<BackupBundle, String> {
        let mut files = Vec::new();
        for name in [CONNECTION_FILE, WINDOW_PLACEMENT_FILE] {
            let path = self.data_dir.join(name);
            if path.exists() {
                let bytes = read_limited(&path, MAX_FILE_BYTES)?;
                let content = String::from_utf8(bytes.clone())
                    .map_err(|_| format!("{name} is not valid UTF-8"))?;
                files.push(BackupFile {
                    name: name.into(),
                    content,
                    sha256: sha256_hex(&bytes),
                });
            }
        }
        Ok(BackupBundle {
            schema_version: BACKUP_SCHEMA_VERSION,
            created_at: Utc::now().to_rfc3339(),
            app_version: env!("CARGO_PKG_VERSION").into(),
            kind,
            files,
            local_storage,
            omitted,
        })
    }

    fn backup_path(&self, file_name: &str) -> Result<PathBuf, String> {
        if !looks_like_backup_file_name(file_name) {
            return Err("invalid backup file name".into());
        }
        Ok(self.backup_dir.join(file_name))
    }

    fn pending_path(&self) -> PathBuf {
        self.data_dir.join(PENDING_RESTORE_FILE)
    }

    fn status_path(&self) -> PathBuf {
        self.data_dir.join(RESTORE_STATUS_FILE)
    }

    fn read_pending_overview(&self) -> Result<Option<ConfigBackupPendingRestore>, String> {
        if !self.pending_path().exists() {
            return Ok(None);
        }
        let bytes = read_limited(&self.pending_path(), MAX_FILE_BYTES)?;
        let manifest: PendingRestoreManifest =
            serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
        Ok(Some(ConfigBackupPendingRestore {
            source_file_name: manifest.source_file_name,
            rollback_file_name: manifest.rollback_file_name,
            staged_at: manifest.staged_at,
        }))
    }

    fn read_restore_status(&self) -> Result<Option<ConfigBackupRestoreStatus>, String> {
        if !self.status_path().exists() {
            return Ok(None);
        }
        let bytes = read_limited(&self.status_path(), MAX_FILE_BYTES)?;
        Ok(Some(
            serde_json::from_slice(&bytes).map_err(|error| error.to_string())?,
        ))
    }
}

fn sanitize_local_storage(
    entries: Vec<BackupLocalStorageEntry>,
) -> Result<(Vec<BackupLocalStorageEntry>, Vec<String>), String> {
    if entries.len() > MAX_LOCAL_STORAGE_ENTRIES {
        return Err("too many local storage entries in backup request".into());
    }
    let mut allowed = BTreeMap::new();
    let mut omitted = BTreeSet::new();
    let mut total = 0usize;
    for entry in entries {
        if !is_allowed_local_storage_key(&entry.key)
            || entry.key.len() > 128
            || entry.value.len() > MAX_LOCAL_STORAGE_VALUE_BYTES
        {
            omitted.insert(entry.key);
            continue;
        }
        let previous = allowed.insert(entry.key.clone(), entry.value);
        total += allowed.get(&entry.key).map(String::len).unwrap_or_default();
        total = total.saturating_sub(previous.as_ref().map(String::len).unwrap_or_default());
        if total > MAX_LOCAL_STORAGE_TOTAL_BYTES {
            return Err("local storage backup exceeds the size limit".into());
        }
    }
    Ok((
        allowed
            .into_iter()
            .map(|(key, value)| BackupLocalStorageEntry { key, value })
            .collect(),
        omitted.into_iter().collect(),
    ))
}

fn is_allowed_local_storage_key(key: &str) -> bool {
    ALLOWED_LOCAL_STORAGE_KEYS.contains(&key)
        || ALLOWED_LOCAL_STORAGE_PREFIXES
            .iter()
            .any(|prefix| key.starts_with(prefix))
}

fn parse_bundle(bytes: &[u8]) -> Result<BackupBundle, String> {
    let bundle: BackupBundle =
        serde_json::from_slice(bytes).map_err(|error| format!("invalid backup: {error}"))?;
    validate_bundle(&bundle)?;
    Ok(bundle)
}

fn validate_bundle(bundle: &BackupBundle) -> Result<(), String> {
    if bundle.schema_version != BACKUP_SCHEMA_VERSION {
        return Err("unsupported backup schema version".into());
    }
    chrono::DateTime::parse_from_rfc3339(&bundle.created_at)
        .map_err(|_| "backup creation time is invalid".to_string())?;
    if bundle.files.len() > 2 {
        return Err("backup contains too many files".into());
    }
    let mut names = BTreeSet::new();
    for file in &bundle.files {
        if ![CONNECTION_FILE, WINDOW_PLACEMENT_FILE].contains(&file.name.as_str())
            || !names.insert(file.name.clone())
        {
            return Err("backup contains an unknown or duplicate file".into());
        }
        let bytes = file.content.as_bytes();
        if bytes.len() > MAX_FILE_BYTES || sha256_hex(bytes) != file.sha256 {
            return Err(format!("digest mismatch for {}", file.name));
        }
        match file.name.as_str() {
            CONNECTION_FILE => crate::p4::context::validate_backup_document(bytes)
                .map_err(|error| format!("connection.json is invalid: {error}"))?,
            WINDOW_PLACEMENT_FILE => crate::window_placement::validate_backup_document(bytes)
                .map_err(|error| format!("window placement is invalid: {error}"))?,
            _ => unreachable!(),
        }
    }
    let (entries, _) = sanitize_local_storage(bundle.local_storage.clone())?;
    if entries.len() != bundle.local_storage.len() {
        return Err("backup contains a disallowed local storage key".into());
    }
    Ok(())
}

fn summary(file_name: &str, size_bytes: u64, bundle: &BackupBundle) -> ConfigBackupSummary {
    ConfigBackupSummary {
        file_name: file_name.into(),
        created_at: bundle.created_at.clone(),
        size_bytes,
        kind: bundle.kind,
        includes_connection: bundle.files.iter().any(|file| file.name == CONNECTION_FILE),
        includes_window_placement: bundle
            .files
            .iter()
            .any(|file| file.name == WINDOW_PLACEMENT_FILE),
        local_storage_keys: bundle
            .local_storage
            .iter()
            .map(|entry| entry.key.clone())
            .collect(),
    }
}

fn looks_like_backup_file_name(name: &str) -> bool {
    name.starts_with(BACKUP_PREFIX)
        && name.ends_with(".json")
        && name.len() <= 160
        && Path::new(name).file_name().and_then(|value| value.to_str()) == Some(name)
        && name.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.')
        })
}

fn read_limited(path: &Path, limit: usize) -> Result<Vec<u8>, String> {
    let metadata = fs::metadata(path).map_err(|error| error.to_string())?;
    if !metadata.is_file() || metadata.len() > limit as u64 {
        return Err("backup file exceeds the size limit".into());
    }
    fs::read(path).map_err(|error| error.to_string())
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("backup");
    let temporary = path.with_file_name(format!(".{name}.{}.tmp", Uuid::new_v4()));
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        crate::p4::context::atomic_replace(&temporary, path)
    })();
    if let Err(error) = result {
        let _ = fs::remove_file(&temporary);
        return Err(error.to_string());
    }
    Ok(())
}

fn write_restore_status(path: &Path, status: &ConfigBackupRestoreStatus) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(status).map_err(|error| error.to_string())?;
    atomic_write(path, &bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_directory() -> PathBuf {
        let path = std::env::temp_dir().join(format!("p4deck-config-backup-{}", Uuid::new_v4()));
        fs::create_dir_all(&path).unwrap();
        path
    }

    fn connection(server: &str, revision: u64) -> String {
        format!(
            r#"{{
  "schemaVersion": 3,
  "revision": {revision},
  "activeProfileId": "11111111-1111-4111-8111-111111111111",
  "profiles": [{{
    "id": "11111111-1111-4111-8111-111111111111",
    "name": "Primary",
    "context": {{
      "executable": null,
      "server": "{server}",
      "user": "fixture-user",
      "client": "fixture-client",
      "cwd": "C:\\fixture\\workspace",
      "charset": null,
      "trustPath": null,
      "ticketsPath": null
    }}
  }}]
}}"#
        )
    }

    fn placement(x: i32) -> String {
        format!(
            r#"{{"version":1,"panels":{{"terminal":{{"x":{x},"y":20,"width":900,"height":700,"maximized":false}}}}}}"#
        )
    }

    fn entry(key: &str, value: &str) -> BackupLocalStorageEntry {
        BackupLocalStorageEntry {
            key: key.into(),
            value: value.into(),
        }
    }

    #[test]
    fn manual_backup_is_self_contained_and_excludes_credentials_and_ephemeral_state() {
        let directory = temp_directory();
        fs::write(
            directory.join(CONNECTION_FILE),
            connection("127.0.0.1:16661", 1),
        )
        .unwrap();
        fs::write(directory.join(WINDOW_PLACEMENT_FILE), placement(10)).unwrap();
        fs::write(directory.join("tickets"), "ticket-secret").unwrap();
        fs::write(directory.join("trust"), "fingerprint-secret").unwrap();
        fs::write(directory.join("operations.sqlite"), "journal-secret").unwrap();
        let service = ConfigBackupService::new(directory.clone());
        let result = service
            .create(ConfigBackupCreateRequest {
                local_storage: vec![
                    entry("p4deck.ui", r#"{"compact":true}"#),
                    entry("p4deck.panel.diff--1", r#"{"target":"//depot/a"}"#),
                    entry("p4deck.terminalHistory", r#"["p4 print //depot/secret"]"#),
                    entry("p4deck.fileSelection", r#"{"path":"//depot/private"}"#),
                ],
            })
            .unwrap();
        assert_eq!(
            result.omitted_local_storage_keys,
            vec![
                "p4deck.fileSelection".to_string(),
                "p4deck.terminalHistory".to_string()
            ]
        );
        let bytes = fs::read(service.backup_path(&result.backup.file_name).unwrap()).unwrap();
        let text = String::from_utf8(bytes.clone()).unwrap();
        assert!(!text.contains("ticket-secret"));
        assert!(!text.contains("fingerprint-secret"));
        assert!(!text.contains("journal-secret"));
        assert!(!text.contains("p4 print"));
        assert!(!text.contains("//depot/private"));
        let bundle = parse_bundle(&bytes).unwrap();
        assert_eq!(bundle.files.len(), 2);
        assert_eq!(bundle.local_storage.len(), 2);
        assert!(bundle.files.iter().all(|file| file.sha256.len() == 64));
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn restore_is_staged_then_applied_at_start_with_a_rollback_bundle() {
        let directory = temp_directory();
        fs::write(
            directory.join(CONNECTION_FILE),
            connection("127.0.0.1:16661", 1),
        )
        .unwrap();
        fs::write(directory.join(WINDOW_PLACEMENT_FILE), placement(10)).unwrap();
        let service = ConfigBackupService::new(directory.clone());
        let created = service
            .create(ConfigBackupCreateRequest {
                local_storage: vec![entry("p4deck.ui", r#"{"compact":true}"#)],
            })
            .unwrap();
        fs::write(
            directory.join(CONNECTION_FILE),
            connection("127.0.0.1:16662", 2),
        )
        .unwrap();
        fs::write(directory.join(WINDOW_PLACEMENT_FILE), placement(20)).unwrap();

        let restored = service
            .restore(ConfigBackupRestoreRequest {
                file_name: created.backup.file_name,
                local_storage: vec![entry("p4deck.ui", r#"{"compact":false}"#)],
            })
            .unwrap();
        assert!(restored.restart_required);
        assert_eq!(
            restored.local_storage,
            vec![entry("p4deck.ui", r#"{"compact":true}"#)]
        );
        let before_start = fs::read_to_string(directory.join(CONNECTION_FILE)).unwrap();
        assert!(before_start.contains("127.0.0.1:16662"));

        let status = service.apply_pending().unwrap().unwrap();
        assert_eq!(status.state, RestoreState::Succeeded);
        let after_start = fs::read_to_string(directory.join(CONNECTION_FILE)).unwrap();
        assert!(after_start.contains("127.0.0.1:16661"));
        assert!(!service.pending_path().exists());

        let rollback_bytes =
            fs::read(service.backup_path(&restored.rollback_file_name).unwrap()).unwrap();
        let rollback = parse_bundle(&rollback_bytes).unwrap();
        let previous = rollback
            .files
            .iter()
            .find(|file| file.name == CONNECTION_FILE)
            .unwrap();
        assert!(previous.content.contains("127.0.0.1:16662"));
        assert_eq!(
            rollback.local_storage,
            vec![entry("p4deck.ui", r#"{"compact":false}"#)]
        );
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn failed_second_file_replacement_restores_every_live_configuration_file() {
        let directory = temp_directory();
        fs::write(
            directory.join(CONNECTION_FILE),
            connection("127.0.0.1:16661", 1),
        )
        .unwrap();
        fs::write(directory.join(WINDOW_PLACEMENT_FILE), placement(10)).unwrap();
        let service = ConfigBackupService::new(directory.clone());
        let created = service
            .create(ConfigBackupCreateRequest {
                local_storage: Vec::new(),
            })
            .unwrap();
        let bundle = parse_bundle(
            &fs::read(service.backup_path(&created.backup.file_name).unwrap()).unwrap(),
        )
        .unwrap();
        let current_connection = connection("127.0.0.1:16662", 2);
        let current_placement = placement(20);
        fs::write(directory.join(CONNECTION_FILE), &current_connection).unwrap();
        fs::write(directory.join(WINDOW_PLACEMENT_FILE), &current_placement).unwrap();

        let error = service.apply_bundle_for_test(&bundle, true).unwrap_err();
        assert!(error.contains("injected window placement write failure"));
        assert!(error.contains("all previously live configuration files were restored"));
        assert_eq!(
            fs::read_to_string(directory.join(CONNECTION_FILE)).unwrap(),
            current_connection
        );
        assert_eq!(
            fs::read_to_string(directory.join(WINDOW_PLACEMENT_FILE)).unwrap(),
            current_placement
        );
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn digest_mismatch_and_path_traversal_do_not_stage_a_restore() {
        let directory = temp_directory();
        fs::write(
            directory.join(CONNECTION_FILE),
            connection("127.0.0.1:16661", 1),
        )
        .unwrap();
        let service = ConfigBackupService::new(directory.clone());
        let created = service
            .create(ConfigBackupCreateRequest {
                local_storage: Vec::new(),
            })
            .unwrap();
        let path = service.backup_path(&created.backup.file_name).unwrap();
        let mut bundle = parse_bundle(&fs::read(&path).unwrap()).unwrap();
        bundle.files[0].content = connection("tampered:1666", 9);
        fs::write(&path, serde_json::to_vec_pretty(&bundle).unwrap()).unwrap();

        assert!(service
            .restore(ConfigBackupRestoreRequest {
                file_name: created.backup.file_name.clone(),
                local_storage: Vec::new(),
            })
            .is_err());
        assert!(!service.pending_path().exists());
        assert!(service
            .restore(ConfigBackupRestoreRequest {
                file_name: "../connection.json".into(),
                local_storage: Vec::new(),
            })
            .is_err());
        assert!(!service.pending_path().exists());
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn unknown_bundle_file_is_rejected_before_any_live_file_changes() {
        let directory = temp_directory();
        fs::write(
            directory.join(CONNECTION_FILE),
            connection("127.0.0.1:16661", 1),
        )
        .unwrap();
        let service = ConfigBackupService::new(directory.clone());
        let created = service
            .create(ConfigBackupCreateRequest {
                local_storage: Vec::new(),
            })
            .unwrap();
        let path = service.backup_path(&created.backup.file_name).unwrap();
        let mut bundle = parse_bundle(&fs::read(&path).unwrap()).unwrap();
        let content = "{}".to_string();
        bundle.files.push(BackupFile {
            name: "../../tickets".into(),
            sha256: sha256_hex(content.as_bytes()),
            content,
        });
        fs::write(&path, serde_json::to_vec_pretty(&bundle).unwrap()).unwrap();
        let current = fs::read(directory.join(CONNECTION_FILE)).unwrap();
        assert!(service
            .restore(ConfigBackupRestoreRequest {
                file_name: created.backup.file_name,
                local_storage: Vec::new(),
            })
            .is_err());
        assert_eq!(fs::read(directory.join(CONNECTION_FILE)).unwrap(), current);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn pending_backup_tampering_fails_without_overwriting_live_configuration() {
        let directory = temp_directory();
        let current = connection("127.0.0.1:16662", 2);
        fs::write(
            directory.join(CONNECTION_FILE),
            connection("127.0.0.1:16661", 1),
        )
        .unwrap();
        let service = ConfigBackupService::new(directory.clone());
        let created = service
            .create(ConfigBackupCreateRequest {
                local_storage: Vec::new(),
            })
            .unwrap();
        fs::write(directory.join(CONNECTION_FILE), &current).unwrap();
        service
            .restore(ConfigBackupRestoreRequest {
                file_name: created.backup.file_name.clone(),
                local_storage: Vec::new(),
            })
            .unwrap();

        let source = service.backup_path(&created.backup.file_name).unwrap();
        let mut bytes = fs::read(&source).unwrap();
        bytes.push(b'\n');
        fs::write(&source, bytes).unwrap();
        assert!(service.apply_pending().is_err());
        assert_eq!(
            fs::read_to_string(directory.join(CONNECTION_FILE)).unwrap(),
            current
        );
        let status = service.read_restore_status().unwrap().unwrap();
        assert_eq!(status.state, RestoreState::Failed);
        assert!(!service.pending_path().exists());
        fs::remove_dir_all(directory).unwrap();
    }
}
