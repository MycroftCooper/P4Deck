use crate::domain::{P4Context, ResolveStrategy, ShelfMode};

pub struct Invocation {
    pub command: &'static str,
    pub args: Vec<String>,
    pub argument_input: Option<Vec<String>>,
}

const FSTAT_FIELDS: &str = "depotFile,clientFile,path,action,change,haveRev,headRev,type,headType,digest,fileSize,modTime,unresolved,otherOpen,otherLock,ourLock,shelved,shelvedChange,shelvedDigest,shelvedSize,shelvedType";
const INLINE_PATH_LIMIT: usize = 128;
const INLINE_ARGUMENT_BYTES: usize = 24 * 1024;

pub fn ensure_context(context: &P4Context) -> Result<(), String> {
    if context.server.trim().is_empty()
        || context.user.trim().is_empty()
        || context.client.trim().is_empty()
        || context.cwd.as_deref().unwrap_or_default().trim().is_empty()
    {
        return Err("workflow requires server, user, client and workspace root".into());
    }
    Ok(())
}

pub fn fstat(paths: &[String], shelved_change: Option<i64>) -> Result<Invocation, String> {
    // `-Ol` is required for server-computed content digest/file size, including with
    // `-Rs -e <shelf>`. The explicit path scope keeps the potentially expensive digest bounded.
    let mut args = vec!["-Ol".into(), "-T".into(), FSTAT_FIELDS.into()];
    if let Some(change) = shelved_change {
        ensure_numbered(change)?;
        args.extend(["-Rs".into(), "-e".into(), change.to_string()]);
    }
    scoped("fstat", args, paths)
}

pub fn describe_shelf(change: i64) -> Result<Invocation, String> {
    ensure_numbered(change)?;
    Ok(Invocation {
        command: "describe",
        args: vec!["-s".into(), "-S".into(), change.to_string()],
        argument_input: None,
    })
}

pub fn reopen(change: i64, path: &str) -> Result<Invocation, String> {
    if change < 0 {
        return Err("target changelist must be Default (0) or numbered".into());
    }
    let target = if change == 0 {
        "default".into()
    } else {
        change.to_string()
    };
    scoped("reopen", vec!["-c".into(), target], &[path.to_owned()])
}

pub fn protects(paths: &[String]) -> Result<Invocation, String> {
    scoped("protects", vec!["-M".into()], paths)
}

pub fn where_paths(paths: &[String]) -> Result<Invocation, String> {
    scoped("where", Vec::new(), paths)
}

pub fn modified_paths(paths: &[String], opened: bool) -> Result<Invocation, String> {
    scoped(
        "diff",
        vec![if opened { "-sa".into() } else { "-se".into() }],
        paths,
    )
}

pub fn client_spec(client: &str) -> Result<Invocation, String> {
    validate_name(client, "workspace")?;
    Ok(Invocation {
        command: "client",
        args: vec!["-o".into(), client.into()],
        argument_input: None,
    })
}

pub fn shelf(
    change: i64,
    paths: &[String],
    mode: ShelfMode,
    replace: bool,
) -> Result<Invocation, String> {
    ensure_numbered(change)?;
    let mut args = match mode {
        ShelfMode::CreateOrUpdate => vec!["-c".into(), change.to_string()],
        ShelfMode::Delete => vec!["-d".into(), "-c".into(), change.to_string()],
    };
    if matches!(mode, ShelfMode::CreateOrUpdate) && replace {
        // `-r` replaces the entire shelf and does not accept a file subset. `-f` is the
        // server-supported way to overwrite only the explicitly selected shelved files.
        args.push("-f".into());
    }
    scoped("shelve", args, paths)
}

pub fn unshelve(
    source: i64,
    target: i64,
    paths: &[String],
    preview: bool,
) -> Result<Invocation, String> {
    ensure_numbered(source)?;
    if target < 0 {
        return Err("target changelist must be Default (0) or numbered".into());
    }
    let mut args = Vec::new();
    if preview {
        args.push("-n".into());
    }
    args.extend([
        "-s".into(),
        source.to_string(),
        "-c".into(),
        if target == 0 {
            "default".into()
        } else {
            target.to_string()
        },
    ]);
    scoped("unshelve", args, paths)
}

pub fn resolve_preview(paths: &[String]) -> Result<Invocation, String> {
    scoped("resolve", vec!["-n".into()], paths)
}

pub fn resolve(path: &str, strategy: ResolveStrategy) -> Result<Invocation, String> {
    let flag = match strategy {
        ResolveStrategy::Safe => "-am",
        ResolveStrategy::AcceptYours => "-ay",
        ResolveStrategy::AcceptTheirs => "-at",
        ResolveStrategy::MergePreview => {
            return Err("mergePreview is non-mutating and cannot be confirmed".into())
        }
    };
    scoped("resolve", vec![flag.into()], &[path.to_owned()])
}

fn scoped(
    command: &'static str,
    mut args: Vec<String>,
    paths: &[String],
) -> Result<Invocation, String> {
    let paths = validate_paths(paths)?;
    let streamed = paths.len() > INLINE_PATH_LIMIT
        || paths.iter().map(|path| path.len() + 1).sum::<usize>() > INLINE_ARGUMENT_BYTES;
    let argument_input = streamed.then_some(paths.clone());
    if !streamed {
        args.extend(paths);
    }
    Ok(Invocation {
        command,
        args,
        argument_input,
    })
}

pub fn validate_paths(paths: &[String]) -> Result<Vec<String>, String> {
    if paths.is_empty() {
        return Err("at least one explicit depot path is required".into());
    }
    let mut paths = paths.to_vec();
    paths.sort();
    paths.dedup();
    if paths.iter().any(|path| {
        !path.starts_with("//") || path.len() > 4096 || path.contains(['\r', '\n', '\0'])
    }) {
        return Err("workflow contains an invalid depot path".into());
    }
    Ok(paths)
}

fn ensure_numbered(change: i64) -> Result<(), String> {
    (change > 0)
        .then_some(())
        .ok_or_else(|| "a numbered pending changelist is required".into())
}

fn validate_name(value: &str, label: &str) -> Result<(), String> {
    if value.trim().is_empty()
        || value.len() > 1024
        || value.chars().any(char::is_whitespace)
        || value.chars().any(char::is_control)
    {
        Err(format!("invalid {label}"))
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explicit_scopes_and_safe_flags_are_preserved() {
        let paths = vec!["//depot/a b.txt".into()];
        assert_eq!(
            shelf(7, &paths, ShelfMode::CreateOrUpdate, true)
                .unwrap()
                .args,
            ["-c", "7", "-f", "//depot/a b.txt"]
        );
        assert_eq!(unshelve(7, 0, &paths, true).unwrap().args[0], "-n");
        assert!(resolve("//depot/a", ResolveStrategy::MergePreview).is_err());
        assert_eq!(
            reopen(0, "//depot/a b#@%.txt").unwrap().args,
            ["-c", "default", "//depot/a b#@%.txt"]
        );
        assert_eq!(describe_shelf(7).unwrap().args, ["-s", "-S", "7"]);
    }
}
