import { tFor } from "../../shared/i18n";
import type { FilePreview, FilePreviewTable } from "../../shared/contracts";

/** Rendering hard limits; the backend is expected to stay inside them. */
export const TABLE_ROW_LIMIT = 500;
export const TABLE_COLUMN_LIMIT = 64;
/** Defensive cap per cell; the backend already clips cells at 512 characters. */
export const CELL_TEXT_LIMIT = 1000;
/** Fixed data row height keeps the virtualizer free of per-row measurement. */
export const TABLE_ROW_HEIGHT = 24;
export const TABLE_GUTTER_WIDTH = 56;
/** Fixed header row height; sticky `top` offsets must use this exact value. */
export const TABLE_HEADER_ROW_HEIGHT = 28;
/** Upper bound for the user-selectable number of frozen header rows. */
export const TABLE_HEADER_ROW_LIMIT = 10;

const DEFAULT_COLUMN_WIDTH = 160;
const MIN_COLUMN_WIDTH = 96;
const MAX_COLUMN_WIDTH = 320;
/** Characters wider than one Latin cell (CJK, full width forms, hangul). */
const WIDE_CHAR =
  /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/u;

export interface TableModel {
  /** Frozen header rows, top first; empty when no row is frozen. */
  headerRows: string[][];
  /** Number of frozen header rows after clamping (0..min(10, rows.length)). */
  headerRowCount: number;
  /** Rows to render; each padded to columnCount. */
  dataRows: string[][];
  /** First frozen row's labels; empty strings when there is no frozen row. */
  columns: string[];
  columnCount: number;
  widths: number[];
  /** Physical number of the first data row (N + 1). */
  gutterStart: number;
  /** ARIA row index of the first data row (header rows occupy 1..max(1,N)). */
  ariaFirstDataRow: number;
  /** Value for `aria-rowcount` (backend total when known, otherwise rows returned). */
  ariaRowCount: number;
  /** Number of rows the user sees as data. */
  dataRowCount: number;
  /** The payload exceeded the UI limits and was clipped for rendering. */
  hardTruncated: boolean;
  /** Every returned row is frozen as a header row. */
  headerOnly: boolean;
  /** Exact height of every rendered header row (letter row included). */
  letterRowHeight: number;
}

/** Narrow a `FilePreview` to its table payload, rejecting malformed payloads. */
export function tablePreviewOf(
  preview: FilePreview | undefined,
): FilePreviewTable | undefined {
  if (preview?.kind !== "table" || !preview.table) return undefined;
  const table = preview.table;
  if (!Array.isArray(table.rows)) return undefined;
  if (table.rows.some((row) => !Array.isArray(row))) return undefined;
  return table;
}

/** Largest number of frozen header rows the given table can offer. */
export function maxHeaderRows(table: FilePreviewTable | undefined): number {
  if (!table || !Array.isArray(table.rows)) return 0;
  return Math.min(TABLE_HEADER_ROW_LIMIT, table.rows.length);
}

/**
 * Single source of truth for the header/data split, row numbers and column
 * count, so the toolbar, ARIA attributes and the rendered rows cannot drift.
 */
export function normalizeTable(
  table: FilePreviewTable,
  headerRows: number,
): TableModel {
  const source: unknown = table.rows;
  const rawRows = (Array.isArray(source) ? source : [])
    .filter((row): row is unknown[] => Array.isArray(row))
    .map((row) => row.map((cell) => (cell == null ? "" : String(cell))));
  const rows = rawRows.slice(0, TABLE_ROW_LIMIT);
  const widest = rows.reduce((count, row) => Math.max(count, row.length), 0);
  const columnCount = Math.min(widest, TABLE_COLUMN_LIMIT);
  const hardTruncated =
    rawRows.length > TABLE_ROW_LIMIT || widest > TABLE_COLUMN_LIMIT;
  const normalized = rows.map((row) =>
    Array.from({ length: columnCount }, (_, index) => row[index] ?? ""),
  );
  const headerRowCount = Math.max(
    0,
    Math.min(
      Math.floor(Number.isFinite(headerRows) ? headerRows : 0),
      Math.min(TABLE_HEADER_ROW_LIMIT, normalized.length),
    ),
  );
  const frozenRows = normalized.slice(0, headerRowCount);
  const dataRows = normalized.slice(headerRowCount);
  const columns = Array.from(
    { length: columnCount },
    (_, index) => frozenRows[0]?.[index] ?? "",
  );
  return {
    headerRows: frozenRows,
    headerRowCount,
    dataRows,
    columns,
    columnCount,
    widths: columns.map((label) => estimateColumnWidth(label)),
    gutterStart: headerRowCount + 1,
    ariaFirstDataRow: Math.max(1, headerRowCount) + 1,
    ariaRowCount: table.rowCount ?? rawRows.length,
    dataRowCount: dataRows.length,
    hardTruncated,
    headerOnly: headerRowCount > 0 && dataRows.length === 0,
    letterRowHeight: TABLE_HEADER_ROW_HEIGHT,
  };
}

/** Would rendering clip the payload even though the backend promised bounds? */
export function hardTruncation(table: FilePreviewTable): boolean {
  const source: unknown = table.rows;
  const rows = Array.isArray(source) ? source : [];
  if (rows.length > TABLE_ROW_LIMIT) return true;
  return rows.some(
    (row) => Array.isArray(row) && row.length > TABLE_COLUMN_LIMIT,
  );
}

/** Excel-style column letter: 0 → A, 25 → Z, 26 → AA, 63 → BL. */
export function columnLetter(index: number): string {
  let value = Math.max(0, Math.floor(index)) + 1;
  let label = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    label = String.fromCharCode(65 + remainder) + label;
    value = Math.floor((value - 1) / 26);
  }
  return label;
}

/** Estimate a column width from its header label; content is never measured. */
export function estimateColumnWidth(label: string): number {
  if (!label) return DEFAULT_COLUMN_WIDTH;
  let units = 0;
  for (const char of label) units += WIDE_CHAR.test(char) ? 2 : 1;
  return Math.min(
    MAX_COLUMN_WIDTH,
    Math.max(MIN_COLUMN_WIDTH, 12 * units + 24),
  );
}

/** Physical row number for the data row at `index`. */
export function physicalRowNumber(index: number, headerRows: number): number {
  return index + headerRows + 1;
}

/** Defensive per-cell clip; a well-behaved backend already stayed at 512. */
export function clipCell(value: string, zh: boolean): string {
  if (value.length <= CELL_TEXT_LIMIT) return value;
  return (
    value.slice(0, CELL_TEXT_LIMIT) +
    tFor(zh ? "zh-CN" : "en-US", "browse.cell.truncated")
  );
}

function tsvCell(value: string): string {
  return /["\t\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** Whole table as TSV (frozen header rows included) for copy/select-all. */
export function tableToTsv(model: TableModel): string {
  const rows = [...model.headerRows, ...model.dataRows];
  return rows.map((row) => row.map(tsvCell).join("\t")).join("\n");
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

/**
 * Human readable clipping notes for the table notice line. `uiTruncated`
 * reports the rendering-side hard limit (a backend contract violation).
 */
export function truncationNotes(
  table: FilePreviewTable,
  zh: boolean,
  uiTruncated = false,
): string[] {
  const notes: string[] = [];
  const reason = table.truncatedReason;
  if (reason === "rowCap") {
    notes.push(
      table.rowCount != null
        ? tFor(
            zh ? "zh-CN" : "en-US",
            "browse.showing.the.first.rows.of.about",
            {
              p1: zh ? TABLE_ROW_LIMIT : TABLE_ROW_LIMIT,
              p2: zh
                ? new Intl.NumberFormat("zh-CN").format(table.rowCount)
                : new Intl.NumberFormat("en-US").format(table.rowCount),
            },
          )
        : tFor(
            zh ? "zh-CN" : "en-US",
            "browse.showing.the.first.rows.total.rows",
            { p1: zh ? TABLE_ROW_LIMIT : TABLE_ROW_LIMIT },
          ),
    );
  } else if (reason === "colCap") {
    notes.push(
      table.totalColumns != null
        ? tFor(
            zh ? "zh-CN" : "en-US",
            "browse.showing.the.first.columns.of.about",
            {
              p1: zh ? TABLE_COLUMN_LIMIT : TABLE_COLUMN_LIMIT,
              p2: zh ? table.totalColumns : table.totalColumns,
            },
          )
        : tFor(zh ? "zh-CN" : "en-US", "browse.showing.the.first.columns", {
            p1: zh ? TABLE_COLUMN_LIMIT : TABLE_COLUMN_LIMIT,
          }),
    );
  } else if (reason === "cellCap") {
    notes.push(
      tFor(zh ? "zh-CN" : "en-US", "browse.cell.limit.reached.later.content"),
    );
  } else if (reason === "byteCap") {
    notes.push(
      tFor(zh ? "zh-CN" : "en-US", "browse.read.limit.reached.showing.the"),
    );
  } else if (reason === "budgetCap") {
    notes.push(
      tFor(zh ? "zh-CN" : "en-US", "browse.text.budget.reached.later.rows"),
    );
  } else if (reason === "timeout") {
    notes.push(
      tFor(zh ? "zh-CN" : "en-US", "browse.read.timed.out.showing.the"),
    );
  } else if (table.hasMore) {
    notes.push(tFor(zh ? "zh-CN" : "en-US", "browse.more.rows.are.not.shown"));
  } else if (table.truncated) {
    notes.push(tFor(zh ? "zh-CN" : "en-US", "browse.content.was.truncated"));
  }
  if (uiTruncated) {
    notes.push(
      tFor(zh ? "zh-CN" : "en-US", "browse.data.exceeded.the.ui.limit"),
    );
  }
  return notes;
}
