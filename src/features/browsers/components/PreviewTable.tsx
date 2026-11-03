import { useEffect, useMemo, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ResizableTable } from "../../../app/context-menu/ResizableTable";
import type { FilePreviewTable } from "../../../shared/contracts";
import {
  TABLE_GUTTER_WIDTH,
  TABLE_ROW_HEIGHT,
  clipCell,
  columnLetter,
  normalizeTable,
} from "../previewTableModel";

/** The row-number column may collapse a little; data columns stay readable. */
const GUTTER_MIN_WIDTH = 40;
const DATA_COLUMN_MIN_WIDTH = 64;

/**
 * Read-only table preview: shared `ResizableTable` (drag/keyboard column widths)
 * with up to 10 frozen header rows, sticky gutter and row virtualisation only
 * (≤64 columns never virtualised). Every cell is a text node; the backend owns
 * value formatting and the 512-character cell cap.
 */
export function PreviewTable({
  table,
  zh,
  headerRows,
}: {
  table: FilePreviewTable;
  zh: boolean;
  headerRows: number;
}) {
  const tr = (a: string, b: string) => (zh ? a : b);
  const scroll = useRef<HTMLDivElement>(null);
  const model = useMemo(
    () => normalizeTable(table, headerRows),
    [table, headerRows],
  );
  const defaults = useMemo(
    () => [TABLE_GUTTER_WIDTH, ...model.widths],
    [model.widths],
  );
  const minimums = useMemo(
    () => [GUTTER_MIN_WIDTH, ...model.widths.map(() => DATA_COLUMN_MIN_WIDTH)],
    [model.widths],
  );
  const virtual = useVirtualizer({
    count: model.dataRows.length,
    getScrollElement: () => scroll.current,
    estimateSize: () => TABLE_ROW_HEIGHT,
    overscan: 8,
    getItemKey: (index) => `${model.headerRowCount}:${index}`,
  });
  const items = virtual.getVirtualItems();
  const paddingTop = items.length > 0 ? items[0].start : 0;
  const paddingBottom =
    items.length > 0 ? virtual.getTotalSize() - items[items.length - 1].end : 0;
  // Changing the frozen row count changes the virtual window; restart at the top.
  useEffect(() => {
    scroll.current?.scrollTo({ top: 0 });
  }, [headerRows]);

  if (model.columnCount === 0 || table.rows.length === 0) {
    return (
      <div className="preview-empty preview-table-empty" role="status">
        {tr("此工作表为空", "This worksheet is empty")}
      </div>
    );
  }
  // Every header row is fixed-height, so sticky offsets are exact multiples of it.
  const headerCellStyle = (rowIndex: number) => ({
    position: "sticky" as const,
    top: rowIndex * model.letterRowHeight,
  });
  return (
    <div
      ref={scroll}
      className="preview-table-scroll"
      tabIndex={0}
      role="region"
      aria-label={tr("表格预览", "Table preview")}
    >
      <ResizableTable
        // A different file/sheet/column count starts from fresh column widths;
        // refreshing the same page keeps the widths the user dragged.
        key={`${table.format}:${table.sheetIndex ?? "csv"}:${model.columnCount}`}
        tableId="file-preview"
        defaults={defaults}
        minimums={minimums}
        headerSticky
        className="preview-table"
        aria-rowcount={model.ariaRowCount}
        aria-colcount={model.columnCount}
      >
        <caption className="sr-only">{tr("表格内容", "Table content")}</caption>
        <thead>
          {/* Always present: holds the column letters and the resize grips. */}
          <tr>
            <th
              scope="col"
              className="preview-table-gutter preview-table-corner"
              style={headerCellStyle(0)}
            >
              #
            </th>
            {model.columns.map((label, index) => {
              const letter = columnLetter(index);
              return (
                <th
                  key={index}
                  scope="col"
                  className="preview-table-head"
                  style={headerCellStyle(0)}
                  title={label ? `${letter} · ${label}` : letter}
                >
                  <span className="preview-table-letter">{letter}</span>
                  {label && (
                    <span className="preview-table-heading">{label}</span>
                  )}
                </th>
              );
            })}
          </tr>
          {model.headerRows.slice(1).map((row, offset) => {
            const rowIndex = offset + 1;
            return (
              <tr key={`header-${rowIndex}`}>
                <th
                  scope="col"
                  className="preview-table-gutter preview-table-corner preview-table-gutter-plain"
                  style={headerCellStyle(rowIndex)}
                />
                {row.map((cell, index) => {
                  const letter = columnLetter(index);
                  return (
                    <th
                      key={index}
                      scope="col"
                      className="preview-table-head"
                      style={headerCellStyle(rowIndex)}
                      title={cell ? `${letter} · ${cell}` : letter}
                    >
                      <span className="preview-table-heading">
                        {clipCell(cell, zh)}
                      </span>
                    </th>
                  );
                })}
              </tr>
            );
          })}
        </thead>
        <tbody>
          {paddingTop > 0 && (
            <tr aria-hidden="true" className="preview-table-spacer">
              <td
                colSpan={model.columnCount + 1}
                style={{ height: paddingTop }}
              />
            </tr>
          )}
          {items.map((item) => {
            const row = model.dataRows[item.index] ?? [];
            const rowNumber = model.gutterStart + item.index;
            return (
              <tr
                key={item.key}
                className="preview-table-row"
                aria-rowindex={model.ariaFirstDataRow + item.index}
              >
                <th scope="row" className="preview-table-gutter">
                  {rowNumber}
                </th>
                {row.map((cell, index) => (
                  <td
                    key={index}
                    className="preview-table-cell"
                    title={cell.length > 40 ? cell.slice(0, 2000) : undefined}
                  >
                    {clipCell(cell, zh)}
                  </td>
                ))}
              </tr>
            );
          })}
          {model.headerOnly && items.length === 0 && (
            <tr className="preview-table-empty-row">
              <td colSpan={model.columnCount + 1}>
                {tr("没有数据行", "No data rows")}
              </td>
            </tr>
          )}
          {paddingBottom > 0 && (
            <tr aria-hidden="true" className="preview-table-spacer">
              <td
                colSpan={model.columnCount + 1}
                style={{ height: paddingBottom }}
              />
            </tr>
          )}
        </tbody>
      </ResizableTable>
    </div>
  );
}
