use crate::{
    domain::*,
    p4::{runner::P4Runner, streams::StreamRepository},
};
use serde_json::Value;
use std::{collections::HashMap, sync::Arc, time::Instant};
use tauri::AppHandle;

pub const CATEGORY_SCAN_LIMIT: usize = 1_000;
pub const SHELF_SCAN_LIMIT: usize = 500;
pub const SHELF_DETAIL_CANDIDATE_LIMIT: usize = 128;
pub const SHELF_DETAIL_BATCH_SIZE: usize = 16;
pub const SHELF_DETAIL_COMMAND_LIMIT: usize = 8;
pub const SHELF_FILE_LIMIT_PER_CHANGE: usize = 256;
pub const SHELF_TOTAL_FILE_LIMIT: usize = 20_000;
pub const SHELF_DEEP_SEARCH_BUDGET_MS: u128 = 20_000;

#[derive(Debug)]
pub struct SearchBatch {
    pub items: Vec<GlobalSearchItem>,
    pub scanned: usize,
    pub partial: bool,
    pub partial_reason: Option<String>,
}

pub struct SearchRepository {
    runner: Arc<P4Runner>,
}

impl SearchRepository {
    pub fn new(runner: Arc<P4Runner>) -> Self {
        Self { runner }
    }

    pub async fn pending(
        &self,
        context: &P4Context,
        operation_id: &str,
        needle: &str,
        app: Option<&AppHandle>,
    ) -> Result<SearchBatch, String> {
        if context.user.trim().is_empty() || context.client.trim().is_empty() {
            return Err("pending changelist search requires a current user and client".into());
        }
        let result = self
            .run(
                context,
                operation_id,
                "changes",
                vec![
                    "-L".into(),
                    "-t".into(),
                    "-s".into(),
                    "pending".into(),
                    "-u".into(),
                    context.user.clone(),
                    "-c".into(),
                    context.client.clone(),
                    "-m".into(),
                    (CATEGORY_SCAN_LIMIT + 1).to_string(),
                ],
                app,
            )
            .await?;
        let mut changes = crate::p4::changelists::parser::parse_change_events(&result.events);
        let partial = changes.len() > CATEGORY_SCAN_LIMIT;
        changes.truncate(CATEGORY_SCAN_LIMIT);
        let scanned = changes.len();
        let items = changes
            .into_iter()
            .filter_map(|change| {
                let title = format!("CL {}", change.id);
                let fields = [
                    ("title", title.as_str()),
                    ("description", change.description.as_str()),
                    ("user", change.user.as_str()),
                    ("client", change.client.as_str()),
                ];
                match_fields(needle, &fields).map(|(matched_fields, highlights, rank)| {
                    GlobalSearchItem {
                        identity: format!("pending-change:{}", change.id),
                        kind: GlobalSearchKind::PendingChange,
                        title,
                        summary: format!(
                            "{} · {} · {}",
                            change.description, change.user, change.client
                        ),
                        target: GlobalSearchTarget::PendingChange {
                            change_id: change.id,
                        },
                        matched_fields,
                        highlights,
                        rank,
                    }
                })
            })
            .collect();
        Ok(SearchBatch {
            items,
            scanned,
            partial,
            partial_reason: partial.then(|| "pending changelist scan limit reached".into()),
        })
    }

    pub async fn depot_files(
        &self,
        context: &P4Context,
        operation_id: &str,
        needle: &str,
        app: Option<&AppHandle>,
    ) -> Result<SearchBatch, String> {
        let result = self
            .run(
                context,
                operation_id,
                "files",
                vec![
                    "-e".into(),
                    "-m".into(),
                    (CATEGORY_SCAN_LIMIT + 1).to_string(),
                    "//...".into(),
                ],
                app,
            )
            .await?;
        let mut values = json_values(&result);
        let partial = values.len() > CATEGORY_SCAN_LIMIT;
        values.truncate(CATEGORY_SCAN_LIMIT);
        let scanned = values.len();
        let items = values
            .into_iter()
            .filter_map(|value| {
                let path = string_field(&value, &["depotFile"])?;
                let title = path.rsplit('/').next().unwrap_or(&path).to_owned();
                let fields = [("title", title.as_str()), ("depotPath", path.as_str())];
                match_fields(needle, &fields).map(|(matched_fields, highlights, rank)| {
                    GlobalSearchItem {
                        identity: format!("depot-file:{path}"),
                        kind: GlobalSearchKind::DepotFile,
                        title,
                        summary: path.clone(),
                        target: GlobalSearchTarget::DepotFile {
                            depot_path: path.clone(),
                        },
                        matched_fields,
                        highlights,
                        rank,
                    }
                })
            })
            .collect();
        Ok(SearchBatch {
            items,
            scanned,
            partial,
            partial_reason: partial.then(|| "depot file scan limit reached".into()),
        })
    }

    pub async fn workspace_files(
        &self,
        context: &P4Context,
        operation_id: &str,
        needle: &str,
        app: Option<&AppHandle>,
    ) -> Result<SearchBatch, String> {
        if context.client.trim().is_empty() {
            return Err("workspace file search requires a current client".into());
        }
        let result = self
            .run(
                context,
                operation_id,
                "fstat",
                vec![
                    "-m".into(),
                    (CATEGORY_SCAN_LIMIT + 1).to_string(),
                    "-T".into(),
                    "depotFile,clientFile,headRev".into(),
                    format!("//{}/...", context.client),
                ],
                app,
            )
            .await?;
        let mut values = json_values(&result);
        let partial = values.len() > CATEGORY_SCAN_LIMIT;
        values.truncate(CATEGORY_SCAN_LIMIT);
        let scanned = values.len();
        let items = values
            .into_iter()
            .filter_map(|value| {
                let absolute = string_field(&value, &["clientFile"])?;
                let depot = string_field(&value, &["depotFile"]);
                let title = absolute
                    .rsplit(['/', '\\'])
                    .next()
                    .unwrap_or(&absolute)
                    .to_owned();
                let mut fields = vec![
                    ("title", title.as_str()),
                    ("absolutePath", absolute.as_str()),
                ];
                if let Some(depot) = &depot {
                    fields.push(("depotPath", depot.as_str()));
                }
                match_fields(needle, &fields).map(|(matched_fields, highlights, rank)| {
                    GlobalSearchItem {
                        identity: format!(
                            "workspace-file:{}",
                            depot.as_deref().unwrap_or(&absolute)
                        ),
                        kind: GlobalSearchKind::WorkspaceFile,
                        title,
                        summary: depot.clone().unwrap_or_else(|| absolute.clone()),
                        target: GlobalSearchTarget::WorkspaceFile {
                            absolute_path: absolute.clone(),
                        },
                        matched_fields,
                        highlights,
                        rank,
                    }
                })
            })
            .collect();
        Ok(SearchBatch {
            items,
            scanned,
            partial,
            partial_reason: partial.then(|| "workspace file scan limit reached".into()),
        })
    }

    /// Job results are no longer offered by the global search UI; kept for
    /// protocol compatibility until the Job kind is fully retired.
    #[allow(dead_code)]
    pub async fn jobs(
        &self,
        context: &P4Context,
        operation_id: &str,
        needle: &str,
        app: Option<&AppHandle>,
    ) -> Result<SearchBatch, String> {
        let result = self
            .run(
                context,
                operation_id,
                "jobs",
                vec![
                    "-l".into(),
                    "-m".into(),
                    (CATEGORY_SCAN_LIMIT + 1).to_string(),
                ],
                app,
            )
            .await?;
        let mut values = json_values(&result);
        let partial = values.len() > CATEGORY_SCAN_LIMIT;
        values.truncate(CATEGORY_SCAN_LIMIT);
        let scanned = values.len();
        let items = values
            .into_iter()
            .filter_map(|value| {
                let job = string_field(&value, &["Job", "job"])?;
                let description = string_field(&value, &["Description", "description", "desc"])
                    .unwrap_or_default();
                let status = string_field(&value, &["Status", "status"]).unwrap_or_default();
                let user = string_field(&value, &["User", "user"]).unwrap_or_default();
                let fields = [
                    ("jobId", job.as_str()),
                    ("description", description.as_str()),
                    ("status", status.as_str()),
                    ("user", user.as_str()),
                ];
                match_fields(needle, &fields).map(|(matched_fields, highlights, rank)| {
                    GlobalSearchItem {
                        identity: format!("job:{job}"),
                        kind: GlobalSearchKind::Job,
                        title: job.clone(),
                        summary: if status.is_empty() {
                            description.clone()
                        } else {
                            format!("{status} · {description}")
                        },
                        target: GlobalSearchTarget::Job {
                            job_id: job.clone(),
                        },
                        matched_fields,
                        highlights,
                        rank,
                    }
                })
            })
            .collect();
        Ok(SearchBatch {
            items,
            scanned,
            partial,
            partial_reason: partial.then(|| "job scan limit reached".into()),
        })
    }

    pub async fn streams(
        &self,
        context: &P4Context,
        operation_id: &str,
        needle: &str,
        app: Option<&AppHandle>,
    ) -> Result<SearchBatch, String> {
        let batch = StreamRepository::new(self.runner.clone())
            .query(context, operation_id, None, None, true, app)
            .await?;
        let scanned = batch.scanned_count;
        let mut items = Vec::new();
        for node in batch.nodes {
            let name = node.name.unwrap_or_default();
            let owner = node.owner.unwrap_or_default();
            let parent = node.parent.unwrap_or_default();
            let kind = node.kind.unwrap_or_default();
            let description = node.description.unwrap_or_default();
            let title = if name.is_empty() {
                node.stream.clone()
            } else {
                name.clone()
            };
            let fields = [
                ("title", title.as_str()),
                ("streamPath", node.stream.as_str()),
                ("name", name.as_str()),
                ("owner", owner.as_str()),
                ("type", kind.as_str()),
                ("parent", parent.as_str()),
                ("description", description.as_str()),
            ];
            if let Some((matched_fields, highlights, rank)) = match_fields(needle, &fields) {
                let mut facts = vec![node.stream.clone()];
                if !kind.is_empty() {
                    facts.push(kind);
                }
                if !owner.is_empty() {
                    facts.push(owner);
                }
                if !parent.is_empty() {
                    facts.push(format!("parent {parent}"));
                }
                if !description.is_empty() {
                    facts.push(description);
                }
                items.push(GlobalSearchItem {
                    identity: format!("stream:{}", node.stream),
                    kind: GlobalSearchKind::Stream,
                    title,
                    summary: facts.join(" · "),
                    target: GlobalSearchTarget::Stream {
                        stream_path: node.stream,
                    },
                    matched_fields,
                    highlights,
                    rank,
                });
            }
        }
        let partial = batch.truncated || batch.invalid_record_count > 0;
        let partial_reason = if batch.truncated {
            Some("stream scan limit reached".into())
        } else if batch.invalid_record_count > 0 {
            Some("one or more stream records could not be parsed".into())
        } else {
            None
        };
        Ok(SearchBatch {
            items,
            scanned,
            partial,
            partial_reason,
        })
    }

    pub async fn shelves<F>(
        &self,
        context: &P4Context,
        operation_id: &str,
        needle: &str,
        app: Option<&AppHandle>,
        ensure_active: F,
    ) -> Result<SearchBatch, String>
    where
        F: Fn() -> Result<(), String>,
    {
        ensure_active()?;
        let listed = self
            .run(
                context,
                operation_id,
                "changes",
                vec![
                    "-l".into(),
                    "-t".into(),
                    "-s".into(),
                    "shelved".into(),
                    "-m".into(),
                    (SHELF_SCAN_LIMIT + 1).to_string(),
                ],
                app,
            )
            .await?;
        ensure_active()?;
        let mut candidates = crate::p4::changelists::parser::parse_change_events(&listed.events);
        let listed_truncated = candidates.len() > SHELF_SCAN_LIMIT;
        candidates.truncate(SHELF_SCAN_LIMIT);
        let scanned = candidates.len();
        let started = Instant::now();
        let mut details = HashMap::<i64, ShelfFiles>::new();
        let detail_count = candidates.len().min(SHELF_DETAIL_CANDIDATE_LIMIT);
        let mut total_files = 0usize;
        let mut reason =
            listed_truncated.then(|| "shelved changelist scan limit reached".to_owned());

        for (batch_index, chunk) in candidates[..detail_count]
            .chunks(SHELF_DETAIL_BATCH_SIZE)
            .enumerate()
        {
            if batch_index >= SHELF_DETAIL_COMMAND_LIMIT {
                reason.get_or_insert_with(|| "shelf detail command limit reached".into());
                break;
            }
            if started.elapsed().as_millis() >= SHELF_DEEP_SEARCH_BUDGET_MS {
                reason.get_or_insert_with(|| "shelf deep-search time budget reached".into());
                break;
            }
            ensure_active()?;
            // The batch loop is bounded by SHELF_DEEP_SEARCH_BUDGET_MS above;
            // each `p4 describe` gets the short-read family instead of a
            // shrinking literal, so a slow batch still yields a partial result.
            let mut args = vec![
                "-s".into(),
                "-S".into(),
                "-m".into(),
                (SHELF_FILE_LIMIT_PER_CHANGE + 1).to_string(),
            ];
            args.extend(chunk.iter().map(|change| change.id.to_string()));
            let result = match self
                .run_with_timeout(
                    context,
                    operation_id,
                    "describe",
                    args,
                    crate::p4::bounds::IoBound::Read,
                    app,
                )
                .await
            {
                Ok(result) => result,
                Err(error)
                    if error.to_ascii_lowercase().contains("timed out")
                        || error.to_ascii_lowercase().contains("timeout")
                        || error.to_ascii_lowercase().contains("output exceeded") =>
                {
                    let lower = error.to_ascii_lowercase();
                    reason.get_or_insert_with(|| {
                        if lower.contains("output exceeded") {
                            "shelf deep-search output safety limit reached".into()
                        } else {
                            "shelf deep-search time budget reached".into()
                        }
                    });
                    break;
                }
                Err(error) => return Err(error),
            };
            ensure_active()?;
            for value in json_values(&result) {
                let Some(change_id) = number_field(&value, &["change", "Change"]) else {
                    continue;
                };
                if !chunk.iter().any(|candidate| candidate.id == change_id) {
                    return Err("shelf detail returned an unexpected changelist".into());
                }
                let mut paths = indexed_strings(&value, "depotFile");
                let truncated = paths.len() > SHELF_FILE_LIMIT_PER_CHANGE;
                paths.truncate(SHELF_FILE_LIMIT_PER_CHANGE);
                if total_files.saturating_add(paths.len()) > SHELF_TOTAL_FILE_LIMIT {
                    let remaining = SHELF_TOTAL_FILE_LIMIT.saturating_sub(total_files);
                    paths.truncate(remaining);
                    reason.get_or_insert_with(|| "shelf total file limit reached".into());
                }
                total_files = total_files.saturating_add(paths.len());
                if truncated {
                    reason.get_or_insert_with(|| "per-shelf file limit reached".into());
                }
                details.insert(change_id, ShelfFiles { paths, truncated });
                if total_files >= SHELF_TOTAL_FILE_LIMIT {
                    break;
                }
            }
            if total_files >= SHELF_TOTAL_FILE_LIMIT {
                break;
            }
        }
        if candidates.len() > detail_count {
            reason.get_or_insert_with(|| "shelf detail candidate limit reached".into());
        }
        if details.len() < detail_count && reason.is_none() {
            reason = Some("one or more shelf details were unavailable".into());
        }

        let mut items = Vec::new();
        for change in candidates {
            let title = format!("Shelf {}", change.id);
            let id = change.id.to_string();
            let metadata = [
                ("title", title.as_str()),
                ("changeId", id.as_str()),
                ("description", change.description.as_str()),
                ("owner", change.user.as_str()),
                ("user", change.user.as_str()),
                ("client", change.client.as_str()),
                ("status", change.status.as_str()),
                ("time", change.time.as_str()),
            ];
            let metadata_match = match_fields(needle, &metadata);
            let files = details.remove(&change.id).unwrap_or_default();
            let matching_paths = files
                .paths
                .iter()
                .filter(|path| find_utf16(path, needle).is_some())
                .cloned()
                .collect::<Vec<_>>();
            if metadata_match.is_none() && matching_paths.is_empty() {
                continue;
            }
            let (mut matched_fields, mut highlights, mut rank) =
                metadata_match.unwrap_or_else(|| (Vec::new(), Vec::new(), u8::MAX));
            if let Some(path) = matching_paths.first() {
                let (start, end) = find_utf16(path, needle).expect("matched shelf path");
                matched_fields.push("depotPath".into());
                highlights.push(GlobalSearchHighlight {
                    field: "depotPath".into(),
                    start,
                    end,
                });
                rank = rank.min(if path.trim() == needle { 0 } else { 2 });
            }
            let mut facts = vec![
                change.description,
                change.user,
                change.client,
                change.status,
                change.time,
            ];
            if !matching_paths.is_empty() {
                facts.push(format!(
                    "{} matching file{}: {}{}",
                    matching_paths.len(),
                    if matching_paths.len() == 1 { "" } else { "s" },
                    matching_paths
                        .iter()
                        .take(3)
                        .cloned()
                        .collect::<Vec<_>>()
                        .join(", "),
                    if matching_paths.len() > 3 || files.truncated {
                        " …"
                    } else {
                        ""
                    }
                ));
            }
            facts.retain(|value| !value.trim().is_empty());
            items.push(GlobalSearchItem {
                identity: format!("shelf:{}", change.id),
                kind: GlobalSearchKind::Shelf,
                title,
                summary: facts.join(" · "),
                target: GlobalSearchTarget::Shelf {
                    change_id: change.id,
                },
                matched_fields,
                highlights,
                rank,
            });
        }
        Ok(SearchBatch {
            items,
            scanned,
            partial: reason.is_some(),
            partial_reason: reason,
        })
    }

    async fn run(
        &self,
        context: &P4Context,
        operation_id: &str,
        command: &str,
        args: Vec<String>,
        app: Option<&AppHandle>,
    ) -> Result<OperationResult, String> {
        self.run_with_timeout(
            context,
            operation_id,
            command,
            args,
            crate::p4::bounds::IoBound::Read,
            app,
        )
        .await
    }

    async fn run_with_timeout(
        &self,
        context: &P4Context,
        operation_id: &str,
        command: &str,
        args: Vec<String>,
        bound: crate::p4::bounds::IoBound,
        app: Option<&AppHandle>,
    ) -> Result<OperationResult, String> {
        let result = self
            .runner
            .run(
                P4CommandRequest {
                    bound,
                    operation_id: Some(operation_id.into()),
                    source: OperationSource::Gui,
                    command: command.into(),
                    args,
                    context: context.clone(),
                    output_mode: OutputMode::JsonLines,
                    timeout_ms: None,
                    input: None,
                },
                app,
            )
            .await
            .map_err(|error| error.to_string())?;
        if result.exit_code == 0 {
            Ok(result)
        } else {
            Err(result
                .events
                .iter()
                .filter_map(|event| event.message.as_deref())
                .collect::<Vec<_>>()
                .join("\n"))
        }
    }
}

pub fn item_for_submitted(change: ChangelistSummary, needle: &str) -> Option<GlobalSearchItem> {
    let title = format!("CL {}", change.id);
    let jobs = change.jobs.join(" ");
    let fields = [
        ("title", title.as_str()),
        ("description", change.description.as_str()),
        ("user", change.user.as_str()),
        ("client", change.client.as_str()),
        ("jobs", jobs.as_str()),
    ];
    match_fields(needle, &fields).map(|(matched_fields, highlights, rank)| GlobalSearchItem {
        identity: format!("submitted-change:{}", change.id),
        kind: GlobalSearchKind::SubmittedChange,
        title,
        summary: format!(
            "{} · {} · {}",
            change.description, change.user, change.client
        ),
        target: GlobalSearchTarget::SubmittedChange {
            change_id: change.id,
        },
        matched_fields,
        highlights,
        rank,
    })
}

pub(crate) fn match_fields(
    needle: &str,
    fields: &[(&'static str, &str)],
) -> Option<(Vec<String>, Vec<GlobalSearchHighlight>, u8)> {
    let mut matched_fields = Vec::new();
    let mut highlights = Vec::new();
    let mut rank = u8::MAX;
    for (field, value) in fields {
        if let Some((start, end)) = find_utf16(value, needle) {
            matched_fields.push((*field).into());
            highlights.push(GlobalSearchHighlight {
                field: (*field).into(),
                start,
                end,
            });
            let value_trimmed = value.trim();
            let field_rank = if value_trimmed == needle {
                0
            } else if value_trimmed.starts_with(needle) {
                1
            } else {
                2
            };
            rank = rank.min(field_rank);
        }
    }
    (!matched_fields.is_empty()).then_some((matched_fields, highlights, rank))
}

fn find_utf16(value: &str, needle: &str) -> Option<(usize, usize)> {
    let byte_start = value.find(needle).or_else(|| {
        if needle.is_ascii() {
            value
                .to_ascii_lowercase()
                .find(&needle.to_ascii_lowercase())
        } else {
            None
        }
    })?;
    let byte_end = byte_start + needle.len();
    if !value.is_char_boundary(byte_end) {
        return None;
    }
    Some((
        value[..byte_start].encode_utf16().count(),
        value[..byte_end].encode_utf16().count(),
    ))
}

fn json_values(result: &OperationResult) -> Vec<Value> {
    result
        .events
        .iter()
        .filter_map(|event| event.message.as_deref())
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .filter(Value::is_object)
        .filter(|value| value.get("code").and_then(Value::as_str) != Some("error"))
        .collect()
}

fn string_field(value: &Value, names: &[&str]) -> Option<String> {
    names
        .iter()
        .find_map(|name| value.get(*name).and_then(Value::as_str))
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

#[derive(Default)]
struct ShelfFiles {
    paths: Vec<String>,
    truncated: bool,
}

fn number_field(value: &Value, names: &[&str]) -> Option<i64> {
    names.iter().find_map(|name| {
        value.get(*name).and_then(|field| {
            field
                .as_i64()
                .or_else(|| field.as_str().and_then(|raw| raw.parse().ok()))
        })
    })
}

fn indexed_strings(value: &Value, prefix: &str) -> Vec<String> {
    (0..)
        .map_while(|index| {
            value
                .get(format!("{prefix}{index}"))
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matching_uses_utf16_ranges_and_accepts_literal_special_characters() {
        let fields = [("title", "你好😀 [asset].txt")];
        let (_, highlights, rank) = match_fields("[asset]", &fields).unwrap();
        assert_eq!(rank, 2);
        assert_eq!(highlights[0].start, 5);
        assert_eq!(highlights[0].end, 12);
    }

    #[test]
    fn shelf_detail_parser_keeps_order_unicode_and_numeric_change_ids() {
        let value = serde_json::json!({
            "change": "42",
            "depotFile0": "//depot/空 格.txt",
            "depotFile1": "//depot/emoji😀.uasset"
        });
        assert_eq!(number_field(&value, &["change"]), Some(42));
        assert_eq!(
            indexed_strings(&value, "depotFile"),
            vec!["//depot/空 格.txt", "//depot/emoji😀.uasset"]
        );
        assert!(find_utf16("//depot/emoji😀.uasset", "😀").is_some());
    }

    #[test]
    fn shelf_deep_search_limits_are_bounded_and_batch_consistent() {
        assert_eq!(SHELF_SCAN_LIMIT, 500);
        assert_eq!(SHELF_DETAIL_CANDIDATE_LIMIT, 128);
        assert_eq!(SHELF_DETAIL_BATCH_SIZE * SHELF_DETAIL_COMMAND_LIMIT, 128);
        assert_eq!(SHELF_FILE_LIMIT_PER_CHANGE, 256);
        assert_eq!(SHELF_TOTAL_FILE_LIMIT, 20_000);
        assert_eq!(SHELF_DEEP_SEARCH_BUDGET_MS, 20_000);
    }
}
