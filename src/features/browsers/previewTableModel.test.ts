import { describe, expect, it } from "vitest";
import type { FilePreview, FilePreviewTable } from "../../shared/contracts";
import {
  CELL_TEXT_LIMIT,
  TABLE_COLUMN_LIMIT,
  TABLE_ROW_LIMIT,
  clipCell,
  columnLetter,
  estimateColumnWidth,
  formatBytes,
  hardTruncation,
  maxHeaderRows,
  normalizeTable,
  physicalRowNumber,
  tablePreviewOf,
  tableToTsv,
  truncationNotes,
} from "./previewTableModel";

const table = (patch: Partial<FilePreviewTable> = {}): FilePreviewTable => ({
  format: "csv",
  delimiter: ",",
  sheetName: null,
  sheetIndex: null,
  sheetNames: null,
  rows: [
    ["名称", "数量"],
    ["甲", "1"],
    ["乙", "2"],
  ],
  rowCount: null,
  rowCountSource: null,
  hasMore: false,
  truncated: false,
  truncatedReason: null,
  ...patch,
});

describe("columnLetter", () => {
  it.each([
    [0, "A"],
    [25, "Z"],
    [26, "AA"],
    [51, "AZ"],
    [52, "BA"],
    [63, "BL"],
  ])("maps %i to %s", (index, letter) => {
    expect(columnLetter(index)).toBe(letter);
  });
  it("never returns an empty label for negative or fractional input", () => {
    expect(columnLetter(-4)).toBe("A");
    expect(columnLetter(2.9)).toBe("C");
  });
});

describe("normalizeTable", () => {
  it("freezes the first row and numbers data rows from 2", () => {
    const model = normalizeTable(table(), 1);
    expect(model.columns).toEqual(["名称", "数量"]);
    expect(model.headerRows).toEqual([["名称", "数量"]]);
    expect(model.headerRowCount).toBe(1);
    expect(model.dataRows).toEqual([
      ["甲", "1"],
      ["乙", "2"],
    ]);
    expect(model.columnCount).toBe(2);
    expect(model.gutterStart).toBe(2);
    expect(model.ariaFirstDataRow).toBe(2);
    expect(model.dataRowCount).toBe(2);
    expect(model.ariaRowCount).toBe(3);
    expect(model.headerOnly).toBe(false);
    expect(model.hardTruncated).toBe(false);
    expect(model.letterRowHeight).toBe(28);
  });

  it("freezes any number of leading rows and keeps them verbatim", () => {
    const model = normalizeTable(
      table({
        rows: [
          ["季度", "Q1", "Q2"],
          ["货币", "CNY", "USD"],
          ["A", "1", "2"],
          ["B", "3", "4"],
        ],
      }),
      2,
    );
    expect(model.headerRows).toEqual([
      ["季度", "Q1", "Q2"],
      ["货币", "CNY", "USD"],
    ]);
    expect(model.headerRowCount).toBe(2);
    expect(model.columns).toEqual(["季度", "Q1", "Q2"]);
    expect(model.dataRows).toEqual([
      ["A", "1", "2"],
      ["B", "3", "4"],
    ]);
    expect(model.gutterStart).toBe(3);
    expect(model.ariaFirstDataRow).toBe(3);
    expect(model.dataRowCount).toBe(2);
    expect(model.ariaRowCount).toBe(4);
  });

  it("keeps every row as data and labels from letters when nothing is frozen", () => {
    const model = normalizeTable(table(), 0);
    expect(model.columns).toEqual(["", ""]);
    expect(model.headerRows).toEqual([]);
    expect(model.headerRowCount).toBe(0);
    expect(model.dataRows).toHaveLength(3);
    expect(model.gutterStart).toBe(1);
    expect(model.ariaFirstDataRow).toBe(2);
    expect(model.dataRowCount).toBe(3);
    expect(model.ariaRowCount).toBe(3);
    expect(model.headerOnly).toBe(false);
  });

  it("clamps the frozen count to the returned rows and the ten-row cap", () => {
    expect(
      normalizeTable(table({ rows: [["a"], ["b"]] }), 7).headerRowCount,
    ).toBe(2);
    const tall = normalizeTable(
      table({ rows: Array.from({ length: 20 }, (_, i) => [`r${i}`]) }),
      20,
    );
    expect(tall.headerRowCount).toBe(10);
    expect(tall.dataRows).toHaveLength(10);
    expect(normalizeTable(table(), -3).headerRowCount).toBe(0);
    expect(normalizeTable(table(), Number.NaN).headerRowCount).toBe(0);
  });

  it("reports header-only pages without inventing a data row", () => {
    const model = normalizeTable(table({ rows: [["名称", "数量"]] }), 1);
    expect(model.headerOnly).toBe(true);
    expect(model.headerRowCount).toBe(1);
    expect(model.dataRowCount).toBe(0);
    expect(model.dataRows).toEqual([]);
  });

  it("treats an empty sheet as having no columns", () => {
    const model = normalizeTable(table({ rows: [] }), 1);
    expect(model.columnCount).toBe(0);
    expect(model.headerRowCount).toBe(0);
    expect(model.dataRows).toEqual([]);
    expect(model.headerOnly).toBe(false);
  });

  it("pads short rows and clips long rows to the widest row", () => {
    const model = normalizeTable(
      table({
        rows: [["a"], ["b", "c", "d"]],
      }),
      0,
    );
    expect(model.columnCount).toBe(3);
    expect(model.dataRows).toEqual([
      ["a", "", ""],
      ["b", "c", "d"],
    ]);
  });

  it("hard-truncates backend contract violations to 500 × 64", () => {
    const tall = normalizeTable(
      table({
        rows: Array.from({ length: TABLE_ROW_LIMIT + 1 }, (_, i) => [`r${i}`]),
      }),
      0,
    );
    expect(tall.dataRows).toHaveLength(TABLE_ROW_LIMIT);
    expect(tall.hardTruncated).toBe(true);
    const wide = normalizeTable(
      table({
        rows: [
          Array.from({ length: TABLE_COLUMN_LIMIT + 1 }, (_, i) => `c${i}`),
        ],
      }),
      0,
    );
    expect(wide.columnCount).toBe(TABLE_COLUMN_LIMIT);
    expect(wide.hardTruncated).toBe(true);
  });

  it("prefers the backend row count for aria-rowcount", () => {
    expect(normalizeTable(table({ rowCount: 150_000 }), 1).ariaRowCount).toBe(
      150_000,
    );
  });

  it("coerces non-string cells and skips non-array rows", () => {
    const malformed = table({
      rows: [
        ["a", 1 as unknown as string, null as unknown as string],
        "not a row" as unknown as string[],
        ["b", "c", "d"],
      ],
    });
    expect(normalizeTable(malformed, 0).dataRows).toEqual([
      ["a", "1", ""],
      ["b", "c", "d"],
    ]);
  });
});

describe("maxHeaderRows", () => {
  it("caps the frozen rows at ten and at the returned row count", () => {
    expect(maxHeaderRows(undefined)).toBe(0);
    expect(maxHeaderRows(table({ rows: [] }))).toBe(0);
    expect(maxHeaderRows(table())).toBe(3);
    expect(
      maxHeaderRows(
        table({ rows: Array.from({ length: 25 }, (_, i) => [`r${i}`]) }),
      ),
    ).toBe(10);
  });
});

describe("estimateColumnWidth", () => {
  it("uses a default width for headerless columns", () => {
    expect(estimateColumnWidth("")).toBe(160);
  });
  it("clamps narrow labels up and wide labels down", () => {
    expect(estimateColumnWidth("A")).toBe(96);
    expect(estimateColumnWidth("ABCDEFGHIJ")).toBe(144);
    expect(estimateColumnWidth("A".repeat(64))).toBe(320);
  });
  it("counts CJK characters as double width", () => {
    expect(estimateColumnWidth("中文名称")).toBe(
      estimateColumnWidth("ABCDEFGH"),
    );
  });
});

describe("physicalRowNumber", () => {
  it("numbers data rows after the frozen header rows", () => {
    expect(physicalRowNumber(0, 1)).toBe(2);
    expect(physicalRowNumber(0, 0)).toBe(1);
    expect(physicalRowNumber(3, 2)).toBe(6);
  });
});

describe("hardTruncation", () => {
  it("only fires beyond the rendering limits", () => {
    expect(hardTruncation(table())).toBe(false);
    expect(
      hardTruncation(
        table({ rows: Array.from({ length: TABLE_ROW_LIMIT }, () => ["a"]) }),
      ),
    ).toBe(false);
    expect(
      hardTruncation(
        table({
          rows: Array.from({ length: TABLE_ROW_LIMIT + 1 }, () => ["a"]),
        }),
      ),
    ).toBe(true);
    expect(
      hardTruncation(table({ rows: [[..."a".repeat(65)].map(() => "a")] })),
    ).toBe(true);
  });
});

describe("clipCell", () => {
  it("keeps cells at the defensive limit and marks longer values", () => {
    const atLimit = "a".repeat(CELL_TEXT_LIMIT);
    expect(clipCell(atLimit, false)).toBe(atLimit);
    expect(clipCell("a".repeat(CELL_TEXT_LIMIT + 1), false)).toBe(
      `${"a".repeat(CELL_TEXT_LIMIT)}…[cell truncated]`,
    );
    expect(clipCell("a".repeat(CELL_TEXT_LIMIT + 1), true)).toContain(
      "…[单元格过长]",
    );
  });
});

describe("tableToTsv", () => {
  it("keeps the frozen header rows and escapes tabs, newlines and quotes", () => {
    const tsv = tableToTsv(
      normalizeTable(
        table({
          rows: [
            ["名称", "备注"],
            ['A"B', "含\t制表"],
            ["C", "含\n换行"],
          ],
        }),
        1,
      ),
    );
    expect(tsv).toBe('名称\t备注\n"A""B"\t"含\t制表"\nC\t"含\n换行"');
  });
  it("serialises every row when nothing is frozen", () => {
    expect(tableToTsv(normalizeTable(table({ rows: [["a"], ["b"]] }), 0))).toBe(
      "a\nb",
    );
  });
  it("serialises all frozen rows", () => {
    expect(
      tableToTsv(normalizeTable(table({ rows: [["h1"], ["h2"], ["a"]] }), 2)),
    ).toBe("h1\nh2\na");
  });
});

describe("formatBytes", () => {
  it.each([
    [0, "0 B"],
    [512, "512 B"],
    [2048, "2.0 KiB"],
    [1024 * 1024, "1.0 MiB"],
    [110_179_268, "105.1 MiB"],
  ])("formats %i as %s", (bytes, expected) => {
    expect(formatBytes(bytes)).toBe(expected);
  });
  it("rejects values that cannot be a file size", () => {
    expect(formatBytes(-1)).toBe("—");
    expect(formatBytes(Number.NaN)).toBe("—");
  });
});

describe("truncationNotes", () => {
  it("explains a row cap with and without a known total", () => {
    expect(
      truncationNotes(
        table({
          truncated: true,
          truncatedReason: "rowCap",
          rowCount: 150_000,
          rowCountSource: "dimension",
        }),
        false,
      ),
    ).toEqual(["Showing the first 500 rows of about 150,000"]);
    expect(
      truncationNotes(
        table({ truncated: true, truncatedReason: "rowCap" }),
        false,
      ),
    ).toEqual(["Showing the first 500 rows (total rows not counted)"]);
    expect(
      truncationNotes(
        table({
          truncated: true,
          truncatedReason: "rowCap",
          rowCount: 150_000,
        }),
        true,
      )[0],
    ).toContain("工作表共约 150,000 行");
  });
  it("explains column caps when the total is known", () => {
    expect(
      truncationNotes(
        table({
          truncated: true,
          truncatedReason: "colCap",
          totalColumns: 100,
        }),
        false,
      ),
    ).toEqual(["Showing the first 64 columns of about 100"]);
    expect(
      truncationNotes(
        table({ truncated: true, truncatedReason: "colCap" }),
        false,
      ),
    ).toEqual(["Showing the first 64 columns"]);
  });
  it.each([
    ["cellCap", "Cell limit reached"],
    ["byteCap", "Read limit reached"],
    ["budgetCap", "Text budget reached"],
    ["timeout", "Read timed out"],
  ] as const)("explains %s", (reason, expected) => {
    expect(
      truncationNotes(
        table({ truncated: true, truncatedReason: reason }),
        false,
      ),
    ).toEqual([expect.stringContaining(expected)]);
  });
  it("falls back to the generic notes for defensive cases", () => {
    expect(truncationNotes(table({ hasMore: true }), false)).toEqual([
      "More rows are not shown",
    ]);
    expect(truncationNotes(table({ truncated: true }), false)).toEqual([
      "Content was truncated",
    ]);
    expect(truncationNotes(table(), false)).toEqual([]);
  });
  it("adds the rendering-limit note last", () => {
    expect(
      truncationNotes(
        table({ truncated: true, truncatedReason: "rowCap" }),
        false,
        true,
      ),
    ).toEqual([
      "Showing the first 500 rows (total rows not counted)",
      "Data exceeded the UI limit and was truncated",
    ]);
  });
});

describe("tablePreviewOf", () => {
  const preview = (patch: Partial<FilePreview>): FilePreview => ({
    kind: "table",
    content: "",
    size: 1,
    ...patch,
  });
  it("returns the table payload only for a well-formed table preview", () => {
    expect(tablePreviewOf(preview({ table: table() }))).toEqual(table());
    expect(tablePreviewOf(preview({}))).toBeUndefined();
    expect(
      tablePreviewOf(preview({ kind: "text", table: table() })),
    ).toBeUndefined();
    expect(tablePreviewOf(undefined)).toBeUndefined();
  });
  it("rejects malformed row matrices", () => {
    expect(
      tablePreviewOf(
        preview({
          table: table({ rows: "nope" as unknown as string[][] }),
        }),
      ),
    ).toBeUndefined();
    expect(
      tablePreviewOf(
        preview({
          table: table({ rows: [["a"], "b" as unknown as string[]] }),
        }),
      ),
    ).toBeUndefined();
  });
});
