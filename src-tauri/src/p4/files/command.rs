use crate::domain::{FileAction, FileActionRequest, OutputMode};
use std::collections::HashSet;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ActionPlan {
    P4(P4FileInvocation),
    DeleteLocal { paths: Vec<String> },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct P4FileInvocation {
    pub command: &'static str,
    pub args: Vec<String>,
    pub argument_input: Option<Vec<String>>,
    pub output_mode: OutputMode,
}

const INLINE_PATH_LIMIT: usize = 128;
const INLINE_ARGUMENT_BYTES: usize = 24 * 1024;

pub fn plan(request: &FileActionRequest) -> Result<ActionPlan, String> {
    validate_parallel(request)?;
    if matches!(request.action, FileAction::Submit) {
        for path in &request.paths {
            validate_path(path)?;
        }
    } else {
        validate_paths(&request.paths)?;
    }

    if matches!(request.action, FileAction::DeleteLocal)
        || (matches!(request.action, FileAction::Delete) && only_untracked(request))
    {
        return Ok(ActionPlan::DeleteLocal {
            paths: request.paths.clone(),
        });
    }

    let mut paths = request.paths.clone();
    let (command, mut args, output_mode) = match request.action {
        FileAction::Refresh => ("fstat", vec!["-Ol".into()], OutputMode::JsonLines),
        FileAction::GetLatest => ("sync", parallel_args(request)?, OutputMode::JsonLines),
        FileAction::GetRevision => {
            let revision = required(&request.revision, "revision")?;
            validate_revision(revision)?;
            paths = paths
                .into_iter()
                .map(|path| format!("{path}{revision}"))
                .collect();
            ("sync", parallel_args(request)?, OutputMode::JsonLines)
        }
        FileAction::RemoveFromWorkspace => {
            paths = paths
                .into_iter()
                .map(|path| format!("{path}#none"))
                .collect();
            ("sync", vec![], OutputMode::JsonLines)
        }
        FileAction::Checkout | FileAction::CheckoutAndOpen => (
            "edit",
            changelist_args(request.changelist_id),
            OutputMode::JsonLines,
        ),
        FileAction::AddRecursive => ("reconcile", vec!["-a".into()], OutputMode::JsonLines),
        FileAction::Add => {
            let mut args = changelist_args(request.changelist_id);
            if let Some(file_type) = &request.file_type {
                validate_file_type(file_type)?;
                args.extend(["-t".into(), file_type.clone()]);
            }
            ("add", args, OutputMode::JsonLines)
        }
        FileAction::Delete | FileAction::MarkForDelete => (
            "delete",
            changelist_args(request.changelist_id),
            OutputMode::JsonLines,
        ),
        FileAction::Submit => {
            let change = required_change(request.changelist_id)?;
            paths.clear();
            let mut args = parallel_args(request)?;
            if change != "default" {
                args.extend(["-c".into(), change]);
            }
            ("submit", args, OutputMode::JsonLines)
        }
        FileAction::RevertUnchanged => ("revert", vec!["-a".into()], OutputMode::JsonLines),
        FileAction::Revert => ("revert", vec![], OutputMode::JsonLines),
        FileAction::MoveToChangelist => {
            let change = required_change(request.changelist_id)?;
            ("reopen", vec!["-c".into(), change], OutputMode::JsonLines)
        }
        FileAction::Resolve => {
            let method = request.resolve_method.as_deref().unwrap_or("am");
            if !["am", "as", "at", "ay", "af", "n"].contains(&method) {
                return Err(format!("unsupported resolve method: {method}"));
            }
            ("resolve", vec![format!("-{method}")], OutputMode::JsonLines)
        }
        FileAction::Reconcile => (
            "reconcile",
            vec!["-e".into(), "-a".into(), "-d".into()],
            OutputMode::JsonLines,
        ),
        FileAction::Shelve => {
            let change = required_numbered_change(request.changelist_id)?;
            let mut args = parallel_args(request)?;
            args.extend(["-c".into(), change.to_string()]);
            ("shelve", args, OutputMode::JsonLines)
        }
        FileAction::ChangeFiletype => {
            let file_type = required(&request.file_type, "fileType")?;
            validate_file_type(file_type)?;
            (
                "reopen",
                vec!["-t".into(), file_type.clone()],
                OutputMode::JsonLines,
            )
        }
        FileAction::Lock => (
            "lock",
            changelist_args(request.changelist_id),
            OutputMode::JsonLines,
        ),
        FileAction::Unlock => (
            "unlock",
            changelist_args(request.changelist_id),
            OutputMode::JsonLines,
        ),
        FileAction::Integrate | FileAction::Branch | FileAction::Copy => {
            if paths.len() != 1 {
                return Err("source action requires exactly one source path".into());
            }
            let target = required(&request.target_path, "targetPath")?;
            validate_path(target)?;
            let command = if matches!(request.action, FileAction::Copy) {
                "copy"
            } else {
                "integrate"
            };
            paths.push(target.clone());
            (
                command,
                changelist_args(request.changelist_id),
                OutputMode::JsonLines,
            )
        }
        FileAction::RenameMove => {
            if paths.len() != 1 {
                return Err("rename/move requires exactly one source path".into());
            }
            let target = required(&request.target_path, "targetPath")?;
            validate_path(target)?;
            paths.push(target.clone());
            (
                "move",
                changelist_args(request.changelist_id),
                OutputMode::JsonLines,
            )
        }
        FileAction::Undo => (
            "undo",
            changelist_args(request.changelist_id),
            OutputMode::JsonLines,
        ),
        FileAction::Clean => ("clean", vec![], OutputMode::JsonLines),
        FileAction::TagWithLabel => {
            let label = required(&request.label, "label")?;
            validate_name(label, "label")?;
            (
                "tag",
                vec!["-l".into(), label.clone()],
                OutputMode::JsonLines,
            )
        }
        FileAction::DeleteLocal => unreachable!(),
    };
    let argument_input = should_stream_paths(request.action, &paths).then(|| paths.clone());
    if argument_input.is_none() {
        args.extend(paths);
    }
    Ok(ActionPlan::P4(P4FileInvocation {
        command,
        args,
        argument_input,
        output_mode,
    }))
}

fn validate_parallel(request: &FileActionRequest) -> Result<(), String> {
    if request.parallel_threads.is_some()
        && !matches!(
            request.action,
            FileAction::GetLatest
                | FileAction::GetRevision
                | FileAction::Shelve
                | FileAction::Submit
        )
    {
        return Err("parallel transfer is only supported for sync, shelve, and submit".into());
    }
    Ok(())
}

fn parallel_args(request: &FileActionRequest) -> Result<Vec<String>, String> {
    let Some(threads) = request.parallel_threads else {
        return Ok(Vec::new());
    };
    if !(2..=4).contains(&threads) {
        return Err("parallelThreads must be between 2 and 4".into());
    }
    Ok(vec![format!("--parallel=threads={threads},batch=8,min=9")])
}

fn should_stream_paths(action: FileAction, paths: &[String]) -> bool {
    if matches!(
        action,
        FileAction::Submit
            | FileAction::Integrate
            | FileAction::Branch
            | FileAction::Copy
            | FileAction::RenameMove
            | FileAction::DeleteLocal
    ) {
        return false;
    }
    paths.len() > INLINE_PATH_LIMIT
        || paths.iter().map(|path| path.len() + 1).sum::<usize>() > INLINE_ARGUMENT_BYTES
}

fn only_untracked(request: &FileActionRequest) -> bool {
    request.states.as_ref().is_some_and(|states| {
        states.len() == request.paths.len() && states.iter().all(|state| state == "untracked")
    })
}

fn changelist_args(change: Option<i64>) -> Vec<String> {
    changelist_name(change)
        .map(|value| vec!["-c".into(), value])
        .unwrap_or_default()
}

fn changelist_name(change: Option<i64>) -> Option<String> {
    change.filter(|value| *value >= 0).map(|value| {
        if value == 0 {
            "default".into()
        } else {
            value.to_string()
        }
    })
}

fn required_change(change: Option<i64>) -> Result<String, String> {
    changelist_name(change).ok_or_else(|| "changelistId is required".into())
}

fn required_numbered_change(change: Option<i64>) -> Result<i64, String> {
    change
        .filter(|value| *value > 0)
        .ok_or_else(|| "a numbered changelistId is required".into())
}

fn required<'a>(value: &'a Option<String>, field: &str) -> Result<&'a String, String> {
    value
        .as_ref()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| format!("{field} is required"))
}

fn validate_paths(paths: &[String]) -> Result<(), String> {
    if paths.is_empty() {
        return Err("at least one path is required".into());
    }
    let mut unique = HashSet::with_capacity(paths.len());
    for path in paths {
        validate_path(path)?;
        if !unique.insert(path) {
            return Err(format!("duplicate file path: {path}"));
        }
    }
    Ok(())
}

fn validate_path(path: &str) -> Result<(), String> {
    if path.trim().is_empty() || path.starts_with('-') || path.contains(['\0', '\r', '\n']) {
        return Err(format!("invalid file path: {path:?}"));
    }
    Ok(())
}

fn validate_revision(revision: &str) -> Result<(), String> {
    let valid_prefix = revision.starts_with('#') || revision.starts_with('@');
    let valid_chars = revision
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || "#@/:-_.,=".contains(c));
    if !valid_prefix || revision.len() < 2 || !valid_chars {
        return Err(format!("invalid revision selector: {revision}"));
    }
    Ok(())
}

fn validate_file_type(file_type: &str) -> Result<(), String> {
    if file_type.is_empty()
        || !file_type
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "+.-".contains(c))
    {
        return Err(format!("invalid file type: {file_type}"));
    }
    Ok(())
}

fn validate_name(value: &str, field: &str) -> Result<(), String> {
    if value.is_empty()
        || value.starts_with('-')
        || !value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c))
    {
        return Err(format!("invalid {field}: {value}"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(action: FileAction) -> FileActionRequest {
        FileActionRequest {
            operation_id: None,
            action,
            paths: vec!["//depot/main/a b.txt".into()],
            revision: None,
            states: None,
            changelist_id: None,
            file_type: None,
            target_path: None,
            resolve_method: None,
            label: None,
            parallel_threads: None,
        }
    }

    fn invocation(request: &FileActionRequest) -> P4FileInvocation {
        match plan(request).unwrap() {
            ActionPlan::P4(value) => value,
            ActionPlan::DeleteLocal { .. } => panic!("expected P4 invocation"),
        }
    }

    #[test]
    fn plans_basic_workspace_actions() {
        let cases = [
            (FileAction::GetLatest, "sync", vec!["//depot/main/a b.txt"]),
            (FileAction::Checkout, "edit", vec!["//depot/main/a b.txt"]),
            (
                FileAction::CheckoutAndOpen,
                "edit",
                vec!["//depot/main/a b.txt"],
            ),
            (
                FileAction::MarkForDelete,
                "delete",
                vec!["//depot/main/a b.txt"],
            ),
            (FileAction::Revert, "revert", vec!["//depot/main/a b.txt"]),
            (FileAction::Lock, "lock", vec!["//depot/main/a b.txt"]),
            (FileAction::Unlock, "unlock", vec!["//depot/main/a b.txt"]),
            (FileAction::Clean, "clean", vec!["//depot/main/a b.txt"]),
        ];
        for (action, command, args) in cases {
            let result = invocation(&request(action));
            assert_eq!(result.command, command);
            assert_eq!(result.args, args);
        }
    }

    #[test]
    fn plans_revision_and_remove_from_workspace_as_filespecs() {
        let mut revision = request(FileAction::GetRevision);
        revision.revision = Some("#42".into());
        assert_eq!(invocation(&revision).args, vec!["//depot/main/a b.txt#42"]);
        assert_eq!(
            invocation(&request(FileAction::RemoveFromWorkspace)).args,
            vec!["//depot/main/a b.txt#none"]
        );
    }

    #[test]
    fn plans_actions_with_changelists() {
        for action in [FileAction::Add, FileAction::Checkout, FileAction::Lock] {
            let mut value = request(action);
            value.changelist_id = Some(123);
            assert_eq!(
                invocation(&value).args,
                vec!["-c", "123", "//depot/main/a b.txt"]
            );
        }
        let mut submit = request(FileAction::Submit);
        submit.changelist_id = Some(123);
        assert_eq!(invocation(&submit).args, vec!["-c", "123"]);

        submit.paths.clear();
        submit.changelist_id = Some(0);
        assert!(invocation(&submit).args.is_empty());

        let mut move_default = request(FileAction::MoveToChangelist);
        move_default.changelist_id = Some(0);
        assert_eq!(
            invocation(&move_default).args,
            vec!["-c", "default", "//depot/main/a b.txt"]
        );
    }

    #[test]
    fn plans_reconcile_resolve_shelve_and_reopen() {
        let add_only = invocation(&request(FileAction::AddRecursive));
        assert_eq!(add_only.command, "reconcile");
        assert_eq!(add_only.args, vec!["-a", "//depot/main/a b.txt"]);
        let reconcile = invocation(&request(FileAction::Reconcile));
        assert_eq!(
            reconcile.args,
            vec!["-e", "-a", "-d", "//depot/main/a b.txt"]
        );

        let mut resolve = request(FileAction::Resolve);
        resolve.resolve_method = Some("at".into());
        assert_eq!(
            invocation(&resolve).args,
            vec!["-at", "//depot/main/a b.txt"]
        );

        let mut shelve = request(FileAction::Shelve);
        shelve.changelist_id = Some(7);
        assert_eq!(
            invocation(&shelve).args,
            vec!["-c", "7", "//depot/main/a b.txt"]
        );
        shelve.changelist_id = Some(0);
        assert!(plan(&shelve).is_err());

        let mut filetype = request(FileAction::ChangeFiletype);
        filetype.file_type = Some("binary+l".into());
        assert_eq!(
            invocation(&filetype).args,
            vec!["-t", "binary+l", "//depot/main/a b.txt"]
        );
    }

    #[test]
    fn plans_two_path_actions_without_splitting_spaces() {
        for (action, command) in [
            (FileAction::Integrate, "integrate"),
            (FileAction::Branch, "integrate"),
            (FileAction::Copy, "copy"),
            (FileAction::RenameMove, "move"),
        ] {
            let mut value = request(action);
            value.target_path = Some("//depot/release/a b.txt".into());
            let result = invocation(&value);
            assert_eq!(result.command, command);
            assert_eq!(
                result.args,
                vec!["//depot/main/a b.txt", "//depot/release/a b.txt"]
            );
        }
    }

    #[test]
    fn plans_undo_and_label() {
        let mut undo = request(FileAction::Undo);
        undo.changelist_id = Some(99);
        assert_eq!(
            invocation(&undo).args,
            vec!["-c", "99", "//depot/main/a b.txt"]
        );

        let mut tag = request(FileAction::TagWithLabel);
        tag.label = Some("release-2026.1".into());
        assert_eq!(
            invocation(&tag).args,
            vec!["-l", "release-2026.1", "//depot/main/a b.txt"]
        );
    }

    #[test]
    fn distinguishes_local_delete_from_p4_delete() {
        let local = request(FileAction::DeleteLocal);
        assert!(matches!(plan(&local), Ok(ActionPlan::DeleteLocal { .. })));

        let mut legacy = request(FileAction::Delete);
        legacy.states = Some(vec!["untracked".into()]);
        assert!(matches!(plan(&legacy), Ok(ActionPlan::DeleteLocal { .. })));
        legacy.states = Some(vec!["controlled".into()]);
        assert_eq!(invocation(&legacy).command, "delete");
    }

    #[test]
    fn rejects_missing_or_option_like_inputs() {
        assert!(plan(&request(FileAction::Submit)).is_err());
        assert!(plan(&request(FileAction::Shelve)).is_err());

        let mut revision = request(FileAction::GetRevision);
        revision.revision = Some("--force".into());
        assert!(plan(&revision).is_err());

        let mut target = request(FileAction::RenameMove);
        target.target_path = Some("-f".into());
        assert!(plan(&target).is_err());

        let mut newline = request(FileAction::Checkout);
        newline.paths = vec!["//depot/main/a\nmalicious".into()];
        assert!(plan(&newline).is_err());

        let mut duplicate = request(FileAction::GetLatest);
        duplicate.paths.push("//depot/main/a b.txt".into());
        assert!(plan(&duplicate).is_err());
    }

    #[test]
    fn streams_large_path_lists_through_batched_stdin() {
        let mut value = request(FileAction::GetLatest);
        value.paths = (0..129)
            .map(|index| format!("//depot/main/file-{index}.txt"))
            .collect();
        let result = invocation(&value);
        assert!(result.args.is_empty());
        assert_eq!(result.argument_input.as_ref().unwrap().len(), 129);

        value.paths = vec![format!(
            "//depot/main/{}",
            "x".repeat(INLINE_ARGUMENT_BYTES)
        )];
        assert!(invocation(&value).argument_input.is_some());
    }

    #[test]
    fn keeps_paired_actions_inline() {
        let mut value = request(FileAction::RenameMove);
        value.paths = vec![format!(
            "//depot/main/{}",
            "x".repeat(INLINE_ARGUMENT_BYTES)
        )];
        value.target_path = Some("//depot/main/target.txt".into());
        let result = invocation(&value);
        assert!(result.argument_input.is_none());
        assert_eq!(result.args.len(), 2);
    }

    #[test]
    fn bounds_native_parallel_transfer_threads() {
        let mut sync = request(FileAction::GetLatest);
        sync.parallel_threads = Some(4);
        assert_eq!(
            invocation(&sync).args,
            vec!["--parallel=threads=4,batch=8,min=9", "//depot/main/a b.txt"]
        );

        sync.parallel_threads = Some(8);
        assert!(plan(&sync).is_err());

        let mut edit = request(FileAction::Checkout);
        edit.parallel_threads = Some(2);
        assert!(plan(&edit).is_err());
    }

    #[test]
    fn deserializes_the_camel_case_ipc_contract() {
        let request: FileActionRequest = serde_json::from_value(serde_json::json!({
            "action": "renameMove",
            "paths": ["//depot/main/source.txt"],
            "targetPath": "//depot/main/target.txt",
            "changelistId": 42
        }))
        .unwrap();

        assert_eq!(request.action, FileAction::RenameMove);
        assert_eq!(
            request.target_path.as_deref(),
            Some("//depot/main/target.txt")
        );
        assert_eq!(request.changelist_id, Some(42));
    }
}
