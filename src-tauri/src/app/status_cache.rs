use serde::{Deserialize, Serialize};
use std::{collections::HashMap, future::Future, sync::Arc, time::Instant};
use tokio::sync::watch;

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct StatusCacheKey {
    server: String,
    user: String,
    client: String,
    pub kind: StatusQueryKind,
    path: String,
    params_hash: u64,
}

impl StatusCacheKey {
    pub fn new(
        server: &str,
        user: &str,
        client: &str,
        kind: StatusQueryKind,
        path: &str,
        params_hash: u64,
    ) -> Self {
        Self {
            server: server.trim().to_ascii_lowercase(),
            user: user.trim().to_owned(),
            client: client.trim().to_owned(),
            kind,
            path: normalize_path(path),
            params_hash,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StatusQueryKind {
    WorkspaceStatus,
    DepotStatus,
    Opened,
    Reconcile,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FileStatusKind {
    Controlled,
    OpenedEdit,
    OpenedAdd,
    OpenedDelete,
    OutOfDate,
    Conflicted,
    ReconcileCandidate,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CachedFileStatus {
    pub path: String,
    pub depot_path: Option<String>,
    pub status: FileStatusKind,
    pub have_revision: Option<i64>,
    pub head_revision: Option<i64>,
    pub changelist_id: Option<i64>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CacheFreshness {
    Fresh,
    Stale,
    OfflineFallback,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StatusSnapshot {
    pub files: Vec<CachedFileStatus>,
    pub freshness: CacheFreshness,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum InvalidationReason {
    FileMutation,
    ChangelistMutation,
    Submit,
    ManualRefresh,
    ConnectionChanged,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheDiagnostics {
    pub hits: u64,
    pub misses: u64,
    pub coalesced: u64,
    pub evicted: u64,
    pub invalidated: u64,
    pub stale_fallbacks: u64,
    pub superseded: u64,
    pub load_count: u64,
    pub total_load_ms: u64,
    pub entries: usize,
    pub estimated_bytes: usize,
    pub invalidation_reasons: HashMap<String, u64>,
}

#[derive(Clone)]
struct Entry {
    value: StatusSnapshot,
    inserted_ms: u64,
    last_access: u64,
    estimated_bytes: usize,
}

type LoadResult = Result<StatusSnapshot, String>;

struct State {
    entries: HashMap<StatusCacheKey, Entry>,
    generations: HashMap<StatusCacheKey, u64>,
    inflight: HashMap<StatusCacheKey, watch::Receiver<Option<LoadResult>>>,
    diagnostics: CacheDiagnostics,
    access_clock: u64,
}

pub struct StatusCache {
    state: parking_lot::Mutex<State>,
    ttl_ms: u64,
    max_entries: usize,
    max_bytes: usize,
}

impl StatusCache {
    pub fn new(ttl_ms: u64, max_entries: usize, max_bytes: usize) -> Self {
        Self {
            state: parking_lot::Mutex::new(State {
                entries: HashMap::new(),
                generations: HashMap::new(),
                inflight: HashMap::new(),
                diagnostics: CacheDiagnostics::default(),
                access_clock: 0,
            }),
            ttl_ms: ttl_ms.max(1),
            max_entries: max_entries.max(1),
            max_bytes: max_bytes.max(1),
        }
    }

    pub async fn get_or_load<F, Fut>(
        &self,
        key: StatusCacheKey,
        now_ms: u64,
        allow_offline_fallback: bool,
        loader: F,
    ) -> LoadResult
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = LoadResult>,
    {
        let (generation, sender, mut follower, stale) = {
            let mut state = self.state.lock();
            state.access_clock += 1;
            let access = state.access_clock;
            let fresh = if let Some(entry) = state.entries.get_mut(&key) {
                entry.last_access = access;
                if now_ms.saturating_sub(entry.inserted_ms) <= self.ttl_ms {
                    Some(entry.value.clone())
                } else {
                    None
                }
            } else {
                None
            };
            if let Some(mut value) = fresh {
                state.diagnostics.hits += 1;
                value.freshness = CacheFreshness::Fresh;
                return Ok(value);
            }
            let stale = state.entries.get(&key).map(|entry| entry.value.clone());
            if let Some(receiver) = state.inflight.get(&key).cloned() {
                state.diagnostics.coalesced += 1;
                (0, None, Some(receiver), stale)
            } else {
                state.diagnostics.misses += 1;
                let generation = *state.generations.entry(key.clone()).or_default();
                let (sender, receiver) = watch::channel(None);
                state.inflight.insert(key.clone(), receiver);
                (generation, Some(sender), None, stale)
            }
        };

        if let Some(receiver) = follower.as_mut() {
            if receiver.borrow().is_none() && receiver.changed().await.is_err() {
                return Err("coalesced status request was cancelled".into());
            }
            return receiver
                .borrow()
                .clone()
                .unwrap_or_else(|| Err("coalesced status request produced no result".into()));
        }

        let started = Instant::now();
        let loaded = loader().await;
        let elapsed = started.elapsed().as_millis() as u64;
        let mut state = self.state.lock();
        state.diagnostics.load_count += 1;
        state.diagnostics.total_load_ms = state.diagnostics.total_load_ms.saturating_add(elapsed);
        state.inflight.remove(&key);
        let current_generation = *state.generations.entry(key.clone()).or_default();
        let result = if current_generation != generation {
            state.diagnostics.superseded += 1;
            Err("status response was superseded by invalidation".into())
        } else {
            match loaded {
                Ok(mut snapshot) => {
                    snapshot.freshness = CacheFreshness::Fresh;
                    let estimated_bytes = estimate_snapshot(&snapshot);
                    state.access_clock += 1;
                    let access = state.access_clock;
                    state.entries.insert(
                        key.clone(),
                        Entry {
                            value: snapshot.clone(),
                            inserted_ms: now_ms,
                            last_access: access,
                            estimated_bytes,
                        },
                    );
                    self.enforce_capacity(&mut state);
                    Ok(snapshot)
                }
                Err(_error) if allow_offline_fallback && stale.is_some() => {
                    state.diagnostics.stale_fallbacks += 1;
                    let mut snapshot = stale.expect("checked above");
                    snapshot.freshness = CacheFreshness::OfflineFallback;
                    Ok(snapshot)
                }
                Err(error) => Err(error),
            }
        };
        if let Some(sender) = sender {
            let _ = sender.send(Some(result.clone()));
        }
        result
    }

    pub fn invalidate(
        &self,
        server: &str,
        user: &str,
        client: &str,
        paths: &[String],
        kinds: &[StatusQueryKind],
        reason: InvalidationReason,
    ) {
        let normalized = paths
            .iter()
            .map(|path| normalize_path(path))
            .collect::<Vec<_>>();
        let mut state = self.state.lock();
        let keys = state
            .entries
            .keys()
            .chain(state.inflight.keys())
            .filter(|key| {
                key.server == server.trim().to_ascii_lowercase()
                    && key.user == user.trim()
                    && key.client == client.trim()
                    && (kinds.is_empty() || kinds.contains(&key.kind))
                    && (normalized.is_empty()
                        || normalized.iter().any(|path| path_overlaps(&key.path, path)))
            })
            .cloned()
            .collect::<std::collections::HashSet<_>>();
        for key in keys {
            state.entries.remove(&key);
            *state.generations.entry(key).or_default() += 1;
            state.diagnostics.invalidated += 1;
        }
        *state
            .diagnostics
            .invalidation_reasons
            .entry(format!("{reason:?}"))
            .or_default() += 1;
    }

    pub fn diagnostics(&self) -> CacheDiagnostics {
        let state = self.state.lock();
        let mut diagnostics = state.diagnostics.clone();
        diagnostics.entries = state.entries.len();
        diagnostics.estimated_bytes = state
            .entries
            .values()
            .map(|entry| entry.estimated_bytes)
            .sum();
        diagnostics
    }

    pub fn clear_for_context_switch(&self) {
        let mut state = self.state.lock();
        let keys = state
            .entries
            .keys()
            .chain(state.inflight.keys())
            .cloned()
            .collect::<std::collections::HashSet<_>>();
        for key in keys {
            state.entries.remove(&key);
            *state.generations.entry(key).or_default() += 1;
            state.diagnostics.invalidated += 1;
        }
        *state
            .diagnostics
            .invalidation_reasons
            .entry(format!("{:?}", InvalidationReason::ConnectionChanged))
            .or_default() += 1;
    }

    pub fn peek(&self, key: &StatusCacheKey, now_ms: u64) -> Option<StatusSnapshot> {
        let state = self.state.lock();
        let entry = state.entries.get(key)?;
        let mut value = entry.value.clone();
        value.freshness = if now_ms.saturating_sub(entry.inserted_ms) <= self.ttl_ms {
            CacheFreshness::Fresh
        } else {
            CacheFreshness::Stale
        };
        Some(value)
    }

    fn enforce_capacity(&self, state: &mut State) {
        while state.entries.len() > self.max_entries
            || state
                .entries
                .values()
                .map(|entry| entry.estimated_bytes)
                .sum::<usize>()
                > self.max_bytes
        {
            let Some(key) = state
                .entries
                .iter()
                .min_by_key(|(_, entry)| entry.last_access)
                .map(|(key, _)| key.clone())
            else {
                break;
            };
            state.entries.remove(&key);
            state.diagnostics.evicted += 1;
        }
    }
}

pub fn normalize_path(path: &str) -> String {
    let mut normalized = path.trim().replace('\\', "/");
    let depot = normalized.starts_with("//");
    let absolute = normalized.starts_with('/');
    let mut body = normalized.trim_start_matches('/').to_owned();
    while body.contains("//") {
        body = body.replace("//", "/");
    }
    normalized = if depot {
        format!("//{body}")
    } else if absolute {
        format!("/{body}")
    } else {
        body
    };
    while normalized.len() > 1 && normalized.ends_with('/') {
        normalized.pop();
    }
    if normalized.as_bytes().get(1) == Some(&b':') {
        normalized.replace_range(0..1, &normalized[..1].to_ascii_lowercase());
    }
    normalized
}

fn path_overlaps(cached: &str, affected: &str) -> bool {
    cached == affected
        || cached.starts_with(&(affected.to_owned() + "/"))
        || affected.starts_with(&(cached.to_owned() + "/"))
}

fn estimate_snapshot(snapshot: &StatusSnapshot) -> usize {
    std::mem::size_of::<StatusSnapshot>()
        + snapshot
            .files
            .iter()
            .map(|file| {
                file.path.len() + file.depot_path.as_deref().map(str::len).unwrap_or(0) + 96
            })
            .sum::<usize>()
}

pub fn shared_default() -> Arc<StatusCache> {
    Arc::new(StatusCache::new(15_000, 512, 16 * 1024 * 1024))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn key(server: &str, path: &str) -> StatusCacheKey {
        StatusCacheKey::new(
            server,
            "user",
            "client",
            StatusQueryKind::WorkspaceStatus,
            path,
            0,
        )
    }

    fn snapshot(path: &str) -> StatusSnapshot {
        StatusSnapshot {
            files: vec![CachedFileStatus {
                path: path.into(),
                depot_path: None,
                status: FileStatusKind::Controlled,
                have_revision: Some(1),
                head_revision: Some(1),
                changelist_id: None,
            }],
            freshness: CacheFreshness::Fresh,
        }
    }

    #[tokio::test]
    async fn coalesces_concurrent_loads_and_isolates_connections() {
        let cache = Arc::new(StatusCache::new(100, 10, 10_000));
        let calls = Arc::new(AtomicUsize::new(0));
        let mut tasks = Vec::new();
        for _ in 0..2 {
            let cache = cache.clone();
            let calls = calls.clone();
            tasks.push(tokio::spawn(async move {
                cache
                    .get_or_load(key("one", "a\\b/"), 1, false, || async move {
                        calls.fetch_add(1, Ordering::SeqCst);
                        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
                        Ok(snapshot("a/b"))
                    })
                    .await
                    .unwrap()
            }));
        }
        for task in tasks {
            task.await.unwrap();
        }
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        cache
            .get_or_load(key("two", "a/b"), 1, false, || async {
                Ok(snapshot("two"))
            })
            .await
            .unwrap();
        assert_eq!(cache.diagnostics().misses, 2);
        assert_eq!(cache.diagnostics().coalesced, 1);
    }

    #[tokio::test]
    async fn marks_offline_stale_and_rejects_superseded_responses() {
        let cache = Arc::new(StatusCache::new(5, 10, 10_000));
        let cache_key = key("one", "/root");
        cache
            .get_or_load(cache_key.clone(), 1, false, || async {
                Ok(snapshot("/root/a"))
            })
            .await
            .unwrap();
        let stale = cache
            .get_or_load(cache_key.clone(), 20, true, || async {
                Err("offline secret".into())
            })
            .await
            .unwrap();
        assert_eq!(stale.freshness, CacheFreshness::OfflineFallback);
        assert_eq!(
            cache.peek(&cache_key, 20).unwrap().freshness,
            CacheFreshness::Stale
        );

        let waiting = tokio::sync::oneshot::channel::<()>();
        let cache_clone = cache.clone();
        let key_clone = cache_key.clone();
        let task = tokio::spawn(async move {
            cache_clone
                .get_or_load(key_clone, 30, false, || async move {
                    let _ = waiting.1.await;
                    Ok(snapshot("late"))
                })
                .await
        });
        tokio::task::yield_now().await;
        cache.invalidate(
            "one",
            "user",
            "client",
            &["/root".into()],
            &[],
            InvalidationReason::FileMutation,
        );
        let _ = waiting.0.send(());
        assert!(task.await.unwrap().unwrap_err().contains("superseded"));
    }

    #[tokio::test]
    async fn evicts_by_capacity_and_invalidates_only_overlapping_paths() {
        let cache = StatusCache::new(100, 2, 10_000);
        for path in ["/a", "/b", "/c"] {
            cache
                .get_or_load(
                    key("one", path),
                    1,
                    false,
                    || async move { Ok(snapshot(path)) },
                )
                .await
                .unwrap();
        }
        assert_eq!(cache.diagnostics().entries, 2);
        assert_eq!(cache.diagnostics().evicted, 1);
        cache.invalidate(
            "one",
            "user",
            "client",
            &["/b/file".into()],
            &[],
            InvalidationReason::FileMutation,
        );
        assert_eq!(cache.diagnostics().entries, 1);
        let json = serde_json::to_string(&cache.diagnostics()).unwrap();
        assert!(!json.contains("/b"));
        assert!(!json.to_ascii_lowercase().contains("ticket"));
    }

    #[tokio::test]
    async fn context_switch_clears_all_connections_and_supersedes_inflight_loads() {
        let cache = Arc::new(StatusCache::new(100, 10, 10_000));
        cache
            .get_or_load(key("one", "/one"), 1, false, || async {
                Ok(snapshot("/one"))
            })
            .await
            .unwrap();
        cache
            .get_or_load(key("two", "/two"), 1, false, || async {
                Ok(snapshot("/two"))
            })
            .await
            .unwrap();
        let waiting = tokio::sync::oneshot::channel::<()>();
        let pending_cache = cache.clone();
        let pending = tokio::spawn(async move {
            pending_cache
                .get_or_load(key("three", "/three"), 2, false, || async move {
                    let _ = waiting.1.await;
                    Ok(snapshot("/three"))
                })
                .await
        });
        tokio::task::yield_now().await;
        cache.clear_for_context_switch();
        assert_eq!(cache.diagnostics().entries, 0);
        let _ = waiting.0.send(());
        assert!(pending.await.unwrap().unwrap_err().contains("superseded"));
    }
}
