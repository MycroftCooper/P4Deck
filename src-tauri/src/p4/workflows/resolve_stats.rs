//! Pure resolve statistics helpers: diff block counting and a conservative
//! three-way conflict estimate. No I/O, no P4 calls, no fabricated values.

use similar::{DiffOp, TextDiff};

fn normalize(text: &str) -> String {
    text.replace("\r\n", "\n")
}

/// Count grouped diff hunks between two texts (non-equal groups only).
pub fn diff_blocks(left: &str, right: &str) -> usize {
    let left = normalize(left);
    let right = normalize(right);
    TextDiff::from_lines(left.as_str(), right.as_str())
        .grouped_ops(3)
        .iter()
        .filter(|group| {
            group
                .iter()
                .any(|operation| !matches!(operation, DiffOp::Equal { .. }))
        })
        .count()
}

/// Ranges in `base` line coordinates touched by `side`. Insertions are points.
fn changed_ranges(base: &str, side: &str) -> Vec<(usize, usize)> {
    TextDiff::from_lines(base, side)
        .ops()
        .iter()
        .filter_map(|operation| match operation {
            DiffOp::Equal { .. } => None,
            _ => {
                let range = operation.old_range();
                Some((range.start, range.end))
            }
        })
        .collect()
}

fn overlaps(left: (usize, usize), right: (usize, usize)) -> bool {
    let left_point = left.0 == left.1;
    let right_point = right.0 == right.1;
    match (left_point, right_point) {
        (true, true) => left.0 == right.0,
        // Conservative: an insertion touching a changed range still counts.
        (true, false) => right.0 <= left.0 && left.0 <= right.1,
        (false, true) => left.0 <= right.0 && right.0 <= left.1,
        (false, false) => left.0 < right.1 && right.0 < left.1,
    }
}

/// Conservative conflict estimate: count source change blocks whose base range
/// overlaps any target change block. Insertions touching a changed range also
/// count, so adjacent edits are not silently reported as conflict-free.
pub fn conflict_blocks(base: &str, source: &str, target: &str) -> usize {
    let base = normalize(base);
    let source_ranges = changed_ranges(&base, &normalize(source));
    let target_ranges = changed_ranges(&base, &normalize(target));
    source_ranges
        .iter()
        .filter(|source_range| {
            target_ranges
                .iter()
                .any(|target_range| overlaps(**source_range, *target_range))
        })
        .count()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_grouped_diff_blocks() {
        assert_eq!(diff_blocks("a\nb\nc\n", "a\nb\nc\n"), 0);
        assert_eq!(diff_blocks("a\nb\nc\n", "a\nX\nc\n"), 1);
        let base = (0..10)
            .map(|index| format!("line{index}\n"))
            .collect::<String>();
        let mut changed = base.lines().map(str::to_owned).collect::<Vec<_>>();
        changed[0] = "first".into();
        changed[8] = "ninth".into();
        assert_eq!(diff_blocks(&base, &changed.join("\n")), 2);
        // CRLF must not create extra blocks.
        assert_eq!(diff_blocks("a\r\nb\r\nc\r\n", "a\r\nX\r\nc\r\n"), 1);
    }

    #[test]
    fn estimates_conflicts_only_for_overlapping_change_ranges() {
        assert_eq!(conflict_blocks("a\nb\nc\n", "a\nX\nc\n", "a\nY\nc\n"), 1);
        assert_eq!(conflict_blocks("a\nb\nc\n", "X\nb\nc\n", "a\nb\nY\n"), 0);
        // An insertion inside the other side's changed range overlaps.
        assert_eq!(conflict_blocks("a\nb\nc\n", "a\nX\nb\nc\n", "a\nb\nc\n"), 0);
        assert_eq!(conflict_blocks("a\nb\nc\n", "a\nX\nb\nc\n", "a\nY\nc\n"), 1);
    }
}
