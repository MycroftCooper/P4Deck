use crate::domain::{ClAction, ClQuery, P4Context, PendingChangeMutation};
use chrono::DateTime;
use std::collections::HashSet;

pub struct P4Invocation {
    pub command: &'static str,
    pub args: Vec<String>,
    pub input: Option<String>,
}

pub struct ActionInvocation {
    pub invocation: P4Invocation,
    pub affected_changes: Vec<i64>,
    pub warnings: Vec<String>,
}

pub struct PendingMutationInvocation {
    pub invocation: P4Invocation,
    pub affected_changes: Vec<i64>,
    pub affected_paths: Vec<String>,
}

pub fn query_invocation(
    query: &ClQuery,
    max_results: usize,
    upper_change_id: Option<i64>,
) -> Result<P4Invocation, String> {
    if max_results == 0 || max_results > 1_000 {
        return Err("submitted query batch size must be between 1 and 1000".into());
    }
    let mut args = vec![
        "-L".into(),
        "-t".into(),
        "-s".into(),
        "submitted".into(),
        "-m".into(),
        max_results.to_string(),
    ];
    if query.users.len() == 1 {
        args.extend(["-u".into(), validate_filter_token(&query.users[0], "user")?]);
    }
    if query.clients.len() == 1 {
        args.extend([
            "-c".into(),
            validate_filter_token(&query.clients[0], "client")?,
        ]);
    }
    let scope = query_scope(query)?;
    let from = p4_date(&query.from)?;
    let upper = match upper_change_id {
        Some(change_id) if change_id > 0 => format!("@{change_id}"),
        Some(_) => return Err("cursor change boundary must be positive".into()),
        None => p4_date(&query.to)?,
    };
    args.push(format!("{scope}@{from},{upper}"));
    Ok(P4Invocation {
        command: "changes",
        args,
        input: None,
    })
}

pub fn query_describe_invocation(change_ids: &[i64]) -> Result<P4Invocation, String> {
    if change_ids.is_empty() || change_ids.len() > 100 {
        return Err("submitted metadata batches must contain 1 to 100 changelists".into());
    }
    let mut args = vec!["-s".into(), "-m".into(), "64".into()];
    for change_id in change_ids {
        ensure_numbered_change(*change_id)?;
        args.push(change_id.to_string());
    }
    Ok(P4Invocation {
        command: "describe",
        args,
        input: None,
    })
}

pub fn job_fixes_invocation(job: &str, max_results: usize) -> Result<P4Invocation, String> {
    if max_results == 0 || max_results > 5_001 {
        return Err("job fix query limit must be between 1 and 5001".into());
    }
    let job = validate_jobs(&[job.to_owned()])?
        .into_iter()
        .next()
        .ok_or("a job ID is required")?;
    Ok(P4Invocation {
        command: "fixes",
        args: vec!["-j".into(), job, "-m".into(), max_results.to_string()],
        input: None,
    })
}

pub fn action_invocation(action: ClAction) -> Result<ActionInvocation, String> {
    let (command, args, input, affected_changes, warnings) = match action {
        ClAction::Create { description } => {
            let input = change_form(None, &description, &[])?;
            ("change", vec!["-i".into()], Some(input), vec![], vec![])
        }
        ClAction::Edit {
            change_id,
            description,
            jobs,
        } => {
            ensure_numbered_change(change_id)?;
            let input = change_form(Some(change_id), &description, &jobs)?;
            (
                "change",
                vec!["-i".into()],
                Some(input),
                vec![change_id],
                vec![],
            )
        }
        ClAction::Delete { change_id } => {
            ensure_numbered_change(change_id)?;
            (
                "change",
                vec!["-d".into(), change_id.to_string()],
                None,
                vec![change_id],
                vec![],
            )
        }
        ClAction::MoveFiles {
            change_id,
            depot_paths,
        } => {
            if change_id < 0 {
                return Err("target changelist must be Default (0) or numbered".into());
            }
            let mut args = vec![
                "-c".into(),
                if change_id == 0 {
                    "default".into()
                } else {
                    change_id.to_string()
                },
            ];
            args.extend(validate_paths(&depot_paths)?);
            ("reopen", args, None, vec![change_id], vec![])
        }
        ClAction::SubmitValidate { change_id } => (
            "opened",
            vec!["-c".into(), change_id.to_string()],
            None,
            vec![change_id],
            vec![
                "Validation checks opened files; submit remains a separate confirmed action."
                    .into(),
            ],
        ),
    };
    Ok(ActionInvocation {
        invocation: P4Invocation {
            command,
            args,
            input,
        },
        affected_changes,
        warnings,
    })
}

pub fn pending_changes_invocation(context: &P4Context) -> Result<P4Invocation, String> {
    ensure_scope(context)?;
    Ok(P4Invocation {
        command: "changes",
        args: vec![
            "-s".into(),
            "pending".into(),
            "-u".into(),
            context.user.clone(),
            "-c".into(),
            context.client.clone(),
            "-l".into(),
        ],
        input: None,
    })
}

pub fn opened_invocation(context: &P4Context) -> Result<P4Invocation, String> {
    ensure_scope(context)?;
    Ok(P4Invocation {
        command: "opened",
        args: vec![
            "-a".into(),
            "-u".into(),
            context.user.clone(),
            "-C".into(),
            context.client.clone(),
        ],
        input: None,
    })
}

pub fn shelved_changes_invocation(context: &P4Context) -> Result<P4Invocation, String> {
    ensure_scope(context)?;
    Ok(P4Invocation {
        command: "changes",
        args: vec![
            "-s".into(),
            "shelved".into(),
            "-u".into(),
            context.user.clone(),
            "-c".into(),
            context.client.clone(),
            "-l".into(),
        ],
        input: None,
    })
}

pub fn change_spec_invocation(change_id: i64) -> Result<P4Invocation, String> {
    ensure_numbered_change(change_id)?;
    Ok(P4Invocation {
        command: "change",
        args: vec!["-o".into(), change_id.to_string()],
        input: None,
    })
}

pub fn describe_shelves_invocation(change_ids: &[i64]) -> Result<P4Invocation, String> {
    if change_ids.is_empty() {
        return Err("at least one shelved changelist is required".into());
    }
    let mut args = vec!["-s".into(), "-S".into()];
    for change_id in change_ids {
        ensure_numbered_change(*change_id)?;
        args.push(change_id.to_string());
    }
    Ok(P4Invocation {
        command: "describe",
        args,
        input: None,
    })
}

pub fn submitted_detail_invocation(change_id: i64) -> Result<P4Invocation, String> {
    ensure_numbered_change(change_id)?;
    Ok(P4Invocation {
        command: "describe",
        args: vec!["-s".into(), change_id.to_string()],
        input: None,
    })
}

pub fn submitted_filelog_invocation(
    files: &[crate::domain::SubmittedChangeFile],
) -> Result<P4Invocation, String> {
    if files.is_empty() {
        return Err("at least one submitted file is required".into());
    }
    let mut args = vec!["-m".into(), "1".into(), "-i".into()];
    for file in files {
        let path = validate_paths(std::slice::from_ref(&file.depot_path))?
            .into_iter()
            .next()
            .expect("one path was validated");
        let revision = file
            .revision
            .filter(|revision| *revision > 0)
            .ok_or("submitted file revision is required for filelog evidence")?;
        args.push(format!("{path}#{revision}"));
    }
    Ok(P4Invocation {
        command: "filelog",
        args,
        input: None,
    })
}

pub fn where_invocation(depot_paths: &[String]) -> Result<P4Invocation, String> {
    let paths = validate_paths(depot_paths)?;
    Ok(P4Invocation {
        command: "where",
        args: paths,
        input: None,
    })
}

pub fn job_query_invocation(job: &str) -> Result<P4Invocation, String> {
    let jobs = validate_jobs(&[job.to_owned()])?;
    Ok(P4Invocation {
        command: "jobs",
        args: vec![
            "-e".into(),
            format!("Job={}", jobs[0]),
            "-m".into(),
            "2".into(),
        ],
        input: None,
    })
}

pub fn pending_mutation_invocation(
    mutation: &PendingChangeMutation,
) -> Result<PendingMutationInvocation, String> {
    let (command, args, input, affected_changes, affected_paths) = match mutation {
        PendingChangeMutation::Create { description, jobs } => (
            "change",
            vec!["-i".into()],
            Some(change_form(None, description, jobs)?),
            Vec::new(),
            Vec::new(),
        ),
        PendingChangeMutation::Edit {
            change_id,
            description,
            jobs,
        } => {
            ensure_numbered_change(*change_id)?;
            (
                "change",
                vec!["-i".into()],
                Some(change_form(Some(*change_id), description, jobs)?),
                vec![*change_id],
                Vec::new(),
            )
        }
        PendingChangeMutation::Delete { change_id } => {
            ensure_numbered_change(*change_id)?;
            (
                "change",
                vec!["-d".into(), change_id.to_string()],
                None,
                vec![*change_id],
                Vec::new(),
            )
        }
        PendingChangeMutation::MoveFiles {
            target_change_id,
            depot_paths,
        } => {
            if *target_change_id < 0 {
                return Err(
                    "target changelist must be Default (0) or a numbered changelist".into(),
                );
            }
            let paths = validate_paths(depot_paths)?;
            let mut args = vec![
                "-c".into(),
                if *target_change_id == 0 {
                    "default".into()
                } else {
                    target_change_id.to_string()
                },
            ];
            args.extend(paths.clone());
            ("reopen", args, None, vec![*target_change_id], paths)
        }
    };
    Ok(PendingMutationInvocation {
        invocation: P4Invocation {
            command,
            args,
            input,
        },
        affected_changes,
        affected_paths,
    })
}

fn change_form(
    change_id: Option<i64>,
    description: &str,
    jobs: &[String],
) -> Result<String, String> {
    let description = description.replace("\r\n", "\n").replace('\r', "\n");
    if description.trim().is_empty() {
        return Err("changelist description is required".into());
    }
    if description.len() > 1024 * 1024 || description.contains('\0') {
        return Err("changelist description is invalid or too large".into());
    }
    let description = description.trim_end_matches('\n');
    let jobs = validate_jobs(jobs)?;
    let mut form = format!(
        "Change: {}\nDescription:\n",
        change_id.map_or_else(|| "new".into(), |value| value.to_string())
    );
    for line in description.split('\n') {
        form.push('\t');
        form.push_str(line);
        form.push('\n');
    }
    form.push_str("Jobs:\n");
    for job in jobs {
        form.push('\t');
        form.push_str(&job);
        form.push('\n');
    }
    Ok(form)
}

fn validate_jobs(jobs: &[String]) -> Result<Vec<String>, String> {
    let mut seen = HashSet::new();
    let mut validated = Vec::new();
    for raw in jobs {
        let job = raw.trim();
        if job.is_empty()
            || job.len() > 1024
            || job.chars().any(char::is_whitespace)
            || job.chars().any(char::is_control)
        {
            return Err("job IDs must be non-empty single-line tokens".into());
        }
        if seen.insert(job.to_owned()) {
            validated.push(job.to_owned());
        }
    }
    Ok(validated)
}

fn validate_paths(paths: &[String]) -> Result<Vec<String>, String> {
    if paths.is_empty() {
        return Err("at least one depot path is required".into());
    }
    let mut seen = HashSet::new();
    let mut validated = Vec::new();
    for path in paths {
        if !path.starts_with("//") || path.len() > 4096 || path.contains(['\r', '\n', '\0']) {
            return Err(format!("invalid depot path: {path}"));
        }
        if seen.insert(path.clone()) {
            validated.push(path.clone());
        }
    }
    Ok(validated)
}

fn ensure_scope(context: &P4Context) -> Result<(), String> {
    if context.user.trim().is_empty() || context.client.trim().is_empty() {
        return Err("pending changelists require a current user and client".into());
    }
    Ok(())
}

fn ensure_numbered_change(change_id: i64) -> Result<(), String> {
    if change_id <= 0 {
        return Err("a numbered pending changelist is required".into());
    }
    Ok(())
}

fn query_scope(query: &ClQuery) -> Result<String, String> {
    let depot_path = query
        .depot_path
        .as_deref()
        .map(validate_query_path)
        .transpose()?;
    let stream = query.stream.as_deref().map(validate_stream).transpose()?;
    match (depot_path, stream) {
        (Some(path), Some(stream)) => {
            let prefix = format!("{}/", stream.trim_end_matches('/'));
            if path != stream && !path.starts_with(&prefix) {
                return Err("depot path must be inside the selected stream".into());
            }
            Ok(path)
        }
        (Some(path), None) => Ok(path),
        (None, Some(stream)) => Ok(format!("{}/...", stream.trim_end_matches('/'))),
        (None, None) => Ok("//...".into()),
    }
}

fn validate_query_path(value: &str) -> Result<String, String> {
    let value = value.trim();
    if !value.starts_with("//")
        || value.len() > 4096
        || value.contains(['\r', '\n', '\0', '@', '#'])
    {
        return Err("invalid submitted depot path".into());
    }
    Ok(value.into())
}

fn validate_stream(value: &str) -> Result<String, String> {
    let value = value.trim().trim_end_matches('/');
    if !value.starts_with("//")
        || value.len() > 1024
        || value.contains(['\r', '\n', '\0', '@', '#'])
        || value.contains('*')
    {
        return Err("invalid submitted stream".into());
    }
    Ok(value.into())
}

fn validate_filter_token(value: &str, name: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty()
        || value.len() > 1024
        || value.chars().any(char::is_control)
        || value.chars().any(char::is_whitespace)
    {
        return Err(format!("invalid submitted {name} filter"));
    }
    Ok(value.into())
}

fn p4_date(value: &str) -> Result<String, String> {
    DateTime::parse_from_rfc3339(value)
        .map(|date| date.format("%Y/%m/%d:%H:%M:%S").to_string())
        .map_err(|_| "submitted query dates must be RFC 3339 timestamps".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn submitted_query() -> ClQuery {
        ClQuery {
            operation_id: "query-1".into(),
            request_generation: 1,
            keyword: String::new(),
            users: vec!["张三".into()],
            clients: vec!["工作区".into()],
            depot_path: Some("//depot/项目/...".into()),
            stream: Some("//depot/项目".into()),
            from: "2026-10-01T00:00:00+08:00".into(),
            to: "2026-10-09T23:59:59+08:00".into(),
            jobs: vec!["JOB-1".into()],
            has_job: Some(true),
            merge_classifications: Vec::new(),
            hide_reliable_merges: false,
            page_size: 50,
            cursor: None,
        }
    }

    #[test]
    fn formats_query_dates_for_p4() {
        assert_eq!(
            p4_date("2026-08-03T10:11:12Z").unwrap(),
            "2026/08/03:10:11:12"
        );
        assert!(p4_date("not-a-date").is_err());
    }

    #[test]
    fn submitted_query_uses_argument_arrays_and_a_change_boundary() {
        let invocation = query_invocation(&submitted_query(), 100, Some(42)).unwrap();
        assert_eq!(invocation.command, "changes");
        assert_eq!(
            invocation.args,
            [
                "-L",
                "-t",
                "-s",
                "submitted",
                "-m",
                "100",
                "-u",
                "张三",
                "-c",
                "工作区",
                "//depot/项目/...@2026/10/01:00:00:00,@42",
            ]
        );
        assert_eq!(
            job_fixes_invocation("JOB-1", 5001).unwrap().args,
            ["-j", "JOB-1", "-m", "5001"]
        );
    }

    #[test]
    fn submitted_query_rejects_path_revision_and_invalid_ranges() {
        let mut query = submitted_query();
        query.depot_path = Some("//depot/main/...@evil".into());
        assert!(query_invocation(&query, 100, None).is_err());
        query.depot_path = Some("//other/...".into());
        assert!(query_invocation(&query, 100, None).is_err());
        query.depot_path = Some("//depot/项目/...".into());
        query.from = "invalid".into();
        assert!(query_invocation(&query, 100, None).is_err());
        assert!(query_invocation(&submitted_query(), 0, None).is_err());
        assert!(job_fixes_invocation("JOB-1\n-m 999", 1).is_err());
    }

    #[test]
    fn move_files_uses_reopen_without_shell() {
        let action = action_invocation(ClAction::MoveFiles {
            change_id: 42,
            depot_paths: vec!["//depot/a b.txt".into()],
        })
        .unwrap();
        assert_eq!(action.invocation.command, "reopen");
        assert_eq!(action.invocation.args, vec!["-c", "42", "//depot/a b.txt"]);
    }

    #[test]
    fn indents_every_description_line_and_rejects_job_injection() {
        let prepared = pending_mutation_invocation(&PendingChangeMutation::Create {
            description: "first\nJobs:\nChange: injected".into(),
            jobs: vec!["JOB-1".into()],
        })
        .unwrap();
        assert_eq!(
            prepared.invocation.input.unwrap(),
            "Change: new\nDescription:\n\tfirst\n\tJobs:\n\tChange: injected\nJobs:\n\tJOB-1\n"
        );
        assert!(pending_mutation_invocation(&PendingChangeMutation::Create {
            description: "safe".into(),
            jobs: vec!["JOB-1\nFiles:".into()],
        })
        .is_err());
    }

    #[test]
    fn deserializes_the_pending_mutation_contract() {
        let request: crate::domain::PendingChangeMutationRequest =
            serde_json::from_value(serde_json::json!({
                "operationId": "known-operation",
                "type": "moveFiles",
                "targetChangeId": 0,
                "depotPaths": ["//depot/a b.txt"]
            }))
            .unwrap();
        assert_eq!(request.operation_id.as_deref(), Some("known-operation"));
        let PendingChangeMutation::MoveFiles {
            target_change_id,
            depot_paths,
        } = request.mutation
        else {
            panic!("expected moveFiles");
        };
        assert_eq!(target_change_id, 0);
        assert_eq!(depot_paths, ["//depot/a b.txt"]);

        let legacy: ClAction = serde_json::from_value(serde_json::json!({
            "type": "edit",
            "changeId": 42,
            "description": "safe",
            "jobs": []
        }))
        .unwrap();
        assert!(matches!(legacy, ClAction::Edit { change_id: 42, .. }));
    }

    #[test]
    fn submitted_detail_commands_are_bounded_to_explicit_revisions() {
        let describe = submitted_detail_invocation(42).unwrap();
        assert_eq!(describe.command, "describe");
        assert_eq!(describe.args, ["-s", "42"]);
        let filelog = submitted_filelog_invocation(&[crate::domain::SubmittedChangeFile {
            depot_path: "//depot/a b.txt".into(),
            action: "edit".into(),
            revision: Some(3),
            file_type: Some("text".into()),
        }])
        .unwrap();
        assert_eq!(filelog.args, ["-m", "1", "-i", "//depot/a b.txt#3"]);
    }
}
