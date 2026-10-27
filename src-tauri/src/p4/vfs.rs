use crate::{
    domain::{P4Context, WorkspaceSyncMode},
    p4::{
        connection::ConnectionAdapter, connection_setup::ConnectionSetupRepository,
        runner::P4Runner,
    },
};
use std::sync::Arc;
use tauri::AppHandle;

pub const MINIMUM_VFS_VERSION: (u32, u32) = (2023, 1);

pub struct VfsInspection {
    pub workspace: String,
    pub mode: WorkspaceSyncMode,
    pub ready: bool,
    pub server_version: Option<String>,
    pub server_supported: bool,
    pub client_version: Option<String>,
    pub client_supported: bool,
    pub agent_configured: bool,
    pub reason: Option<String>,
    pub operation_ids: Vec<String>,
}

#[derive(Clone)]
pub struct P4VfsRepository {
    runner: Arc<P4Runner>,
}

impl P4VfsRepository {
    pub fn new(runner: Arc<P4Runner>) -> Self {
        Self { runner }
    }

    pub async fn inspect(
        &self,
        context: &P4Context,
        operation_id: &str,
        app: Option<&AppHandle>,
    ) -> Result<VfsInspection, String> {
        let setup = ConnectionSetupRepository::new(self.runner.clone());
        let (identity, info_id) = setup
            .inspect_identity(context, &format!("{operation_id}:info"), app)
            .await?;
        let (workspace, client_id) = setup
            .read_workspace(
                context,
                &context.client,
                &format!("{operation_id}:client"),
                app,
            )
            .await?;
        let workspace =
            workspace.ok_or_else(|| "The active workspace specification was empty.".to_owned())?;
        let server_supported = identity
            .server_version
            .as_deref()
            .is_some_and(version_supports_vfs);
        let cli = ConnectionAdapter::discover(context.executable.as_deref());
        let client_version = cli.version;
        let client_supported = client_version.as_deref().is_some_and(version_supports_vfs);
        let agent_configured = agent_is_configured();
        let mode = workspace_sync_mode(&workspace.options);
        let reason =
            vfs_readiness_reason(mode, server_supported, client_supported, agent_configured);

        Ok(VfsInspection {
            workspace: context.cwd.clone().unwrap_or_default(),
            mode,
            ready: reason.is_none() && mode == WorkspaceSyncMode::Virtual,
            server_version: identity.server_version,
            server_supported,
            client_version,
            client_supported,
            agent_configured,
            reason,
            operation_ids: vec![info_id, client_id],
        })
    }
}

fn workspace_sync_mode(options: &str) -> WorkspaceSyncMode {
    crate::p4::connection_setup::workspace_sync_mode_from_options(options)
}

pub fn agent_is_configured() -> bool {
    std::env::var("P4ALTSYNC").is_ok_and(|value| !value.trim().is_empty())
}

pub fn version_supports_vfs(version: &str) -> bool {
    version
        .split(|character: char| !character.is_ascii_digit() && character != '.')
        .filter_map(|part| {
            let (major, minor) = part.split_once('.')?;
            let major = major.parse::<u32>().ok()?;
            let minor = minor.parse::<u32>().ok()?;
            (major >= 2000).then_some((major, minor))
        })
        .any(|version| {
            version.0 > MINIMUM_VFS_VERSION.0
                || (version.0 == MINIMUM_VFS_VERSION.0 && version.1 >= MINIMUM_VFS_VERSION.1)
        })
}

fn vfs_readiness_reason(
    mode: WorkspaceSyncMode,
    server_supported: bool,
    client_supported: bool,
    agent_configured: bool,
) -> Option<String> {
    match mode {
        WorkspaceSyncMode::Virtual => {}
        WorkspaceSyncMode::Standard => {
            return Some(
                "This workspace uses standard sync. Create a new virtual workspace to use P4VFS."
                    .into(),
            )
        }
        WorkspaceSyncMode::Unknown => {
            return Some("The workspace sync mode could not be determined.".into())
        }
    }
    if !cfg!(windows) {
        return Some("P4VFS is supported only on Windows clients.".into());
    }
    if !server_supported {
        return Some("P4 Server 2023.1 or later is required for P4VFS.".into());
    }
    if !client_supported {
        return Some("P4 CLI 2023.1 or later is required for P4VFS.".into());
    }
    if !agent_configured {
        return Some(
            "P4ALTSYNC is not visible to P4Deck. Install P4VFS and restart P4Deck.".into(),
        );
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognizes_supported_server_and_client_versions() {
        assert!(version_supports_vfs(
            "P4D/NTX64/2023.1/2525840 (2023/05/01)"
        ));
        assert!(version_supports_vfs(
            "Rev. P4/NTX64/2025.2/2890000 (2025/08/01)"
        ));
        assert!(!version_supports_vfs(
            "P4D/NTX64/2022.2/2400000 (2022/08/01)"
        ));
        assert!(!version_supports_vfs("unknown"));
    }

    #[test]
    fn distinguishes_altsync_from_noaltsync() {
        assert_eq!(
            workspace_sync_mode("noallwrite noclobber altsync normdir"),
            WorkspaceSyncMode::Virtual
        );
        assert_eq!(
            workspace_sync_mode("noallwrite noaltsync normdir"),
            WorkspaceSyncMode::Standard
        );
        assert_eq!(workspace_sync_mode(""), WorkspaceSyncMode::Unknown);
    }

    #[test]
    fn readiness_requires_a_virtual_workspace_and_all_platform_prerequisites() {
        assert!(
            vfs_readiness_reason(WorkspaceSyncMode::Standard, true, true, true)
                .is_some_and(|reason| reason.contains("standard sync"))
        );
        assert!(
            vfs_readiness_reason(WorkspaceSyncMode::Unknown, true, true, true)
                .is_some_and(|reason| reason.contains("could not be determined"))
        );

        let virtual_reason = vfs_readiness_reason(WorkspaceSyncMode::Virtual, true, true, true);
        if cfg!(windows) {
            assert_eq!(virtual_reason, None);
        } else {
            assert!(virtual_reason.is_some_and(|reason| reason.contains("Windows")));
        }
    }
}
