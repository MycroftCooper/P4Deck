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

pub fn query_invocation(query: &ClQuery) -> P4Invocation {
    let mut args = vec![
        "-L".into(),
        "-t".into(),
        "-m".into(),
        query.limit.min(20_000).to_string(),
    ];
    if query.statuses.len() == 1 {
        args.extend(["-s".into(), query.statuses[0].clone()]);
    }
    for user in &query.users {
        args.extend(["-u".into(), user.clone()]);
    }
    for client in &query.clients {
        args.extend(["-c".into(), client.clone()]);
    }
    let scope = query
        .path
        .clone()
        .or(query
            .stream
            .clone()
            .map(|stream| format!("{}/...", stream.trim_end_matches('/'))))
        .unwrap_or_else(|| "//...".into());
    args.push(format!(
        "{}@{},{}",
        scope,
        p4_date(&query.from),
        p4_date(&query.to)
    ));
    P4Invocation {
        command: "changes",
        args,
        input: None,
    }
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
        ClAction::Shelve {
            change_id,
            depot_paths,
            replace,
        } => {
            let mut args = vec!["-c".into(), change_id.to_string()];
            if replace.unwrap_or(false) {
                args.push("-r".into());
            }
            if let Some(paths) = depot_paths {
                args.extend(paths);
            }
            ("shelve", args, None, vec![change_id], vec![])
        }
        ClAction::DeleteShelf {
            change_id,
            depot_paths,
        } => {
            let mut args = vec!["-d".into(), "-c".into(), change_id.to_string()];
            if let Some(paths) = depot_paths {
                args.extend(paths);
            }
            ("shelve", args, None, vec![change_id], vec![])
        }
        ClAction::UnshelvePreview {
            source_change_id,
            target_change_id,
        } => (
            "unshelve",
            vec![
                "-n".into(),
                "-s".into(),
                source_change_id.to_string(),
                "-c".into(),
                target_change_id.to_string(),
            ],
            None,
            vec![source_change_id, target_change_id],
            vec!["Preview only: no workspace files were changed.".into()],
        ),
        ClAction::Unshelve {
            source_change_id,
            target_change_id,
        } => (
            "unshelve",
            vec![
                "-s".into(),
                source_change_id.to_string(),
                "-c".into(),
                target_change_id.to_string(),
            ],
            None,
            vec![source_change_id, target_change_id],
            vec![],
        ),
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

fn p4_date(value: &str) -> String {
    DateTime::parse_from_rfc3339(value)
        .map(|date| date.format("%Y/%m/%d:%H:%M:%S").to_string())
        .unwrap_or_else(|_| "1970/01/01:00:00:00".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_query_dates_for_p4() {
        assert_eq!(p4_date("2026-08-03T10:11:12Z"), "2026/08/03:10:11:12");
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
}
