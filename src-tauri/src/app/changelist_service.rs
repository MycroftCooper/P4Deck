use crate::{domain::*, p4::changelists::ChangelistRepository};
use tauri::AppHandle;

pub struct ChangelistService {
    repository: ChangelistRepository,
}

impl ChangelistService {
    pub fn new(repository: ChangelistRepository) -> Self {
        Self { repository }
    }

    pub async fn query(
        &self,
        context: P4Context,
        query: ClQuery,
        app: &AppHandle,
    ) -> Result<ClQueryResult, String> {
        self.repository.query(context, query, app).await
    }

    pub async fn perform(
        &self,
        context: P4Context,
        action: ClAction,
        app: &AppHandle,
    ) -> Result<ClActionResult, String> {
        self.repository.perform(context, action, app).await
    }
}
