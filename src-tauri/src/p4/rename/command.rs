use crate::domain::RenameMovePreflightRequest;

pub struct Invocation {
    pub command: &'static str,
    pub args: Vec<String>,
}

pub fn validate(request: &RenameMovePreflightRequest) -> Result<(), String> {
    validate_path(&request.source_path)?;
    validate_path(&request.target_path)?;
    if request.source_path == request.target_path {
        return Err("source and target paths are identical".into());
    }
    if request.target_change_id < 0 {
        return Err("targetChangeId must be Default (0) or an existing numbered changelist".into());
    }
    Ok(())
}

pub fn where_path(path: &str) -> Result<Invocation, String> {
    validate_path(path)?;
    Ok(Invocation {
        command: "where",
        args: vec![path.into()],
    })
}

pub fn fstat(path: &str) -> Result<Invocation, String> {
    validate_path(path)?;
    Ok(Invocation {
        command: "fstat",
        args: vec![
            "-Ol".into(),
            "-T".into(),
            "depotFile,clientFile,path,action,change,type,haveRev,headRev,headAction".into(),
            path.into(),
        ],
    })
}

pub fn change(change_id: i64) -> Result<Invocation, String> {
    if change_id <= 0 {
        return Err("numbered changelist ID must be positive".into());
    }
    Ok(Invocation {
        command: "change",
        args: vec!["-o".into(), change_id.to_string()],
    })
}

pub fn move_file(
    source_depot: &str,
    target_depot: &str,
    change_id: i64,
) -> Result<Invocation, String> {
    validate_path(source_depot)?;
    validate_path(target_depot)?;
    if change_id < 0 {
        return Err("target changelist is invalid".into());
    }
    Ok(Invocation {
        command: "move",
        args: vec![
            "-c".into(),
            if change_id == 0 {
                "default".into()
            } else {
                change_id.to_string()
            },
            source_depot.into(),
            target_depot.into(),
        ],
    })
}

fn validate_path(path: &str) -> Result<(), String> {
    if path.trim().is_empty()
        || path.starts_with('-')
        || path.contains(['\0', '\r', '\n'])
        || path.contains(['*', '?', '@', '#', '%'])
        || path.contains("...")
    {
        return Err(format!("invalid rename/move path: {path:?}"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn move_uses_an_argument_array_and_explicit_changelist() {
        let invocation = move_file("//depot/a b.txt", "//depot/c d.txt", 42).unwrap();
        assert_eq!(invocation.command, "move");
        assert_eq!(
            invocation.args,
            ["-c", "42", "//depot/a b.txt", "//depot/c d.txt"]
        );
        assert_eq!(
            move_file("//depot/a", "//depot/b", 0).unwrap().args[1],
            "default"
        );
    }

    #[test]
    fn rejects_option_like_wildcard_and_negative_inputs() {
        assert!(where_path("-f").is_err());
        assert!(fstat("//depot/...").is_err());
        assert!(fstat("C:/workspace/name@change.txt").is_err());
        assert!(fstat("C:/workspace/name#revision.txt").is_err());
        assert!(fstat("C:/workspace/name%40.txt").is_err());
        assert!(move_file("//depot/a", "//depot/b", -1).is_err());
    }
}
