use crate::{domain::*, p4::runner::P4Runner};
use serde_json::Value;
use std::sync::Arc;
use tauri::AppHandle;

pub const CATEGORY_SCAN_LIMIT: usize = 1_000;

#[derive(Debug)]
pub struct SearchBatch {
    pub items: Vec<GlobalSearchItem>,
    pub scanned: usize,
    pub partial: bool,
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
                        identity: format!("file:{path}"),
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
                        identity: depot.as_ref().map_or_else(
                            || format!("workspace-file:{absolute}"),
                            |path| format!("file:{path}"),
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
        })
    }

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
        let result = self
            .runner
            .run(
                P4CommandRequest {
                    operation_id: Some(operation_id.into()),
                    source: OperationSource::Gui,
                    command: command.into(),
                    args,
                    context: context.clone(),
                    output_mode: OutputMode::JsonLines,
                    timeout_ms: Some(30_000),
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

fn match_fields(
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
}
