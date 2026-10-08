use crate::domain::P4Context;

pub struct SubmitInvocation {
    pub command: &'static str,
    pub args: Vec<String>,
    pub argument_input: Option<Vec<String>>,
}

const INLINE_PATH_LIMIT: usize = 128;
const INLINE_ARGUMENT_BYTES: usize = 24 * 1024;
const FSTAT_FIELDS: &str =
    "depotFile,action,change,headRev,haveRev,type,headType,unresolved,otherOpen,otherLock,ourLock";

pub fn fstat(paths: &[String]) -> Result<SubmitInvocation, String> {
    scoped_paths("fstat", vec!["-T".into(), FSTAT_FIELDS.into()], paths)
}

pub fn protects(paths: &[String]) -> Result<SubmitInvocation, String> {
    scoped_paths("protects", vec!["-M".into()], paths)
}

pub fn job(job: &str) -> Result<SubmitInvocation, String> {
    if job.trim().is_empty()
        || job.len() > 1024
        || job.chars().any(char::is_whitespace)
        || job.chars().any(char::is_control)
    {
        return Err("job IDs must be non-empty single-line tokens".into());
    }
    Ok(SubmitInvocation {
        command: "jobs",
        args: vec!["-e".into(), format!("Job={job}"), "-m".into(), "2".into()],
        argument_input: None,
    })
}

pub fn submit(change_id: i64) -> Result<SubmitInvocation, String> {
    ensure_numbered_change(change_id)?;
    Ok(SubmitInvocation {
        command: "submit",
        args: vec!["-c".into(), change_id.to_string()],
        argument_input: None,
    })
}

pub fn ensure_context(context: &P4Context) -> Result<(), String> {
    if context.server.trim().is_empty()
        || context.user.trim().is_empty()
        || context.client.trim().is_empty()
        || context.cwd.as_deref().unwrap_or_default().trim().is_empty()
    {
        return Err("submit requires server, user, client and workspace root".into());
    }
    Ok(())
}

fn scoped_paths(
    command: &'static str,
    mut args: Vec<String>,
    paths: &[String],
) -> Result<SubmitInvocation, String> {
    let paths = validate_paths(paths)?;
    let stream = paths.len() > INLINE_PATH_LIMIT
        || paths.iter().map(|path| path.len() + 1).sum::<usize>() > INLINE_ARGUMENT_BYTES;
    let argument_input = stream.then_some(paths.clone());
    if !stream {
        args.extend(paths);
    }
    Ok(SubmitInvocation {
        command,
        args,
        argument_input,
    })
}

fn validate_paths(paths: &[String]) -> Result<Vec<String>, String> {
    if paths.is_empty() {
        return Err("submit inspection requires at least one depot path".into());
    }
    let mut paths = paths.to_vec();
    paths.sort();
    paths.dedup();
    if paths.iter().any(|path| {
        !path.starts_with("//") || path.len() > 4096 || path.contains(['\r', '\n', '\0'])
    }) {
        return Err("submit inspection contains an invalid depot path".into());
    }
    Ok(paths)
}

fn ensure_numbered_change(change_id: i64) -> Result<(), String> {
    if change_id <= 0 {
        Err("submit requires a numbered pending changelist".into())
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn submit_is_always_one_numbered_changelist_without_parallelism() {
        let invocation = submit(42).unwrap();
        assert_eq!(invocation.command, "submit");
        assert_eq!(invocation.args, ["-c", "42"]);
        assert!(invocation.argument_input.is_none());
        assert!(submit(0).is_err());
    }

    #[test]
    fn large_preflight_path_sets_use_bounded_stdin() {
        let paths = (0..129)
            .map(|index| format!("//depot/main/{index}.txt"))
            .collect::<Vec<_>>();
        let invocation = fstat(&paths).unwrap();
        assert_eq!(invocation.args, ["-T", FSTAT_FIELDS]);
        assert_eq!(invocation.argument_input.unwrap().len(), 129);
    }
}
