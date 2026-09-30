use crate::domain::FileRevision;
use serde_json::Value;

pub fn parse(value: Value) -> Vec<FileRevision> {
    let mut suffixes: Vec<String> = value
        .as_object()
        .into_iter()
        .flat_map(|v| v.keys())
        .filter_map(|key| {
            key.strip_prefix("rev")
                .filter(|suffix| !suffix.is_empty() && suffix.chars().all(|c| c.is_ascii_digit()))
                .map(str::to_owned)
        })
        .collect();
    suffixes.sort_by_key(|suffix| suffix.parse::<usize>().unwrap_or(usize::MAX));
    if suffixes.is_empty() {
        suffixes.push(String::new());
    }
    suffixes
        .into_iter()
        .filter_map(|suffix| {
            let field = |key: &str| value.get(format!("{key}{suffix}"));
            let number = |key: &str| {
                field(key).and_then(|v| v.as_u64().or_else(|| v.as_str()?.parse().ok()))
            };
            let text = |key: &str| field(key).and_then(Value::as_str).unwrap_or("").to_owned();
            let time = number("time")
                .and_then(|seconds| chrono::DateTime::from_timestamp(seconds as i64, 0))
                .map(|date| date.to_rfc3339())
                .unwrap_or_else(|| text("time"));
            Some(FileRevision {
                revision: i64::try_from(number("rev")?).ok()?,
                changelist_id: i64::try_from(number("change").unwrap_or(0)).ok()?,
                user: text("user"),
                action: text("action"),
                time,
                description: text("desc"),
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn handles_tagged_revision_arrays() {
        let value = serde_json::json!({"depotFile":"//atlas/main/文件.cpp","rev0":"2","change0":"42","user0":"alice","time0":"1700000000","desc0":"修改","rev1":1,"change1":40,"action1":"add"});
        let result = parse(value);
        assert_eq!(result.len(), 2);
        assert_eq!(result[0].revision, 2);
        assert_eq!(result[0].description, "修改");
        assert!(result[0].time.starts_with("2023-"));
        assert_eq!(result[1].action, "add");
    }
}
