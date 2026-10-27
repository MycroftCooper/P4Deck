use crate::{
    domain::{P4VfsInspectRequest, P4VfsStatus},
    p4::{context::ContextStore, vfs::P4VfsRepository},
};
use std::sync::Arc;
use tauri::AppHandle;
use uuid::Uuid;

pub struct VfsService {
    repository: P4VfsRepository,
    contexts: Arc<ContextStore>,
}

impl VfsService {
    pub fn new(repository: P4VfsRepository, contexts: Arc<ContextStore>) -> Self {
        Self {
            repository,
            contexts,
        }
    }

    pub async fn inspect(
        &self,
        request: P4VfsInspectRequest,
        app: Option<&AppHandle>,
    ) -> Result<P4VfsStatus, String> {
        let (context, context_generation) = self.contexts.snapshot();
        if context_generation != request.expected_context_generation {
            return Err(
                "contextChanged: The active connection changed before VFS inspection.".into(),
            );
        }
        let operation_id = request
            .operation_id
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| format!("vfs-inspect-{}", Uuid::new_v4()));
        let inspection = self
            .repository
            .inspect(&context, &operation_id, app)
            .await?;
        if self.contexts.snapshot().1 != context_generation {
            return Err(
                "contextChanged: The active connection changed during VFS inspection.".into(),
            );
        }
        Ok(P4VfsStatus {
            context_generation,
            workspace: inspection.workspace,
            mode: inspection.mode,
            ready: inspection.ready,
            server_version: inspection.server_version,
            server_supported: inspection.server_supported,
            client_version: inspection.client_version,
            client_supported: inspection.client_supported,
            agent_configured: inspection.agent_configured,
            reason: inspection.reason,
            operation_ids: inspection.operation_ids,
        })
    }
}
