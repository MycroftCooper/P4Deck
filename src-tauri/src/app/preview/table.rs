//! Bounded table page builder shared by the CSV and XLSX preview readers.
//!
//! Every limit is applied while cells are appended so the page is always
//! bounded in memory and in serialized size. Hitting a limit only stops the
//! page; the reader returns the rows collected so far together with a
//! `truncatedReason`, never an error.

use std::time::Instant;

use super::{CELL_CAP, CELL_CHAR_CAP, CELL_TEXT_BUDGET, COL_CAP, ROW_CAP};

pub(crate) const COL_CAP_REASON: &str = "colCap";

/// Why a table page stopped growing. The serialized reason is selected from
/// this with a fixed priority, see [`PageWriter::finish`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Stop {
    RowCap,
    CellCap,
    BudgetCap,
    ByteCap,
    Timeout,
}

impl Stop {
    fn reason(self) -> &'static str {
        match self {
            Self::RowCap => "rowCap",
            Self::CellCap => "cellCap",
            Self::BudgetCap => "budgetCap",
            Self::ByteCap => "byteCap",
            Self::Timeout => "timeout",
        }
    }
}

/// Hard limits for a single preview page.
#[derive(Clone, Copy, Debug)]
pub(crate) struct PageLimits {
    pub row_cap: usize,
    pub col_cap: usize,
    pub cell_cap: usize,
    pub cell_char_cap: usize,
    pub text_budget: usize,
}

impl Default for PageLimits {
    fn default() -> Self {
        Self {
            row_cap: ROW_CAP,
            col_cap: COL_CAP,
            cell_cap: CELL_CAP,
            cell_char_cap: CELL_CHAR_CAP,
            text_budget: CELL_TEXT_BUDGET,
        }
    }
}

/// The bounded page produced by [`PageWriter`].
pub(crate) struct PageResult {
    pub rows: Vec<Vec<String>>,
    pub truncated: bool,
    pub truncated_reason: Option<&'static str>,
    pub has_more: bool,
    pub total_columns: Option<u32>,
}

/// Collects display-ready rows while enforcing the page limits.
pub(crate) struct PageWriter {
    limits: PageLimits,
    rows: Vec<Vec<String>>,
    text_bytes: usize,
    cell_count: usize,
    /// More columns were present than [`PageLimits::col_cap`].
    column_overflow: bool,
    /// A cell was cut at [`PageLimits::cell_char_cap`].
    cell_truncated: bool,
    stop: Option<Stop>,
    deadline: Instant,
}

impl PageWriter {
    pub(crate) fn new(limits: PageLimits, deadline: Instant) -> Self {
        Self {
            limits,
            rows: Vec::new(),
            text_bytes: 0,
            cell_count: 0,
            column_overflow: false,
            cell_truncated: false,
            stop: None,
            deadline,
        }
    }

    pub(crate) fn is_stopped(&self) -> bool {
        self.stop.is_some()
    }

    pub(crate) fn stop(&mut self, stop: Stop) {
        if self.stop.is_none() {
            self.stop = Some(stop);
        }
    }

    /// Ensures row `index` exists. Returns `false` when that would exceed the
    /// row cap (the caller then marks the page as truncated with `rowCap`).
    pub(crate) fn ensure_row(&mut self, index: usize) -> bool {
        if index >= self.limits.row_cap {
            return false;
        }
        while self.rows.len() <= index {
            self.rows.push(Vec::new());
        }
        true
    }

    /// Stores one cell. The row must already exist (see [`Self::ensure_row`]).
    /// Stops the page when a hard limit or the text budget is reached.
    pub(crate) fn set_cell(&mut self, row: usize, column: usize, text: String) {
        if self.stop.is_some() || row >= self.rows.len() {
            return;
        }
        if column >= self.limits.col_cap {
            self.column_overflow = true;
            return;
        }
        if self.cell_count >= self.limits.cell_cap {
            self.stop(Stop::CellCap);
            return;
        }
        let mut truncated = false;
        let text = clamp_cell_text(text, self.limits.cell_char_cap, &mut truncated);
        if truncated {
            self.cell_truncated = true;
        }
        if self.text_bytes.saturating_add(text.len()) > self.limits.text_budget {
            self.stop(Stop::BudgetCap);
            return;
        }
        self.text_bytes += text.len();
        self.cell_count += 1;
        let target = &mut self.rows[row];
        while target.len() <= column {
            target.push(String::new());
        }
        target[column] = text;
    }

    /// Records that a cell was cut short before reaching [`Self::set_cell`].
    pub(crate) fn mark_cell_truncated(&mut self) {
        self.cell_truncated = true;
    }

    /// Aborts the page when the wall-clock deadline has passed.
    pub(crate) fn tick(&mut self) {
        if self.stop.is_none() && Instant::now() >= self.deadline {
            self.stop = Some(Stop::Timeout);
        }
    }

    /// Finalizes the page. `has_more` reports whether more rows exist beyond
    /// the returned page.
    pub(crate) fn finish(self, has_more: bool) -> PageResult {
        // Fixed reason priority: rowCap > colCap > cellCap > budgetCap >
        // byteCap > timeout.
        let reason = match self.stop {
            Some(Stop::RowCap) => Some(Stop::RowCap.reason()),
            _ if self.column_overflow => Some(COL_CAP_REASON),
            Some(stop) => Some(stop.reason()),
            None => None,
        };
        let total_columns = if self.column_overflow {
            None
        } else {
            let width = self.rows.iter().map(Vec::len).max().unwrap_or(0);
            Some(width as u32)
        };
        PageResult {
            truncated: reason.is_some() || self.cell_truncated,
            truncated_reason: reason,
            has_more,
            total_columns,
            rows: self.rows,
        }
    }
}

/// Clamps a cell to `cap` characters, replacing the last kept character with an
/// ellipsis when the text is longer.
fn clamp_cell_text(text: String, cap: usize, truncated: &mut bool) -> String {
    if text.len() <= cap || text.chars().count() <= cap {
        return text;
    }
    *truncated = true;
    let mut clamped = String::new();
    for character in text.chars().take(cap.saturating_sub(1)) {
        clamped.push(character);
    }
    clamped.push('…');
    clamped
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn writer(row_cap: usize) -> PageWriter {
        PageWriter::new(
            PageLimits {
                row_cap,
                ..PageLimits::default()
            },
            Instant::now() + Duration::from_secs(60),
        )
    }

    #[test]
    fn budget_cuts_the_page_and_wire_stays_bounded() {
        let mut page = writer(500);
        'rows: for row in 0..500 {
            if !page.ensure_row(row) {
                page.stop(Stop::RowCap);
                break;
            }
            for column in 0..64 {
                page.set_cell(row, column, "x".repeat(512));
                if page.is_stopped() {
                    break 'rows;
                }
            }
        }
        assert!(page.is_stopped());
        let result = page.finish(false);
        assert!(result.rows.len() < 500);
        assert_eq!(result.truncated_reason, Some("budgetCap"));
        assert!(result.truncated);
        let wire = serde_json::to_vec(&serde_json::json!({ "rows": result.rows })).unwrap();
        assert!(wire.len() <= 2_500_000, "wire too large: {}", wire.len());
    }

    #[test]
    fn row_cap_has_priority_over_column_overflow() {
        let mut page = writer(2);
        for row in 0..2 {
            assert!(page.ensure_row(row));
            for column in 0..70 {
                page.set_cell(row, column, "v".into());
            }
        }
        assert!(!page.ensure_row(2));
        page.stop(Stop::RowCap);
        let result = page.finish(true);
        assert_eq!(result.truncated_reason, Some("rowCap"));
        assert_eq!(result.rows.len(), 2);
        assert_eq!(result.rows[0].len(), 64);
        assert!(result.has_more);
        assert_eq!(result.total_columns, None);
    }

    #[test]
    fn deadline_stops_the_page_as_timeout() {
        let mut page = PageWriter::new(PageLimits::default(), Instant::now());
        assert!(page.ensure_row(0));
        page.set_cell(0, 0, "a".into());
        page.tick();
        assert!(page.is_stopped());
        let result = page.finish(true);
        assert_eq!(result.truncated_reason, Some("timeout"));
        assert_eq!(result.rows.len(), 1);
    }

    #[test]
    fn long_cell_is_clamped_to_the_character_cap() {
        let mut page = writer(1);
        assert!(page.ensure_row(0));
        page.set_cell(0, 0, "字".repeat(600));
        let result = page.finish(false);
        assert_eq!(result.rows[0][0].chars().count(), CELL_CHAR_CAP);
        assert!(result.truncated);
        assert_eq!(result.truncated_reason, None);
    }
}
