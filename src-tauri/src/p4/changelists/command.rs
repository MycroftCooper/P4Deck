use crate::domain::{ClAction, ClQuery};
use chrono::DateTime;

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

pub fn action_invocation(action: ClAction) -> ActionInvocation {
    let (command, args, input, affected_changes, warnings) = match action {
        ClAction::Create { description } => (
            "change",
            vec!["-i".into()],
            Some(format!("Change: new\nDescription:\n\t{}\n", description)),
            vec![],
            vec![],
        ),
        ClAction::Edit {
            change_id,
            description,
            jobs,
        } => (
            "change",
            vec!["-i".into()],
            Some(format!(
                "Change: {}\nDescription:\n\t{}\nJobs:\n{}",
                change_id,
                description,
                jobs.iter()
                    .map(|job| format!("\t{}\n", job))
                    .collect::<String>()
            )),
            vec![change_id],
            vec![],
        ),
        ClAction::Delete { change_id } => (
            "change",
            vec!["-d".into(), change_id.to_string()],
            None,
            vec![change_id],
            vec![],
        ),
        ClAction::MoveFiles {
            change_id,
            depot_paths,
        } => {
            let mut args = vec!["-c".into(), change_id.to_string()];
            args.extend(depot_paths);
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
    ActionInvocation {
        invocation: P4Invocation {
            command,
            args,
            input,
        },
        affected_changes,
        warnings,
    }
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
        });
        assert_eq!(action.invocation.command, "reopen");
        assert_eq!(action.invocation.args, vec!["-c", "42", "//depot/a b.txt"]);
    }
}
