use crate::domain::{FileIntegration, FileRevision};
use serde_json::Value;

pub fn parse(value: Value) -> Vec<FileRevision> {
    let depot_path = value
        .get("depotFile")
        .and_then(Value::as_str)
        .map(decode_filespec)
        .unwrap_or_default();
    revision_indices(&value)
        .into_iter()
        .filter_map(|index| parse_revision(&value, &depot_path, index))
        .collect()
}

fn revision_indices(value: &Value) -> Vec<usize> {
    let mut indices = value
        .as_object()
        .into_iter()
        .flat_map(|object| object.keys())
        .filter_map(|key| key.strip_prefix("rev")?.parse::<usize>().ok())
        .collect::<Vec<_>>();
    indices.sort_unstable();
    indices.dedup();
    if indices.is_empty() && value.get("rev").is_some() {
        indices.push(usize::MAX);
    }
    indices
}

fn parse_revision(value: &Value, depot_path: &str, index: usize) -> Option<FileRevision> {
    let suffix = if index != usize::MAX {
        index.to_string()
    } else {
        String::new()
    };
    let field = |key: &str| value.get(format!("{key}{suffix}"));
    let number = |key: &str| field(key).and_then(number_value);
    let text = |key: &str| field(key).and_then(Value::as_str).unwrap_or("").to_owned();
    let time = number("time")
        .and_then(|seconds| chrono::DateTime::from_timestamp(seconds as i64, 0))
        .map(|date| date.to_rfc3339())
        .unwrap_or_else(|| text("time"));
    Some(FileRevision {
        depot_path: depot_path.to_owned(),
        revision: i64::try_from(number("rev")?).ok()?,
        changelist_id: i64::try_from(number("change").unwrap_or(0)).ok()?,
        user: text("user"),
        action: text("action"),
        file_type: text("type"),
        time,
        description: text("desc"),
        digest: field("digest").and_then(Value::as_str).map(str::to_owned),
        file_size: number("fileSize"),
        integrations: parse_integrations(value, &suffix),
    })
}

fn parse_integrations(value: &Value, revision_suffix: &str) -> Vec<FileIntegration> {
    let prefix = format!("how{revision_suffix},");
    let mut indices = value
        .as_object()
        .into_iter()
        .flat_map(|object| object.keys())
        .filter_map(|key| key.strip_prefix(&prefix)?.parse::<usize>().ok())
        .collect::<Vec<_>>();
    indices.sort_unstable();
    indices.dedup();
    indices
        .into_iter()
        .filter_map(|integration_index| {
            let suffix = format!("{revision_suffix},{integration_index}");
            let relationship = value.get(format!("how{suffix}"))?.as_str()?.to_owned();
            let related_path = decode_filespec(value.get(format!("file{suffix}"))?.as_str()?);
            let lower = relationship.to_ascii_lowercase();
            let direction = if lower.ends_with(" from") {
                "from"
            } else if lower.ends_with(" into") {
                "into"
            } else {
                "related"
            };
            let kind = lower
                .split_whitespace()
                .next()
                .unwrap_or("integration")
                .trim_end_matches('d')
                .to_owned();
            Some(FileIntegration {
                relationship,
                kind,
                direction: direction.into(),
                related_path,
                start_revision: value
                    .get(format!("srev{suffix}"))
                    .and_then(number_value)
                    .and_then(|value| i64::try_from(value).ok()),
                end_revision: value
                    .get(format!("erev{suffix}"))
                    .and_then(number_value)
                    .and_then(|value| i64::try_from(value).ok()),
            })
        })
        .collect()
}

fn number_value(value: &Value) -> Option<u64> {
    value
        .as_u64()
        .or_else(|| value.as_str()?.trim_start_matches('#').parse().ok())
}

pub fn decode_filespec(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut output = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            let pair = [
                bytes[index + 1].to_ascii_lowercase(),
                bytes[index + 2].to_ascii_lowercase(),
            ];
            let decoded = match pair {
                [b'2', b'5'] => Some(b'%'),
                [b'2', b'3'] => Some(b'#'),
                [b'4', b'0'] => Some(b'@'),
                [b'2', b'a'] => Some(b'*'),
                _ => None,
            };
            if let Some(decoded) = decoded {
                output.push(decoded);
                index += 3;
                continue;
            }
        }
        output.push(bytes[index]);
        index += 1;
    }
    String::from_utf8(output).unwrap_or_else(|_| value.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn handles_tagged_revision_arrays() {
        let value = serde_json::json!({"depotFile":"//atlas/main/文件 @#%.cpp","rev0":"2","change0":"42","user0":"alice","time0":"1700000000","desc0":"修改","type0":"text","digest0":"abc","fileSize0":"12","how0,0":"merge from","file0,0":"//atlas/dev/文件.cpp","srev0,0":"#1","erev0,0":"#3","rev1":1,"change1":40,"action1":"add"});
        let result = parse(value);
        assert_eq!(result.len(), 2);
        assert_eq!(result[0].revision, 2);
        assert_eq!(result[0].depot_path, "//atlas/main/文件 @#%.cpp");
        assert_eq!(result[0].description, "修改");
        assert_eq!(result[0].file_size, Some(12));
        assert_eq!(result[0].integrations[0].kind, "merge");
        assert_eq!(result[0].integrations[0].end_revision, Some(3));
        assert!(result[0].time.starts_with("2023-"));
        assert_eq!(result[1].action, "add");
        assert_eq!(
            decode_filespec("//depot/a%40%23%25.txt"),
            "//depot/a@#%.txt"
        );
        assert_eq!(
            decode_filespec("//depot/literal%2540.txt"),
            "//depot/literal%40.txt"
        );
    }
}
