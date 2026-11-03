//! Bounded CSV/TSV preview: encoding cascade, delimiter detection, RFC 4180
//! state machine and page limits.
//!
//! Only the first [`CSV_READ_CAP`] raw bytes are decoded; rows/columns/cells and
//! the text budget stop the page early. Whenever a cap (or the deadline) cuts
//! the page, the partial rows are returned with a `truncatedReason` instead of
//! failing the preview.

use encoding_rs::{
    CoderResult, Decoder, Encoding, GB18030, UTF_16BE, UTF_16LE, UTF_8, WINDOWS_1252,
};
use std::fs::File;
use std::io::{Cursor, Read};
use std::path::Path;
use std::time::Instant;

use super::table::{PageLimits, PageWriter, Stop};
use super::{TablePreview, TableSpec, CSV_FIELD_CAP, CSV_READ_CAP, TABLE_DEADLINE};

/// Raw prefix used for encoding and delimiter detection.
const HEAD_PROBE: usize = 64 * 1024;
/// Raw decode chunk size.
const DECODE_CHUNK: usize = 64 * 1024;
/// Candidate delimiters, in tie-break priority order.
const DELIMITER_CANDIDATES: [char; 4] = [',', '\t', ';', '|'];

/// Result of one CSV page: the table plus the detected encoding metadata.
pub(crate) struct CsvOutcome {
    pub table: TablePreview,
    pub encoding: &'static str,
    pub encoding_guess: bool,
}

/// Tunable limits for one CSV page; production uses the module constants.
#[derive(Clone, Copy)]
pub(crate) struct CsvOptions {
    pub read_cap: u64,
    pub deadline: Instant,
    pub row_limit: usize,
    pub forced_tab: bool,
}

pub(crate) fn preview(
    path: &Path,
    spec: TableSpec,
    forced_tab: bool,
) -> Result<CsvOutcome, String> {
    let file = File::open(path).map_err(|error| error.to_string())?;
    let options = CsvOptions {
        read_cap: CSV_READ_CAP,
        deadline: Instant::now() + TABLE_DEADLINE,
        row_limit: spec.row_limit(),
        forced_tab,
    };
    preview_reader(file, spec, options)
}

fn preview_reader<R: Read>(
    mut input: R,
    spec: TableSpec,
    options: CsvOptions,
) -> Result<CsvOutcome, String> {
    let mut head = Vec::with_capacity(HEAD_PROBE);
    let mut buffer = [0u8; 8 * 1024];
    while head.len() < HEAD_PROBE {
        let want = (HEAD_PROBE - head.len()).min(buffer.len());
        let read = input
            .read(&mut buffer[..want])
            .map_err(|_| "This file could not be read for preview".to_string())?;
        if read == 0 {
            break;
        }
        head.extend_from_slice(&buffer[..read]);
    }
    let detected = detect_encoding(&head);
    let probe_text = detected.decode_probe(&head);
    if contains_binary_controls(&probe_text) {
        return Err("Binary files cannot be previewed as text".into());
    }
    let delimiter = if options.forced_tab {
        '\t'
    } else {
        detect_delimiter(&probe_text)
    };

    // The prefix already read is replayed from memory; the rest streams from the
    // same open file, so the file is opened exactly once.
    let stream = Cursor::new(head[detected.bom_len..].to_vec()).chain(input);
    let mut source = stream.take(options.read_cap);
    let mut decoder: Decoder = detected.encoding.new_decoder_without_bom_handling();
    let limits = PageLimits {
        row_cap: options.row_limit,
        ..PageLimits::default()
    };
    let mut parser = CsvParser::new(delimiter, spec, PageWriter::new(limits, options.deadline));
    let mut decoded = String::new();
    // `decode_to_string` treats the spare capacity of the destination as the
    // output limit and never reallocates, so reserve room for a whole chunk up
    // front (worst-case expansion is 3 bytes per input byte) and grow if a
    // chunk still fills the buffer.
    decoded.reserve(DECODE_CHUNK * 4);
    let mut raw = vec![0u8; DECODE_CHUNK];
    loop {
        let read = source
            .read(&mut raw)
            .map_err(|_| "This file could not be read for preview".to_string())?;
        let last = read == 0;
        decoded.clear();
        let mut offset = 0usize;
        loop {
            let (result, consumed, _) =
                decoder.decode_to_string(&raw[offset..read], &mut decoded, last);
            offset += consumed;
            if result == CoderResult::InputEmpty {
                break;
            }
            decoded.reserve(DECODE_CHUNK);
        }
        if !decoded.is_empty() {
            parser.push(&decoded);
        }
        if parser.is_stopped() || last {
            break;
        }
    }
    // The read cap (not EOF) ended the stream: return the partial page.
    if !parser.is_stopped() && source.limit() == 0 {
        let mut probe = [0u8; 1];
        let mut remainder = source.into_inner();
        if remainder
            .read(&mut probe)
            .map_err(|_| "This file could not be read for preview".to_string())?
            > 0
        {
            parser.stop(Stop::ByteCap);
            parser.mark_has_more();
        }
    }
    let page = parser.finish();
    Ok(CsvOutcome {
        table: TablePreview::new("csv", Some(delimiter_name(delimiter)), page, None),
        encoding: detected.name,
        encoding_guess: detected.guess,
    })
}

/// Machine-readable name of the detected encoding plus how it was detected.
#[derive(Clone, Copy)]
struct DetectedEncoding {
    encoding: &'static Encoding,
    name: &'static str,
    guess: bool,
    bom_len: usize,
}

impl DetectedEncoding {
    fn decode_probe(self, head: &[u8]) -> String {
        let bytes = &head[self.bom_len..];
        self.encoding
            .decode_without_bom_handling(bytes)
            .0
            .into_owned()
    }
}

/// Encoding cascade: BOM, strict UTF-8, strict GB18030, then Windows-1252.
fn detect_encoding(head: &[u8]) -> DetectedEncoding {
    if head.starts_with(&[0xef, 0xbb, 0xbf]) {
        return DetectedEncoding {
            encoding: UTF_8,
            name: "UTF-8",
            guess: false,
            bom_len: 3,
        };
    }
    if head.starts_with(&[0xff, 0xfe]) {
        return DetectedEncoding {
            encoding: UTF_16LE,
            name: "UTF-16 LE",
            guess: false,
            bom_len: 2,
        };
    }
    if head.starts_with(&[0xfe, 0xff]) {
        return DetectedEncoding {
            encoding: UTF_16BE,
            name: "UTF-16 BE",
            guess: false,
            bom_len: 2,
        };
    }
    if valid_utf8_prefix(head) {
        return DetectedEncoding {
            encoding: UTF_8,
            name: "UTF-8",
            guess: false,
            bom_len: 0,
        };
    }
    if decodes_as_gb18030(head) {
        return DetectedEncoding {
            encoding: GB18030,
            name: "GB18030",
            guess: true,
            bom_len: 0,
        };
    }
    DetectedEncoding {
        encoding: WINDOWS_1252,
        name: "Windows-1252",
        guess: true,
        bom_len: 0,
    }
}

/// True when the prefix is valid UTF-8 apart from a multi-byte sequence cut at
/// the probe boundary.
fn valid_utf8_prefix(bytes: &[u8]) -> bool {
    match std::str::from_utf8(bytes) {
        Ok(_) => true,
        // `error_len` is `None` when the decoded prefix ends in an incomplete
        // multi-byte sequence, which is expected for a bounded probe.
        Err(error) => error.error_len().is_none(),
    }
}

/// True when the prefix decodes as strict GB18030, tolerating a truncated
/// trailing multi-byte sequence.
fn decodes_as_gb18030(bytes: &[u8]) -> bool {
    if GB18030
        .decode_without_bom_handling_and_without_replacement(bytes)
        .is_some()
    {
        return true;
    }
    for trim in 1..=3 {
        if bytes.len() > trim
            && GB18030
                .decode_without_bom_handling_and_without_replacement(&bytes[..bytes.len() - trim])
                .is_some()
        {
            return true;
        }
    }
    false
}

/// Rejects binary payloads that decoded into control characters. This keeps a
/// random binary file saved as `.csv` from rendering as a bogus table.
fn contains_binary_controls(text: &str) -> bool {
    text.chars()
        .any(|character| character.is_control() && !matches!(character, '\t' | '\r' | '\n'))
}

/// Picks the delimiter whose outside-quotes count is the most consistent across
/// the first logical lines. Falls back to a comma for single-column input.
fn detect_delimiter(text: &str) -> char {
    let mut lines: Vec<[usize; DELIMITER_CANDIDATES.len()]> = Vec::new();
    let mut current = [0usize; DELIMITER_CANDIDATES.len()];
    let mut in_quotes = false;
    let mut pending_cr = false;
    let mut any_line = false;
    for character in text.chars().take(HEAD_PROBE) {
        if pending_cr {
            pending_cr = false;
            if character == '\n' {
                continue;
            }
        }
        match character {
            '"' => in_quotes = !in_quotes,
            '\r' if !in_quotes => {
                if any_line || current.iter().any(|count| *count > 0) {
                    lines.push(current);
                }
                current = [0; DELIMITER_CANDIDATES.len()];
                any_line = false;
                pending_cr = true;
            }
            '\n' if !in_quotes => {
                if any_line || current.iter().any(|count| *count > 0) {
                    lines.push(current);
                }
                current = [0; DELIMITER_CANDIDATES.len()];
                any_line = false;
            }
            other if !in_quotes => {
                any_line = true;
                for (index, candidate) in DELIMITER_CANDIDATES.iter().enumerate() {
                    if other == *candidate {
                        current[index] += 1;
                    }
                }
            }
            _ => {}
        }
        if lines.len() >= 20 {
            break;
        }
    }
    if current.iter().any(|count| *count > 0) {
        lines.push(current);
    }
    let mut best: Option<(char, usize, usize, usize)> = None;
    for (index, candidate) in DELIMITER_CANDIDATES.iter().enumerate() {
        let counts: Vec<usize> = lines
            .iter()
            .map(|line| line[index])
            .filter(|count| *count > 0)
            .collect();
        if counts.is_empty() {
            continue;
        }
        let mut modal = 0;
        let mut modal_frequency = 0;
        for count in &counts {
            let frequency = counts.iter().filter(|other| *other == count).count();
            if frequency > modal_frequency {
                modal = *count;
                modal_frequency = frequency;
            }
        }
        let score = (modal_frequency, counts.len(), modal);
        let better = match best {
            None => true,
            Some((_, best_frequency, best_lines, best_modal)) => {
                score.0 > best_frequency
                    || (score.0 == best_frequency
                        && (score.1 > best_lines
                            || (score.1 == best_lines && score.2 > best_modal)))
            }
        };
        if better {
            best = Some((*candidate, score.0, score.1, score.2));
        }
    }
    best.map(|(delimiter, ..)| delimiter).unwrap_or(',')
}

fn delimiter_name(delimiter: char) -> &'static str {
    match delimiter {
        '\t' => "\t",
        ';' => ";",
        '|' => "|",
        _ => ",",
    }
}

/// Streaming RFC 4180 parser feeding a [`PageWriter`].
struct CsvParser {
    delimiter: char,
    offset_left: u32,
    row_limit: usize,
    writer: PageWriter,
    field: String,
    field_char_count: usize,
    field_raw_bytes: usize,
    field_truncated: bool,
    quote_seen: bool,
    in_quotes: bool,
    after_quote: bool,
    pending_cr: bool,
    column: usize,
    /// Output row index of the record currently being parsed.
    page_row: usize,
    stopped: bool,
    has_more: bool,
}

impl CsvParser {
    fn new(delimiter: char, spec: TableSpec, writer: PageWriter) -> Self {
        Self {
            delimiter,
            offset_left: spec.offset,
            row_limit: spec.row_limit(),
            writer,
            field: String::new(),
            field_char_count: 0,
            field_raw_bytes: 0,
            field_truncated: false,
            quote_seen: false,
            in_quotes: false,
            after_quote: false,
            pending_cr: false,
            column: 0,
            page_row: 0,
            stopped: false,
            has_more: false,
        }
    }

    fn is_stopped(&self) -> bool {
        self.stopped
    }

    fn stop(&mut self, reason: Stop) {
        self.writer.stop(reason);
        self.stopped = true;
    }

    fn mark_has_more(&mut self) {
        self.has_more = true;
    }

    fn push(&mut self, text: &str) {
        for character in text.chars() {
            if self.stopped {
                return;
            }
            self.push_char(character);
        }
    }

    fn push_char(&mut self, character: char) {
        if self.pending_cr {
            self.pending_cr = false;
            if character == '\n' {
                return;
            }
        }
        if self.in_quotes {
            if character == '"' {
                self.in_quotes = false;
                self.after_quote = true;
            } else {
                self.push_field_char(character);
            }
            return;
        }
        if self.after_quote {
            self.after_quote = false;
            if character == '"' {
                // Escaped quote: `""` inside a quoted field.
                self.in_quotes = true;
                self.push_field_char('"');
                return;
            }
        }
        self.handle_outside(character);
    }

    fn handle_outside(&mut self, character: char) {
        if character == '"' && !self.quote_seen && self.field_raw_bytes == 0 {
            self.in_quotes = true;
            self.quote_seen = true;
            return;
        }
        if character == self.delimiter {
            self.complete_field();
            self.column += 1;
            return;
        }
        if character == '\r' {
            self.end_record();
            self.pending_cr = true;
            return;
        }
        if character == '\n' {
            self.end_record();
            return;
        }
        self.push_field_char(character);
    }

    fn push_field_char(&mut self, character: char) {
        self.field_raw_bytes += character.len_utf8();
        if self.field_char_count < super::CELL_CHAR_CAP {
            self.field.push(character);
            self.field_char_count += 1;
        } else {
            self.field_truncated = true;
        }
        if self.field_raw_bytes > CSV_FIELD_CAP {
            self.field_truncated = true;
        }
    }

    fn complete_field(&mut self) {
        if self.stopped {
            self.clear_field();
            return;
        }
        let text = self.take_field_text();
        let cell_was_truncated = self.field_truncated;
        if self.offset_left > 0 {
            self.clear_field();
            return;
        }
        if self.page_row >= self.row_limit {
            self.has_more = true;
            self.stop(Stop::RowCap);
            self.clear_field();
            return;
        }
        if !self.writer.ensure_row(self.page_row) {
            self.has_more = true;
            self.stop(Stop::RowCap);
            self.clear_field();
            return;
        }
        if cell_was_truncated {
            self.writer.mark_cell_truncated();
        }
        self.writer.set_cell(self.page_row, self.column, text);
        self.clear_field();
        if self.writer.is_stopped() {
            self.stopped = true;
            self.has_more = true;
        }
    }

    fn end_record(&mut self) {
        if self.stopped {
            self.reset_record();
            return;
        }
        let empty_line = self.column == 0 && self.field.is_empty() && !self.quote_seen;
        if empty_line {
            self.reset_record();
            return;
        }
        self.complete_field();
        if !self.stopped {
            if self.offset_left > 0 {
                self.offset_left -= 1;
            } else {
                self.page_row += 1;
            }
            self.writer.tick();
            if self.writer.is_stopped() {
                self.stopped = true;
                self.has_more = true;
            }
        }
        self.reset_record();
    }

    fn take_field_text(&mut self) -> String {
        let mut text = std::mem::take(&mut self.field);
        if self.field_truncated {
            text = truncate_field(text);
        }
        text
    }

    fn reset_record(&mut self) {
        self.clear_field();
        self.column = 0;
    }

    /// Resets the in-progress field but keeps the column counter.
    fn clear_field(&mut self) {
        self.field.clear();
        self.field_char_count = 0;
        self.field_raw_bytes = 0;
        self.field_truncated = false;
        self.quote_seen = false;
        self.in_quotes = false;
        self.after_quote = false;
    }

    fn finish(mut self) -> super::table::PageResult {
        // A last record without a trailing line break is still a record.
        if !self.stopped {
            let pending = self.column > 0 || !self.field.is_empty() || self.quote_seen;
            if pending {
                self.end_record();
            }
        }
        self.writer.finish(self.has_more)
    }
}

/// Keeps at most [`super::CELL_CHAR_CAP`] characters, ending with an ellipsis.
fn truncate_field(text: String) -> String {
    let mut truncated = String::new();
    for character in text.chars().take(super::CELL_CHAR_CAP.saturating_sub(1)) {
        truncated.push(character);
    }
    truncated.push('…');
    truncated
}

#[cfg(test)]
mod tests {
    use super::super::{FilePreview, TableSpec};
    use super::*;

    fn options(row_limit: usize) -> CsvOptions {
        CsvOptions {
            read_cap: CSV_READ_CAP,
            deadline: Instant::now() + TABLE_DEADLINE,
            row_limit,
            forced_tab: false,
        }
    }

    fn parse(bytes: &[u8], spec: TableSpec) -> Result<CsvOutcome, String> {
        preview_reader(Cursor::new(bytes.to_vec()), spec, options(spec.row_limit()))
    }

    fn rows(bytes: &[u8]) -> Vec<Vec<String>> {
        parse(bytes, TableSpec::default()).unwrap().table.rows
    }

    /// Reader that yields one byte per call, forcing every possible slice
    /// boundary (including between `\r` and `\n`) to be exercised.
    struct OneByteReader(Cursor<Vec<u8>>);

    impl Read for OneByteReader {
        fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
            if buffer.is_empty() {
                return Ok(0);
            }
            self.0.read(&mut buffer[..1])
        }
    }

    fn parse_one_byte(bytes: &[u8]) -> CsvOutcome {
        preview_reader(
            OneByteReader(Cursor::new(bytes.to_vec())),
            TableSpec::default(),
            options(500),
        )
        .unwrap()
    }

    #[test]
    fn one_byte_reads_parse_the_same_rows() {
        let parsed = parse_one_byte(b"a,b\r\nc,d\r\n");
        assert_eq!(
            parsed.table.rows,
            vec![
                vec!["a".to_string(), "b".into()],
                vec!["c".to_string(), "d".into()],
            ]
        );
    }

    #[test]
    fn basic_rows_and_cells() {
        assert_eq!(
            rows(b"a,b,c\n1,2,3"),
            vec![
                vec!["a".to_string(), "b".into(), "c".into()],
                vec!["1".to_string(), "2".into(), "3".into()],
            ]
        );
    }

    #[test]
    fn quoted_fields_keep_delimiters_and_escaped_quotes() {
        let parsed = rows(b"a,\"b,c\",d\n\"he said \"\"hi\"\"\"");
        assert_eq!(parsed[0], vec!["a", "b,c", "d"]);
        assert_eq!(parsed[1], vec!["he said \"hi\""]);
    }

    #[test]
    fn quoted_crlf_does_not_split_the_record() {
        let parsed = rows(b"x,\"line1\r\nline2\",y\n1,2,3");
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0], vec!["x", "line1\r\nline2", "y"]);
    }

    #[test]
    fn mixed_line_endings_and_trailing_record_without_newline() {
        let parsed = rows(b"a,b\r\nc,d\ne,f\rg,h");
        assert_eq!(parsed.len(), 4);
        assert_eq!(parsed[3], vec!["g", "h"]);
    }

    #[test]
    fn crlf_split_across_read_boundaries_is_one_row_break() {
        // The 64 KiB probe ends exactly on a `\r`; the `\n` and everything after
        // it are then read one byte at a time by `OneByteReader`, so the CRLF
        // pair straddles two buffers.
        let mut csv = vec![b'a'; HEAD_PROBE - 1];
        csv.extend_from_slice(b"\r\nb,c\r\n");
        let parsed = preview_reader(
            OneByteReader(Cursor::new(csv)),
            TableSpec::default(),
            options(500),
        )
        .unwrap();
        assert_eq!(parsed.table.rows.len(), 2);
        assert_eq!(
            parsed.table.rows[0][0].chars().count(),
            super::super::CELL_CHAR_CAP
        );
        assert_eq!(parsed.table.rows[1], vec!["b".to_string(), "c".into()]);
        assert_eq!(parsed.table.truncated_reason, None);
    }

    #[test]
    fn utf8_bom_and_utf16_boms() {
        let mut utf8_bom = vec![0xef, 0xbb, 0xbf];
        utf8_bom.extend_from_slice("名称,值\n中文,1".as_bytes());
        let parsed = parse(&utf8_bom, TableSpec::default()).unwrap();
        assert_eq!(parsed.encoding, "UTF-8");
        assert!(!parsed.encoding_guess);
        assert_eq!(parsed.table.rows[1][0], "中文");

        let mut le = vec![0xff, 0xfe];
        let mut be = vec![0xfe, 0xff];
        for unit in "名称,值\n中文,1".encode_utf16() {
            le.extend_from_slice(&unit.to_le_bytes());
            be.extend_from_slice(&unit.to_be_bytes());
        }
        for bytes in [le, be] {
            let parsed = parse(&bytes, TableSpec::default()).unwrap();
            assert!(parsed.encoding.starts_with("UTF-16"));
            assert_eq!(parsed.table.rows[1][0], "中文");
        }
    }

    #[test]
    fn gbk_bytes_are_detected_as_gb18030() {
        // "名称,值\n中文,1" encoded as GBK (no BOM). Hard-coded so the test does
        // not depend on an encoder.
        let bytes = [
            0xc3, 0xfb, 0xb3, 0xc6, 0x2c, 0xd6, 0xb5, 0x0a, 0xd6, 0xd0, 0xce, 0xc4, 0x2c, 0x31,
        ];
        let parsed = parse(&bytes, TableSpec::default()).unwrap();
        assert_eq!(parsed.encoding, "GB18030");
        assert!(parsed.encoding_guess);
        assert_eq!(parsed.table.rows[0], vec!["名称", "值"]);
        assert_eq!(parsed.table.rows[1], vec!["中文", "1"]);
    }

    #[test]
    fn detects_semicolon_tab_and_pipe_delimiters() {
        assert_eq!(
            rows(b"a;b;c\n1;2;3"),
            vec![
                vec!["a".to_string(), "b".into(), "c".into()],
                vec!["1".to_string(), "2".into(), "3".into()],
            ]
        );
        assert_eq!(rows(b"a\tb\n1\t2")[0], vec!["a", "b"]);
        assert_eq!(rows(b"a|b\n1|2")[0], vec!["a", "b"]);
    }

    #[test]
    fn delimiters_inside_quotes_do_not_win_detection() {
        let parsed = parse(b"\"a;b\";c\n\"d;e\";f", TableSpec::default()).unwrap();
        assert_eq!(parsed.table.delimiter, Some(";"));
        assert_eq!(parsed.table.rows[0], vec!["a;b", "c"]);
    }

    #[test]
    fn tsv_forces_tab_delimiter() {
        let mut options = options(500);
        options.forced_tab = true;
        let parsed = preview_reader(
            Cursor::new(b"a,b\tc,d\n1,2\t3,4".to_vec()),
            TableSpec::default(),
            options,
        )
        .unwrap();
        assert_eq!(parsed.table.delimiter, Some("\t"));
        assert_eq!(parsed.table.rows[0], vec!["a,b", "c,d"]);
    }

    #[test]
    fn row_cap_truncates_to_500_with_has_more() {
        let mut csv = String::new();
        for index in 0..501 {
            csv.push_str(&format!("{index},{}\n", index + 1));
        }
        let parsed = parse(csv.as_bytes(), TableSpec::default()).unwrap();
        assert_eq!(parsed.table.rows.len(), 500);
        assert_eq!(parsed.table.truncated_reason, Some("rowCap"));
        assert!(parsed.table.truncated);
        assert!(parsed.table.has_more);
        assert_eq!(parsed.table.row_count, None);
    }

    #[test]
    fn exactly_row_cap_rows_is_not_truncated() {
        let mut csv = String::new();
        for index in 0..500 {
            csv.push_str(&format!("{index}\n"));
        }
        let parsed = parse(csv.as_bytes(), TableSpec::default()).unwrap();
        assert_eq!(parsed.table.rows.len(), 500);
        assert!(!parsed.table.truncated);
        assert_eq!(parsed.table.truncated_reason, None);
        assert!(!parsed.table.has_more);
    }

    #[test]
    fn column_cap_truncates_to_64() {
        let mut csv = String::new();
        for column in 0..100 {
            if column > 0 {
                csv.push(',');
            }
            csv.push_str(&format!("c{column}"));
        }
        csv.push('\n');
        let parsed = parse(csv.as_bytes(), TableSpec::default()).unwrap();
        assert_eq!(parsed.table.rows[0].len(), 64);
        assert_eq!(parsed.table.truncated_reason, Some("colCap"));
        assert_eq!(parsed.table.total_columns, None);
    }

    #[test]
    fn long_field_is_clamped_and_marks_truncation() {
        let mut csv = vec![b'a'; 100 * 1024];
        csv.push(b'\n');
        let parsed = parse(&csv, TableSpec::default()).unwrap();
        assert_eq!(parsed.table.rows.len(), 1);
        assert_eq!(
            parsed.table.rows[0][0].chars().count(),
            super::super::CELL_CHAR_CAP
        );
        assert!(parsed.table.truncated);
        assert_eq!(parsed.table.truncated_reason, None);
    }

    #[test]
    fn text_budget_cuts_the_page() {
        let mut csv = String::new();
        for _ in 0..200 {
            for column in 0..64 {
                if column > 0 {
                    csv.push(',');
                }
                csv.push_str(&"x".repeat(400));
            }
            csv.push('\n');
        }
        let parsed = parse(csv.as_bytes(), TableSpec::default()).unwrap();
        assert_eq!(parsed.table.truncated_reason, Some("budgetCap"));
        assert!(parsed.table.truncated);
        assert!(parsed.table.has_more);
        assert!(parsed.table.rows.len() < 200);
    }

    #[test]
    fn byte_cap_returns_partial_rows() {
        let mut csv = String::new();
        for index in 0..10_000 {
            csv.push_str(&format!("{index},{}\n", "x".repeat(100)));
        }
        let mut options = options(500);
        options.read_cap = 4096;
        let parsed =
            preview_reader(Cursor::new(csv.into_bytes()), TableSpec::default(), options).unwrap();
        assert!(parsed.table.rows.len() < 500);
        assert_eq!(parsed.table.truncated_reason, Some("byteCap"));
        assert!(parsed.table.has_more);
    }

    #[test]
    fn timeout_returns_partial_rows() {
        let mut csv = String::new();
        for index in 0..1000 {
            csv.push_str(&format!("{index},a\n"));
        }
        let mut options = options(500);
        // Already expired: the first completed record stops the page.
        options.deadline = Instant::now();
        let parsed =
            preview_reader(Cursor::new(csv.into_bytes()), TableSpec::default(), options).unwrap();
        assert_eq!(parsed.table.truncated_reason, Some("timeout"));
        assert_eq!(parsed.table.rows.len(), 1);
        assert!(parsed.table.has_more);
    }

    #[test]
    fn empty_and_blank_lines_produce_no_rows() {
        assert!(rows(b"").is_empty());
        assert!(rows(b"\n\r\n\n").is_empty());
        assert_eq!(rows(b"\n\na,b\n"), vec![vec!["a".to_string(), "b".into()]]);
    }

    #[test]
    fn binary_file_is_rejected() {
        assert!(parse(&[0x00, 0x01, 0x02, 0x03], TableSpec::default()).is_err());
        assert!(parse(b"a,b\n\x01\x02", TableSpec::default()).is_err());
    }

    #[test]
    fn single_column_csv_keeps_comma_delimiter() {
        let parsed = parse(b"name\nvalue", TableSpec::default()).unwrap();
        assert_eq!(parsed.table.delimiter, Some(","));
        assert_eq!(parsed.table.rows.len(), 2);
    }

    #[test]
    fn table_wire_shape_has_empty_content_and_detected_encoding() {
        let mut utf8_bom = vec![0xef, 0xbb, 0xbf];
        utf8_bom.extend_from_slice(b"a,b\n1,2");
        let outcome = parse(&utf8_bom, TableSpec::default()).unwrap();
        let preview = FilePreview {
            kind: "table",
            content: String::new(),
            size: utf8_bom.len() as u64,
            encoding: Some(outcome.encoding),
            encoding_guess: Some(outcome.encoding_guess),
            width: None,
            height: None,
            table: Some(outcome.table),
        };
        let wire = serde_json::to_value(preview).unwrap();
        assert_eq!(wire["kind"], "table");
        assert_eq!(wire["content"], "");
        assert_eq!(wire["encoding"], "UTF-8");
        assert_eq!(wire["encodingGuess"], false);
        assert!(wire["width"].is_null());
        assert!(wire["height"].is_null());
        assert_eq!(wire["table"]["format"], "csv");
        assert_eq!(wire["table"]["delimiter"], ",");
        assert!(wire["table"]["sheetName"].is_null());
        assert!(wire["table"]["sheetNames"].is_null());
        assert!(wire["table"]["rowCount"].is_null());
        assert_eq!(wire["table"]["rows"][0][0], "a");
        assert!(serde_json::to_vec(&wire).unwrap().len() < 2_500_000);
    }
}
