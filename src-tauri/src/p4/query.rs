use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const CURSOR_VERSION: u8 = 1;
const MAX_CURSOR_BYTES: usize = 2048;

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChangeCursor {
    version: u8,
    upper_change_id: i64,
    query_fingerprint: String,
    connection_fingerprint: String,
    connection_generation: u64,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GlobalSearchCursor {
    version: u8,
    snapshot_id: String,
    offset: usize,
    query_fingerprint: String,
    connection_fingerprint: String,
    connection_generation: u64,
}

pub fn fingerprint<T: Serialize>(value: &T) -> Result<String, String> {
    let bytes = serde_json::to_vec(value).map_err(|error| error.to_string())?;
    let digest = Sha256::digest(bytes);
    Ok(digest.iter().map(|byte| format!("{byte:02x}")).collect())
}

pub fn encode_change_cursor(
    upper_change_id: i64,
    query_fingerprint: &str,
    connection_fingerprint: &str,
    connection_generation: u64,
) -> Result<String, String> {
    if upper_change_id <= 0 {
        return Err("cursor change boundary must be positive".into());
    }
    let bytes = serde_json::to_vec(&ChangeCursor {
        version: CURSOR_VERSION,
        upper_change_id,
        query_fingerprint: query_fingerprint.into(),
        connection_fingerprint: connection_fingerprint.into(),
        connection_generation,
    })
    .map_err(|error| error.to_string())?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

pub fn decode_change_cursor(
    encoded: &str,
    expected_query_fingerprint: &str,
    expected_connection_fingerprint: &str,
    expected_connection_generation: u64,
) -> Result<i64, String> {
    if encoded.is_empty() || encoded.len() > MAX_CURSOR_BYTES {
        return Err("invalid submitted query cursor".into());
    }
    let bytes = URL_SAFE_NO_PAD
        .decode(encoded)
        .map_err(|_| "invalid submitted query cursor")?;
    if bytes.len() > MAX_CURSOR_BYTES {
        return Err("invalid submitted query cursor".into());
    }
    let cursor: ChangeCursor =
        serde_json::from_slice(&bytes).map_err(|_| "invalid submitted query cursor")?;
    if cursor.version != CURSOR_VERSION
        || cursor.upper_change_id <= 0
        || cursor.query_fingerprint != expected_query_fingerprint
        || cursor.connection_fingerprint != expected_connection_fingerprint
        || cursor.connection_generation != expected_connection_generation
    {
        return Err("submitted query cursor does not match this query or connection".into());
    }
    Ok(cursor.upper_change_id)
}

pub fn encode_global_search_cursor(
    snapshot_id: &str,
    offset: usize,
    query_fingerprint: &str,
    connection_fingerprint: &str,
    connection_generation: u64,
) -> Result<String, String> {
    if snapshot_id.is_empty() || snapshot_id.len() > 128 || offset == 0 {
        return Err("invalid global search cursor boundary".into());
    }
    let bytes = serde_json::to_vec(&GlobalSearchCursor {
        version: CURSOR_VERSION,
        snapshot_id: snapshot_id.into(),
        offset,
        query_fingerprint: query_fingerprint.into(),
        connection_fingerprint: connection_fingerprint.into(),
        connection_generation,
    })
    .map_err(|error| error.to_string())?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

pub fn decode_global_search_cursor(
    encoded: &str,
    expected_query_fingerprint: &str,
    expected_connection_fingerprint: &str,
    expected_connection_generation: u64,
) -> Result<(String, usize), String> {
    if encoded.is_empty() || encoded.len() > MAX_CURSOR_BYTES {
        return Err("invalid global search cursor".into());
    }
    let bytes = URL_SAFE_NO_PAD
        .decode(encoded)
        .map_err(|_| "invalid global search cursor")?;
    if bytes.len() > MAX_CURSOR_BYTES {
        return Err("invalid global search cursor".into());
    }
    let cursor: GlobalSearchCursor =
        serde_json::from_slice(&bytes).map_err(|_| "invalid global search cursor")?;
    if cursor.version != CURSOR_VERSION
        || cursor.snapshot_id.is_empty()
        || cursor.offset == 0
        || cursor.query_fingerprint != expected_query_fingerprint
        || cursor.connection_fingerprint != expected_connection_fingerprint
        || cursor.connection_generation != expected_connection_generation
    {
        return Err("global search cursor does not match this query or connection".into());
    }
    Ok((cursor.snapshot_id, cursor.offset))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cursor_is_versioned_and_bound_to_query_connection_and_generation() {
        let cursor = encode_change_cursor(41, "query-一", "connection-一", 7).unwrap();
        assert_eq!(
            decode_change_cursor(&cursor, "query-一", "connection-一", 7).unwrap(),
            41
        );
        assert!(decode_change_cursor(&cursor, "other", "connection-一", 7).is_err());
        assert!(decode_change_cursor(&cursor, "query-一", "other", 7).is_err());
        assert!(decode_change_cursor(&cursor, "query-一", "connection-一", 8).is_err());
        assert!(decode_change_cursor("not-base64", "query-一", "connection-一", 7).is_err());
    }

    #[test]
    fn global_cursor_is_versioned_and_bound_to_snapshot_query_and_connection() {
        let cursor =
            encode_global_search_cursor("snapshot-1", 25, "query-一", "connection-一", 7).unwrap();
        assert_eq!(
            decode_global_search_cursor(&cursor, "query-一", "connection-一", 7).unwrap(),
            ("snapshot-1".into(), 25)
        );
        assert!(decode_global_search_cursor(&cursor, "other", "connection-一", 7).is_err());
        assert!(decode_global_search_cursor(&cursor, "query-一", "other", 7).is_err());
        assert!(decode_global_search_cursor(&cursor, "query-一", "connection-一", 8).is_err());
    }
}
