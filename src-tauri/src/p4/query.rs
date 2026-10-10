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

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StreamGraphCursor {
    version: u8,
    snapshot_id: String,
    cursor_id: String,
    offset: usize,
    query_fingerprint: String,
    connection_fingerprint: String,
    connection_generation: u64,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BranchMappingCursor {
    version: u8,
    snapshot_id: String,
    cursor_id: String,
    offset: usize,
    query_fingerprint: String,
    connection_fingerprint: String,
    connection_generation: u64,
}

#[derive(Debug, PartialEq, Eq)]
pub struct StreamGraphCursorBoundary {
    pub snapshot_id: String,
    pub cursor_id: String,
    pub offset: usize,
}

#[derive(Debug, PartialEq, Eq)]
pub struct BranchMappingCursorBoundary {
    pub snapshot_id: String,
    pub cursor_id: String,
    pub offset: usize,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PendingChangeCursor {
    version: u8,
    snapshot_id: String,
    offset: usize,
    query_fingerprint: String,
    connection_fingerprint: String,
    connection_generation: u64,
    pending_generation: u64,
}

#[derive(Debug, PartialEq, Eq)]
pub struct ShelfDetailCursorBoundary {
    pub snapshot_id: String,
    pub cursor_id: String,
    pub offset: usize,
}

#[derive(Debug, PartialEq, Eq)]
pub enum ShelfDetailCursorError {
    Invalid,
    QueryMismatch,
    ConnectionMismatch,
    GenerationMismatch,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ShelfDetailCursor {
    version: u8,
    snapshot_id: String,
    cursor_id: String,
    offset: usize,
    query_fingerprint: String,
    connection_fingerprint: String,
    connection_generation: u64,
    shelf_generation: u64,
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

#[allow(clippy::too_many_arguments)]
pub fn encode_stream_graph_cursor(
    snapshot_id: &str,
    cursor_id: &str,
    offset: usize,
    query_fingerprint: &str,
    connection_fingerprint: &str,
    connection_generation: u64,
) -> Result<String, String> {
    if snapshot_id.is_empty()
        || snapshot_id.len() > 128
        || cursor_id.is_empty()
        || cursor_id.len() > 128
        || offset == 0
    {
        return Err("invalid Stream Graph cursor boundary".into());
    }
    let bytes = serde_json::to_vec(&StreamGraphCursor {
        version: CURSOR_VERSION,
        snapshot_id: snapshot_id.into(),
        cursor_id: cursor_id.into(),
        offset,
        query_fingerprint: query_fingerprint.into(),
        connection_fingerprint: connection_fingerprint.into(),
        connection_generation,
    })
    .map_err(|error| error.to_string())?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

pub fn decode_stream_graph_cursor(
    encoded: &str,
    expected_query_fingerprint: &str,
    expected_connection_fingerprint: &str,
    expected_connection_generation: u64,
) -> Result<StreamGraphCursorBoundary, String> {
    if encoded.is_empty() || encoded.len() > MAX_CURSOR_BYTES {
        return Err("invalid Stream Graph cursor".into());
    }
    let bytes = URL_SAFE_NO_PAD
        .decode(encoded)
        .map_err(|_| "invalid Stream Graph cursor")?;
    if bytes.len() > MAX_CURSOR_BYTES {
        return Err("invalid Stream Graph cursor".into());
    }
    let cursor: StreamGraphCursor =
        serde_json::from_slice(&bytes).map_err(|_| "invalid Stream Graph cursor")?;
    if cursor.version != CURSOR_VERSION
        || cursor.snapshot_id.is_empty()
        || cursor.cursor_id.is_empty()
        || cursor.offset == 0
        || cursor.query_fingerprint != expected_query_fingerprint
        || cursor.connection_fingerprint != expected_connection_fingerprint
        || cursor.connection_generation != expected_connection_generation
    {
        return Err("Stream Graph cursor does not match this query or connection".into());
    }
    Ok(StreamGraphCursorBoundary {
        snapshot_id: cursor.snapshot_id,
        cursor_id: cursor.cursor_id,
        offset: cursor.offset,
    })
}

#[allow(clippy::too_many_arguments)]
pub fn encode_branch_mapping_cursor(
    snapshot_id: &str,
    cursor_id: &str,
    offset: usize,
    query_fingerprint: &str,
    connection_fingerprint: &str,
    connection_generation: u64,
) -> Result<String, String> {
    if snapshot_id.is_empty()
        || snapshot_id.len() > 128
        || cursor_id.is_empty()
        || cursor_id.len() > 128
        || offset == 0
    {
        return Err("invalid Branch Mapping cursor boundary".into());
    }
    let bytes = serde_json::to_vec(&BranchMappingCursor {
        version: CURSOR_VERSION,
        snapshot_id: snapshot_id.into(),
        cursor_id: cursor_id.into(),
        offset,
        query_fingerprint: query_fingerprint.into(),
        connection_fingerprint: connection_fingerprint.into(),
        connection_generation,
    })
    .map_err(|error| error.to_string())?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

pub fn decode_branch_mapping_cursor(
    encoded: &str,
    expected_query_fingerprint: &str,
    expected_connection_fingerprint: &str,
    expected_connection_generation: u64,
) -> Result<BranchMappingCursorBoundary, String> {
    if encoded.is_empty() || encoded.len() > MAX_CURSOR_BYTES {
        return Err("invalid Branch Mapping cursor".into());
    }
    let bytes = URL_SAFE_NO_PAD
        .decode(encoded)
        .map_err(|_| "invalid Branch Mapping cursor")?;
    if bytes.len() > MAX_CURSOR_BYTES {
        return Err("invalid Branch Mapping cursor".into());
    }
    let cursor: BranchMappingCursor =
        serde_json::from_slice(&bytes).map_err(|_| "invalid Branch Mapping cursor")?;
    if cursor.version != CURSOR_VERSION
        || cursor.snapshot_id.is_empty()
        || cursor.cursor_id.is_empty()
        || cursor.offset == 0
        || cursor.query_fingerprint != expected_query_fingerprint
        || cursor.connection_fingerprint != expected_connection_fingerprint
        || cursor.connection_generation != expected_connection_generation
    {
        return Err("Branch Mapping cursor does not match this query or connection".into());
    }
    Ok(BranchMappingCursorBoundary {
        snapshot_id: cursor.snapshot_id,
        cursor_id: cursor.cursor_id,
        offset: cursor.offset,
    })
}

pub fn encode_pending_change_cursor(
    snapshot_id: &str,
    offset: usize,
    query_fingerprint: &str,
    connection_fingerprint: &str,
    connection_generation: u64,
    pending_generation: u64,
) -> Result<String, String> {
    if snapshot_id.is_empty() || snapshot_id.len() > 128 || offset == 0 {
        return Err("invalid pending changelist cursor boundary".into());
    }
    let bytes = serde_json::to_vec(&PendingChangeCursor {
        version: CURSOR_VERSION,
        snapshot_id: snapshot_id.into(),
        offset,
        query_fingerprint: query_fingerprint.into(),
        connection_fingerprint: connection_fingerprint.into(),
        connection_generation,
        pending_generation,
    })
    .map_err(|error| error.to_string())?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

pub fn decode_pending_change_cursor(
    encoded: &str,
    expected_query_fingerprint: &str,
    expected_connection_fingerprint: &str,
    expected_connection_generation: u64,
    expected_pending_generation: u64,
) -> Result<(String, usize), String> {
    if encoded.is_empty() || encoded.len() > MAX_CURSOR_BYTES {
        return Err("invalid pending changelist cursor".into());
    }
    let bytes = URL_SAFE_NO_PAD
        .decode(encoded)
        .map_err(|_| "invalid pending changelist cursor")?;
    if bytes.len() > MAX_CURSOR_BYTES {
        return Err("invalid pending changelist cursor".into());
    }
    let cursor: PendingChangeCursor =
        serde_json::from_slice(&bytes).map_err(|_| "invalid pending changelist cursor")?;
    if cursor.version != CURSOR_VERSION
        || cursor.snapshot_id.is_empty()
        || cursor.offset == 0
        || cursor.query_fingerprint != expected_query_fingerprint
        || cursor.connection_fingerprint != expected_connection_fingerprint
        || cursor.connection_generation != expected_connection_generation
        || cursor.pending_generation != expected_pending_generation
    {
        return Err("pending changelist cursor does not match this query or connection".into());
    }
    Ok((cursor.snapshot_id, cursor.offset))
}

#[allow(clippy::too_many_arguments)]
pub fn encode_shelf_detail_cursor(
    snapshot_id: &str,
    cursor_id: &str,
    offset: usize,
    query_fingerprint: &str,
    connection_fingerprint: &str,
    connection_generation: u64,
    shelf_generation: u64,
) -> Result<String, String> {
    if snapshot_id.is_empty()
        || snapshot_id.len() > 128
        || cursor_id.is_empty()
        || cursor_id.len() > 128
        || offset == 0
    {
        return Err("invalid shelf detail cursor boundary".into());
    }
    let bytes = serde_json::to_vec(&ShelfDetailCursor {
        version: CURSOR_VERSION,
        snapshot_id: snapshot_id.into(),
        cursor_id: cursor_id.into(),
        offset,
        query_fingerprint: query_fingerprint.into(),
        connection_fingerprint: connection_fingerprint.into(),
        connection_generation,
        shelf_generation,
    })
    .map_err(|error| error.to_string())?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

pub fn decode_shelf_detail_cursor(
    encoded: &str,
    expected_query_fingerprint: &str,
    expected_connection_fingerprint: &str,
    expected_connection_generation: u64,
    expected_shelf_generation: u64,
) -> Result<ShelfDetailCursorBoundary, ShelfDetailCursorError> {
    if encoded.is_empty() || encoded.len() > MAX_CURSOR_BYTES {
        return Err(ShelfDetailCursorError::Invalid);
    }
    let bytes = URL_SAFE_NO_PAD
        .decode(encoded)
        .map_err(|_| ShelfDetailCursorError::Invalid)?;
    if bytes.len() > MAX_CURSOR_BYTES {
        return Err(ShelfDetailCursorError::Invalid);
    }
    let cursor: ShelfDetailCursor =
        serde_json::from_slice(&bytes).map_err(|_| ShelfDetailCursorError::Invalid)?;
    if cursor.version != CURSOR_VERSION
        || cursor.snapshot_id.is_empty()
        || cursor.cursor_id.is_empty()
        || cursor.offset == 0
    {
        return Err(ShelfDetailCursorError::Invalid);
    }
    if cursor.query_fingerprint != expected_query_fingerprint {
        return Err(ShelfDetailCursorError::QueryMismatch);
    }
    if cursor.connection_fingerprint != expected_connection_fingerprint {
        return Err(ShelfDetailCursorError::ConnectionMismatch);
    }
    if cursor.connection_generation != expected_connection_generation
        || cursor.shelf_generation != expected_shelf_generation
    {
        return Err(ShelfDetailCursorError::GenerationMismatch);
    }
    Ok(ShelfDetailCursorBoundary {
        snapshot_id: cursor.snapshot_id,
        cursor_id: cursor.cursor_id,
        offset: cursor.offset,
    })
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

    #[test]
    fn stream_graph_cursor_binds_page_size_query_connection_and_generation() {
        let cursor = encode_stream_graph_cursor(
            "snapshot-graph",
            "cursor-once",
            2,
            "query-page-size-2",
            "profile-and-context",
            7,
        )
        .unwrap();
        assert_eq!(
            decode_stream_graph_cursor(&cursor, "query-page-size-2", "profile-and-context", 7)
                .unwrap(),
            StreamGraphCursorBoundary {
                snapshot_id: "snapshot-graph".into(),
                cursor_id: "cursor-once".into(),
                offset: 2,
            }
        );
        assert!(decode_stream_graph_cursor(
            &cursor,
            "different-page-size",
            "profile-and-context",
            7
        )
        .is_err());
        assert!(
            decode_stream_graph_cursor(&cursor, "query-page-size-2", "other-profile", 7).is_err()
        );
        assert!(
            decode_stream_graph_cursor(&cursor, "query-page-size-2", "profile-and-context", 8)
                .is_err()
        );
    }

    #[test]
    fn branch_mapping_cursor_binds_query_profile_context_and_generation() {
        let cursor = encode_branch_mapping_cursor(
            "branch-snapshot",
            "branch-cursor-once",
            25,
            "query-page-size-25",
            "profile-and-full-context",
            11,
        )
        .unwrap();
        assert_eq!(
            decode_branch_mapping_cursor(
                &cursor,
                "query-page-size-25",
                "profile-and-full-context",
                11,
            )
            .unwrap(),
            BranchMappingCursorBoundary {
                snapshot_id: "branch-snapshot".into(),
                cursor_id: "branch-cursor-once".into(),
                offset: 25,
            }
        );
        assert!(decode_branch_mapping_cursor(
            &cursor,
            "other-query",
            "profile-and-full-context",
            11,
        )
        .is_err());
        assert!(decode_branch_mapping_cursor(
            &cursor,
            "query-page-size-25",
            "other-profile-or-context",
            11,
        )
        .is_err());
        assert!(decode_branch_mapping_cursor(
            &cursor,
            "query-page-size-25",
            "profile-and-full-context",
            12,
        )
        .is_err());
        assert!(decode_branch_mapping_cursor(
            "not-base64",
            "query-page-size-25",
            "profile-and-full-context",
            11,
        )
        .is_err());
    }

    #[test]
    fn pending_cursor_is_bound_to_snapshot_query_connection_and_both_generations() {
        let cursor =
            encode_pending_change_cursor("random-snapshot", 50, "query-a", "connection-a", 7, 3)
                .unwrap();
        assert_eq!(
            decode_pending_change_cursor(&cursor, "query-a", "connection-a", 7, 3,).unwrap(),
            ("random-snapshot".into(), 50)
        );
        assert!(decode_pending_change_cursor(&cursor, "query-b", "connection-a", 7, 3,).is_err());
        assert!(decode_pending_change_cursor(&cursor, "query-a", "connection-a", 7, 4,).is_err());
    }

    #[test]
    fn shelf_cursor_is_bound_to_snapshot_query_connection_and_both_generations() {
        let cursor = encode_shelf_detail_cursor(
            "snapshot-1",
            "cursor-1",
            500,
            "query-a",
            "connection-a",
            7,
            3,
        )
        .unwrap();
        assert_eq!(
            decode_shelf_detail_cursor(&cursor, "query-a", "connection-a", 7, 3).unwrap(),
            ShelfDetailCursorBoundary {
                snapshot_id: "snapshot-1".into(),
                cursor_id: "cursor-1".into(),
                offset: 500,
            }
        );
        assert_eq!(
            decode_shelf_detail_cursor(&cursor, "query-b", "connection-a", 7, 3),
            Err(ShelfDetailCursorError::QueryMismatch)
        );
        assert_eq!(
            decode_shelf_detail_cursor(&cursor, "query-a", "connection-b", 7, 3),
            Err(ShelfDetailCursorError::ConnectionMismatch)
        );
        assert_eq!(
            decode_shelf_detail_cursor(&cursor, "query-a", "connection-a", 8, 3),
            Err(ShelfDetailCursorError::GenerationMismatch)
        );
        assert_eq!(
            decode_shelf_detail_cursor(&cursor, "query-a", "connection-a", 7, 4),
            Err(ShelfDetailCursorError::GenerationMismatch)
        );
    }
}
