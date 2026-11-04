//! Bounded XLSX/XLSM preview: zip central-directory preflight followed by
//! `calamine` streaming cell reads.
//!
//! The preflight reads only the zip central directory: it validates entry
//! counts, declared entry sizes, the total declared decompressed size and the
//! compression ratio, and it caps the declared (and actually decompressed) size
//! of `xl/sharedStrings.xml` and `xl/styles.xml`, which calamine loads eagerly.
//! Cell values are then streamed through `worksheet_cells_reader` and the first
//! page of rows is formatted; `worksheet_range`/`worksheets()` are never used.

use calamine::{DataRef, Dimensions, ExcelDateTime, Reader, Xlsx};
use std::fs::File;
use std::io::{BufReader, Read, Seek, SeekFrom};
use std::path::Path;
use std::time::Instant;
use zip::ZipArchive;

use super::table::{PageLimits, PageWriter, Stop};
use super::{
    SheetMeta, TablePreview, TableSpec, MAX_EXCEL_COLUMNS, MAX_EXCEL_ROWS, SHEET_NAMES_CAP,
    SHEET_NAME_LEN, TABLE_DEADLINE, XLSX_ENTRY_CAP, XLSX_SHARED_STRINGS_CAP, XLSX_STYLES_CAP,
    XLSX_UNCOMPRESSED_TOTAL, XLSX_ZIP_ENTRIES, XLSX_ZIP_RATIO,
};

const DAMAGED: &str = "Unsupported or damaged workbook";

pub(crate) fn preview(path: &Path, spec: TableSpec) -> Result<TablePreview, String> {
    let file = File::open(path).map_err(|error| error.to_string())?;
    preview_reader(file, spec)
}

fn preview_reader<R: Read + Seek>(mut reader: R, spec: TableSpec) -> Result<TablePreview, String> {
    let mut magic = [0u8; 4];
    let read = reader
        .read(&mut magic)
        .map_err(|_| "This file could not be read for preview".to_string())?;
    if read < magic.len() || magic != *b"PK\x03\x04" {
        return Err(DAMAGED.into());
    }
    reader
        .seek(SeekFrom::Start(0))
        .map_err(|_| "This file could not be read for preview".to_string())?;
    preflight(&mut reader)?;
    reader
        .seek(SeekFrom::Start(0))
        .map_err(|_| "This file could not be read for preview".to_string())?;
    let mut workbook = Xlsx::new(BufReader::new(reader)).map_err(|_| DAMAGED.to_string())?;
    let names = workbook.sheet_names();
    if names.is_empty() {
        return Err(DAMAGED.into());
    }
    let index = spec.sheet_index as usize;
    if index >= names.len() {
        return Err(format!(
            "Worksheet index is out of range ({} sheets)",
            names.len()
        ));
    }
    let current = names[index].clone();
    let mut cells = workbook
        .worksheet_cells_reader(&current)
        .map_err(|_| DAMAGED.to_string())?;
    let dimensions = cells.dimensions();
    let mut credible = credible_dimension(dimensions);
    let limits = PageLimits {
        row_cap: spec.row_limit(),
        ..PageLimits::default()
    };
    let mut writer = PageWriter::new(limits, Instant::now() + TABLE_DEADLINE);
    let mut first_row: Option<u32> = None;
    let mut has_more = false;
    let mut visited: usize = 0;
    loop {
        match cells.next_cell() {
            Ok(Some(cell)) => {
                visited += 1;
                if visited.is_multiple_of(4_096) {
                    writer.tick();
                    if writer.is_stopped() {
                        has_more = true;
                        break;
                    }
                }
                let (row, column) = cell.get_position();
                if let Some(info) = credible {
                    if row > info.end.0 || column > info.end.1 {
                        // The declared dimension is smaller than the real data.
                        credible = None;
                    }
                }
                let first = *first_row.get_or_insert(row);
                let logical = row.saturating_sub(first);
                if logical < spec.offset {
                    continue;
                }
                let page_row = (logical - spec.offset) as usize;
                if page_row >= spec.row_limit() {
                    has_more = true;
                    writer.stop(Stop::RowCap);
                    break;
                }
                if !writer.ensure_row(page_row) {
                    has_more = true;
                    writer.stop(Stop::RowCap);
                    break;
                }
                let value = cell.get_value();
                // Blank cells (for example style-only cells) carry no content and
                // are skipped instead of padding columns.
                if matches!(value, DataRef::Empty) {
                    continue;
                }
                writer.set_cell(page_row, column as usize, format_cell(value));
                if writer.is_stopped() {
                    has_more = true;
                    break;
                }
            }
            Ok(None) => break,
            Err(_) => return Err(DAMAGED.into()),
        }
    }
    let mut page = writer.finish(has_more);
    if page.rows.is_empty() {
        page.has_more = false;
    } else if let Some(info) = credible {
        if !page.truncated {
            page.has_more = info.rows > u64::from(spec.offset) + page.rows.len() as u64;
        }
    }
    let row_count = if page.rows.is_empty() {
        None
    } else {
        credible.map(|info| info.rows)
    };
    let total_columns = credible.and_then(|info| {
        if page.rows.is_empty() {
            None
        } else {
            Some(info.columns as u32)
        }
    });
    let sheet_names: Vec<String> = names
        .iter()
        .take(SHEET_NAMES_CAP)
        .map(|name| clip_sheet_name(name))
        .collect();
    let names_truncated = names.len() > SHEET_NAMES_CAP;
    let sheet = SheetMeta {
        names: sheet_names,
        current: clip_sheet_name(&current),
        index: spec.sheet_index,
        row_count,
        total_columns,
    };
    let mut table = TablePreview::new("xlsx", None, page, Some(sheet));
    if names_truncated {
        table.truncated = true;
    }
    Ok(table)
}

/// Validated worksheet dimensions: row/column counts plus the declared end cell.
#[derive(Clone, Copy)]
struct DimensionInfo {
    rows: u64,
    columns: u64,
    end: (u32, u32),
}

/// Validated worksheet dimensions. `None` when the declaration is not credible
/// (inverted, at/over the Excel grid limits, or contradicted by real cells).
fn credible_dimension(dimensions: Dimensions) -> Option<DimensionInfo> {
    if dimensions.end.0 < dimensions.start.0 || dimensions.end.1 < dimensions.start.1 {
        return None;
    }
    let rows = u64::from(dimensions.end.0) - u64::from(dimensions.start.0) + 1;
    let columns = u64::from(dimensions.end.1) - u64::from(dimensions.start.1) + 1;
    if rows >= MAX_EXCEL_ROWS || columns >= MAX_EXCEL_COLUMNS {
        return None;
    }
    Some(DimensionInfo {
        rows,
        columns,
        end: dimensions.end,
    })
}

fn clip_sheet_name(name: &str) -> String {
    if name.chars().count() <= SHEET_NAME_LEN {
        return name.to_string();
    }
    let mut clipped: String = name
        .chars()
        .take(SHEET_NAME_LEN.saturating_sub(1))
        .collect();
    clipped.push('…');
    clipped
}

/// Validates the zip central directory before anything is decompressed.
fn preflight<R: Read + Seek>(reader: &mut R) -> Result<(), String> {
    let mut archive = ZipArchive::new(reader).map_err(|_| DAMAGED.to_string())?;
    let entries = archive.len();
    if entries > XLSX_ZIP_ENTRIES {
        return Err("Workbook contains too many archive entries to preview".into());
    }
    let mut total: u64 = 0;
    let mut shared_strings: Option<usize> = None;
    let mut styles: Option<usize> = None;
    for index in 0..entries {
        let entry = archive.by_index(index).map_err(|_| DAMAGED.to_string())?;
        let name = entry.name().map_err(|_| DAMAGED.to_string())?.into_owned();
        let size = entry.size();
        let compressed = entry.compressed_size();
        drop(entry);
        if size > XLSX_ENTRY_CAP {
            return Err("Workbook entry exceeds the preview size limit".into());
        }
        total = total.saturating_add(size);
        if total > XLSX_UNCOMPRESSED_TOTAL {
            return Err("Workbook expands beyond the preview size limit".into());
        }
        if size > 1024 * 1024 && compressed > 0 && size / compressed > XLSX_ZIP_RATIO {
            return Err("Workbook compression ratio is unsafe for preview".into());
        }
        match name.as_str() {
            "xl/sharedStrings.xml" => shared_strings = Some(index),
            "xl/styles.xml" => styles = Some(index),
            _ => {}
        }
    }
    if let Some(index) = shared_strings {
        let entry = archive.by_index(index).map_err(|_| DAMAGED.to_string())?;
        if entry.size() > XLSX_SHARED_STRINGS_CAP {
            return Err("Workbook string table is too large to preview".into());
        }
        enforce_decompressed_cap(
            entry,
            XLSX_SHARED_STRINGS_CAP,
            "Workbook string table is too large to preview",
        )?;
    }
    if let Some(index) = styles {
        let entry = archive.by_index(index).map_err(|_| DAMAGED.to_string())?;
        if entry.size() > XLSX_STYLES_CAP {
            return Err("Workbook styles are too large to preview".into());
        }
        enforce_decompressed_cap(
            entry,
            XLSX_STYLES_CAP,
            "Workbook styles are too large to preview",
        )?;
    }
    Ok(())
}

/// Reads a decompression stream and rejects it when it produces more than `cap`
/// bytes, so a liar in the central directory cannot bypass the declared-size
/// checks.
fn enforce_decompressed_cap(reader: impl Read, cap: u64, message: &str) -> Result<(), String> {
    let mut limited = reader.take(cap.saturating_add(1));
    let copied =
        std::io::copy(&mut limited, &mut std::io::sink()).map_err(|_| DAMAGED.to_string())?;
    if copied > cap {
        Err(message.to_string())
    } else {
        Ok(())
    }
}

/// Formats one cached cell value as display text. Formula values are the values
/// cached in the file; nothing is evaluated.
fn format_cell(value: &DataRef<'_>) -> String {
    match value {
        DataRef::Empty => String::new(),
        DataRef::String(text) => text.clone(),
        DataRef::SharedString(text) => (*text).to_string(),
        DataRef::Int(number) => number.to_string(),
        DataRef::Float(number) => number.to_string(),
        DataRef::Bool(flag) => {
            if *flag {
                "TRUE".into()
            } else {
                "FALSE".into()
            }
        }
        DataRef::DateTime(datetime) => format_excel_datetime(datetime),
        DataRef::DateTimeIso(text) | DataRef::DurationIso(text) => text.clone(),
        DataRef::Error(error) => error.to_string(),
    }
}

/// Formats an Excel serial date/time the way spreadsheets display it: date only,
/// time only (serial < 1) or date + time. Duration cells use total hours.
fn format_excel_datetime(datetime: &ExcelDateTime) -> String {
    let (year, month, day, hour, minute, second, milli) = datetime.to_ymd_hms_milli();
    if datetime.is_duration() {
        let total_hours = (datetime.as_f64() * 24.0).round() as u64;
        return format!("{total_hours:02}:{minute:02}:{second:02}");
    }
    if datetime.as_f64() < 1.0 {
        if milli == 0 {
            return format!("{hour:02}:{minute:02}:{second:02}");
        }
        return format!("{hour:02}:{minute:02}:{second:02}.{milli:03}");
    }
    if hour == 0 && minute == 0 && second == 0 && milli == 0 {
        format!("{year:04}-{month:02}-{day:02}")
    } else {
        format!("{year:04}-{month:02}-{day:02} {hour:02}:{minute:02}:{second:02}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Cursor, Seek, Write};
    use zip::write::SimpleFileOptions;
    use zip::{CompressionMethod, ZipWriter};

    struct SheetFixture {
        name: &'static str,
        xml: String,
    }

    fn worksheet(dimension: Option<&str>, rows: &str) -> String {
        let dimension = dimension
            .map(|value| format!(r#"<dimension ref="{value}"/>"#))
            .unwrap_or_default();
        format!(
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">{dimension}<sheetData>{rows}</sheetData></worksheet>"#
        )
    }

    fn inline_sheet(rows: &[[&str; 2]]) -> String {
        let mut xml = String::new();
        for (row, cells) in rows.iter().enumerate() {
            let number = row + 1;
            xml.push_str(&format!(r#"<row r="{number}">"#));
            for (column, value) in cells.iter().enumerate() {
                let letter = column_letter(column);
                xml.push_str(&format!(
                    r#"<c r="{letter}{number}" t="inlineStr"><is><t>{value}</t></is></c>"#
                ));
            }
            xml.push_str("</row>");
        }
        worksheet(None, &xml)
    }

    fn column_letter(column: usize) -> String {
        let mut column = column + 1;
        let mut letters = String::new();
        while column > 0 {
            let remainder = (column - 1) % 26;
            letters.insert(0, (b'A' + remainder as u8) as char);
            column = (column - 1) / 26;
        }
        letters
    }

    fn start<W: Write + Seek>(zip: &mut ZipWriter<W>, name: &str, bytes: &[u8]) {
        zip.start_file(
            name,
            SimpleFileOptions::default().compression_method(CompressionMethod::Stored),
        )
        .unwrap();
        zip.write_all(bytes).unwrap();
    }

    /// Builds an in-memory minimal xlsx workbook.
    fn build_xlsx(
        sheets: &[SheetFixture],
        shared: Option<&str>,
        styles: Option<&str>,
        extra: &[(&str, &[u8])],
    ) -> Vec<u8> {
        let mut cursor = Cursor::new(Vec::new());
        {
            let mut zip = ZipWriter::new(&mut cursor);
            let mut overrides = String::new();
            for index in 0..sheets.len() {
                overrides.push_str(&format!(
                    r#"<Override PartName="/xl/worksheets/sheet{}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>"#,
                    index + 1
                ));
            }
            if shared.is_some() {
                overrides.push_str(r#"<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>"#);
            }
            if styles.is_some() {
                overrides.push_str(r#"<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>"#);
            }
            let content_types = format!(
                r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>{overrides}</Types>"#
            );
            start(&mut zip, "[Content_Types].xml", content_types.as_bytes());
            start(
                &mut zip,
                "_rels/.rels",
                br#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>"#,
            );
            let mut sheet_entries = String::new();
            for (index, sheet) in sheets.iter().enumerate() {
                sheet_entries.push_str(&format!(
                    r#"<sheet name="{}" sheetId="{}" r:id="rId{}"/>"#,
                    sheet.name,
                    index + 1,
                    index + 1
                ));
            }
            let workbook = format!(
                r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>{sheet_entries}</sheets></workbook>"#
            );
            start(&mut zip, "xl/workbook.xml", workbook.as_bytes());
            let mut relationships = String::new();
            for index in 0..sheets.len() {
                relationships.push_str(&format!(
                    r#"<Relationship Id="rId{}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet{}.xml"/>"#,
                    index + 1,
                    index + 1
                ));
            }
            let mut next_id = sheets.len() + 1;
            if shared.is_some() {
                relationships.push_str(&format!(
                    r#"<Relationship Id="rId{next_id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>"#
                ));
                next_id += 1;
            }
            if styles.is_some() {
                relationships.push_str(&format!(
                    r#"<Relationship Id="rId{next_id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>"#
                ));
            }
            let relationships = format!(
                r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">{relationships}</Relationships>"#
            );
            start(
                &mut zip,
                "xl/_rels/workbook.xml.rels",
                relationships.as_bytes(),
            );
            for (index, sheet) in sheets.iter().enumerate() {
                start(
                    &mut zip,
                    &format!("xl/worksheets/sheet{}.xml", index + 1),
                    sheet.xml.as_bytes(),
                );
            }
            if let Some(shared) = shared {
                start(&mut zip, "xl/sharedStrings.xml", shared.as_bytes());
            }
            if let Some(styles) = styles {
                start(&mut zip, "xl/styles.xml", styles.as_bytes());
            }
            for (name, bytes) in extra {
                start(&mut zip, name, bytes);
            }
            zip.finish().unwrap();
        }
        cursor.into_inner()
    }

    fn one_sheet(rows: &[[&str; 2]]) -> Vec<u8> {
        build_xlsx(
            &[SheetFixture {
                name: "Sheet1",
                xml: inline_sheet(rows),
            }],
            None,
            None,
            &[],
        )
    }

    fn preview(bytes: Vec<u8>, spec: TableSpec) -> Result<TablePreview, String> {
        preview_reader(Cursor::new(bytes), spec)
    }

    fn preview_default(bytes: Vec<u8>) -> TablePreview {
        preview(bytes, TableSpec::default()).unwrap()
    }

    fn patch_central_directory(
        bytes: &mut [u8],
        target_name: &str,
        uncompressed: Option<u32>,
        compressed: Option<u32>,
    ) {
        let mut offset = 0usize;
        while offset + 46 <= bytes.len() {
            if bytes[offset..offset + 4] == [0x50, 0x4b, 0x01, 0x02] {
                let name_len =
                    u16::from_le_bytes([bytes[offset + 28], bytes[offset + 29]]) as usize;
                let extra_len =
                    u16::from_le_bytes([bytes[offset + 30], bytes[offset + 31]]) as usize;
                let comment_len =
                    u16::from_le_bytes([bytes[offset + 32], bytes[offset + 33]]) as usize;
                let name_start = offset + 46;
                if name_start + name_len <= bytes.len()
                    && &bytes[name_start..name_start + name_len] == target_name.as_bytes()
                {
                    if let Some(value) = uncompressed {
                        bytes[offset + 24..offset + 28].copy_from_slice(&value.to_le_bytes());
                    }
                    if let Some(value) = compressed {
                        bytes[offset + 20..offset + 24].copy_from_slice(&value.to_le_bytes());
                    }
                    return;
                }
                offset = name_start + name_len + extra_len + comment_len;
            } else {
                offset += 1;
            }
        }
        panic!("central directory entry not found: {target_name}");
    }

    #[test]
    fn minimal_workbook_reads_rows_and_columns() {
        let table = preview_default(one_sheet(&[["id", "name"], ["1", "alpha"], ["2", "beta"]]));
        assert_eq!(table.rows.len(), 3);
        assert_eq!(table.rows[0], vec!["id", "name"]);
        assert_eq!(table.rows[2], vec!["2", "beta"]);
        assert_eq!(table.sheet_name.as_deref(), Some("Sheet1"));
        assert_eq!(table.sheet_index, Some(0));
        assert_eq!(table.row_count, None);
        assert_eq!(table.total_columns, None);
        assert!(!table.truncated);
    }

    #[test]
    fn shared_strings_and_inline_strings_are_formatted() {
        let shared = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="2" uniqueCount="2"><si><t>名称</t></si><si><t>中文</t></si></sst>"#;
        let sheet = worksheet(
            Some("A1:B2"),
            r#"<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="inlineStr"><is><t>inline</t></is></c></row><row r="2"><c r="A2" t="s"><v>1</v></c></row>"#,
        );
        let bytes = build_xlsx(
            &[SheetFixture {
                name: "Sheet1",
                xml: sheet,
            }],
            Some(shared),
            None,
            &[],
        );
        let table = preview_default(bytes);
        assert_eq!(table.rows[0], vec!["名称", "inline"]);
        assert_eq!(table.rows[1][0], "中文");
        assert_eq!(table.row_count, Some(2));
        assert_eq!(table.row_count_source, Some("dimension"));
        assert_eq!(table.total_columns, Some(2));
    }

    #[test]
    fn numbers_booleans_and_empty_cells_are_formatted() {
        let sheet = worksheet(
            Some("A1:C2"),
            r#"<row r="1"><c r="A1"><v>42</v></c><c r="B1" t="b"><v>1</v></c><c r="C1" t="b"><v>0</v></c></row><row r="2"><c r="A2"><v>1.5</v></c><c r="C2" t="e"><v>#DIV/0!</v></c></row>"#,
        );
        let table = preview_default(build_xlsx(
            &[SheetFixture {
                name: "Sheet1",
                xml: sheet,
            }],
            None,
            None,
            &[],
        ));
        assert_eq!(table.rows[0], vec!["42", "TRUE", "FALSE"]);
        assert_eq!(table.rows[1][0], "1.5");
        assert_eq!(table.rows[1][1], "");
        assert_eq!(table.rows[1][2], "#DIV/0!");
    }

    #[test]
    fn date_number_format_is_formatted_like_a_spreadsheet() {
        let styles = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>"#;
        // 46024 = 2026-01-02 in the 1900 date system.
        let sheet = worksheet(
            Some("A1:B1"),
            r#"<row r="1"><c r="A1" s="1"><v>46024</v></c><c r="B1" s="1"><v>46024.5</v></c></row>"#,
        );
        let table = preview_default(build_xlsx(
            &[SheetFixture {
                name: "Sheet1",
                xml: sheet,
            }],
            None,
            Some(styles),
            &[],
        ));
        assert_eq!(table.rows[0][0], "2026-01-02");
        assert_eq!(table.rows[0][1], "2026-01-02 12:00:00");
    }

    #[test]
    fn row_cap_truncates_to_500_rows() {
        let mut rows = String::new();
        for row in 1..=501 {
            rows.push_str(&format!(
                r#"<row r="{row}"><c r="A{row}"><v>{row}</v></c></row>"#
            ));
        }
        let bytes = build_xlsx(
            &[SheetFixture {
                name: "Sheet1",
                xml: worksheet(Some("A1:A501"), &rows),
            }],
            None,
            None,
            &[],
        );
        let table = preview_default(bytes);
        assert_eq!(table.rows.len(), 500);
        assert_eq!(table.truncated_reason, Some("rowCap"));
        assert!(table.truncated);
        assert!(table.has_more);
        assert_eq!(table.row_count, Some(501));
    }

    #[test]
    fn column_cap_truncates_to_64_columns() {
        let mut cells = String::new();
        for column in 0..100 {
            let letter = column_letter(column);
            cells.push_str(&format!(r#"<c r="{letter}1"><v>{column}</v></c>"#));
        }
        let bytes = build_xlsx(
            &[SheetFixture {
                name: "Sheet1",
                xml: worksheet(Some("A1:CV1"), &format!(r#"<row r="1">{cells}</row>"#)),
            }],
            None,
            None,
            &[],
        );
        let table = preview_default(bytes);
        assert_eq!(table.rows[0].len(), 64);
        assert_eq!(table.truncated_reason, Some("colCap"));
        assert_eq!(table.total_columns, Some(100));
    }

    #[test]
    fn empty_sheet_previews_without_rows() {
        let bytes = build_xlsx(
            &[SheetFixture {
                name: "Sheet1",
                xml: worksheet(Some("A1"), ""),
            }],
            None,
            None,
            &[],
        );
        let table = preview_default(bytes);
        assert!(table.rows.is_empty());
        assert_eq!(table.row_count, None);
        assert_eq!(table.total_columns, None);
        assert!(!table.truncated);
    }

    #[test]
    fn sheet_index_out_of_range_reports_total_count() {
        let bytes = build_xlsx(
            &[
                SheetFixture {
                    name: "First",
                    xml: inline_sheet(&[["a", "b"]]),
                },
                SheetFixture {
                    name: "Second",
                    xml: inline_sheet(&[["c", "d"]]),
                },
            ],
            None,
            None,
            &[],
        );
        let error = preview(
            bytes.clone(),
            TableSpec {
                sheet_index: 7,
                ..Default::default()
            },
        )
        .unwrap_err();
        assert!(error.contains('2'), "unexpected error: {error}");
        let table = preview(
            bytes,
            TableSpec {
                sheet_index: 1,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(table.sheet_name.as_deref(), Some("Second"));
        assert_eq!(table.sheet_index, Some(1));
        assert_eq!(table.rows[0], vec!["c", "d"]);
        assert_eq!(
            table.sheet_names.as_deref(),
            Some(&["First".to_string(), "Second".to_string()][..])
        );
    }

    #[test]
    fn bad_zip_and_missing_workbook_are_rejected() {
        let error = preview(b"not a zip".to_vec(), TableSpec::default()).unwrap_err();
        assert_eq!(error, DAMAGED);
        let mut cursor = Cursor::new(Vec::new());
        {
            let mut zip = ZipWriter::new(&mut cursor);
            start(&mut zip, "[Content_Types].xml", b"<Types/>");
            zip.finish().unwrap();
        }
        let error = preview(cursor.into_inner(), TableSpec::default()).unwrap_err();
        assert_eq!(error, DAMAGED);
    }

    #[test]
    fn declared_zip_bomb_is_rejected_before_decompression() {
        let mut bytes = one_sheet(&[["a", "b"]]);
        // Claim a 300 MiB worksheet entry, above XLSX_ENTRY_CAP.
        patch_central_directory(
            &mut bytes,
            "xl/worksheets/sheet1.xml",
            Some(300 * 1024 * 1024),
            None,
        );
        let error = preview(bytes, TableSpec::default()).unwrap_err();
        assert!(error.contains("exceeds"), "unexpected error: {error}");
    }

    #[test]
    fn oversized_shared_strings_declaration_is_rejected() {
        let shared = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>a</t></si></sst>"#;
        let mut bytes = build_xlsx(
            &[SheetFixture {
                name: "Sheet1",
                xml: worksheet(
                    Some("A1"),
                    r#"<row r="1"><c r="A1" t="s"><v>0</v></c></row>"#,
                ),
            }],
            Some(shared),
            None,
            &[],
        );
        patch_central_directory(
            &mut bytes,
            "xl/sharedStrings.xml",
            Some(XLSX_SHARED_STRINGS_CAP as u32 + 1),
            Some(XLSX_SHARED_STRINGS_CAP as u32),
        );
        let error = preview(bytes, TableSpec::default()).unwrap_err();
        assert!(error.contains("string table"), "unexpected error: {error}");
    }

    #[test]
    fn decompressed_stream_cap_is_enforced() {
        assert!(enforce_decompressed_cap(std::io::repeat(b'a'), 16, "too large").is_err());
        assert!(enforce_decompressed_cap(&b"short"[..], 16, "too large").is_ok());
    }

    #[test]
    fn xlsm_vba_project_is_not_extracted_or_executed() {
        let bytes = build_xlsx(
            &[SheetFixture {
                name: "Sheet1",
                xml: inline_sheet(&[["a", "b"]]),
            }],
            None,
            None,
            &[("xl/vbaProject.bin", &[0xde, 0xad, 0xbe, 0xef])],
        );
        let table = preview_default(bytes);
        assert_eq!(table.rows[0], vec!["a", "b"]);
    }

    #[test]
    fn untrusted_dimension_yields_no_row_count() {
        let bytes = build_xlsx(
            &[SheetFixture {
                name: "Sheet1",
                xml: worksheet(
                    Some("A1:XFD1048576"),
                    r#"<row r="1"><c r="A1"><v>1</v></c></row>"#,
                ),
            }],
            None,
            None,
            &[],
        );
        let table = preview_default(bytes);
        assert_eq!(table.row_count, None);
        assert_eq!(table.row_count_source, None);
        assert_eq!(table.total_columns, None);
        assert_eq!(table.rows[0][0], "1");
    }

    #[test]
    fn offset_and_limit_select_a_page() {
        let mut rows = String::new();
        for row in 1..=10 {
            rows.push_str(&format!(
                r#"<row r="{row}"><c r="A{row}"><v>{row}</v></c></row>"#
            ));
        }
        let bytes = build_xlsx(
            &[SheetFixture {
                name: "Sheet1",
                xml: worksheet(Some("A1:A10"), &rows),
            }],
            None,
            None,
            &[],
        );
        let table = preview(
            bytes,
            TableSpec {
                sheet_index: 0,
                offset: 3,
                limit: 2,
            },
        )
        .unwrap();
        assert_eq!(table.rows.len(), 2);
        assert_eq!(table.rows[0][0], "4");
        assert_eq!(table.rows[1][0], "5");
        assert!(table.has_more);
        assert_eq!(table.row_count, Some(10));
    }

    #[test]
    fn rendered_table_json_stays_bounded() {
        let mut rows = String::new();
        for row in 1..=500 {
            rows.push_str(&format!(r#"<row r="{row}">"#));
            for column in 0..64 {
                let letter = column_letter(column);
                rows.push_str(&format!(
                    r#"<c r="{letter}{row}" t="inlineStr"><is><t>{}</t></is></c>"#,
                    "x".repeat(64)
                ));
            }
            rows.push_str("</row>");
        }
        let bytes = build_xlsx(
            &[SheetFixture {
                name: "Sheet1",
                xml: worksheet(Some("A1:BL500"), &rows),
            }],
            None,
            None,
            &[],
        );
        let table = preview_default(bytes);
        let wire = serde_json::to_vec(&table).unwrap();
        assert!(wire.len() <= 2_500_000, "wire too large: {}", wire.len());
        assert!(!table.truncated || table.truncated_reason.is_some());
    }

    #[test]
    #[ignore = "requires P4DECK_PREVIEW_SAMPLE pointing at a real .xlsx file"]
    fn preview_real_sample_from_env() {
        let path = std::env::var("P4DECK_PREVIEW_SAMPLE")
            .expect("set P4DECK_PREVIEW_SAMPLE to a real .xlsx path before running --ignored");
        let started = Instant::now();
        let sheet0 = super::preview(Path::new(&path), TableSpec::default()).unwrap();
        println!(
            "sheet0 name={:?} rows={} cols={:?} rowCount={:?} truncated={:?} hasMore={} elapsed={:?}",
            sheet0.sheet_name,
            sheet0.rows.len(),
            sheet0.total_columns,
            sheet0.row_count,
            sheet0.truncated_reason,
            sheet0.has_more,
            started.elapsed()
        );
        assert!(!sheet0.rows.is_empty());

        let started = Instant::now();
        let sheet1 = super::preview(
            Path::new(&path),
            TableSpec {
                sheet_index: 1,
                ..Default::default()
            },
        )
        .unwrap();
        println!(
            "sheet1 name={:?} rows={} cols={:?} rowCount={:?} truncated={:?} hasMore={} elapsed={:?}",
            sheet1.sheet_name,
            sheet1.rows.len(),
            sheet1.total_columns,
            sheet1.row_count,
            sheet1.truncated_reason,
            sheet1.has_more,
            started.elapsed()
        );
        assert_eq!(sheet1.sheet_index, Some(1));
        assert!(!sheet1.rows.is_empty());
        assert!(started.elapsed() < std::time::Duration::from_secs(5));
    }
}
