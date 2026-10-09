use crate::{
    app::changelist_service::ChangelistService,
    domain::*,
    p4::{
        context::ContextStore,
        query as stable_query,
        runner::P4Runner,
        search::{item_for_submitted, SearchBatch, SearchRepository, CATEGORY_SCAN_LIMIT},
    },
};
use parking_lot::Mutex;
use serde::Serialize;
use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::AppHandle;
use uuid::Uuid;

const SNAPSHOT_TTL_MS: u64 = 120_000;
const SNAPSHOT_CAPACITY: usize = 16;
const SUBMITTED_RESULT_LIMIT: usize = 500;

#[derive(Clone)]
struct SearchSnapshot {
    created_at_ms: u64,
    items: Vec<GlobalSearchItem>,
    facets: Vec<GlobalSearchFacet>,
    partial: bool,
    scanned_count: usize,
    category_failure_count: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SearchFingerprint<'a> {
    text: &'a str,
    kinds: &'a [GlobalSearchKind],
}

pub struct GlobalSearchService {
    repository: SearchRepository,
    changelists: Arc<ChangelistService>,
    contexts: Arc<ContextStore>,
    snapshots: Mutex<HashMap<String, SearchSnapshot>>,
    cancelled: Mutex<HashSet<String>>,
}

impl GlobalSearchService {
    pub fn new(
        runner: Arc<P4Runner>,
        changelists: Arc<ChangelistService>,
        contexts: Arc<ContextStore>,
    ) -> Self {
        Self {
            repository: SearchRepository::new(runner),
            changelists,
            contexts,
            snapshots: Mutex::new(HashMap::new()),
            cancelled: Mutex::new(HashSet::new()),
        }
    }

    pub fn cancel(&self, operation_id: &str) {
        self.cancelled.lock().insert(operation_id.to_owned());
    }

    pub async fn query(
        &self,
        query: GlobalSearchQuery,
        app: Option<&AppHandle>,
    ) -> Result<GlobalSearchResult, GlobalSearchRequestError> {
        let query = normalize_query(query)?;
        self.cancelled.lock().remove(&query.operation_id);
        let (context, connection_generation) = self.contexts.snapshot();
        let connection_fingerprint = stable_query::fingerprint(&context).map_err(|message| {
            request_error(GlobalSearchRequestErrorCode::InvalidQuery, message)
        })?;
        let query_fingerprint = stable_query::fingerprint(&SearchFingerprint {
            text: &query.text,
            kinds: &query.kinds,
        })
        .map_err(|message| request_error(GlobalSearchRequestErrorCode::InvalidQuery, message))?;

        let outcome = if let Some(cursor) = query.cursor.as_deref() {
            let (snapshot_id, offset) = stable_query::decode_global_search_cursor(
                cursor,
                &query_fingerprint,
                &connection_fingerprint,
                connection_generation,
            )
            .map_err(|message| {
                request_error(GlobalSearchRequestErrorCode::InvalidCursor, message)
            })?;
            let snapshot = self.snapshot(&snapshot_id).ok_or_else(|| {
                request_error(
                    GlobalSearchRequestErrorCode::CursorExpired,
                    "The global search cursor expired; restart the search.",
                )
            })?;
            self.page(
                &query,
                snapshot_id,
                snapshot,
                offset,
                &query_fingerprint,
                &connection_fingerprint,
                connection_generation,
            )
        } else {
            let snapshot = self
                .collect_snapshot(&query, &context, connection_generation, app)
                .await?;
            let snapshot_id = Uuid::new_v4().to_string();
            if snapshot.items.len() > query.page_size {
                self.insert_snapshot(snapshot_id.clone(), snapshot.clone());
            }
            self.page(
                &query,
                snapshot_id,
                snapshot,
                0,
                &query_fingerprint,
                &connection_fingerprint,
                connection_generation,
            )
        };
        self.cancelled.lock().remove(&query.operation_id);
        outcome
    }

    #[allow(clippy::too_many_arguments)]
    fn page(
        &self,
        query: &GlobalSearchQuery,
        snapshot_id: String,
        snapshot: SearchSnapshot,
        offset: usize,
        query_fingerprint: &str,
        connection_fingerprint: &str,
        connection_generation: u64,
    ) -> Result<GlobalSearchResult, GlobalSearchRequestError> {
        if offset > 0 && offset >= snapshot.items.len() {
            return Err(request_error(
                GlobalSearchRequestErrorCode::InvalidCursor,
                "The global search cursor points beyond the result snapshot.",
            ));
        }
        let end = offset
            .saturating_add(query.page_size)
            .min(snapshot.items.len());
        let page_items = &snapshot.items[offset..end];
        let groups = query
            .kinds
            .iter()
            .filter_map(|kind| {
                let items = page_items
                    .iter()
                    .filter(|item| item.kind == *kind)
                    .cloned()
                    .collect::<Vec<_>>();
                (!items.is_empty()).then_some(GlobalSearchGroup { kind: *kind, items })
            })
            .collect();
        let has_more = end < snapshot.items.len();
        let next_cursor = has_more
            .then(|| {
                stable_query::encode_global_search_cursor(
                    &snapshot_id,
                    end,
                    query_fingerprint,
                    connection_fingerprint,
                    connection_generation,
                )
            })
            .transpose()
            .map_err(|message| {
                request_error(GlobalSearchRequestErrorCode::InvalidCursor, message)
            })?;
        Ok(GlobalSearchResult {
            request_generation: query.request_generation,
            normalized_query: query.text.clone(),
            groups,
            facets: snapshot.facets,
            has_more,
            next_cursor,
            partial: snapshot.partial,
            simulated: false,
            stats: GlobalSearchStats {
                scanned_count: snapshot.scanned_count,
                matched_count: snapshot.items.len(),
                returned_count: page_items.len(),
                category_failure_count: snapshot.category_failure_count,
                safety_limit: CATEGORY_SCAN_LIMIT,
            },
        })
    }

    async fn collect_snapshot(
        &self,
        query: &GlobalSearchQuery,
        context: &P4Context,
        connection_generation: u64,
        app: Option<&AppHandle>,
    ) -> Result<SearchSnapshot, GlobalSearchRequestError> {
        let mut items = Vec::new();
        let mut facets = Vec::new();
        for kind in &query.kinds {
            self.ensure_active(query, context, connection_generation)?;
            let batch = match kind {
                GlobalSearchKind::SubmittedChange => {
                    let result = self
                        .changelists
                        .query(
                            context.clone(),
                            ClQuery {
                                operation_id: query.operation_id.clone(),
                                request_generation: query.request_generation,
                                keyword: query.text.clone(),
                                users: Vec::new(),
                                clients: Vec::new(),
                                depot_path: None,
                                stream: None,
                                from: "2000-01-01T00:00:00Z".into(),
                                to: "2100-01-01T00:00:00Z".into(),
                                jobs: Vec::new(),
                                has_job: None,
                                merge_classifications: Vec::new(),
                                hide_reliable_merges: false,
                                page_size: SUBMITTED_RESULT_LIMIT,
                                cursor: None,
                            },
                            app,
                        )
                        .await;
                    result.map(|result| SearchBatch {
                        partial: result.has_more || result.stats.truncated_by_safety_limit,
                        scanned: result.stats.scanned_count,
                        items: result
                            .items
                            .into_iter()
                            .filter_map(|change| item_for_submitted(change, &query.text))
                            .collect(),
                    })
                }
                GlobalSearchKind::PendingChange => {
                    self.repository
                        .pending(context, &query.operation_id, &query.text, app)
                        .await
                }
                GlobalSearchKind::WorkspaceFile => {
                    self.repository
                        .workspace_files(context, &query.operation_id, &query.text, app)
                        .await
                }
                GlobalSearchKind::DepotFile => {
                    self.repository
                        .depot_files(context, &query.operation_id, &query.text, app)
                        .await
                }
                GlobalSearchKind::Job => {
                    self.repository
                        .jobs(context, &query.operation_id, &query.text, app)
                        .await
                }
            };
            self.ensure_active(query, context, connection_generation)?;
            match batch {
                Ok(mut batch) => {
                    batch.items.sort_by(|left, right| {
                        (left.rank, left.title.to_lowercase(), &left.identity).cmp(&(
                            right.rank,
                            right.title.to_lowercase(),
                            &right.identity,
                        ))
                    });
                    facets.push(GlobalSearchFacet {
                        kind: *kind,
                        matched_count: batch.items.len(),
                        scanned_count: batch.scanned,
                        partial: batch.partial,
                        error: None,
                    });
                    items.extend(batch.items);
                }
                Err(message) => {
                    if is_cancelled(&message) || self.is_cancelled(&query.operation_id) {
                        return Err(request_error(
                            GlobalSearchRequestErrorCode::Cancelled,
                            "Global search was cancelled.",
                        ));
                    }
                    facets.push(GlobalSearchFacet {
                        kind: *kind,
                        matched_count: 0,
                        scanned_count: 0,
                        partial: true,
                        error: Some(category_error(message)),
                    });
                }
            }
        }
        deduplicate_items(&mut items);
        for facet in &mut facets {
            facet.matched_count = items.iter().filter(|item| item.kind == facet.kind).count();
        }
        let scanned_count = facets.iter().map(|facet| facet.scanned_count).sum();
        let category_failure_count = facets.iter().filter(|facet| facet.error.is_some()).count();
        let partial = facets.iter().any(|facet| facet.partial);
        Ok(SearchSnapshot {
            created_at_ms: now_ms(),
            items,
            facets,
            partial,
            scanned_count,
            category_failure_count,
        })
    }

    fn ensure_active(
        &self,
        query: &GlobalSearchQuery,
        context: &P4Context,
        generation: u64,
    ) -> Result<(), GlobalSearchRequestError> {
        if self.is_cancelled(&query.operation_id) {
            return Err(request_error(
                GlobalSearchRequestErrorCode::Cancelled,
                "Global search was cancelled.",
            ));
        }
        let (current, current_generation) = self.contexts.snapshot();
        if current_generation != generation || current != *context {
            return Err(request_error(
                GlobalSearchRequestErrorCode::ConnectionChanged,
                "The connection changed while global search was running.",
            ));
        }
        Ok(())
    }

    fn is_cancelled(&self, operation_id: &str) -> bool {
        self.cancelled.lock().contains(operation_id)
    }

    fn snapshot(&self, snapshot_id: &str) -> Option<SearchSnapshot> {
        let now = now_ms();
        let mut snapshots = self.snapshots.lock();
        snapshots
            .retain(|_, snapshot| now.saturating_sub(snapshot.created_at_ms) <= SNAPSHOT_TTL_MS);
        snapshots.get(snapshot_id).cloned()
    }

    fn insert_snapshot(&self, snapshot_id: String, snapshot: SearchSnapshot) {
        let mut snapshots = self.snapshots.lock();
        if snapshots.len() >= SNAPSHOT_CAPACITY {
            if let Some(oldest) = snapshots
                .iter()
                .min_by_key(|(_, snapshot)| snapshot.created_at_ms)
                .map(|(id, _)| id.clone())
            {
                snapshots.remove(&oldest);
            }
        }
        snapshots.insert(snapshot_id, snapshot);
    }
}

pub(crate) fn deduplicate_items(items: &mut Vec<GlobalSearchItem>) {
    let mut identities = HashSet::new();
    items.retain(|item| identities.insert(item.identity.clone()));
}

fn normalize_query(
    mut query: GlobalSearchQuery,
) -> Result<GlobalSearchQuery, GlobalSearchRequestError> {
    query.operation_id = query.operation_id.trim().to_owned();
    if query.operation_id.is_empty()
        || query.operation_id.chars().count() > 128
        || query.operation_id.chars().any(char::is_control)
    {
        return Err(request_error(
            GlobalSearchRequestErrorCode::InvalidQuery,
            "A valid global search operation ID is required.",
        ));
    }
    if query.text.chars().any(|character| character.is_control()) {
        return Err(request_error(
            GlobalSearchRequestErrorCode::InvalidQuery,
            "Global search text cannot contain control characters.",
        ));
    }
    query.text = query.text.split_whitespace().collect::<Vec<_>>().join(" ");
    if query.text.is_empty() || query.text.chars().count() > 128 {
        return Err(request_error(
            GlobalSearchRequestErrorCode::InvalidQuery,
            "Global search text must contain 1 to 128 Unicode characters.",
        ));
    }
    if !(1..=100).contains(&query.page_size) {
        return Err(request_error(
            GlobalSearchRequestErrorCode::InvalidQuery,
            "Global search page size must be between 1 and 100.",
        ));
    }
    if query.kinds.is_empty() {
        query.kinds = vec![
            GlobalSearchKind::SubmittedChange,
            GlobalSearchKind::PendingChange,
            GlobalSearchKind::WorkspaceFile,
            GlobalSearchKind::DepotFile,
            GlobalSearchKind::Job,
        ];
    }
    query.kinds.sort();
    query.kinds.dedup();
    Ok(query)
}

fn category_error(message: String) -> GlobalSearchCategoryError {
    let lower = message.to_lowercase();
    let code = if lower.contains("timed out") || lower.contains("timeout") {
        GlobalSearchErrorCode::Timeout
    } else if lower.contains("permission") || lower.contains("protect") {
        GlobalSearchErrorCode::PermissionDenied
    } else if lower.contains("connection changed") {
        GlobalSearchErrorCode::ConnectionChanged
    } else if is_cancelled(&message) {
        GlobalSearchErrorCode::Cancelled
    } else {
        GlobalSearchErrorCode::QueryFailed
    };
    GlobalSearchCategoryError { code, message }
}

fn is_cancelled(message: &str) -> bool {
    message.to_lowercase().contains("cancel")
}

fn request_error(
    code: GlobalSearchRequestErrorCode,
    message: impl Into<String>,
) -> GlobalSearchRequestError {
    GlobalSearchRequestError {
        code,
        message: message.into(),
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

    fn query(text: &str) -> GlobalSearchQuery {
        GlobalSearchQuery {
            operation_id: "search-1".into(),
            request_generation: 1,
            text: text.into(),
            kinds: Vec::new(),
            page_size: 25,
            cursor: None,
        }
    }

    #[test]
    fn normalizes_unicode_whitespace_and_kind_order() {
        let mut value = query("  你好\u{2003}world [x]  ");
        value.kinds = vec![
            GlobalSearchKind::Job,
            GlobalSearchKind::SubmittedChange,
            GlobalSearchKind::Job,
        ];
        let value = normalize_query(value).unwrap();
        assert_eq!(value.text, "你好 world [x]");
        assert_eq!(
            value.kinds,
            vec![GlobalSearchKind::SubmittedChange, GlobalSearchKind::Job]
        );
    }

    #[test]
    fn rejects_blank_control_overlong_and_invalid_page_queries() {
        assert_eq!(
            normalize_query(query(" \t ")).unwrap_err().code,
            GlobalSearchRequestErrorCode::InvalidQuery
        );
        assert!(normalize_query(query("line\nfeed")).is_err());
        assert!(normalize_query(query(&"界".repeat(129))).is_err());
        let mut invalid_page = query("ok");
        invalid_page.page_size = 0;
        assert!(normalize_query(invalid_page).is_err());
    }
}
