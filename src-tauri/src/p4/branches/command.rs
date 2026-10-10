use crate::domain::{BranchMappingDraft, BranchViewModifier};
use std::collections::HashMap;

pub const BRANCH_SCAN_LIMIT: usize = 5_000;
pub const BRANCH_VIEW_LIMIT: usize = 512;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Invocation {
    pub command: &'static str,
    pub args: Vec<String>,
}

pub fn list(name_filter: Option<&str>, owner: Option<&str>) -> Result<Invocation, String> {
    let mut args = vec![
        "-m".into(),
        (BRANCH_SCAN_LIMIT + 1).to_string(),
        "-t".into(),
    ];
    if let Some(filter) = name_filter {
        validate_filter(filter)?;
        args.extend(["-E".into(), format!("*{filter}*")]);
    }
    if let Some(owner) = owner {
        validate_identity(owner, "branch owner")?;
        args.extend(["-u".into(), owner.into()]);
    }
    Ok(Invocation {
        command: "branches",
        args,
    })
}

pub fn detail(name: &str) -> Result<Invocation, String> {
    validate_name(name)?;
    Ok(Invocation {
        command: "branch",
        args: vec!["-o".into(), name.into()],
    })
}

pub fn where_paths(paths: &[String]) -> Result<Invocation, String> {
    if paths.is_empty() || paths.len() > BRANCH_VIEW_LIMIT {
        return Err("branch mapping requires between 1 and 512 target mappings".into());
    }
    for path in paths {
        validate_depot_pattern(path)?;
    }
    Ok(Invocation {
        command: "where",
        args: paths.to_vec(),
    })
}

pub fn preview(name: &str, reverse: bool, limit: usize) -> Result<Invocation, String> {
    validate_name(name)?;
    if !(1..=BRANCH_SCAN_LIMIT).contains(&limit) {
        return Err("branch impact limit must be between 1 and 5000".into());
    }
    let mut args = vec![
        "-n".into(),
        "-m".into(),
        limit.saturating_add(1).to_string(),
        "-b".into(),
        name.into(),
    ];
    if reverse {
        args.push("-r".into());
    }
    Ok(Invocation {
        command: "integrate",
        args,
    })
}

pub fn save(draft: &BranchMappingDraft) -> Result<(Invocation, String), String> {
    validate_draft(draft)?;
    Ok((
        Invocation {
            command: "branch",
            args: vec!["-i".into()],
        },
        serialize_form(draft),
    ))
}

pub fn delete(name: &str) -> Result<Invocation, String> {
    validate_name(name)?;
    Ok(Invocation {
        command: "branch",
        args: vec!["-d".into(), name.into()],
    })
}

pub fn validate_draft(draft: &BranchMappingDraft) -> Result<(), String> {
    validate_name(&draft.name)?;
    validate_identity(&draft.owner, "branch owner")?;
    validate_description(&draft.description)?;
    if draft.view.is_empty() || draft.view.len() > BRANCH_VIEW_LIMIT {
        return Err("branch View must contain between 1 and 512 mappings".into());
    }
    let mut sources = HashMap::<String, (BranchViewModifier, String)>::new();
    for (index, line) in draft.view.iter().enumerate() {
        if line.comment.is_some() || line.unknown.is_some() {
            return Err(format!(
                "branch View line {} contains comment or unknown text that cannot be safely round-tripped",
                index + 1
            ));
        }
        if matches!(line.modifier, BranchViewModifier::Unknown) {
            return Err(format!(
                "branch View line {} has an unknown modifier",
                index + 1
            ));
        }
        let source = line
            .source
            .as_deref()
            .ok_or_else(|| format!("branch View line {} is missing a source", index + 1))?;
        let target = line
            .target
            .as_deref()
            .ok_or_else(|| format!("branch View line {} is missing a target", index + 1))?;
        validate_depot_pattern(source)?;
        validate_depot_pattern(target)?;
        if wildcard_signature(source) != wildcard_signature(target) {
            return Err(format!(
                "branch View line {} has incompatible source and target wildcards",
                index + 1
            ));
        }
        let key = source.to_ascii_lowercase();
        if let Some((existing_modifier, existing_target)) = sources.get(&key) {
            if existing_modifier == &line.modifier && existing_target == target {
                return Err(format!("branch View line {} is duplicated", index + 1));
            }
            return Err(format!(
                "branch View line {} conflicts with another mapping for the same source",
                index + 1
            ));
        }
        sources.insert(key, (line.modifier, target.into()));
    }
    Ok(())
}

pub fn validate_name(value: &str) -> Result<(), String> {
    validate_identity(value, "branch name")
}

fn validate_filter(value: &str) -> Result<(), String> {
    let value = value.trim();
    if value.is_empty()
        || value.chars().count() > 128
        || value
            .chars()
            .any(|character| character.is_control() || matches!(character, '*' | '%' | '@' | '#'))
    {
        return Err("branch name filter must be a literal value of at most 128 characters".into());
    }
    Ok(())
}

fn validate_identity(value: &str, label: &str) -> Result<(), String> {
    if value.is_empty()
        || value.trim() != value
        || value.chars().count() > 128
        || value.starts_with('-')
        || value.chars().any(|character| {
            character.is_control()
                || character.is_whitespace()
                || matches!(character, ':' | '*' | '%' | '@' | '#' | '/' | '\\' | '"')
        })
    {
        return Err(format!("{label} is invalid"));
    }
    Ok(())
}

fn validate_description(value: &str) -> Result<(), String> {
    if value.chars().count() > 4_096
        || value.chars().any(|character| {
            character == '\r' || (character.is_control() && character != '\n' && character != '\t')
        })
    {
        return Err("branch description is invalid or exceeds 4096 characters".into());
    }
    Ok(())
}

pub fn validate_depot_pattern(value: &str) -> Result<(), String> {
    if !value.starts_with("//")
        || value.len() > 1_024
        || value.trim() != value
        || value.contains('@')
        || value.contains('#')
        || value.contains('%')
        || value.contains('"')
        || value.contains('\\')
        || value.chars().any(char::is_control)
    {
        return Err("branch View paths must be literal depot patterns".into());
    }
    let mut index = 0usize;
    let bytes = value.as_bytes();
    while index < bytes.len() {
        if bytes[index] == b'.' {
            if bytes[index..].starts_with(b"...") {
                index += 3;
                continue;
            }
            if bytes[index..].starts_with(b"..") {
                return Err("branch View paths contain an invalid wildcard".into());
            }
        }
        index += 1;
    }
    Ok(())
}

fn wildcard_signature(value: &str) -> Vec<&'static str> {
    let mut result = Vec::new();
    let bytes = value.as_bytes();
    let mut index = 0usize;
    while index < bytes.len() {
        if bytes[index..].starts_with(b"...") {
            result.push("...");
            index += 3;
        } else if bytes[index] == b'*' {
            result.push("*");
            index += 1;
        } else {
            index += 1;
        }
    }
    result
}

fn serialize_form(draft: &BranchMappingDraft) -> String {
    let mut form = format!(
        "Branch: {}\n\nOwner: {}\n\nDescription:\n",
        draft.name, draft.owner
    );
    if draft.description.is_empty() {
        form.push_str("\t\n");
    } else {
        for line in draft.description.lines() {
            form.push('\t');
            form.push_str(line);
            form.push('\n');
        }
    }
    form.push_str(&format!(
        "\nOptions: {}\n\nView:\n",
        if draft.locked { "locked" } else { "unlocked" }
    ));
    for line in &draft.view {
        let prefix = match line.modifier {
            BranchViewModifier::Map => "",
            BranchViewModifier::Exclude => "-",
            BranchViewModifier::Overlay => "+",
            BranchViewModifier::Unknown => unreachable!("validated branch modifier"),
        };
        form.push('\t');
        form.push_str(prefix);
        form.push_str(&quote_path(
            line.source.as_deref().expect("validated source"),
        ));
        form.push(' ');
        form.push_str(&quote_path(
            line.target.as_deref().expect("validated target"),
        ));
        form.push('\n');
    }
    form
}

fn quote_path(value: &str) -> String {
    if value.chars().any(char::is_whitespace) {
        format!("\"{}\"", value.replace('"', ""))
    } else {
        value.into()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::BranchViewLine;

    fn line(modifier: BranchViewModifier, source: &str, target: &str) -> BranchViewLine {
        BranchViewLine {
            modifier,
            source: Some(source.into()),
            target: Some(target.into()),
            comment: None,
            unknown: None,
        }
    }

    #[test]
    fn commands_are_bounded_preview_only_and_never_force() {
        assert_eq!(
            list(Some("release"), Some("alice")).unwrap().args,
            vec!["-m", "5001", "-t", "-E", "*release*", "-u", "alice"]
        );
        assert_eq!(
            preview("map-one", true, 40).unwrap().args,
            vec!["-n", "-m", "41", "-b", "map-one", "-r"]
        );
        assert_eq!(delete("map-one").unwrap().args, vec!["-d", "map-one"]);
    }

    #[test]
    fn validates_wildcards_duplicates_injection_and_roundtrip_boundaries() {
        let mut draft = BranchMappingDraft {
            name: "map-one".into(),
            owner: "alice".into(),
            description: "Unicode 描述".into(),
            locked: false,
            view: vec![line(
                BranchViewModifier::Map,
                "//depot/source/...",
                "//depot/target/...",
            )],
        };
        let (_, form) = save(&draft).unwrap();
        assert!(form.contains("\t//depot/source/... //depot/target/..."));
        draft.view[0].target = Some("//depot/target/*".into());
        assert!(validate_draft(&draft).is_err());
        draft.view[0].target = Some("//depot/target/...\nOwner: root".into());
        assert!(validate_draft(&draft).is_err());
        draft.view[0].target = Some("//depot/target/...".into());
        draft.view.push(draft.view[0].clone());
        assert!(validate_draft(&draft).is_err());
        draft.view.pop();
        draft.view[0].comment = Some("not safely writable".into());
        assert!(validate_draft(&draft).is_err());

        draft.view = vec![
            line(
                BranchViewModifier::Map,
                "//depot/source/...",
                "//depot/target/...",
            );
            BRANCH_VIEW_LIMIT + 1
        ];
        assert!(validate_draft(&draft).is_err());
    }

    #[test]
    fn form_quotes_unicode_paths_with_spaces() {
        let draft = BranchMappingDraft {
            name: "unicode-map".into(),
            owner: "alice".into(),
            description: "路径 测试".into(),
            locked: true,
            view: vec![line(
                BranchViewModifier::Overlay,
                "//depot/源 路径/*",
                "//depot/目标 路径/*",
            )],
        };
        let (_, form) = save(&draft).unwrap();
        assert!(form.contains("+\"//depot/源 路径/*\" \"//depot/目标 路径/*\""));
        assert!(form.contains("Options: locked"));
    }
}
