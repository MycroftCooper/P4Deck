use crate::{
    domain::*,
    p4::{
        context::ContextStore,
        query as stable_query,
        runner::P4Runner,
        streams::{StreamBatch, StreamRepository, STREAM_SCAN_LIMIT},
    },
};
use parking_lot::Mutex;
use serde::Serialize;
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::AppHandle;
use uuid::Uuid;

const SNAPSHOT_TTL_MS: u64 = 120_000;
const CACHE_TTL_MS: u64 = 60_000;
const ENTRY_CAPACITY: usize = 16;

#[derive(Clone)]
struct GraphSnapshot {
    created_at_ms: u64,
    scope: StreamGraphScope,
    nodes: Vec<StreamGraphNode>,
    edges: Vec<StreamGraphEdge>,
    roots: Vec<String>,
    orphans: Vec<String>,
    partial: bool,
    truncated: bool,
    stats: StreamGraphStats,
    operation_ids: Vec<String>,
    cache_freshness: StreamGraphCacheFreshness,
}

#[derive(Clone)]
struct StoredSnapshot {
    graph: GraphSnapshot,
    next_cursor_id: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct QueryFingerprint<'a> {
    request_generation: u64,
    depot_prefix: &'a Option<String>,
    text: &'a Option<String>,
    include_deleted: bool,
    page_size: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ConnectionFingerprint<'a> {
    active_profile_id: &'a Option<String>,
    context: &'a P4Context,
}

pub struct StreamGraphService {
    repository: StreamRepository,
    runner: Arc<P4Runner>,
    contexts: Arc<ContextStore>,
    snapshots: Mutex<HashMap<String, StoredSnapshot>>,
    cache: Mutex<HashMap<String, GraphSnapshot>>,
    cancelled: Mutex<HashSet<String>>,
}

impl StreamGraphService {
    pub fn new(runner: Arc<P4Runner>, contexts: Arc<ContextStore>) -> Self {
        Self {
            repository: StreamRepository::new(runner.clone()),
            runner,
            contexts,
            snapshots: Mutex::new(HashMap::new()),
            cache: Mutex::new(HashMap::new()),
            cancelled: Mutex::new(HashSet::new()),
        }
    }

    pub fn cancel(&self, operation_id: &str) {
        self.cancelled.lock().insert(operation_id.to_owned());
        self.runner.cancel(operation_id);
    }

    pub fn clear_for_context_switch(&self) {
        self.snapshots.lock().clear();
        self.cache.lock().clear();
        self.cancelled.lock().clear();
    }

    pub async fn query(
        &self,
        query: StreamGraphQuery,
        app: Option<&AppHandle>,
    ) -> Result<StreamGraphResult, StreamGraphRequestError> {
        let query = normalize_query(query)?;
        let (context, connection_generation) = self.contexts.snapshot();
        let active_profile_id = self.contexts.active_profile_id();
        self.ensure_active(
            &query.operation_id,
            &active_profile_id,
            &context,
            connection_generation,
            false,
        )?;
        let connection_fingerprint = stable_query::fingerprint(&ConnectionFingerprint {
            active_profile_id: &active_profile_id,
            context: &context,
        })
        .map_err(|message| request_error(StreamGraphRequestErrorCode::InvalidQuery, message))?;
        let query_fingerprint = stable_query::fingerprint(&QueryFingerprint {
            request_generation: query.request_generation,
            depot_prefix: &query.depot_prefix,
            text: &query.text,
            include_deleted: query.include_deleted,
            page_size: query.page_size,
        })
        .map_err(|message| request_error(StreamGraphRequestErrorCode::InvalidQuery, message))?;

        let result = if let Some(cursor) = query.cursor.as_deref() {
            let boundary = stable_query::decode_stream_graph_cursor(
                cursor,
                &query_fingerprint,
                &connection_fingerprint,
                connection_generation,
            )
            .map_err(|message| {
                request_error(StreamGraphRequestErrorCode::InvalidCursor, message)
            })?;
            self.page_existing(
                &query,
                boundary,
                &query_fingerprint,
                &connection_fingerprint,
                connection_generation,
            )?
        } else {
            let cache_key =
                format!("{connection_generation}:{connection_fingerprint}:{query_fingerprint}");
            let graph = if !query.refresh {
                self.cached_graph(&cache_key)
            } else {
                None
            };
            let graph = match graph {
                Some(mut graph) => {
                    graph.created_at_ms = now_ms();
                    graph.cache_freshness = StreamGraphCacheFreshness::Cached;
                    graph
                }
                None => {
                    let batch = self
                        .repository
                        .query(
                            &context,
                            &query.operation_id,
                            query.depot_prefix.as_deref(),
                            query.text.as_deref(),
                            query.include_deleted,
                            app,
                        )
                        .await
                        .map_err(|message| self.repository_error(&query.operation_id, message))?;
                    self.ensure_active(
                        &query.operation_id,
                        &active_profile_id,
                        &context,
                        connection_generation,
                        true,
                    )?;
                    let graph = build_graph(
                        batch,
                        StreamGraphScope {
                            active_profile_id: active_profile_id.clone(),
                            context_generation: connection_generation,
                            server: context.server.clone(),
                            user: context.user.clone(),
                            client: context.client.clone(),
                            depot_prefix: query.depot_prefix.clone(),
                        },
                    );
                    self.ensure_active(
                        &query.operation_id,
                        &active_profile_id,
                        &context,
                        connection_generation,
                        true,
                    )?;
                    self.insert_cache(cache_key, graph.clone());
                    graph
                }
            };
            self.page_new(
                &query,
                graph,
                &query_fingerprint,
                &connection_fingerprint,
                connection_generation,
            )?
        };
        self.ensure_active(
            &query.operation_id,
            &active_profile_id,
            &context,
            connection_generation,
            true,
        )?;
        self.cancelled.lock().remove(&query.operation_id);
        Ok(result)
    }

    fn page_new(
        &self,
        query: &StreamGraphQuery,
        graph: GraphSnapshot,
        query_fingerprint: &str,
        connection_fingerprint: &str,
        connection_generation: u64,
    ) -> Result<StreamGraphResult, StreamGraphRequestError> {
        let snapshot_id = Uuid::new_v4().to_string();
        self.page(
            query,
            snapshot_id,
            graph,
            0,
            query_fingerprint,
            connection_fingerprint,
            connection_generation,
        )
    }

    fn page_existing(
        &self,
        query: &StreamGraphQuery,
        boundary: stable_query::StreamGraphCursorBoundary,
        query_fingerprint: &str,
        connection_fingerprint: &str,
        connection_generation: u64,
    ) -> Result<StreamGraphResult, StreamGraphRequestError> {
        let now = now_ms();
        let graph = {
            let mut snapshots = self.snapshots.lock();
            snapshots.retain(|_, snapshot| {
                now.saturating_sub(snapshot.graph.created_at_ms) <= SNAPSHOT_TTL_MS
            });
            let stored = snapshots.get_mut(&boundary.snapshot_id).ok_or_else(|| {
                request_error(
                    StreamGraphRequestErrorCode::CursorExpired,
                    "The Stream Graph cursor expired; restart the query.",
                )
            })?;
            if stored.next_cursor_id.as_deref() != Some(boundary.cursor_id.as_str()) {
                return Err(request_error(
                    StreamGraphRequestErrorCode::InvalidCursor,
                    "The Stream Graph cursor was already used or is not current.",
                ));
            }
            stored.next_cursor_id = None;
            stored.graph.clone()
        };
        self.page(
            query,
            boundary.snapshot_id,
            graph,
            boundary.offset,
            query_fingerprint,
            connection_fingerprint,
            connection_generation,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn page(
        &self,
        query: &StreamGraphQuery,
        snapshot_id: String,
        graph: GraphSnapshot,
        offset: usize,
        query_fingerprint: &str,
        connection_fingerprint: &str,
        connection_generation: u64,
    ) -> Result<StreamGraphResult, StreamGraphRequestError> {
        if offset > 0 && offset >= graph.nodes.len() {
            return Err(request_error(
                StreamGraphRequestErrorCode::InvalidCursor,
                "The Stream Graph cursor points beyond the result snapshot.",
            ));
        }
        let end = offset
            .saturating_add(query.page_size)
            .min(graph.nodes.len());
        let nodes = graph.nodes[offset..end].to_vec();
        let page_paths = nodes
            .iter()
            .map(|node| node.stream.as_str())
            .collect::<HashSet<_>>();
        let edges = graph
            .edges
            .iter()
            .filter(|edge| page_paths.contains(edge.child.as_str()))
            .cloned()
            .collect();
        let roots = graph
            .roots
            .iter()
            .filter(|path| page_paths.contains(path.as_str()))
            .cloned()
            .collect();
        let orphans = graph
            .orphans
            .iter()
            .filter(|path| page_paths.contains(path.as_str()))
            .cloned()
            .collect();
        let has_more = end < graph.nodes.len();
        let next_cursor = if has_more {
            let cursor_id = Uuid::new_v4().to_string();
            let encoded = stable_query::encode_stream_graph_cursor(
                &snapshot_id,
                &cursor_id,
                end,
                query_fingerprint,
                connection_fingerprint,
                connection_generation,
            )
            .map_err(|message| {
                request_error(StreamGraphRequestErrorCode::InvalidCursor, message)
            })?;
            let mut snapshots = self.snapshots.lock();
            if snapshots.len() >= ENTRY_CAPACITY && !snapshots.contains_key(&snapshot_id) {
                if let Some(oldest) = snapshots
                    .iter()
                    .min_by_key(|(_, snapshot)| snapshot.graph.created_at_ms)
                    .map(|(id, _)| id.clone())
                {
                    snapshots.remove(&oldest);
                }
            }
            snapshots.insert(
                snapshot_id.clone(),
                StoredSnapshot {
                    graph: graph.clone(),
                    next_cursor_id: Some(cursor_id),
                },
            );
            Some(encoded)
        } else {
            self.snapshots.lock().remove(&snapshot_id);
            None
        };
        let mut stats = graph.stats;
        stats.returned_count = nodes.len();
        Ok(StreamGraphResult {
            request_generation: query.request_generation,
            scope: graph.scope,
            nodes,
            edges,
            roots,
            orphans,
            has_more,
            next_cursor,
            partial: graph.partial,
            truncated: graph.truncated,
            stats,
            operation_ids: graph.operation_ids,
            cache_freshness: graph.cache_freshness,
            simulated: false,
        })
    }

    fn cached_graph(&self, cache_key: &str) -> Option<GraphSnapshot> {
        let now = now_ms();
        let mut cache = self.cache.lock();
        cache.retain(|_, graph| now.saturating_sub(graph.created_at_ms) <= CACHE_TTL_MS);
        cache.get(cache_key).cloned()
    }

    fn insert_cache(&self, key: String, graph: GraphSnapshot) {
        let mut cache = self.cache.lock();
        if cache.len() >= ENTRY_CAPACITY {
            if let Some(oldest) = cache
                .iter()
                .min_by_key(|(_, graph)| graph.created_at_ms)
                .map(|(key, _)| key.clone())
            {
                cache.remove(&oldest);
            }
        }
        cache.insert(key, graph);
    }

    fn ensure_active(
        &self,
        operation_id: &str,
        active_profile_id: &Option<String>,
        context: &P4Context,
        generation: u64,
        after_start: bool,
    ) -> Result<(), StreamGraphRequestError> {
        if self.cancelled.lock().contains(operation_id) {
            return Err(request_error(
                StreamGraphRequestErrorCode::Cancelled,
                "The Stream Graph query was cancelled.",
            ));
        }
        let (current, current_generation) = self.contexts.snapshot();
        if current_generation != generation
            || current != *context
            || self.contexts.active_profile_id() != *active_profile_id
        {
            return Err(request_error(
                StreamGraphRequestErrorCode::ConnectionChanged,
                if after_start {
                    "The connection changed while Stream Graph was running."
                } else {
                    "The Stream Graph query no longer matches the active connection."
                },
            ));
        }
        Ok(())
    }

    fn repository_error(&self, operation_id: &str, message: String) -> StreamGraphRequestError {
        if self.cancelled.lock().contains(operation_id)
            || message.to_ascii_lowercase().contains("cancel")
        {
            request_error(
                StreamGraphRequestErrorCode::Cancelled,
                "The Stream Graph query was cancelled.",
            )
        } else {
            request_error(StreamGraphRequestErrorCode::QueryFailed, message)
        }
    }
}

fn build_graph(batch: StreamBatch, scope: StreamGraphScope) -> GraphSnapshot {
    let mut by_path = BTreeMap::new();
    let mut duplicate_count = 0usize;
    for node in batch.nodes {
        if by_path.contains_key(&node.stream) {
            duplicate_count += 1;
        } else {
            by_path.insert(node.stream.clone(), node);
        }
    }
    let nodes = by_path.values().cloned().collect::<Vec<_>>();
    let known = by_path.keys().cloned().collect::<HashSet<_>>();
    let mut cycle_nodes = HashSet::new();
    for start in by_path.keys() {
        let mut chain = Vec::new();
        let mut positions = HashMap::new();
        let mut current = start.as_str();
        while let Some(parent) = by_path
            .get(current)
            .and_then(|node| node.parent.as_deref())
            .filter(|parent| known.contains(*parent))
        {
            positions.insert(current.to_owned(), chain.len());
            chain.push(current.to_owned());
            if let Some(index) = positions.get(parent).copied() {
                cycle_nodes.extend(chain[index..].iter().cloned());
                break;
            }
            current = parent;
        }
    }

    let mut edges = Vec::new();
    let mut roots = Vec::new();
    let mut orphans = Vec::new();
    let mut invalid_relation_count = 0usize;
    for node in &nodes {
        match node.parent.as_deref() {
            None => roots.push(node.stream.clone()),
            Some(_) if cycle_nodes.contains(&node.stream) => {
                orphans.push(node.stream.clone());
                invalid_relation_count += 1;
            }
            Some(parent) if !known.contains(parent) => {
                orphans.push(node.stream.clone());
                invalid_relation_count += 1;
            }
            Some(parent) => edges.push(StreamGraphEdge {
                parent: parent.to_owned(),
                child: node.stream.clone(),
            }),
        }
    }
    let partial = batch.truncated
        || batch.invalid_record_count > 0
        || duplicate_count > 0
        || invalid_relation_count > 0;
    GraphSnapshot {
        created_at_ms: now_ms(),
        scope,
        stats: StreamGraphStats {
            scanned_count: batch.scanned_count,
            matched_count: nodes.len(),
            returned_count: 0,
            duplicate_count,
            invalid_relation_count,
            safety_limit: STREAM_SCAN_LIMIT,
        },
        nodes,
        edges,
        roots,
        orphans,
        partial,
        truncated: batch.truncated,
        operation_ids: batch.operation_ids,
        cache_freshness: StreamGraphCacheFreshness::Fresh,
    }
}

fn normalize_query(
    mut query: StreamGraphQuery,
) -> Result<StreamGraphQuery, StreamGraphRequestError> {
    query.operation_id = query.operation_id.trim().to_owned();
    if query.operation_id.is_empty()
        || query.operation_id.chars().count() > 128
        || query.operation_id.chars().any(char::is_control)
        || query.request_generation == 0
    {
        return Err(request_error(
            StreamGraphRequestErrorCode::InvalidQuery,
            "A valid operation ID and positive request generation are required.",
        ));
    }
    if !(1..=200).contains(&query.page_size) {
        return Err(request_error(
            StreamGraphRequestErrorCode::InvalidQuery,
            "Stream Graph page size must be between 1 and 200.",
        ));
    }
    query.depot_prefix = query
        .depot_prefix
        .map(|value| value.trim().trim_end_matches('/').to_owned())
        .filter(|value| !value.is_empty());
    if query.depot_prefix.as_deref().is_some_and(|value| {
        !value.starts_with("//")
            || value.len() > 1024
            || value.contains("...")
            || value
                .chars()
                .any(|character| character.is_control() || matches!(character, '*' | '@' | '#'))
    }) {
        return Err(request_error(
            StreamGraphRequestErrorCode::InvalidQuery,
            "Stream Graph depot prefix must be a literal depot path.",
        ));
    }
    query.text = query
        .text
        .map(|value| value.split_whitespace().collect::<Vec<_>>().join(" "))
        .filter(|value| !value.is_empty());
    if query
        .text
        .as_deref()
        .is_some_and(|value| value.chars().count() > 128 || value.chars().any(char::is_control))
    {
        return Err(request_error(
            StreamGraphRequestErrorCode::InvalidQuery,
            "Stream Graph text must contain at most 128 non-control characters.",
        ));
    }
    Ok(query)
}

fn request_error(
    code: StreamGraphRequestErrorCode,
    message: impl Into<String>,
) -> StreamGraphRequestError {
    StreamGraphRequestError {
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

    fn node(path: &str, parent: Option<&str>) -> StreamGraphNode {
        StreamGraphNode {
            stream: path.into(),
            name: None,
            owner: None,
            parent: parent.map(str::to_owned),
            kind: None,
            description: None,
            parent_view: None,
            flow_options: StreamFlowOptions::default(),
            deleted: None,
        }
    }

    fn graph(nodes: Vec<StreamGraphNode>) -> GraphSnapshot {
        build_graph(
            StreamBatch {
                scanned_count: nodes.len(),
                nodes,
                operation_ids: vec!["stream-test".into()],
                invalid_record_count: 0,
                truncated: false,
            },
            StreamGraphScope {
                active_profile_id: None,
                context_generation: 1,
                server: "fixture:1666".into(),
                user: "tester".into(),
                client: "client".into(),
                depot_prefix: None,
            },
        )
    }

    #[test]
    fn builds_a_forest_and_marks_missing_parent_without_forging_a_node() {
        let result = graph(vec![
            node("//d/main", None),
            node("//d/dev", Some("//d/main")),
            node("//d/orphan", Some("//hidden/main")),
        ]);
        assert_eq!(result.nodes.len(), 3);
        assert_eq!(result.edges.len(), 1);
        assert_eq!(result.roots, vec!["//d/main"]);
        assert_eq!(result.orphans, vec!["//d/orphan"]);
        assert!(!result
            .nodes
            .iter()
            .any(|node| node.stream == "//hidden/main"));
        assert!(result.partial);
    }

    #[test]
    fn rejects_self_cycles_longer_cycles_and_duplicates_from_the_forest() {
        let result = graph(vec![
            node("//d/self", Some("//d/self")),
            node("//d/a", Some("//d/b")),
            node("//d/b", Some("//d/a")),
            node("//d/dup", None),
            node("//d/dup", Some("//d/a")),
        ]);
        assert!(result.edges.is_empty());
        assert_eq!(result.stats.duplicate_count, 1);
        assert_eq!(result.stats.invalid_relation_count, 3);
        assert_eq!(result.orphans.len(), 3);
        assert!(result.partial);
    }

    #[test]
    fn reports_the_server_scan_safety_limit_without_claiming_completeness() {
        let result = build_graph(
            StreamBatch {
                nodes: vec![node("//d/main", None)],
                operation_ids: vec!["stream-limit".into()],
                scanned_count: STREAM_SCAN_LIMIT + 1,
                invalid_record_count: 0,
                truncated: true,
            },
            StreamGraphScope {
                active_profile_id: Some("profile-a".into()),
                context_generation: 9,
                server: "fixture:1666".into(),
                user: "tester".into(),
                client: "client".into(),
                depot_prefix: Some("//d".into()),
            },
        );
        assert!(result.truncated);
        assert!(result.partial);
        assert_eq!(result.stats.scanned_count, STREAM_SCAN_LIMIT + 1);
        assert_eq!(result.stats.safety_limit, STREAM_SCAN_LIMIT);
    }

    #[test]
    fn query_validation_enforces_literal_scope_page_and_generation_limits() {
        let valid = normalize_query(StreamGraphQuery {
            operation_id: " graph-一 ".into(),
            request_generation: 2,
            depot_prefix: Some(" //depot/项目/ ".into()),
            text: Some("  release   流 ".into()),
            include_deleted: false,
            page_size: 200,
            cursor: None,
            refresh: false,
        })
        .unwrap();
        assert_eq!(valid.depot_prefix.as_deref(), Some("//depot/项目"));
        assert_eq!(valid.text.as_deref(), Some("release 流"));
        for prefix in ["depot/main", "//depot/...", "//depot/*", "//depot@42"] {
            let mut invalid = valid.clone();
            invalid.depot_prefix = Some(prefix.into());
            assert!(normalize_query(invalid).is_err());
        }
        let mut oversized = valid.clone();
        oversized.page_size = 201;
        assert!(normalize_query(oversized).is_err());
        let mut zero_generation = valid;
        zero_generation.request_generation = 0;
        assert!(normalize_query(zero_generation).is_err());
    }
}
