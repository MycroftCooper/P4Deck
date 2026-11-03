//! Local file preview.
//!
//! The preview payload stays flat on the wire: text and image previews keep the
//! existing `kind` + `content`/`size`/`encoding`/`width`/`height` shape, and
//! table previews add `kind: "table"` plus an optional `table` object. The
//! `table` field is skipped for the legacy kinds so their serialization is
//! unchanged (`width`/`height` still serialize as `null`).
//!
//! Reading is bounded by design: CSV parses at most [`CSV_READ_CAP`] bytes and
//! XLSX streams the first rows of one worksheet after a zip central-directory
//! preflight. Hitting a cap returns a partial page plus a `truncatedReason`
//! instead of failing the whole preview.

mod csv;
mod legacy;
mod table;
mod xlsx;

use serde::Serialize;
use std::path::Path;
use std::time::Duration;

/// Text preview read cap (unchanged from the original implementation).
pub(crate) const TEXT_LIMIT: u64 = 2 * 1024 * 1024;
/// Image preview read cap (unchanged from the original implementation).
pub(crate) const IMAGE_LIMIT: u64 = 8 * 1024 * 1024;
/// Image preview pixel cap (unchanged from the original hard-coded value).
pub(crate) const IMAGE_MEGAPIXELS: u64 = 20_000_000;

/// Sanity cap for the CSV/TSV file itself; larger files are rejected outright.
pub(crate) const CSV_INPUT_LIMIT: u64 = 512 * 1024 * 1024;
/// Maximum number of raw bytes decoded for one CSV page.
pub(crate) const CSV_READ_CAP: u64 = 8 * 1024 * 1024;
/// Maximum raw characters scanned for a single CSV field.
pub(crate) const CSV_FIELD_CAP: usize = 64 * 1024;

/// Input xlsx/xlsm file cap. Guards `Xlsx::new`, which loads sharedStrings and
/// styles eagerly.
pub(crate) const XLSX_INPUT_LIMIT: u64 = 64 * 1024 * 1024;
/// Maximum number of entries accepted from the zip central directory.
pub(crate) const XLSX_ZIP_ENTRIES: usize = 2_048;
/// Maximum declared decompressed size of a single zip entry.
pub(crate) const XLSX_ENTRY_CAP: u64 = 256 * 1024 * 1024;
/// Maximum declared decompressed size of all zip entries combined.
pub(crate) const XLSX_UNCOMPRESSED_TOTAL: u64 = 512 * 1024 * 1024;
/// Maximum accepted per-entry compression ratio (decompressed / compressed).
pub(crate) const XLSX_ZIP_RATIO: u64 = 200;
/// Maximum declared decompressed size of `xl/sharedStrings.xml`.
pub(crate) const XLSX_SHARED_STRINGS_CAP: u64 = 24 * 1024 * 1024;
/// Maximum declared decompressed size of `xl/styles.xml`.
pub(crate) const XLSX_STYLES_CAP: u64 = 4 * 1024 * 1024;

/// Maximum number of rows in one preview page.
pub(crate) const ROW_CAP: usize = 500;
/// Maximum number of columns in one preview page.
pub(crate) const COL_CAP: usize = 64;
/// Maximum number of cells in one preview page.
pub(crate) const CELL_CAP: usize = 32_000;
/// Maximum number of characters kept for one cell.
pub(crate) const CELL_CHAR_CAP: usize = 512;
/// Maximum UTF-8 bytes of cell text in one response.
pub(crate) const CELL_TEXT_BUDGET: usize = 2 * 1024 * 1024;

/// Maximum number of worksheet names returned to the frontend.
pub(crate) const SHEET_NAMES_CAP: usize = 200;
/// Maximum characters kept for one worksheet name.
pub(crate) const SHEET_NAME_LEN: usize = 128;
/// Maximum accepted row offset; deeper paging would require re-reading too much.
pub(crate) const PAGE_OFFSET_CAP: u32 = 5_000;
/// Wall-clock budget for a table preview before a partial page is returned.
pub(crate) const TABLE_DEADLINE: Duration = Duration::from_secs(5);

/// Excel worksheet row limit; a declared dimension at or above it is untrusted.
const MAX_EXCEL_ROWS: u64 = 1_048_576;
/// Excel worksheet column limit; a declared dimension at or above it is untrusted.
const MAX_EXCEL_COLUMNS: u64 = 16_384;

/// Table preview parameters coming from the `get_file_preview` command.
#[derive(Clone, Copy, Debug)]
pub struct TableSpec {
    pub sheet_index: u32,
    pub offset: u32,
    pub limit: u32,
}

impl Default for TableSpec {
    fn default() -> Self {
        Self {
            sheet_index: 0,
            offset: 0,
            limit: ROW_CAP as u32,
        }
    }
}

impl TableSpec {
    /// Validates and clamps the optional command arguments.
    pub fn from_options(
        sheet_index: Option<u32>,
        offset: Option<u32>,
        limit: Option<u32>,
    ) -> Result<Self, String> {
        let offset = offset.unwrap_or(0);
        if offset > PAGE_OFFSET_CAP {
            return Err(format!(
                "Preview offset exceeds the {PAGE_OFFSET_CAP}-row limit"
            ));
        }
        let limit = limit.unwrap_or(ROW_CAP as u32).clamp(1, ROW_CAP as u32);
        Ok(Self {
            sheet_index: sheet_index.unwrap_or(0),
            offset,
            limit,
        })
    }

    pub(crate) fn row_limit(&self) -> usize {
        self.limit as usize
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FilePreview {
    kind: &'static str,
    content: String,
    size: u64,
    encoding: Option<&'static str>,
    /// Only serialized for detected encodings so text/image wire stays stable.
    #[serde(skip_serializing_if = "Option::is_none")]
    encoding_guess: Option<bool>,
    width: Option<u32>,
    height: Option<u32>,
    /// Only present for `kind == "table"`; text/image wire has no `table` key.
    #[serde(skip_serializing_if = "Option::is_none")]
    table: Option<TablePreview>,
}

impl FilePreview {
    pub(crate) fn legacy(
        kind: &'static str,
        content: String,
        size: u64,
        encoding: Option<&'static str>,
        width: Option<u32>,
        height: Option<u32>,
    ) -> Self {
        Self {
            kind,
            content,
            size,
            encoding,
            encoding_guess: None,
            width,
            height,
            table: None,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TablePreview {
    /// `"csv"` for .csv/.tsv and `"xlsx"` for .xlsx/.xlsm.
    format: &'static str,
    /// Detected CSV delimiter; `null` for workbooks.
    delimiter: Option<&'static str>,
    /// Current worksheet name; `null` for CSV.
    sheet_name: Option<String>,
    /// Current worksheet index; `null` for CSV.
    sheet_index: Option<u32>,
    /// All worksheet names (at most [`SHEET_NAMES_CAP`]); `null` for CSV.
    sheet_names: Option<Vec<String>>,
    /// Display-ready cell text, at most [`ROW_CAP`] rows and [`COL_CAP`] columns.
    rows: Vec<Vec<String>>,
    /// Known row count; CSV never counts rows, xlsx only when the dimension is credible.
    row_count: Option<u64>,
    /// `"dimension"` when `row_count` comes from the worksheet dimension.
    row_count_source: Option<&'static str>,
    /// Whether more rows exist beyond this page.
    has_more: bool,
    /// Whether the page was cut short by a cap, the budget or the deadline.
    truncated: bool,
    /// Why the page was cut short; `null` when `truncated` is false.
    truncated_reason: Option<&'static str>,
    /// Total worksheet columns when known; used by the column truncation notice.
    total_columns: Option<u32>,
}

impl TablePreview {
    fn new(
        format: &'static str,
        delimiter: Option<&'static str>,
        page: table::PageResult,
        sheet: Option<SheetMeta>,
    ) -> Self {
        // CSV has no worksheet metadata and falls back to the widest page row;
        // xlsx reports the worksheet column count (or null when untrusted).
        let total_columns = match sheet.as_ref() {
            Some(meta) => meta.total_columns,
            None => page.total_columns,
        };
        Self {
            format,
            delimiter,
            sheet_name: sheet.as_ref().map(|meta| meta.current.clone()),
            sheet_index: sheet.as_ref().map(|meta| meta.index),
            sheet_names: sheet.as_ref().map(|meta| meta.names.clone()),
            rows: page.rows,
            row_count: sheet.as_ref().and_then(|meta| meta.row_count),
            row_count_source: sheet
                .as_ref()
                .and_then(|meta| meta.row_count.map(|_| "dimension")),
            has_more: page.has_more,
            truncated: page.truncated,
            truncated_reason: page.truncated_reason,
            total_columns,
        }
    }
}

/// Worksheet metadata for workbook previews.
struct SheetMeta {
    names: Vec<String>,
    current: String,
    index: u32,
    row_count: Option<u64>,
    total_columns: Option<u32>,
}

/// Reads a local workspace file into a bounded preview payload.
///
/// `root` is the verified workspace root and `input` is either an absolute
/// local path or a path relative to `root`; both are canonicalized before the
/// workspace containment check.
pub fn read(root: &Path, input: &str, spec: TableSpec) -> Result<FilePreview, String> {
    let root = root.canonicalize().map_err(|e| e.to_string())?;
    let input = Path::new(input);
    let path = if input.is_absolute() {
        input.to_owned()
    } else {
        root.join(input)
    };
    let path = path
        .canonicalize()
        .map_err(|_| "File is not available locally. Sync it first, then retry.".to_string())?;
    if !path.starts_with(&root) {
        return Err("Preview is restricted to the current workspace directory".into());
    }
    if !std::fs::metadata(&path)
        .map_err(|e| e.to_string())?
        .is_file()
    {
        return Err("Select a regular file".into());
    }
    let size = std::fs::metadata(&path).map_err(|e| e.to_string())?.len();
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase());
    match extension.as_deref() {
        Some("csv") => {
            if size > CSV_INPUT_LIMIT {
                return Err("File is too large to preview".into());
            }
            let outcome = csv::preview(&path, spec, false)?;
            Ok(FilePreview {
                kind: "table",
                content: String::new(),
                size,
                encoding: Some(outcome.encoding),
                encoding_guess: Some(outcome.encoding_guess),
                width: None,
                height: None,
                table: Some(outcome.table),
            })
        }
        Some("tsv") => {
            if size > CSV_INPUT_LIMIT {
                return Err("File is too large to preview".into());
            }
            let outcome = csv::preview(&path, spec, true)?;
            Ok(FilePreview {
                kind: "table",
                content: String::new(),
                size,
                encoding: Some(outcome.encoding),
                encoding_guess: Some(outcome.encoding_guess),
                width: None,
                height: None,
                table: Some(outcome.table),
            })
        }
        Some("xlsx" | "xlsm") => {
            if size > XLSX_INPUT_LIMIT {
                return Err("Workbook is too large to preview".into());
            }
            let preview = xlsx::preview(&path, spec)?;
            Ok(FilePreview {
                kind: "table",
                content: String::new(),
                size,
                encoding: None,
                encoding_guess: None,
                width: None,
                height: None,
                table: Some(preview),
            })
        }
        _ => legacy::preview(&path, size),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn restricts_workspace_and_rejects_directories() {
        let root = std::env::temp_dir().join(format!("p4deck-preview-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        assert!(read(&root, "..", TableSpec::default()).is_err());
        assert!(read(&root, ".", TableSpec::default()).is_err());
        std::fs::remove_dir(root).unwrap();
    }

    #[test]
    fn dispatches_csv_and_tsv_to_table_previews() {
        let root =
            std::env::temp_dir().join(format!("p4deck-preview-csv-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        std::fs::write(root.join("data.csv"), b"id,name\n1,\"a,b\"\n").unwrap();
        std::fs::write(root.join("data.tsv"), b"id\tname\n1\tvalue\n").unwrap();
        std::fs::write(root.join("note.txt"), b"plain text").unwrap();

        let csv = read(&root, "data.csv", TableSpec::default()).unwrap();
        let wire = serde_json::to_value(&csv).unwrap();
        assert_eq!(wire["kind"], "table");
        assert_eq!(wire["content"], "");
        assert_eq!(wire["size"], 16);
        assert_eq!(wire["table"]["format"], "csv");
        assert_eq!(wire["table"]["rows"][1][1], "a,b");
        assert!(wire["table"]["sheetName"].is_null());

        let tsv = read(&root, "data.tsv", TableSpec::default()).unwrap();
        let wire = serde_json::to_value(&tsv).unwrap();
        assert_eq!(wire["table"]["delimiter"], "\t");

        let text = read(&root, "note.txt", TableSpec::default()).unwrap();
        let wire = serde_json::to_value(&text).unwrap();
        assert_eq!(wire["kind"], "text");
        assert!(wire.get("table").is_none());

        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn table_spec_clamps_and_validates_command_options() {
        assert_eq!(
            TableSpec::from_options(None, None, None).unwrap().limit,
            500
        );
        assert_eq!(
            TableSpec::from_options(None, None, Some(0)).unwrap().limit,
            1
        );
        assert_eq!(
            TableSpec::from_options(None, None, Some(9_999))
                .unwrap()
                .limit,
            500
        );
        assert_eq!(
            TableSpec::from_options(Some(2), None, None)
                .unwrap()
                .sheet_index,
            2
        );
        assert!(TableSpec::from_options(None, Some(5_001), None).is_err());
        assert_eq!(
            TableSpec::from_options(None, Some(5_000), None)
                .unwrap()
                .offset,
            5_000
        );
    }

    #[test]
    fn missing_table_field_keeps_legacy_wire_shape() {
        let preview = FilePreview::legacy("text", "hello".into(), 5, Some("UTF-8"), None, None);
        let wire = serde_json::to_value(preview).unwrap();
        assert!(wire.get("table").is_none());
        assert!(wire.get("encodingGuess").is_none());
        assert!(wire["width"].is_null());
        assert!(wire["height"].is_null());
        assert_eq!(wire["content"], "hello");
    }
}
