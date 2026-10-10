use crate::domain::{ForceUnlockOrigin, ForceUnlockOriginMode};
use std::collections::HashSet;

pub const FORCE_UNLOCK_PATH_LIMIT: usize = 128;
const INLINE_PATH_LIMIT: usize = 32;
const INLINE_ARGUMENT_BYTES: usize = 24 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Invocation {
    pub command: &'static str,
    pub args: Vec<String>,
    pub argument_input: Option<Vec<String>>,
}

pub fn validate_origin(origin: &ForceUnlockOrigin) -> Result<(), String> {
    match origin.mode {
        ForceUnlockOriginMode::OpenedChangelist | ForceUnlockOriginMode::ShelvedChangelist => {
            if !origin.change_id.is_some_and(|change| change > 0) {
                return Err(
                    "force unlock requires a positive numbered changelist; another client's default changelist cannot be addressed safely"
                        .into(),
                );
            }
        }
        ForceUnlockOriginMode::OrphanDistributed if origin.change_id.is_some() => {
            return Err("orphan distributed force unlock cannot carry a changelist".into());
        }
        ForceUnlockOriginMode::OrphanDistributed => {}
    }
    Ok(())
}

pub fn validate_paths(paths: &[String]) -> Result<Vec<String>, String> {
    if paths.is_empty() || paths.len() > FORCE_UNLOCK_PATH_LIMIT {
        return Err("force unlock requires between 1 and 128 explicit depot files".into());
    }
    let mut seen = HashSet::new();
    let mut canonical = Vec::with_capacity(paths.len());
    for path in paths {
        if !path.starts_with("//")
            || path.trim() != path
            || path.len() > 1024
            || path.starts_with("///")
            || path.contains(['\0', '\r', '\n', '\\', '*', '@', '#', '%'])
            || path.contains("...")
            || path.chars().any(char::is_control)
            || path
                .split('/')
                .any(|segment| segment == "." || segment == "..")
        {
            return Err("force unlock accepts only exact canonical depot file paths".into());
        }
        if seen.insert(path.clone()) {
            canonical.push(path.clone());
        }
    }
    Ok(canonical)
}

pub fn info() -> Invocation {
    Invocation {
        command: "info",
        args: vec!["-s".into()],
        argument_input: None,
    }
}

pub fn fstat(paths: &[String]) -> Result<Invocation, String> {
    let indexed = (0..128)
        .flat_map(|index| {
            [
                format!("otherLock{index}"),
                format!("otherUser{index}"),
                format!("otherClient{index}"),
                format!("otherChange{index}"),
                format!("otherAction{index}"),
            ]
        })
        .collect::<Vec<_>>()
        .join(",");
    scoped(
        "fstat",
        vec![
            "-Ol".into(),
            "-T".into(),
            format!("depotFile,type,headType,ourLock,otherLock,otherOpen,{indexed}"),
        ],
        paths,
    )
}

pub fn protects(paths: &[String]) -> Result<Invocation, String> {
    scoped("protects", vec!["-M".into()], paths)
}

pub fn opened(origin: &ForceUnlockOrigin, paths: &[String]) -> Result<Invocation, String> {
    validate_origin(origin)?;
    let change = origin
        .change_id
        .ok_or("opened force unlock requires a changelist")?;
    scoped(
        "opened",
        vec![
            "-a".into(),
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

pub fn mutate(origin: &ForceUnlockOrigin, depot_path: &str) -> Result<Invocation, String> {
    validate_origin(origin)?;
    let path = validate_paths(&[depot_path.to_owned()])?
        .into_iter()
        .next()
        .expect("one validated path");
    let mut args = vec!["-f".into()];
    match origin.mode {
        ForceUnlockOriginMode::OpenedChangelist => {
            let change = origin.change_id.expect("validated change");
            args.extend([
                "-c".into(),
                if change == 0 {
                    "default".into()
                } else {
                    change.to_string()
                },
            ]);
        }
        ForceUnlockOriginMode::ShelvedChangelist => {
            args.extend([
                "-s".into(),
                origin.change_id.expect("validated change").to_string(),
            ]);
        }
        ForceUnlockOriginMode::OrphanDistributed => args.push("-x".into()),
    }
    args.push(path);
    Ok(Invocation {
        command: "unlock",
        args,
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
    let argument_input = streamed.then(|| paths.clone());
    if !streamed {
        args.extend(paths);
    }
    Ok(Invocation {
        command,
        args,
        argument_input,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_exact_depot_files_and_preserves_first_seen_order() {
        assert_eq!(
            validate_paths(&[
                "//depot/b.txt".into(),
                "//depot/a file.txt".into(),
                "//depot/b.txt".into(),
            ])
            .unwrap(),
            ["//depot/b.txt", "//depot/a file.txt"]
        );
        for invalid in [
            "C:/work/a.txt",
            "//depot/...",
            "//depot/*.txt",
            "//depot/a@1",
            "//depot/a#head",
            "-f",
        ] {
            assert!(validate_paths(&[invalid.into()]).is_err(), "{invalid}");
        }
        assert!(validate_origin(&ForceUnlockOrigin {
            mode: ForceUnlockOriginMode::OpenedChangelist,
            change_id: Some(0),
        })
        .is_err());
        assert!(validate_paths(&vec!["//depot/a".into(); 129]).is_err());
    }

    #[test]
    fn force_commands_have_exactly_one_origin_and_never_fallback() {
        let opened = ForceUnlockOrigin {
            mode: ForceUnlockOriginMode::OpenedChangelist,
            change_id: Some(42),
        };
        assert_eq!(
            mutate(&opened, "//depot/a").unwrap().args,
            ["-f", "-c", "42", "//depot/a"]
        );
        let shelf = ForceUnlockOrigin {
            mode: ForceUnlockOriginMode::ShelvedChangelist,
            change_id: Some(43),
        };
        assert_eq!(
            mutate(&shelf, "//depot/a").unwrap().args,
            ["-f", "-s", "43", "//depot/a"]
        );
        let orphan = ForceUnlockOrigin {
            mode: ForceUnlockOriginMode::OrphanDistributed,
            change_id: None,
        };
        assert_eq!(
            mutate(&orphan, "//depot/a").unwrap().args,
            ["-f", "-x", "//depot/a"]
        );
    }
}
