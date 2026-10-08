//! Non-secret P4 connection configuration and persistence.
//!
//! Command execution and authentication deliberately live outside this module. The persisted
//! schema contains only connection parameters and paths to credential files, never passwords or
//! ticket contents.

use crate::domain::P4Context;
use std::{path::PathBuf, sync::RwLock};

struct CurrentContext {
    value: P4Context,
    generation: u64,
}

pub struct ContextStore {
    path: PathBuf,
    current: RwLock<CurrentContext>,
}

impl ContextStore {
    pub fn load(directory: &std::path::Path) -> Self {
        let path = directory.join("connection.json");
        let persisted = std::fs::read(&path).ok();
        let parsed = persisted
            .as_deref()
            .and_then(|bytes| serde_json::from_slice::<P4Context>(bytes).ok());
        let loaded = parsed
            .clone()
            .filter(|context| validate_values(context).is_ok());
        let current = loaded.clone().unwrap_or_else(environment_context);
        // Re-serialize legacy files through the allowlisted schema. This preserves compatible
        // fields while removing any historic/unknown secret property such as `password`.
        if let Some(parsed) = parsed {
            if let Ok(sanitized) = serde_json::to_vec_pretty(&parsed) {
                if persisted.as_deref() != Some(sanitized.as_slice()) {
                    let _ = std::fs::write(&path, sanitized);
                }
            }
        }
        Self {
            path,
            current: RwLock::new(CurrentContext {
                value: current,
                generation: 1,
            }),
        }
    }

    pub fn current(&self) -> P4Context {
        self.current
            .read()
            .unwrap_or_else(|error| error.into_inner())
            .value
            .clone()
    }

    /// Returns the connection and the in-process generation under one read lock.
    /// The generation changes on every accepted save, including switching away and back.
    pub fn snapshot(&self) -> (P4Context, u64) {
        let current = self
            .current
            .read()
            .unwrap_or_else(|error| error.into_inner());
        (current.value.clone(), current.generation)
    }

    pub fn save(&self, context: P4Context) -> Result<P4Context, String> {
        validate_persisted_context(&context)?;
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let bytes = serde_json::to_vec_pretty(&context).map_err(|error| error.to_string())?;
        std::fs::write(&self.path, bytes).map_err(|error| error.to_string())?;
        let mut current = self
            .current
            .write()
            .unwrap_or_else(|error| error.into_inner());
        current.value = context.clone();
        current.generation = current.generation.saturating_add(1);
        Ok(context)
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
        .any(|value| value.chars().any(char::is_control))
    {
        return Err("Connection settings contain control characters".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn configured() -> P4Context {
        P4Context {
            server: "ssl:test:1666".into(),
            user: "tester".into(),
            client: "test-workspace".into(),
            tickets_path: Some("/credentials/tickets".into()),
            trust_path: Some("/credentials/trust".into()),
            ..Default::default()
        }
    }

    #[test]
    fn loads_legacy_json_and_rewrites_only_non_secret_fields() {
        let directory =
            std::env::temp_dir().join(format!("p4deck-context-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(
            directory.join("connection.json"),
            r#"{"server":"ssl:test:1666","user":"tester","client":"legacy","password":"must-not-survive","ticketsPath":"/credentials/tickets"}"#,
        )
        .unwrap();

        let store = ContextStore::load(&directory);
        assert_eq!(store.current().client, "legacy");
        let migrated = std::fs::read_to_string(directory.join("connection.json")).unwrap();
        assert!(!migrated.contains("password"));
        assert!(!migrated.contains("must-not-survive"));
        store.save(configured()).unwrap();
        let persisted = std::fs::read_to_string(directory.join("connection.json")).unwrap();
        assert!(!persisted.contains("password"));
        assert!(!persisted.contains("must-not-survive"));
        assert!(!persisted.to_ascii_lowercase().contains("ticket\":"));
        assert!(persisted.contains("ticketsPath"));

        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn rejects_incomplete_and_control_character_configuration() {
        let directory =
            std::env::temp_dir().join(format!("p4deck-context-{}", uuid::Uuid::new_v4()));
        let store = ContextStore::load(&directory);
        assert!(store.save(P4Context::default()).is_err());
        let mut context = configured();
        context.server.push('\n');
        assert!(store.save(context).is_err());
        assert!(!directory.exists());
    }
}
