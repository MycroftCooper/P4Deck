use crate::domain::{P4Context, ResolveStrategy, ShelfMode};

pub struct Invocation {
    pub command: &'static str,
    pub args: Vec<String>,
    pub argument_input: Option<Vec<String>>,
}

const FSTAT_FIELDS: &str = "depotFile,clientFile,path,action,change,haveRev,headRev,type,headType,digest,fileSize,modTime,unresolved,resolved,otherOpen,otherLock,ourLock,shelved,shelvedChange,shelvedDigest,shelvedSize,shelvedType";
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

/// Opened-state evidence for exact paths; `-Mj` records which paths are still
/// open and reports the rest as "file(s) not opened on this client".
pub fn opened(paths: &[String]) -> Result<Invocation, String> {
    scoped("opened", Vec::new(), paths)
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

pub fn reopen_batch(change: i64, paths: &[String]) -> Result<Invocation, String> {
    if !(0..=9_007_199_254_740_991).contains(&change) {
        return Err("Invalid target CL".into());
    }
    validate_exact_paths(paths)?;
    if paths.len() > 128 || paths.iter().map(|p| p.len() + 1).sum::<usize>() > 24 * 1024 {
        return Err("Reopen batch exceeds explicit inline limits".into());
    }
    scoped(
        "reopen",
        vec![
            "-c".into(),
            if change == 0 {
                "default".into()
            } else {
                change.to_string()
            },
        ],
        paths,
    )
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
    validate_exact_paths(paths)?;
    let mut args = match mode {
        ShelfMode::CreateOrUpdate => vec!["-c".into(), change.to_string()],
        ShelfMode::Delete => vec!["-d".into(), "-c".into(), change.to_string()],
    };
    if matches!(mode, ShelfMode::CreateOrUpdate) && replace {
        // `-r` replaces the entire shelf and does not accept a file subset. `-f` is the
        // server-supported way to overwrite only the explicitly selected shelved files.
        args.push("-f".into());
    }
    args.insert(0, "-Af".into());
    scoped("shelve", args, paths)
}

pub fn unshelve(
    source: i64,
    target: i64,
    paths: &[String],
    preview: bool,
) -> Result<Invocation, String> {
    ensure_numbered(source)?;
    validate_exact_paths(paths)?;
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
    args.push("-Af".into());
    scoped("unshelve", args, paths)
}

pub fn resolve_preview(paths: &[String], force: bool) -> Result<Invocation, String> {
    // `-o` asks the server for the authoritative base revision used by this
    // resolve record. Manual merge must never infer that revision from have/head.
    // `-f` additionally allows records that are already resolved (not submitted).
    let args = if force {
        vec!["-f".into(), "-n".into(), "-o".into()]
    } else {
        vec!["-n".into(), "-o".into()]
    };
    scoped("resolve", args, paths)
}

/// Interactive resolve target. The caller supplies `s` on stdin, so the file
/// is skipped and never modified; the only purpose is P4's own chunk summary.
/// `force` re-opens already resolved records so their chunk summary is available.
pub fn resolve_interactive(path: &str, force: bool) -> Result<Invocation, String> {
    let args = if force { vec!["-f".into()] } else { Vec::new() };
    scoped("resolve", args, &[path.to_owned()])
}

pub fn print_to(spec: &str, output: &str) -> Result<Invocation, String> {
    let valid_revision = spec
        .rsplit_once('#')
        .filter(|(path, _)| {
            path.starts_with("//") && !path.contains(['#', '@', '\r', '\n']) && !path.ends_with('/')
        })
        .and_then(|(_, revision)| revision.parse::<i64>().ok())
        .is_some_and(|revision| revision > 0);
    if !valid_revision {
        return Err("manual merge source must be an explicit depot revision".into());
    }
    if output.trim().is_empty() || output.contains(['\r', '\n']) {
        return Err("manual merge output path is invalid".into());
    }
    Ok(Invocation {
        command: "print",
        args: vec!["-q".into(), "-o".into(), output.into(), spec.into()],
        argument_input: None,
    })
}

pub fn resolve(path: &str, strategy: ResolveStrategy, force: bool) -> Result<Invocation, String> {
    let flag = match strategy {
        ResolveStrategy::Safe => "-am",
        ResolveStrategy::AcceptYours => "-ay",
        ResolveStrategy::AcceptTheirs => "-at",
        ResolveStrategy::MergePreview => {
            return Err("mergePreview is non-mutating and cannot be confirmed".into())
        }
    };
    let mut args = Vec::new();
    if force {
        args.push("-f".into());
    }
    args.push(flag.into());
    scoped("resolve", args, &[path.to_owned()])
}

/// `p4 filelog -m 1 -t <depot>#<rev>`: latest revision metadata for one file.
pub fn filelog_revision(depot_path: &str, revision: i64) -> Result<Invocation, String> {
    if !depot_path.starts_with("//")
        || depot_path.len() > 4096
        || depot_path.ends_with('/')
        || depot_path.contains(['#', '@', '*', '\r', '\n', '\0'])
    {
        return Err("filelog requires an explicit depot file path".into());
    }
    if revision <= 0 {
        return Err("filelog requires an explicit positive revision".into());
    }
    Ok(Invocation {
        command: "filelog",
        args: vec![
            "-m".into(),
            "1".into(),
            "-t".into(),
            format!("{depot_path}#{revision}"),
        ],
        argument_input: None,
    })
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

pub fn validate_exact_paths(paths: &[String]) -> Result<Vec<String>, String> {
    let paths = validate_paths(paths)?;
    if paths
        .iter()
        .any(|path| path.contains(['*', '#', '@']) || path.contains("...") || path.ends_with('/'))
    {
        return Err("shelf operations require exact escaped depot file paths, without wildcards or revision selectors".into());
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
    fn shelf_i01_exact_file_scope_and_streaming() {
        let paths = vec!["//depot/b".into(), "//depot/a".into(), "//depot/b".into()];
        assert_eq!(
            shelf(7, &paths, ShelfMode::Delete, false).unwrap().args,
            ["-Af", "-d", "-c", "7", "//depot/a", "//depot/b"]
        );
        assert_eq!(
            unshelve(7, 9, &paths, false).unwrap().args,
            ["-s", "7", "-c", "9", "-Af", "//depot/a", "//depot/b"]
        );
        let many: Vec<_> = (0..140).map(|n| format!("//depot/file{n:03}")).collect();
        let streamed = shelf(7, &many, ShelfMode::Delete, false).unwrap();
        assert_eq!(streamed.argument_input, Some(many));
        assert_eq!(streamed.args, ["-Af", "-d", "-c", "7"]);
    }

    #[test]
    fn shelf_i01_rejects_empty_patterns_and_revision_ranges() {
        assert!(shelf(7, &[], ShelfMode::Delete, false).is_err());
        for path in [
            "//depot/...",
            "//depot/*",
            "//depot/a#1",
            "//depot/a@7",
            "//depot/",
        ] {
            let paths = vec![path.into()];
            assert!(shelf(7, &paths, ShelfMode::Delete, false).is_err());
            assert!(unshelve(7, 0, &paths, true).is_err());
            assert!(unshelve(7, 0, &paths, false).is_err());
        }
        assert!(shelf(
            7,
            &["//depot/a%23%40%2A b".into()],
            ShelfMode::Delete,
            false
        )
        .is_ok());
        assert!(unshelve(0, 9, &["//depot/a".into()], false).is_err());
    }
    #[test]
    fn explicit_scopes_and_safe_flags_are_preserved() {
        let paths = vec!["//depot/a b.txt".into()];
        assert_eq!(
            shelf(7, &paths, ShelfMode::CreateOrUpdate, true)
                .unwrap()
                .args,
            ["-Af", "-c", "7", "-f", "//depot/a b.txt"]
        );
        assert_eq!(unshelve(7, 0, &paths, true).unwrap().args[0], "-n");
        assert!(resolve("//depot/a", ResolveStrategy::MergePreview, false).is_err());
        assert_eq!(
            resolve("//depot/a", ResolveStrategy::AcceptYours, false)
                .unwrap()
                .args,
            ["-ay", "//depot/a"]
        );
        assert_eq!(
            resolve("//depot/a", ResolveStrategy::Safe, true)
                .unwrap()
                .args,
            ["-f", "-am", "//depot/a"]
        );
        assert_eq!(
            resolve_preview(&["//depot/a".into()], false).unwrap().args,
            ["-n", "-o", "//depot/a"]
        );
        assert_eq!(
            resolve_preview(&["//depot/a".into()], true).unwrap().args,
            ["-f", "-n", "-o", "//depot/a"]
        );
        assert_eq!(
            resolve_interactive("//depot/a", false).unwrap().args,
            ["//depot/a"]
        );
        assert_eq!(
            resolve_interactive("//depot/a", true).unwrap().args,
            ["-f", "//depot/a"]
        );
        assert_eq!(
            reopen(0, "//depot/a b#@%.txt").unwrap().args,
            ["-c", "default", "//depot/a b#@%.txt"]
        );
        assert_eq!(describe_shelf(7).unwrap().args, ["-s", "-S", "7"]);
        assert_eq!(
            print_to("//depot/a b.txt#3", "C:\\merge\\base")
                .unwrap()
                .args,
            ["-q", "-o", "C:\\merge\\base", "//depot/a b.txt#3"]
        );
        for invalid in [
            "//depot/a",
            "//depot/a#0",
            "//depot/a#head",
            "//depot/a#3#4",
            "//depot/a@7#3",
        ] {
            assert!(print_to(invalid, "out").is_err(), "accepted {invalid}");
        }
        assert_eq!(
            filelog_revision("//depot/a b.txt", 3).unwrap().args,
            ["-m", "1", "-t", "//depot/a b.txt#3"]
        );
        for (path, revision) in [
            ("depot/a", 3),
            ("//depot/a#2", 3),
            ("//depot/a", 0),
            ("//depot/", 3),
        ] {
            assert!(
                filelog_revision(path, revision).is_err(),
                "accepted {path}#{revision}"
            );
        }
    }
}
