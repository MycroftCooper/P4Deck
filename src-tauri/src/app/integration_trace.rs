use super::*;
use std::{future::Future, sync::Weak, time::Duration};
use tokio::sync::{Mutex as AsyncMutex, Semaphore};

const RECORD_LIMIT: usize = 200;
type Flight = AsyncMutex<Option<IntegrationTraceBatch>>;

// Overlapping successful reads share a result; cancelled readers do not poison
// the next waiter. Weak entries do not retain completed responses.
pub(super) struct TraceReads {
    flights: Mutex<HashMap<String, Weak<Flight>>>,
    slots: Semaphore,
}
impl Default for TraceReads {
    fn default() -> Self {
        Self {
            flights: Mutex::new(HashMap::new()),
            slots: Semaphore::new(2),
        }
    }
}
impl TraceReads {
    fn flight(&self, key: &str) -> Result<Arc<Flight>, String> {
        let mut flights = self.flights.lock();
        flights.retain(|_, value| value.strong_count() > 0);
        if let Some(value) = flights.get(key).and_then(Weak::upgrade) {
            return Ok(value);
        }
        if flights.len() >= 128 {
            return Err("Too many pending integration trace batches".into());
        }
        let value = Arc::new(AsyncMutex::new(None));
        flights.insert(key.into(), Arc::downgrade(&value));
        Ok(value)
    }
}

async fn wait_active<T>(
    future: impl Future<Output = T>,
    active: impl Fn() -> Result<(), String>,
) -> Result<T, String> {
    let mut tick = tokio::time::interval(Duration::from_millis(50));
    let deadline = tokio::time::sleep(Duration::from_secs(30));
    tokio::pin!(future, deadline);
    loop {
        active()?;
        tokio::select! {
            value = &mut future => { active()?; return Ok(value); }
            _ = &mut deadline => return Err("Integration trace queue wait timed out".into()),
            _ = tick.tick() => {}
        }
    }
}

fn literal_path(path: &str) -> bool {
    path.starts_with("//")
        && path.len() >= 5
        && !path.ends_with('/')
        && path[2..].contains('/')
        && !path.contains("...")
        && !path.chars().any(char::is_control)
}

fn canonical_path(path: &str) -> Option<String> {
    if !literal_path(path) || path.contains(['@', '#', '*']) {
        return None;
    }
    let decoded = crate::p4::history::decode_filespec(path);
    Some(escape_filespec_literal(decoded))
}

fn arguments(paths: &[String]) -> Result<Vec<String>, String> {
    // Wire paths retain P4 escaping, as the existing CL describe parser does.
    // Decode exactly once: a literal "%40" is represented by "%2540".
    if paths.is_empty()
        || paths.len() > 20
        || paths.iter().map(String::len).sum::<usize>() > 16_000
        || paths.iter().any(|path| canonical_path(path).is_none())
    {
        return Err("Trace requires 1-20 exact P4-escaped depot paths from CL detail (maximum 16 KB; use %40/%23/%2A for literal @/#/*; ellipsis unsupported)".into());
    }
    let mut paths: Vec<_> = paths
        .iter()
        .filter_map(|path| canonical_path(path))
        .collect();
    paths.sort();
    paths.dedup();
    let mut args = vec!["-m".into(), RECORD_LIMIT.to_string()];
    args.extend(paths);
    Ok(args)
}

fn cache_key(scope: &FileReviewScope, args: &[String]) -> String {
    let mut identity = scope.clone();
    identity.file_identity.clear();
    format!(
        "integrated-trace:{}:{}",
        review_fingerprint(&identity),
        serde_json::to_string(args).expect("string list")
    )
}

fn revision(value: &Value, field: &str) -> Option<i64> {
    let raw = value.get(field)?;
    let number = if let Some(n) = raw.as_i64() {
        n
    } else {
        let text = raw.as_str()?;
        let text = text.strip_prefix('#').unwrap_or(text);
        if text == "none" {
            0
        } else {
            text.parse::<i64>().ok()?
        }
    };
    (0..=9_007_199_254_740_991)
        .contains(&number)
        .then_some(number)
}

fn normalize(value: &Value) -> Option<IntegrationTraceRecord> {
    let how = value.get("how")?.as_str()?;
    // Tagged toFile is the printed file, not invariably the destination.
    let into = match how {
        "add into" | "branch into" | "merge into" | "moved into" | "copy into" | "delete into"
        | "edit into" | "ignored by" | "undone by" => true,
        "add from" | "branch from" | "merge from" | "moved from" | "copy from" | "delete from"
        | "edit from" | "ignored" | "undid" => false,
        _ => return None,
    };
    let (source, target, sr, tr) = if into {
        ("toFile", "fromFile", "To", "From")
    } else {
        ("fromFile", "toFile", "From", "To")
    };
    let source_path = canonical_path(value.get(source)?.as_str()?)?;
    let target_path = canonical_path(value.get(target)?.as_str()?)?;
    let source_start = revision(value, &format!("start{sr}Rev"))?;
    let source_end = revision(value, &format!("end{sr}Rev"))?;
    let target_start = revision(value, &format!("start{tr}Rev"))?;
    let target_end = revision(value, &format!("end{tr}Rev"))?;
    let record_change = revision(value, "change")?;
    if source_end <= source_start || target_end <= target_start || record_change == 0 {
        return None;
    }
    Some(IntegrationTraceRecord {
        source_path,
        target_path,
        source_start,
        source_end,
        target_start,
        target_end,
        how: how.into(),
        record_change,
    })
}

fn parse_batch(
    result: &OperationResult,
    paths: &[String],
) -> Result<IntegrationTraceBatch, String> {
    if result
        .events
        .iter()
        .any(|event| matches!(event.kind, EventKind::Cancelled))
    {
        return Err("Integration trace cancelled; result discarded".into());
    }
    let mut batch = IntegrationTraceBatch {
        records: Vec::new(),
        incomplete: result.exit_code != 0,
        warnings: Vec::new(),
        read_at: now_ms(),
    };
    let mut count = 0;
    let mut seen = HashSet::new();
    for event in &result.events {
        match event.kind {
            EventKind::Stderr | EventKind::Warning | EventKind::Error => {
                batch.incomplete = true;
                continue;
            }
            EventKind::Stdout => {}
            _ => continue,
        }
        let Some(line) = event
            .message
            .as_deref()
            .filter(|line| !line.trim().is_empty())
        else {
            continue;
        };
        count += 1;
        if count > RECORD_LIMIT {
            batch.incomplete = true;
            continue;
        }
        let record = serde_json::from_str::<Value>(line).ok().and_then(|value| {
            if value.get("severity").is_some()
                || value.get("code").is_some_and(|code| code != "stat")
            {
                return None;
            }
            normalize(&value)
        });
        let Some(record) = record else {
            batch.incomplete = true;
            continue;
        };
        if !paths
            .iter()
            .any(|path| canonical_path(path).as_ref() == Some(&record.source_path))
        {
            continue;
        }
        let action = record
            .how
            .strip_suffix(" into")
            .or_else(|| record.how.strip_suffix(" from"))
            .unwrap_or(match record.how.as_str() {
                "ignored by" => "ignored",
                "undone by" => "undid",
                other => other,
            });
        let identity = (
            record.source_path.clone(),
            record.target_path.clone(),
            record.source_start,
            record.source_end,
            record.target_start,
            record.target_end,
            record.record_change,
            action.to_owned(),
        );
        if seen.insert(identity) {
            batch.records.push(record);
        }
    }
    if count >= RECORD_LIMIT {
        batch.incomplete = true;
        batch
            .warnings
            .push("200-record cap reached; older records unknown".into());
    }
    if batch.incomplete {
        batch.warnings.push("Records may be missing: limit, permissions, unsupported output or query failure; no exhaustive destination claim is possible".into());
    }
    Ok(batch)
}

impl FileService {
    pub async fn integration_trace(
        &self,
        request: IntegrationTraceRequest,
        app: Option<&AppHandle>,
    ) -> Result<IntegrationTraceBatch, String> {
        let args = arguments(&request.paths)?;
        let context = self.validate_review_scope(&request.scope)?;
        let key = cache_key(&request.scope, &args);
        let id = request
            .operation_id
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        let operation = self.runner.begin_operation_group(id.clone());
        let active = || {
            operation.ensure_active()?;
            self.ensure_review_scope_current(&request.scope)
        };
        active()?;
        if !request.refresh {
            if let Some(value) = self.review_cache.lock().get(&key) {
                return serde_json::from_value(value).map_err(|e| e.to_string());
            }
        }
        let flight = self.trace_reads.flight(&key)?;
        let mut shared = wait_active(flight.lock(), &active).await?;
        if let Some(batch) = shared.as_ref() {
            return Ok(batch.clone());
        }
        if !request.refresh {
            if let Some(value) = self.review_cache.lock().get(&key) {
                return serde_json::from_value(value).map_err(|e| e.to_string());
            }
        }
        let _slot = wait_active(self.trace_reads.slots.acquire(), &active)
            .await?
            .map_err(|e| e.to_string())?;
        active()?;
        let result = self
            .runner
            .run(
                P4CommandRequest {
                    operation_id: Some(id),
                    source: OperationSource::Gui,
                    command: "integrated".into(),
                    args,
                    context,
                    output_mode: OutputMode::JsonLines,
                    timeout_ms: Some(30_000),
                    input: None,
                },
                app,
            )
            .await
            .map_err(|e| e.to_string())?;
        active()?;
        let batch = parse_batch(&result, &request.paths)?;
        active()?;
        self.review_cache.lock().put(key, &batch)?;
        *shared = Some(batch.clone());
        Ok(batch)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn record(how: &str) -> Value {
        serde_json::json!({"toFile":"//d/source", "fromFile":"//d/target", "startToRev":"#2", "endToRev":"#5", "startFromRev":"#none", "endFromRev":"#1", "how":how, "change":"91"})
    }
    fn event(kind: EventKind, message: String) -> OperationEvent {
        OperationEvent {
            operation_id: "mock-only".into(),
            kind,
            message: Some(message),
            progress: None,
            timestamp: String::new(),
        }
    }
    fn result(events: Vec<OperationEvent>) -> OperationResult {
        OperationResult {
            operation_id: "mock-only".into(),
            exit_code: 0,
            events,
            duration_ms: 0,
        }
    }
    fn scope() -> FileReviewScope {
        serde_json::from_value(serde_json::json!({"server":"mock", "user":"u", "client":"c", "workspace":"", "contextGeneration":1, "fileIdentity":"//change/42"})).unwrap()
    }
    #[test]
    fn explicit_paths_are_bounded_sorted_deduplicated_and_escaped_once() {
        assert_eq!(
            arguments(&["//d/b".into(), "//d/a".into(), "//d/b".into()]).unwrap(),
            ["-m", "200", "//d/a", "//d/b"]
        );
        assert_eq!(
            arguments(&["//d/a%40%23%2a%25%2540".into()]).unwrap()[2],
            "//d/a%40%23%2A%25%2540"
        );
        for path in [
            "//d/...",
            "//d/a#7",
            "//d/*",
            "//d/a@123",
            "//d/",
            "relative",
            "//d/a\n",
        ] {
            assert!(arguments(&[path.into()]).is_err(), "{path}");
        }
        assert!(arguments(&[]).is_err());
        assert!(arguments(&vec!["//d/a".into(); 21]).is_err());
        assert!(arguments(&[format!("//d/{}", "a".repeat(16000))]).is_err());
    }
    #[test]
    fn all_documented_directions_preserve_exclusive_ranges() {
        for how in [
            "add into",
            "branch into",
            "merge into",
            "moved into",
            "copy into",
            "delete into",
            "edit into",
            "ignored by",
            "undone by",
        ] {
            let r = normalize(&record(how)).unwrap();
            assert_eq!(
                (r.source_path.as_str(), r.target_path.as_str()),
                ("//d/source", "//d/target")
            );
            assert_eq!(
                (r.source_start, r.source_end, r.target_start, r.target_end),
                (2, 5, 0, 1)
            );
        }
        for how in [
            "add from",
            "branch from",
            "merge from",
            "moved from",
            "copy from",
            "delete from",
            "edit from",
            "ignored",
            "undid",
        ] {
            let r = normalize(&record(how)).unwrap();
            assert_eq!(
                (r.source_path.as_str(), r.target_path.as_str()),
                ("//d/target", "//d/source")
            );
            assert_eq!(
                (r.source_start, r.source_end, r.target_start, r.target_end),
                (0, 1, 2, 5)
            );
        }
    }
    #[test]
    fn malformed_unknown_or_unsafe_records_do_not_become_evidence() {
        for how in ["future into", "merge with edit", "", "COPY INTO"] {
            assert!(normalize(&record(how)).is_none());
        }
        for (field, value) in [
            ("endToRev", "#2"),
            ("startFromRev", "#1"),
            ("change", "0"),
            ("change", "9007199254740992"),
            ("startToRev", "##2"),
            ("toFile", "//d/..."),
        ] {
            let mut v = record("copy into");
            v[field] = value.into();
            assert!(normalize(&v).is_none(), "{field}");
        }
    }
    #[test]
    fn diagnostics_non_json_permissions_and_nonzero_exit_are_incomplete() {
        let valid = event(EventKind::Stdout, record("copy into").to_string());
        for diagnostic in [
            event(EventKind::Warning, "limit".into()),
            event(EventKind::Error, "capture limit".into()),
            event(EventKind::Stderr, "permission denied".into()),
            event(EventKind::Stdout, "not JSON".into()),
            event(
                EventKind::Stdout,
                r#"{"code":"error","severity":3,"data":"no permission"}"#.into(),
            ),
        ] {
            let batch = parse_batch(
                &result(vec![valid.clone(), diagnostic]),
                &["//d/source".into()],
            )
            .unwrap();
            assert!(batch.incomplete);
            assert_eq!(batch.records.len(), 1);
            assert!(!batch.warnings.is_empty());
        }
        let mut failed = result(vec![]);
        failed.exit_code = 1;
        assert!(parse_batch(&failed, &[]).unwrap().incomplete);
        assert!(parse_batch(
            &result(vec![event(EventKind::Cancelled, "cancelled".into())]),
            &[]
        )
        .is_err());
    }
    #[test]
    fn cap_counts_raw_records_before_filtering_or_deduplication() {
        let repeated = event(EventKind::Stdout, record("copy into").to_string());
        let batch = parse_batch(&result(vec![repeated; 200]), &["//d/source".into()]).unwrap();
        assert!(batch.incomplete);
        assert_eq!(batch.records.len(), 1);
        assert!(!parse_batch(&result(vec![]), &[]).unwrap().incomplete);
        let incoming = parse_batch(
            &result(vec![event(
                EventKind::Stdout,
                record("copy from").to_string(),
            )]),
            &["//d/source".into()],
        )
        .unwrap();
        assert!(incoming.records.is_empty());
        assert!(!incoming.incomplete);
    }
    #[test]
    fn reverse_views_deduplicate_but_ignored_and_undo_remain_visible() {
        let mut reverse = record("copy from");
        for (a, b) in [
            ("toFile", "fromFile"),
            ("startToRev", "startFromRev"),
            ("endToRev", "endFromRev"),
        ] {
            let saved = reverse[a].clone();
            reverse[a] = reverse[b].clone();
            reverse[b] = saved;
        }
        let values = [
            record("copy into"),
            reverse,
            record("ignored by"),
            record("undone by"),
        ];
        let batch = parse_batch(
            &result(
                values
                    .iter()
                    .map(|v| event(EventKind::Stdout, v.to_string()))
                    .collect(),
            ),
            &["//d/source".into(), "//d/target".into()],
        )
        .unwrap();
        assert_eq!(batch.records.len(), 3);
        assert!(!batch.incomplete);
    }
    #[test]
    fn connection_identity_and_generation_isolate_cache_and_snapshot() {
        let original = scope();
        let args = arguments(&["//d/a".into()]).unwrap();
        let key = cache_key(&original, &args);
        let mut other = original.clone();
        other.file_identity = "//change/99".into();
        assert_eq!(key, cache_key(&other, &args));
        for field in [
            "server",
            "user",
            "client",
            "workspace",
            "activeProfileId",
            "contextGeneration",
        ] {
            let mut wire = serde_json::to_value(&original).unwrap();
            wire[field] = if field == "contextGeneration" {
                2.into()
            } else {
                "different".into()
            };
            let changed: FileReviewScope = serde_json::from_value(wire).unwrap();
            assert_ne!(key, cache_key(&changed, &args));
            let context = P4Context {
                server: "mock".into(),
                user: "u".into(),
                client: "c".into(),
                ..Default::default()
            };
            assert!(validate_review_snapshot(&changed, &context, 1, &None).is_err());
            assert!(validate_review_snapshot(&original, &context, 1, &None).is_ok());
        }
    }
    #[test]
    fn wire_contract_rejects_internal_tags_and_preserves_response_shape() {
        let mut wire = serde_json::json!({"scope":scope(),"paths":["//d/a"]});
        let request: IntegrationTraceRequest = serde_json::from_value(wire.clone()).unwrap();
        assert!(!request.refresh);
        assert!(request.operation_id.is_none());
        wire["kind"] = "trace".into();
        assert!(serde_json::from_value::<IntegrationTraceRequest>(wire).is_err());
        let batch = parse_batch(
            &result(vec![event(
                EventKind::Stdout,
                record("copy into").to_string(),
            )]),
            &["//d/source".into()],
        )
        .unwrap();
        let value = serde_json::to_value(batch).unwrap();
        assert_eq!(value.as_object().unwrap().len(), 4);
        assert_eq!(value["records"][0].as_object().unwrap().len(), 8);
        assert_eq!(value["records"][0]["recordChange"], 91);
    }
    #[tokio::test]
    async fn overlapping_reads_share_success_and_waiter_cancellation_is_local() {
        let reads = TraceReads::default();
        let first = reads.flight("same").unwrap();
        let second = reads.flight("same").unwrap();
        assert!(Arc::ptr_eq(&first, &second));
        let mut owner = first.lock().await;
        let cancelled = wait_active(second.lock(), || Err("cancelled".into())).await;
        assert!(cancelled.is_err());
        drop(cancelled);
        *owner = Some(parse_batch(&result(vec![]), &[]).unwrap());
        drop(owner);
        assert!(wait_active(second.lock(), || Ok(()))
            .await
            .unwrap()
            .is_some());
        drop(first);
        drop(second);
        assert!(reads.flight("same").unwrap().lock().await.is_none());
        let a = reads.slots.try_acquire().unwrap();
        let b = reads.slots.try_acquire().unwrap();
        assert!(reads.slots.try_acquire().is_err());
        drop((a, b));
    }
    #[tokio::test]
    async fn failed_owner_leaves_waiter_free_and_pending_keys_are_bounded() {
        let reads = TraceReads::default();
        let first = reads.flight("same").unwrap();
        let second = reads.flight("same").unwrap();
        drop(first.lock().await);
        assert!(wait_active(second.lock(), || Ok(()))
            .await
            .unwrap()
            .is_none());
        let mut held = vec![first, second];
        for i in 0..127 {
            held.push(reads.flight(&i.to_string()).unwrap());
        }
        assert!(reads.flight("overflow").is_err());
        drop(held);
        assert!(reads.flight("overflow").is_ok());
    }
}
