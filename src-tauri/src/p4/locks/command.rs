use crate::domain::FileLockOperation;

pub struct Invocation {
    pub command: &'static str,
    pub args: Vec<String>,
    pub argument_input: Option<Vec<String>>,
}

const INLINE_PATH_LIMIT: usize = 128;
const INLINE_ARGUMENT_BYTES: usize = 24 * 1024;
const FSTAT_BASE_FIELDS: &str =
    "depotFile,clientFile,path,action,change,type,headType,ourLock,otherLock,otherOpen";
const MAX_STATUS_PATHS: usize = 100_000;

pub fn validate_paths(paths: &[String]) -> Result<Vec<String>, String> {
    if paths.is_empty() || paths.len() > 512 {
        return Err("lock operations require between 1 and 512 explicit files".into());
    }
    let mut paths = paths.to_vec();
    if paths.iter().any(|path| {
        path.trim().is_empty()
            || path.len() > 4096
            || path.starts_with('-')
            || path.contains(['\0', '\r', '\n'])
            || path.ends_with("/...")
            || path.ends_with("\\...")
    }) {
        return Err("lock operations contain an invalid or recursive target".into());
    }
    paths.sort_by(|left, right| left.as_bytes().cmp(right.as_bytes()));
    paths.dedup();
    Ok(paths)
}

pub fn info() -> Invocation {
    Invocation {
        command: "info",
        args: vec!["-s".into()],
        argument_input: None,
    }
}

pub fn where_paths(paths: &[String]) -> Result<Invocation, String> {
    scoped("where", Vec::new(), paths)
}

pub fn fstat(paths: &[String]) -> Result<Invocation, String> {
    scoped(
        "fstat",
        vec!["-Ol".into(), "-T".into(), fstat_fields()],
        paths,
    )
}

/// Read-only status aggregation may cover the complete bounded pending scan.
/// It deliberately has a larger cap than a user-triggered mutation, while
/// retaining literal filespec escaping and stdin argument streaming.
pub fn fstat_status(paths: &[String]) -> Result<Invocation, String> {
    if paths.is_empty() || paths.len() > MAX_STATUS_PATHS {
        return Err("status aggregation requires between 1 and 100000 explicit files".into());
    }
    let mut paths = paths.to_vec();
    if paths.iter().any(|path| {
        path.trim().is_empty()
            || path.len() > 4096
            || path.starts_with('-')
            || path.contains(['\0', '\r', '\n'])
            || path.ends_with("/...")
            || path.ends_with("\\...")
    }) {
        return Err("status aggregation contains an invalid or recursive target".into());
    }
    paths.sort_by(|left, right| left.as_bytes().cmp(right.as_bytes()));
    paths.dedup();
    let paths = paths
        .into_iter()
        .map(|path| escape_literal(&path))
        .collect::<Vec<_>>();
    Ok(Invocation {
        command: "fstat",
        args: vec!["-Ol".into(), "-T".into(), fstat_fields()],
        argument_input: Some(paths),
    })
}

pub fn fstat_fields() -> String {
    let indexed = (0..16)
        .flat_map(|index| [format!("otherLock{index}"), format!("otherOpen{index}")])
        .collect::<Vec<_>>()
        .join(",");
    format!("{FSTAT_BASE_FIELDS},{indexed}")
}

pub fn protects(paths: &[String]) -> Result<Invocation, String> {
    scoped("protects", vec!["-M".into()], paths)
}

pub fn mutate(operation: FileLockOperation, depot_path: &str) -> Result<Invocation, String> {
    if !depot_path.starts_with("//") {
        return Err("lock mutation requires a depot path".into());
    }
    scoped(
        match operation {
            FileLockOperation::Lock => "lock",
            FileLockOperation::Unlock => "unlock",
        },
        Vec::new(),
        &[depot_path.to_owned()],
    )
}

fn scoped(
    command: &'static str,
    mut args: Vec<String>,
    paths: &[String],
) -> Result<Invocation, String> {
    let paths = validate_paths(paths)?
        .into_iter()
        .map(|path| escape_literal(&path))
        .collect::<Vec<_>>();
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

pub fn escape_literal(value: &str) -> String {
    crate::p4::history::decode_filespec(value)
        .replace('%', "%25")
        .replace("...", "%2E%2E%2E")
        .replace('@', "%40")
        .replace('#', "%23")
        .replace('*', "%2A")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escapes_literal_special_filespecs_without_double_encoding() {
        assert_eq!(
            escape_literal("//depot/空 格@#%*.bin"),
            "//depot/空 格%40%23%25%2A.bin"
        );
        assert_eq!(
            escape_literal("//depot/name%2540.bin"),
            "//depot/name%2540.bin"
        );
        assert_eq!(
            escape_literal("//depot/literal...name.bin"),
            "//depot/literal%2E%2E%2Ename.bin"
        );
    }

    #[test]
    fn rejects_recursive_option_like_and_empty_targets() {
        assert!(validate_paths(&[]).is_err());
        assert!(validate_paths(&["-f".into()]).is_err());
        assert!(validate_paths(&["//depot/...".into()]).is_err());
    }

    #[test]
    fn status_fstat_streams_large_explicit_sets() {
        let invocation =
            fstat_status(&["//depot/a.txt".into(), "//depot/空 格@.txt".into()]).unwrap();
        assert!(invocation.args.iter().all(|arg| arg != "//depot/a.txt"));
        assert_eq!(
            invocation.argument_input.unwrap(),
            ["//depot/a.txt", "//depot/空 格%40.txt"]
        );
    }
}
