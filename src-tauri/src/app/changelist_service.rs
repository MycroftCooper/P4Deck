use crate::{
    app::status_cache::{InvalidationReason, StatusCache, StatusQueryKind},
    domain::*,
    p4::{changelists::ChangelistRepository, context::ContextStore},
};
use std::{
    collections::{BTreeSet, HashMap},
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::AppHandle;

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct SubmittedDetailCacheKey {
    server: String,
    user: String,
    client: String,
    generation: u64,
    change_id: i64,
}

#[derive(Clone)]
struct SubmittedDetailCacheEntry {
    detail: SubmittedChangeDetail,
    inserted_ms: u64,
    last_access: u64,
}

struct SubmittedDetailCacheState {
    entries: HashMap<SubmittedDetailCacheKey, SubmittedDetailCacheEntry>,
    access_clock: u64,
}

struct SubmittedDetailCache {
    state: parking_lot::Mutex<SubmittedDetailCacheState>,
    ttl_ms: u64,
    max_entries: usize,
}

impl SubmittedDetailCache {
    fn new(ttl_ms: u64, max_entries: usize) -> Self {
        Self {
            state: parking_lot::Mutex::new(SubmittedDetailCacheState {
                entries: HashMap::new(),
                access_clock: 0,
            }),
            ttl_ms: ttl_ms.max(1),
            max_entries: max_entries.max(1),
        }
    }

    fn get(&self, key: &SubmittedDetailCacheKey, now_ms: u64) -> Option<SubmittedChangeDetail> {
        let mut state = self.state.lock();
        let expired = state
            .entries
            .get(key)
            .is_some_and(|entry| now_ms.saturating_sub(entry.inserted_ms) > self.ttl_ms);
        if expired {
            state.entries.remove(key);
            return None;
        }
        state.access_clock = state.access_clock.saturating_add(1);
        let access = state.access_clock;
        let entry = state.entries.get_mut(key)?;
        entry.last_access = access;
        Some(entry.detail.clone())
    }

    fn insert(&self, key: SubmittedDetailCacheKey, detail: SubmittedChangeDetail, now_ms: u64) {
        let mut state = self.state.lock();
        state.access_clock = state.access_clock.saturating_add(1);
        let access = state.access_clock;
        state.entries.insert(
            key,
            SubmittedDetailCacheEntry {
                detail,
                inserted_ms: now_ms,
                last_access: access,
            },
        );
        while state.entries.len() > self.max_entries {
            let Some(oldest) = state
                .entries
                .iter()
                .min_by_key(|(_, entry)| entry.last_access)
                .map(|(key, _)| key.clone())
            else {
                break;
            };
            state.entries.remove(&oldest);
        }
    }
}

pub struct ChangelistService {
    repository: ChangelistRepository,
    status_cache: Arc<StatusCache>,
    contexts: Arc<ContextStore>,
    submitted_details: SubmittedDetailCache,
}

impl ChangelistService {
    pub fn new(
        repository: ChangelistRepository,
        status_cache: Arc<StatusCache>,
        contexts: Arc<ContextStore>,
    ) -> Self {
        Self {
            repository,
            status_cache,
            contexts,
            submitted_details: SubmittedDetailCache::new(60_000, 256),
        }
    }

    pub async fn query(
        &self,
        context: P4Context,
        query: ClQuery,
        app: Option<&AppHandle>,
    ) -> Result<ClQueryResult, String> {
        let hide_reliable_merges = query.hide_reliable_merges;
        let mut result = self.repository.query(context.clone(), query, app).await?;
        let (current, generation) = self.contexts.snapshot();
        if same_connection(&current, &context) {
            let now = now_ms();
            for change in &mut result.changes {
                if let Some(detail) = self
                    .submitted_details
                    .get(&submitted_cache_key(&context, generation, change.id), now)
                {
                    change.file_count = detail.files.len();
                    change.jobs = detail.jobs;
                    change.merge_classification = detail.merge_classification;
                }
            }
            if hide_reliable_merges {
                let before = result.changes.len();
                result.changes.retain(|change| {
                    change.merge_classification != MergeClassification::ReliableMerge
                });
                result.hidden_merge_count += before - result.changes.len();
            }
        }
        Ok(result)
    }

    pub async fn query_pending(
        &self,
        context: P4Context,
        app: Option<&AppHandle>,
    ) -> Result<Vec<PendingChange>, String> {
        self.repository.query_pending(context, app).await
    }

    pub async fn submitted_detail(
        &self,
        request: SubmittedChangeDetailRequest,
        app: Option<&AppHandle>,
    ) -> SubmittedChangeDetail {
        let (context, generation) = self.contexts.snapshot();
        let key = submitted_cache_key(&context, generation, request.change_id);
        if let Some(detail) = self.submitted_details.get(&key, now_ms()) {
            return detail;
        }
        let detail = match self
            .repository
            .submitted_detail(&context, &request, app)
            .await
        {
            Ok(detail) => detail,
            Err(_) => {
                return unavailable_detail(
                    request.change_id,
                    "Submitted changelist inspection failed.",
                )
            }
        };
        let (current, current_generation) = self.contexts.snapshot();
        if submitted_cache_key(&current, current_generation, request.change_id) != key {
            return unavailable_detail(
                request.change_id,
                "The connection changed while the submitted changelist was being inspected.",
            );
        }
        self.submitted_details.insert(key, detail.clone(), now_ms());
        detail
    }

    pub async fn mutate_pending(
        &self,
        context: P4Context,
        request: PendingChangeMutationRequest,
        app: Option<&AppHandle>,
    ) -> Result<PendingChangeMutationResult, String> {
        let before = self.repository.query_pending(context.clone(), app).await?;
        let mut affected_changes = validate_pending_mutation(&before, &request.mutation)?;
        let jobs = match &request.mutation {
            PendingChangeMutation::Create { jobs, .. }
            | PendingChangeMutation::Edit { jobs, .. } => jobs.as_slice(),
            _ => &[],
        };
        self.repository
            .ensure_jobs_exist(&context, jobs, app)
            .await?;
        let requested_paths = match &request.mutation {
            PendingChangeMutation::MoveFiles { depot_paths, .. } => depot_paths.clone(),
            _ => Vec::new(),
        };
        let local_paths = self
            .repository
            .local_paths(&context, &requested_paths, app)
            .await?;
        let execution = self
            .repository
            .perform_pending(context.clone(), &request, app)
            .await?;

        affected_changes.extend(execution.affected_changes.iter().copied());
        let mut created_change_id = execution.created_change_id;
        if !local_paths.is_empty() {
            self.status_cache.invalidate(
                &context.server,
                &context.user,
                &context.client,
                &local_paths,
                &[StatusQueryKind::WorkspaceStatus, StatusQueryKind::Opened],
                InvalidationReason::ChangelistMutation,
            );
        }

        let (after, refresh_error) = match self.repository.query_pending(context, app).await {
            Ok(changes) => (changes, None),
            Err(error) => (Vec::new(), Some(error)),
        };
        if created_change_id.is_none()
            && matches!(request.mutation, PendingChangeMutation::Create { .. })
        {
            let previous_ids = before
                .iter()
                .map(|change| change.id)
                .collect::<BTreeSet<_>>();
            created_change_id = after
                .iter()
                .map(|change| change.id)
                .find(|id| *id > 0 && !previous_ids.contains(id));
        }
        if let Some(change_id) = created_change_id {
            affected_changes.insert(change_id);
        }
        let refreshed_changes = after
            .into_iter()
            .filter(|change| affected_changes.contains(&change.id))
            .collect();
        Ok(PendingChangeMutationResult {
            operation: execution.operation,
            created_change_id,
            affected_changes: affected_changes.into_iter().collect(),
            affected_paths: execution.affected_paths,
            refreshed_changes,
            refresh_error,
        })
    }

    pub async fn perform(
        &self,
        context: P4Context,
        action: ClAction,
        app: Option<&AppHandle>,
    ) -> Result<ClActionResult, String> {
        let reason = if matches!(action, ClAction::SubmitValidate { .. }) {
            InvalidationReason::Submit
        } else {
            InvalidationReason::ChangelistMutation
        };
        let result = self
            .repository
            .perform(context.clone(), action, app)
            .await?;
        self.status_cache.invalidate(
            &context.server,
            &context.user,
            &context.client,
            &[],
            &[
                StatusQueryKind::WorkspaceStatus,
                StatusQueryKind::Opened,
                StatusQueryKind::Reconcile,
            ],
            reason,
        );
        Ok(result)
    }
}

fn validate_pending_mutation(
    changes: &[PendingChange],
    mutation: &PendingChangeMutation,
) -> Result<BTreeSet<i64>, String> {
    let mut affected = BTreeSet::new();
    match mutation {
        PendingChangeMutation::Create { .. } => {}
        PendingChangeMutation::Edit { change_id, .. } => {
            require_numbered_change(changes, *change_id)?;
            affected.insert(*change_id);
        }
        PendingChangeMutation::Delete { change_id } => {
            let change = require_numbered_change(changes, *change_id)?;
            if !change.files.is_empty()
                || !change.shelved_files.is_empty()
                || !change.jobs.is_empty()
            {
                return Err(format!(
                    "changelist {change_id} is not empty; clear Jobs, move/revert opened files, and delete shelves first"
                ));
            }
            affected.insert(*change_id);
        }
        PendingChangeMutation::MoveFiles {
            target_change_id,
            depot_paths,
        } => {
            if *target_change_id > 0 {
                require_numbered_change(changes, *target_change_id)?;
            } else if *target_change_id < 0 {
                return Err("target changelist must be Default (0) or numbered".into());
            }
            affected.insert(*target_change_id);
            for path in depot_paths {
                let source = changes
                    .iter()
                    .find(|change| change.files.iter().any(|file| file.depot_path == *path))
                    .ok_or_else(|| {
                        format!("{path} is not opened by the current user and client")
                    })?;
                affected.insert(source.id);
            }
        }
    }
    Ok(affected)
}

fn require_numbered_change(
    changes: &[PendingChange],
    change_id: i64,
) -> Result<&PendingChange, String> {
    if change_id <= 0 {
        return Err("a numbered pending changelist is required".into());
    }
    changes
        .iter()
        .find(|change| change.id == change_id)
        .ok_or_else(|| {
            format!("changelist {change_id} is not pending in the current user/client scope")
        })
}

fn submitted_cache_key(
    context: &P4Context,
    generation: u64,
    change_id: i64,
) -> SubmittedDetailCacheKey {
    SubmittedDetailCacheKey {
        server: context.server.trim().to_ascii_lowercase(),
        user: context.user.trim().to_owned(),
        client: context.client.trim().to_owned(),
        generation,
        change_id,
    }
}

fn same_connection(left: &P4Context, right: &P4Context) -> bool {
    left.server.trim().eq_ignore_ascii_case(right.server.trim())
        && left.user.trim() == right.user.trim()
        && left.client.trim() == right.client.trim()
}

fn unavailable_detail(change_id: i64, message: &str) -> SubmittedChangeDetail {
    SubmittedChangeDetail {
        change_id,
        description: String::new(),
        user: String::new(),
        client: String::new(),
        time: String::new(),
        jobs: Vec::new(),
        files: Vec::new(),
        integration_evidence: Vec::new(),
        merge_classification: MergeClassification::Unknown,
        inspection_status: SubmittedInspectionStatus::Unavailable,
        message: Some(message.into()),
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    fn change(id: i64, paths: &[&str], shelves: &[&str]) -> PendingChange {
        let file = |path: &&str| PendingFile {
            depot_path: (*path).into(),
            action: "edit".into(),
            state: Some("openedEdit".into()),
            client_path: None,
            revision: None,
            file_type: None,
        };
        PendingChange {
            id,
            description: String::new(),
            user: "u".into(),
            client: "c".into(),
            status: "pending".into(),
            updated_at: None,
            jobs: Vec::new(),
            files: paths.iter().map(file).collect(),
            shelved_files: shelves.iter().map(file).collect(),
        }
    }

    fn submitted_detail(id: i64) -> SubmittedChangeDetail {
        SubmittedChangeDetail {
            change_id: id,
            description: "ordinary".into(),
            user: "u".into(),
            client: "c".into(),
            time: "2026-10-08T00:00:00Z".into(),
            jobs: Vec::new(),
            files: vec![SubmittedChangeFile {
                depot_path: "//depot/a".into(),
                action: "edit".into(),
                revision: Some(1),
                file_type: Some("text".into()),
            }],
            integration_evidence: Vec::new(),
            merge_classification: MergeClassification::Normal,
            inspection_status: SubmittedInspectionStatus::Complete,
            message: None,
        }
    }

    #[test]
    fn move_tracks_source_and_target_and_delete_requires_empty() {
        let changes = [change(0, &["//depot/a"], &[]), change(7, &[], &[])];
        let affected = validate_pending_mutation(
            &changes,
            &PendingChangeMutation::MoveFiles {
                target_change_id: 7,
                depot_paths: vec!["//depot/a".into()],
            },
        )
        .unwrap();
        assert_eq!(affected.into_iter().collect::<Vec<_>>(), vec![0, 7]);
        assert!(validate_pending_mutation(
            &[change(7, &["//depot/a"], &[])],
            &PendingChangeMutation::Delete { change_id: 7 }
        )
        .is_err());
    }

    #[test]
    fn submitted_cache_isolates_generation_identity_expires_and_evicts() {
        let cache = SubmittedDetailCache::new(10, 2);
        let context = P4Context {
            server: "P4:1666".into(),
            user: "u".into(),
            client: "c".into(),
            ..Default::default()
        };
        let first = submitted_cache_key(&context, 1, 1);
        cache.insert(first.clone(), submitted_detail(1), 1);
        assert_eq!(cache.get(&first, 2).unwrap().change_id, 1);
        assert!(cache.get(&submitted_cache_key(&context, 2, 1), 2).is_none());
        let mut other = context.clone();
        other.client = "other".into();
        assert!(cache.get(&submitted_cache_key(&other, 1, 1), 2).is_none());
        assert!(cache.get(&first, 12).is_none());

        for id in 1..=3 {
            cache.insert(
                submitted_cache_key(&context, 3, id),
                submitted_detail(id),
                20,
            );
        }
        assert_eq!(cache.state.lock().entries.len(), 2);
        assert!(cache
            .get(&submitted_cache_key(&context, 3, 1), 20)
            .is_none());

        let failed = unavailable_detail(99, "inspection failed");
        assert_eq!(failed.merge_classification, MergeClassification::Unknown);
        assert_eq!(
            failed.inspection_status,
            SubmittedInspectionStatus::Unavailable
        );
    }
}
