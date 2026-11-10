use crate::{
    app::{
        file_service::fstat_status_snapshot,
        search_service::deduplicate_items,
        status_cache::{
            CacheFreshness, CachedFileStatus, FileStatusKind, InvalidationReason, StatusCache,
            StatusCacheKey, StatusQueryKind, StatusSnapshot,
        },
    },
    domain::{
        ChangelistSummary, ClQueryResult, ClQueryStats, EventKind, LogEntry, LogLevel,
        MergeClassification, OperationEvent, OperationResult, OperationSource, WorkspaceLocalState,
        WorkspaceResolveState, WorkspaceSyncState,
    },
    p4::{changelists::parser, query, search::item_for_submitted},
};
use serde::Serialize;
use std::{
    env,
    fmt::Write as _,
    fs,
    hint::black_box,
    path::{Path, PathBuf},
    process::Command,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
    time::Instant,
};

const SEED: u64 = 0x5034_4445_434b_0009;
const WARMUP_ROUNDS: usize = 7;
const MEASURED_ROUNDS: usize = 25;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Report {
    schema_version: u32,
    generated_at: String,
    suite: &'static str,
    seed: u64,
    warmup_rounds: usize,
    measured_rounds: usize,
    profile: &'static str,
    environment: Environment,
    compatibility: Compatibility,
    cases: Vec<CaseResult>,
    correctness: Vec<CorrectnessResult>,
    caveats: Vec<&'static str>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Environment {
    os: String,
    arch: String,
    cpu: String,
    logical_cpu_count: usize,
    rustc: String,
    cargo: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Compatibility {
    p4_executable: Option<String>,
    p4_version: Option<String>,
    p4d_executable: Option<String>,
    p4d_version: Option<String>,
    p4_charset: Option<String>,
    server_unicode_mode: &'static str,
    verified_scope: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CaseResult {
    name: String,
    production_path: String,
    dataset_size: usize,
    payload_bytes: Option<usize>,
    p50_ms: f64,
    p95_ms: f64,
    min_ms: f64,
    max_ms: f64,
    threshold_ms: Option<f64>,
    result: &'static str,
    checksum: usize,
    memory: MemoryResult,
}

#[derive(Clone, Copy, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct MemoryResult {
    rss_before_bytes: Option<u64>,
    rss_after_bytes: Option<u64>,
    rss_delta_bytes: Option<i64>,
    peak_rss_bytes: Option<u64>,
    measurement: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CorrectnessResult {
    name: &'static str,
    result: &'static str,
    assertion: &'static str,
}

pub fn run() -> Result<(), String> {
    if cfg!(debug_assertions) {
        return Err("backend performance suite must run with the release profile".into());
    }

    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_time()
        .build()
        .map_err(|error| error.to_string())?;
    let correctness = verify_correctness(&runtime)?;
    let mut cases = Vec::new();

    let submitted = submitted_events(100_000);
    cases.push(measure(
        "parse_submitted_json_100k",
        "p4::changelists::parser::parse_change_events",
        submitted.len(),
        Some(messages_bytes(&submitted)),
        || {
            let parsed = parser::parse_change_events(black_box(&submitted));
            black_box(parsed.len())
        },
    ));
    drop(submitted);

    let pending = pending_events(100_000);
    cases.push(measure(
        "parse_pending_opened_json_100k",
        "p4::changelists::parser::parse_opened_files",
        pending.len(),
        Some(messages_bytes(&pending)),
        || {
            let parsed = parser::parse_opened_files(black_box(&pending));
            black_box(parsed.len())
        },
    ));
    drop(pending);

    let files = file_result(100_000);
    cases.push(measure(
        "parse_file_status_json_100k",
        "app::file_service::status_snapshot",
        files.events.len(),
        Some(messages_bytes(&files.events)),
        || {
            let parsed = fstat_status_snapshot(black_box(&files));
            black_box(parsed.files.len())
        },
    ));
    drop(files);

    for size in [10_000, 50_000, 100_000] {
        let payload = changelist_payload(size);
        let encoded = serde_json::to_vec(&payload).map_err(|error| error.to_string())?;
        cases.push(measure(
            &format!("serialize_cl_query_result_{size}"),
            "serde_json::to_vec<domain::ClQueryResult> (IPC payload)",
            size,
            Some(encoded.len()),
            || {
                let bytes = serde_json::to_vec(black_box(&payload)).expect("validated payload");
                black_box(bytes.len())
            },
        ));
        cases.push(measure(
            &format!("deserialize_cl_query_result_{size}"),
            "serde_json::from_slice<domain::ClQueryResult> (IPC payload)",
            size,
            Some(encoded.len()),
            || {
                let decoded: ClQueryResult =
                    serde_json::from_slice(black_box(&encoded)).expect("validated payload");
                black_box(decoded.items.len())
            },
        ));
    }

    let logs = log_entries(100_000);
    let encoded_logs = serde_json::to_vec(&logs).map_err(|error| error.to_string())?;
    cases.push(measure(
        "serialize_log_ipc_100k",
        "serde_json::to_vec<domain::LogEntry[]> (log IPC payload)",
        logs.len(),
        Some(encoded_logs.len()),
        || {
            let bytes = serde_json::to_vec(black_box(&logs)).expect("validated logs");
            black_box(bytes.len())
        },
    ));
    cases.push(measure(
        "deserialize_log_ipc_100k",
        "serde_json::from_slice<domain::LogEntry[]> (log IPC payload)",
        logs.len(),
        Some(encoded_logs.len()),
        || {
            let decoded: Vec<LogEntry> =
                serde_json::from_slice(black_box(&encoded_logs)).expect("validated logs");
            black_box(decoded.len())
        },
    ));
    drop(logs);
    drop(encoded_logs);

    let hot_cache = StatusCache::new(60_000, 4, 1024 * 1024);
    let hot_key = cache_key("//depot/main");
    runtime.block_on(hot_cache.get_or_load(hot_key.clone(), 1, false, || async {
        Ok(cache_snapshot("//depot/main/a.txt"))
    }))?;
    cases.push(measure(
        "status_cache_hot_hits_100k",
        "app::status_cache::StatusCache::get_or_load",
        100_000,
        None,
        || {
            runtime.block_on(async {
                let mut count = 0;
                for _ in 0..100_000 {
                    let value = hot_cache
                        .get_or_load(hot_key.clone(), 2, false, || async {
                            Err("unexpected reload".into())
                        })
                        .await
                        .expect("hot cache hit");
                    count += value.files.len();
                }
                black_box(count)
            })
        },
    ));
    cases.push(measure(
        "status_cache_lru_insert_10k",
        "app::status_cache::StatusCache::get_or_load + capacity eviction",
        10_000,
        None,
        || {
            runtime.block_on(async {
                let cache = StatusCache::new(60_000, 512, 16 * 1024 * 1024);
                for index in 0..10_000 {
                    let path = format!("//depot/cache/{index:05}");
                    cache
                        .get_or_load(cache_key(&path), 1, false, || async {
                            Ok(cache_snapshot(&path))
                        })
                        .await
                        .expect("cache insert");
                }
                let diagnostics = cache.diagnostics();
                assert_eq!(diagnostics.entries, 512);
                black_box(diagnostics.evicted as usize)
            })
        },
    ));

    cases.push(measure(
        "cursor_fingerprint_roundtrip_100k",
        "p4::query fingerprint + versioned cursor encode/decode",
        100_000,
        None,
        || {
            let connection = "fixed-connection";
            let mut checksum = 0usize;
            for index in 0..100_000usize {
                let fingerprint = query::fingerprint(&(SEED, index)).expect("serializable");
                let cursor =
                    query::encode_change_cursor(index as i64 + 1, &fingerprint, connection, 7)
                        .expect("valid cursor");
                checksum ^= query::decode_change_cursor(&cursor, &fingerprint, connection, 7)
                    .expect("cursor round-trip") as usize;
            }
            black_box(checksum)
        },
    ));

    let searchable = changelist_summaries(100_000);
    cases.push(measure(
        "search_filter_deduplicate_100k",
        "p4::search::item_for_submitted + app::search_service::deduplicate_items",
        searchable.len(),
        None,
        || {
            let mut items = searchable
                .iter()
                .cloned()
                .filter_map(|change| item_for_submitted(change, "关键"))
                .flat_map(|item| [item.clone(), item])
                .collect::<Vec<_>>();
            deduplicate_items(&mut items);
            black_box(items.len())
        },
    ));

    let report = Report {
        schema_version: 1,
        generated_at: chrono::Utc::now().to_rfc3339(),
        suite: "P4Deck backend performance",
        seed: SEED,
        warmup_rounds: WARMUP_ROUNDS,
        measured_rounds: MEASURED_ROUNDS,
        profile: "release",
        environment: environment(),
        compatibility: compatibility(),
        cases,
        correctness,
        caveats: vec![
            "All timing results are informational because the project defines no backend latency threshold.",
            "RSS is sampled at case boundaries; peak RSS is supplied only when the host exposes it and is process-wide, not per case.",
            "Synthetic JSON/IPC data exercises production code paths but is not a real P4 server or native UI workload.",
            "This run does not certify macOS, multiple P4 versions, server Unicode/non-Unicode modes, proxy, broker, or SSL.",
        ],
    };
    write_report(&report)?;
    print_summary(&report);
    Ok(())
}

fn verify_correctness(runtime: &tokio::runtime::Runtime) -> Result<Vec<CorrectnessResult>, String> {
    let submitted = parser::parse_change_events(&submitted_events(32));
    assert_eq!(submitted.len(), 32);
    assert!(submitted.windows(2).all(|pair| pair[0].id > pair[1].id));
    assert_eq!(
        submitted[0].merge_classification,
        MergeClassification::SuspectedMerge
    );

    let pending = parser::parse_opened_files(&pending_events(32));
    assert_eq!(pending.len(), 32);
    assert_eq!(pending[0].0, 0);
    assert_eq!(pending[1].0, 10_001);
    assert_eq!(pending[0].1.state.as_deref(), Some("openedEdit"));

    let file_snapshot = fstat_status_snapshot(&file_result(32));
    assert_eq!(file_snapshot.files.len(), 32);
    let status_for = |index: usize| {
        file_snapshot
            .files
            .iter()
            .find(|status| status.path.contains(&format!("文件-{index:06}.bin")))
            .map(|status| status.status)
            .expect("synthetic file status should exist")
    };
    assert_eq!(status_for(0), FileStatusKind::Conflicted);
    assert_eq!(status_for(1), FileStatusKind::OpenedAdd);
    assert_eq!(status_for(4), FileStatusKind::OutOfDate);

    let payload = changelist_payload(1_024);
    let bytes = serde_json::to_vec(&payload).map_err(|error| error.to_string())?;
    let decoded: ClQueryResult =
        serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
    assert_eq!(decoded.items.len(), payload.items.len());
    assert_eq!(decoded.items[511].id, payload.items[511].id);

    runtime.block_on(verify_cache_correctness())?;

    let fingerprint = query::fingerprint(&(SEED, "查询😀"))?;
    let cursor = query::encode_change_cursor(42, &fingerprint, "connection", 9)?;
    assert_eq!(
        query::decode_change_cursor(&cursor, &fingerprint, "connection", 9)?,
        42
    );
    assert!(query::decode_change_cursor(&cursor, "wrong", "connection", 9).is_err());
    let pending_cursor =
        query::encode_pending_change_cursor("snapshot", 100, &fingerprint, "connection", 9, 4)?;
    assert_eq!(
        query::decode_pending_change_cursor(&pending_cursor, &fingerprint, "connection", 9, 4,)?,
        ("snapshot".into(), 100)
    );
    assert!(
        query::decode_pending_change_cursor(&pending_cursor, &fingerprint, "connection", 9, 5,)
            .is_err()
    );
    let shelf_cursor = query::encode_shelf_detail_cursor(
        "shelf-snapshot",
        "one-time-cursor",
        500,
        &fingerprint,
        "connection",
        9,
        4,
    )?;
    assert_eq!(
        query::decode_shelf_detail_cursor(&shelf_cursor, &fingerprint, "connection", 9, 4)
            .map_err(|error| format!("{error:?}"))?
            .offset,
        500
    );
    assert!(
        query::decode_shelf_detail_cursor(&shelf_cursor, &fingerprint, "connection", 9, 5).is_err()
    );

    let mut search_items = changelist_summaries(100)
        .into_iter()
        .filter_map(|change| item_for_submitted(change, "关键"))
        .flat_map(|item| [item.clone(), item])
        .collect::<Vec<_>>();
    assert_eq!(search_items.len(), 40);
    deduplicate_items(&mut search_items);
    assert_eq!(search_items.len(), 20);
    assert!(search_items
        .iter()
        .all(|item| item.highlights.iter().all(|range| range.end > range.start)));

    Ok(vec![
        correctness(
            "parser_domain_invariants",
            "Submitted/Pending/File counts, order and classifications are deterministic",
        ),
        correctness(
            "ipc_round_trip",
            "ClQueryResult item count and stable IDs survive JSON round-trip",
        ),
        correctness(
            "cache_semantics",
            "TTL, LRU, concurrent coalescing and scoped invalidation use production StatusCache",
        ),
        correctness(
            "cursor_binding",
            "Submitted, Pending and Shelf cursors round-trip and reject mismatched query or generations",
        ),
        correctness(
            "search_filter_dedup",
            "Unicode filtering and identity deduplication preserve the expected 20 unique matches",
        ),
    ])
}

async fn verify_cache_correctness() -> Result<(), String> {
    let cache = Arc::new(StatusCache::new(5, 2, 1024 * 1024));
    let calls = Arc::new(AtomicUsize::new(0));
    let key_a = cache_key("//depot/a");
    let left_cache = cache.clone();
    let left_calls = calls.clone();
    let left_key = key_a.clone();
    let right_cache = cache.clone();
    let right_calls = calls.clone();
    let right_key = key_a.clone();
    let (left, right) = tokio::join!(
        left_cache.get_or_load(left_key, 1, false, || async move {
            left_calls.fetch_add(1, Ordering::SeqCst);
            tokio::time::sleep(std::time::Duration::from_millis(1)).await;
            Ok(cache_snapshot("//depot/a/file.txt"))
        }),
        right_cache.get_or_load(right_key, 1, false, || async move {
            right_calls.fetch_add(1, Ordering::SeqCst);
            Ok(cache_snapshot("//depot/a/wrong.txt"))
        })
    );
    left?;
    right?;
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert_eq!(cache.diagnostics().coalesced, 1);

    let stale = cache.peek(&key_a, 10).expect("cached entry");
    assert_eq!(stale.freshness, CacheFreshness::Stale);
    cache
        .get_or_load(key_a.clone(), 10, false, || async {
            Ok(cache_snapshot("//depot/a/reloaded.txt"))
        })
        .await?;
    let key_b = cache_key("//depot/b");
    cache
        .get_or_load(key_b.clone(), 10, false, || async {
            Ok(cache_snapshot("//depot/b/file.txt"))
        })
        .await?;
    cache
        .get_or_load(key_a.clone(), 10, false, || async {
            Err("must remain hot".into())
        })
        .await?;
    let key_c = cache_key("//depot/c");
    cache
        .get_or_load(key_c, 10, false, || async {
            Ok(cache_snapshot("//depot/c/file.txt"))
        })
        .await?;
    assert!(cache.peek(&key_b, 10).is_none());
    assert_eq!(cache.diagnostics().evicted, 1);

    cache.invalidate(
        "PERFORCE:1666",
        "perf-user",
        "perf-client",
        &["//depot/a".into()],
        &[StatusQueryKind::WorkspaceStatus],
        InvalidationReason::ManualRefresh,
    );
    assert!(cache.peek(&key_a, 10).is_none());
    assert_eq!(cache.diagnostics().invalidated, 1);
    Ok(())
}

fn measure(
    name: &str,
    production_path: &str,
    dataset_size: usize,
    payload_bytes: Option<usize>,
    mut operation: impl FnMut() -> usize,
) -> CaseResult {
    for _ in 0..WARMUP_ROUNDS {
        black_box(operation());
    }
    let before = process_memory();
    let mut samples = Vec::with_capacity(MEASURED_ROUNDS);
    let mut checksum = 0usize;
    for _ in 0..MEASURED_ROUNDS {
        let started = Instant::now();
        checksum ^= operation();
        samples.push(started.elapsed().as_secs_f64() * 1_000.0);
    }
    let after = process_memory();
    samples.sort_by(f64::total_cmp);
    CaseResult {
        name: name.into(),
        production_path: production_path.into(),
        dataset_size,
        payload_bytes,
        p50_ms: rounded(percentile(&samples, 0.50)),
        p95_ms: rounded(percentile(&samples, 0.95)),
        min_ms: rounded(samples[0]),
        max_ms: rounded(*samples.last().expect("measured rounds")),
        threshold_ms: None,
        result: "INFORMATIONAL",
        checksum,
        memory: MemoryResult {
            rss_before_bytes: before.current,
            rss_after_bytes: after.current,
            rss_delta_bytes: before
                .current
                .zip(after.current)
                .map(|(before, after)| after as i64 - before as i64),
            peak_rss_bytes: after.peak.or(before.peak),
            measurement:
                "process RSS sampled at case boundaries; peak is process-wide when available",
        },
    }
}

fn percentile(samples: &[f64], quantile: f64) -> f64 {
    let index = ((samples.len() - 1) as f64 * quantile).ceil() as usize;
    samples[index]
}

fn rounded(value: f64) -> f64 {
    (value * 1_000.0).round() / 1_000.0
}

fn submitted_events(size: usize) -> Vec<OperationEvent> {
    (0..size)
        .map(|index| {
            let id = 2_000_000 - index as i64;
            event(
                serde_json::json!({
                    "change": id.to_string(),
                    "status": "submitted",
                    "user": format!("user-{}", index % 17),
                    "client": format!("workspace-{}", index % 29),
                    "desc": if index % 5 == 0 { "Merge 关键资产 😀" } else { "普通提交 long description" },
                    "time": (1_700_000_000 + (seeded(index) % 100_000)).to_string(),
                    "stream": format!("//streams/main-{}", index % 7)
                })
                .to_string(),
            )
        })
        .collect()
}

fn pending_events(size: usize) -> Vec<OperationEvent> {
    (0..size)
        .map(|index| {
            let action = ["edit", "add", "delete"][index % 3];
            event(
                serde_json::json!({
                    "depotFile": format!("//depot/main/目录-{}/文件-{:06}.txt", index % 97, index),
                    "clientFile": format!("C:/p4/work/目录-{}/文件-{:06}.txt", index % 97, index),
                    "action": action,
                    "change": if index % 7 == 0 { "default".into() } else { (10_000 + index).to_string() },
                    "rev": ((index % 41) + 1).to_string(),
                    "type": if index % 11 == 0 { "utf16" } else { "text" }
                })
                .to_string(),
            )
        })
        .collect()
}

fn file_result(size: usize) -> OperationResult {
    let events = (0..size)
        .map(|index| {
            let action = match index % 5 {
                1 => Some("add"),
                2 => Some("edit"),
                3 => Some("delete"),
                _ => None,
            };
            event(
                serde_json::json!({
                    "clientFile": format!("C:/p4/work/目录-{}/文件-{:06}.bin", index % 97, index),
                    "depotFile": format!("//depot/main/目录-{}/文件-{:06}.bin", index % 97, index),
                    "haveRev": (index % 31) as i64,
                    "headRev": ((index % 31) + usize::from(index % 5 == 4)) as i64,
                    "action": action,
                    "change": (20_000 + index) as i64,
                    "unresolved": usize::from(index % 13 == 0)
                })
                .to_string(),
            )
        })
        .collect();
    OperationResult {
        operation_id: "perf-files".into(),
        exit_code: 0,
        events,
        duration_ms: 0,
    }
}

fn changelist_payload(size: usize) -> ClQueryResult {
    ClQueryResult {
        request_generation: 7,
        items: changelist_summaries(size),
        has_more: true,
        next_cursor: Some("eyJ2ZXJzaW9uIjoxfQ".into()),
        stats: ClQueryStats {
            scanned_count: size,
            matched_count: size,
            hidden_reliable_merge_count: size / 13,
            truncated_by_safety_limit: false,
        },
    }
}

fn changelist_summaries(size: usize) -> Vec<ChangelistSummary> {
    (0..size)
        .map(|index| ChangelistSummary {
            id: 2_000_000 - index as i64,
            description: if index % 5 == 0 {
                format!("关键资产 😀 merge candidate {index}")
            } else {
                format!("ordinary submitted change with long description {index}")
            },
            user: format!("user-{}", index % 17),
            client: format!("workspace-{}", index % 29),
            status: "submitted".into(),
            time: "2026-10-09T00:00:00Z".into(),
            file_count: (seeded(index) % 100) as usize + 1,
            has_shelf: false,
            jobs: vec![format!("JOB-{:05}", index % 1_000)],
            stream: Some(format!("//streams/main-{}", index % 7)),
            merge_classification: if index % 13 == 0 {
                MergeClassification::ReliableMerge
            } else {
                MergeClassification::Normal
            },
        })
        .collect()
}

fn log_entries(size: usize) -> Vec<LogEntry> {
    (0..size)
        .map(|index| LogEntry {
            id: format!("log-{index:06}"),
            timestamp: "2026-10-09T00:00:00Z".into(),
            level: match index % 20 {
                0 => LogLevel::Error,
                1..=3 => LogLevel::Warning,
                _ => LogLevel::Info,
            },
            operation_id: format!("operation-{}", index % 2_000),
            source: if index % 7 == 0 {
                OperationSource::Terminal
            } else {
                OperationSource::Gui
            },
            server: "ssl:perforce.example:1666".into(),
            workspace: format!("workspace-{}", index % 29),
            command: ["fstat", "changes", "describe", "filelog"][index % 4].into(),
            message: format!("structured log message 关键字段 😀 {index}"),
            duration_ms: Some(seeded(index) % 10_000),
            repeat_count: (index % 4 + 1) as u32,
        })
        .collect()
}

fn event(message: String) -> OperationEvent {
    OperationEvent {
        operation_id: "perf".into(),
        kind: EventKind::Stdout,
        message: Some(message),
        progress: None,
        progress_current: None,
        progress_total: None,
        timestamp: "2026-10-09T00:00:00Z".into(),
    }
}

fn messages_bytes(events: &[OperationEvent]) -> usize {
    events
        .iter()
        .filter_map(|event| event.message.as_ref())
        .map(String::len)
        .sum()
}

fn seeded(index: usize) -> u64 {
    let mut value = SEED ^ index as u64;
    value ^= value << 13;
    value ^= value >> 7;
    value ^ (value << 17)
}

fn cache_key(path: &str) -> StatusCacheKey {
    StatusCacheKey::new(
        "PERFORCE:1666",
        "perf-user",
        "perf-client",
        StatusQueryKind::WorkspaceStatus,
        path,
        7,
    )
}

fn cache_snapshot(path: &str) -> StatusSnapshot {
    StatusSnapshot {
        files: vec![CachedFileStatus {
            path: path.into(),
            depot_path: Some(path.into()),
            status: FileStatusKind::Controlled,
            have_revision: Some(1),
            head_revision: Some(1),
            changelist_id: None,
            opened_action: None,
            reconcile_action: None,
            sync: WorkspaceSyncState::Current,
            resolve: WorkspaceResolveState::None,
            local: WorkspaceLocalState::Present,
            mapped: Some(true),
            moved_file: None,
            ignore: None,
            file_type: None,
            exclusive_open: None,
            lock_ownership: None,
            lock_owner: None,
            other_open: Vec::new(),
            can_lock: None,
            can_unlock: None,
            lock_reason: None,
            evidence: Vec::new(),
            errors: Vec::new(),
        }],
        freshness: CacheFreshness::Fresh,
        errors: Vec::new(),
        operation_ids: Vec::new(),
        truncated: false,
    }
}

fn correctness(name: &'static str, assertion: &'static str) -> CorrectnessResult {
    CorrectnessResult {
        name,
        result: "PASS",
        assertion,
    }
}

#[derive(Default)]
struct ProcessMemory {
    current: Option<u64>,
    peak: Option<u64>,
}

fn process_memory() -> ProcessMemory {
    let pid = std::process::id().to_string();
    if cfg!(windows) {
        let script = format!(
            "$p=Get-Process -Id {pid}; Write-Output ($p.WorkingSet64.ToString() + ',' + $p.PeakWorkingSet64.ToString())"
        );
        let output = Command::new("powershell")
            .args(["-NoProfile", "-Command", &script])
            .output()
            .ok();
        if let Some(output) = output.filter(|output| output.status.success()) {
            let value = String::from_utf8_lossy(&output.stdout);
            let mut parts = value.trim().split(',');
            return ProcessMemory {
                current: parts.next().and_then(|value| value.parse().ok()),
                peak: parts.next().and_then(|value| value.parse().ok()),
            };
        }
    } else if let Ok(output) = Command::new("ps").args(["-o", "rss=", "-p", &pid]).output() {
        let current = String::from_utf8_lossy(&output.stdout)
            .trim()
            .parse::<u64>()
            .ok()
            .map(|kib| kib * 1024);
        return ProcessMemory {
            current,
            peak: None,
        };
    }
    ProcessMemory::default()
}

fn environment() -> Environment {
    Environment {
        os: os_description(),
        arch: env::consts::ARCH.into(),
        cpu: env::var("PROCESSOR_IDENTIFIER")
            .or_else(|_| env::var("HOSTTYPE"))
            .unwrap_or_else(|_| "unavailable".into()),
        logical_cpu_count: std::thread::available_parallelism()
            .map(usize::from)
            .unwrap_or(1),
        rustc: command_text(Path::new("rustc"), &["--version"])
            .unwrap_or_else(|| "unavailable".into()),
        cargo: command_text(Path::new("cargo"), &["--version"])
            .unwrap_or_else(|| "unavailable".into()),
    }
}

fn compatibility() -> Compatibility {
    let p4 = executable("P4DECK_P4_PATH", "p4");
    let p4d = executable("P4DECK_P4D_PATH", "p4d");
    let p4_version = p4
        .as_deref()
        .and_then(|path| command_text(path, &["-V"]))
        .and_then(|value| version_line(&value));
    let p4d_version = p4d
        .as_deref()
        .and_then(|path| command_text(path, &["-V"]))
        .and_then(|value| version_line(&value));
    let p4_charset = p4
        .as_deref()
        .and_then(|path| command_text(path, &["set", "-q", "P4CHARSET"]))
        .filter(|value| !value.trim().is_empty());
    Compatibility {
        p4_executable: p4.map(|path| path.display().to_string()),
        p4_version,
        p4d_executable: p4d.map(|path| path.display().to_string()),
        p4d_version,
        p4_charset,
        server_unicode_mode: "not verified (no server handshake in the synthetic benchmark)",
        verified_scope: "local binaries were executed with -V; P4CHARSET was read from the local p4 configuration only",
    }
}

fn version_line(value: &str) -> Option<String> {
    value
        .lines()
        .find(|line| line.trim_start().starts_with("Rev."))
        .map(str::trim)
        .map(str::to_owned)
}

fn executable(override_name: &str, name: &str) -> Option<PathBuf> {
    if let Some(path) = env::var_os(override_name).map(PathBuf::from) {
        if path.is_file() {
            return Some(path);
        }
    }
    let executable_name = if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.into()
    };
    if let Some(paths) = env::var_os("PATH") {
        for directory in env::split_paths(&paths) {
            let path = directory.join(&executable_name);
            if path.is_file() {
                return Some(path);
            }
        }
    }
    let fixture = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()?
        .join(".tools")
        .join("p4d-fixture")
        .join("bin")
        .join(executable_name);
    fixture.is_file().then_some(fixture)
}

fn command_text(executable: &Path, args: &[&str]) -> Option<String> {
    let output = Command::new(executable).args(args).output().ok()?;
    let mut value = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    if value.is_empty() {
        value = String::from_utf8_lossy(&output.stderr).trim().to_owned();
    }
    (!value.is_empty()).then_some(value)
}

fn os_description() -> String {
    if cfg!(windows) {
        command_text(Path::new("cmd"), &["/C", "ver"])
            .unwrap_or_else(|| format!("{} (version unavailable)", env::consts::OS))
    } else {
        command_text(Path::new("uname"), &["-srv"])
            .unwrap_or_else(|| format!("{} (version unavailable)", env::consts::OS))
    }
}

fn write_report(report: &Report) -> Result<(), String> {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .ok_or("Cargo manifest has no repository parent")?;
    let output = root.join("artifacts").join("performance");
    fs::create_dir_all(&output).map_err(|error| error.to_string())?;
    let json = serde_json::to_string_pretty(report).map_err(|error| error.to_string())?;
    fs::write(output.join("backend-latest.json"), json).map_err(|error| error.to_string())?;
    fs::write(output.join("backend-latest.md"), markdown(report))
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn markdown(report: &Report) -> String {
    let mut output = String::new();
    writeln!(output, "# P4Deck backend performance report\n").unwrap();
    writeln!(output, "Generated: {}\n", report.generated_at).unwrap();
    writeln!(
        output,
        "> Synthetic local release benchmark. Timing values are informational; no backend latency threshold exists in the project specification.\n"
    )
    .unwrap();
    writeln!(output, "## Environment\n").unwrap();
    writeln!(
        output,
        "- OS: {} ({})",
        report.environment.os, report.environment.arch
    )
    .unwrap();
    writeln!(
        output,
        "- CPU: {} ({} logical CPUs)",
        report.environment.cpu, report.environment.logical_cpu_count
    )
    .unwrap();
    writeln!(
        output,
        "- Runtime: {}; {}; release profile",
        report.environment.rustc, report.environment.cargo
    )
    .unwrap();
    writeln!(
        output,
        "- Warmup/measured rounds: {}/{}; fixed seed {}\n",
        report.warmup_rounds, report.measured_rounds, report.seed
    )
    .unwrap();
    writeln!(output, "## Compatibility inventory\n").unwrap();
    writeln!(
        output,
        "- p4: {}",
        report
            .compatibility
            .p4_version
            .as_deref()
            .unwrap_or("unavailable")
    )
    .unwrap();
    writeln!(
        output,
        "- p4d: {}",
        report
            .compatibility
            .p4d_version
            .as_deref()
            .unwrap_or("unavailable")
    )
    .unwrap();
    writeln!(
        output,
        "- Local P4CHARSET: {}",
        report
            .compatibility
            .p4_charset
            .as_deref()
            .unwrap_or("unset/unavailable")
    )
    .unwrap();
    writeln!(
        output,
        "- Server Unicode mode: {}\n",
        report.compatibility.server_unicode_mode
    )
    .unwrap();
    writeln!(output, "## Timings\n").unwrap();
    writeln!(
        output,
        "| Production path | Rows/operations | Payload | p50 ms | p95 ms | Gate | Result |"
    )
    .unwrap();
    writeln!(output, "|---|---:|---:|---:|---:|---|---|").unwrap();
    for case in &report.cases {
        writeln!(
            output,
            "| {} | {} | {} | {:.3} | {:.3} | informational | {} |",
            case.name,
            case.dataset_size,
            case.payload_bytes
                .map(format_bytes)
                .unwrap_or_else(|| "n/a".into()),
            case.p50_ms,
            case.p95_ms,
            case.result
        )
        .unwrap();
    }
    writeln!(output, "\n## Correctness gates\n").unwrap();
    for check in &report.correctness {
        writeln!(
            output,
            "- {}: {} — {}",
            check.result, check.name, check.assertion
        )
        .unwrap();
    }
    writeln!(output, "\n## Memory and scope\n").unwrap();
    writeln!(
        output,
        "RSS is sampled before and after each case. On Windows, `PeakWorkingSet64` is also captured, but it is the process-wide peak accumulated across the run rather than an isolated per-case peak. Full values are in the JSON report.\n"
    )
    .unwrap();
    for caveat in &report.caveats {
        writeln!(output, "- {caveat}").unwrap();
    }
    output
}

fn format_bytes(bytes: usize) -> String {
    format!("{:.2} MiB", bytes as f64 / 1_048_576.0)
}

fn print_summary(report: &Report) {
    println!("P4Deck backend performance report");
    for case in &report.cases {
        println!(
            "  {}: p50={:.3}ms p95={:.3}ms (informational)",
            case.name, case.p50_ms, case.p95_ms
        );
    }
    println!("  correctness gates: {} PASS", report.correctness.len());
    println!("  JSON: artifacts/performance/backend-latest.json");
    println!("  Markdown: artifacts/performance/backend-latest.md");
}
