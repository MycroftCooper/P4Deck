import { t } from "../../../shared/i18n";
import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { PageRefreshSlotContext } from "../../../app/docking/chrome";
import { useFilePreview } from "../useFilePreview";
import { useVirtualizer } from "@tanstack/react-virtual";
import { FileText, Image, Minus, Plus, RefreshCw, Table2 } from "lucide-react";
import type { FilePreviewTable, RuntimeInfo } from "../../../shared/contracts";

import { useContentMenu } from "../../../app/context-menu/useContentMenu";
import { action, copy, copyLazy } from "../../../app/context-menu/bindings";
import { useFullTextSelection } from "../../../app/context-menu/FullTextSelection";
import { PreviewTable } from "./PreviewTable";
import {
  formatBytes,
  hardTruncation,
  maxHeaderRows,
  normalizeTable,
  tablePreviewOf,
  tableToTsv,
  truncationNotes,
} from "../previewTableModel";

function delimiterLabel(delimiter: FilePreviewTable["delimiter"]) {
  if (delimiter === "\t") return "Tab";
  return delimiter ?? "—";
}

export function FilePreviewPage({
  target,
  runtime,
  zh,
}: {
  target: string;
  locked: boolean;
  onTargetChange(path: string): void;
  runtime: RuntimeInfo;
  zh: boolean;
}) {
  const menu = useContentMenu();
  const textSelection = useFullTextSelection();
  const tr = (a: string, b: string) => (zh ? a : b);
  const refreshSlot = useContext(PageRefreshSlotContext);
  const [zoom, setZoom] = useState<number | null>(null),
    [imageError, setImageError] = useState(false);
  // Cross-target worksheet/header choices are derived below rather than reset in
  // an effect, so a new target never sends the previous target's sheet index.
  const [view, setView] = useState<{
    target: string;
    sheetIndex: number;
    headerRows: number;
  }>();
  // Keeps the worksheet picker mounted while the next sheet is being read.
  const [lastTable, setLastTable] = useState<{
    target: string;
    table: FilePreviewTable;
    encoding?: string | null;
    encodingGuess?: boolean;
  }>();
  const scroll = useRef<HTMLDivElement>(null);
  const sheetIndex = view?.target === target ? view.sheetIndex : 0;
  const requestedHeaderRows = view?.target === target ? view.headerRows : 1;
  const { data, error, loading, reload } = useFilePreview(target, runtime, {
    sheetIndex,
  });
  useEffect(() => {
    if (loading) setImageError(false);
  }, [loading]);
  useEffect(() => {
    setZoom(null);
    setImageError(false);
    scroll.current?.scrollTo(0, 0);
  }, [target]);
  const lines = useMemo(
    () =>
      data?.kind === "text"
        ? data.content.replace(/\r\n?/g, "\n").split("\n")
        : [],
    [data],
  );
  const virtual = useVirtualizer({
    count: lines.length,
    getScrollElement: () => scroll.current,
    estimateSize: () => 24,
    overscan: 10,
  });
  const table = tablePreviewOf(data);
  useEffect(() => {
    if (table)
      setLastTable({
        target,
        table,
        encoding: data?.encoding,
        encodingGuess: data?.encodingGuess,
      });
  }, [data, table, target]);
  const shownTable =
    table ?? (lastTable?.target === target ? lastTable.table : undefined);
  // Frozen header rows stay inside 0..min(10, rows.length); the page keeps the
  // user's wording, the clamp only applies when the table shrinks underneath it.
  const headerRowLimit = maxHeaderRows(shownTable);
  const headerRows = Math.max(0, Math.min(requestedHeaderRows, headerRowLimit));
  const shownEncoding =
    table !== undefined
      ? data?.encoding
      : lastTable?.target === target
        ? lastTable.encoding
        : null;
  const shownEncodingGuess =
    table !== undefined
      ? data?.encodingGuess
      : lastTable?.target === target
        ? lastTable.encodingGuess
        : false;
  const tableModel = useMemo(
    () => (shownTable ? normalizeTable(shownTable, headerRows) : undefined),
    [shownTable, headerRows],
  );
  const notes = table ? truncationNotes(table, zh, hardTruncation(table)) : [];
  const rowCountTitle =
    shownTable?.rowCountSource === "dimension" && shownTable.rowCount != null
      ? tr(
          `工作表共约 ${shownTable.rowCount} 行（声明值，可能包含空行）`,
          `About ${shownTable.rowCount} rows from the worksheet dimension; may include empty rows`,
        )
      : undefined;
  const refreshButton = (
    <button
      type="button"
      title={t("browse.refresh")}
      aria-label={t("browse.refresh")}
      aria-busy={loading}
      disabled={!target || loading}
      onClick={reload}
    >
      <RefreshCw
        size={14}
        className={loading ? "spin" : ""}
        aria-hidden="true"
      />
      {!refreshSlot && <span>{t("browse.refresh")}</span>}
    </button>
  );
  return (
    <section className="file-preview-page" ref={textSelection.surfaceRef}>
      {refreshSlot ? createPortal(refreshButton, refreshSlot) : refreshButton}
      {runtime.mode === "mock" && (
        <div className="preview-note">
          {t("browse.browser.demo.simulated.content.no.local")}
        </div>
      )}
      <div className="preview-toolbar">
        {shownTable ? (
          <>
            <Table2 size={14} />
            <span className="preview-table-format">
              {shownTable.format === "xlsx" ? "XLSX" : "CSV"}
            </span>
            <span className="preview-table-stats" title={rowCountTitle}>
              {tableModel?.columnCount ?? 0} {t("browse.cols")} ×{" "}
              {tableModel?.dataRowCount ?? 0} {t("browse.rows")}
            </span>
            {shownTable.format === "csv" && shownEncoding && (
              <span className="preview-toolbar-secondary">
                {t("browse.encoding")} {shownEncoding}
                {shownEncodingGuess ? t("browse.guessed") : ""}
              </span>
            )}
            {shownTable.format === "csv" && shownTable.delimiter && (
              <span className="preview-toolbar-secondary">
                {t("browse.delimiter")} {delimiterLabel(shownTable.delimiter)}
              </span>
            )}
            {shownTable.sheetNames && shownTable.sheetNames.length > 1 && (
              <select
                className="preview-table-select"
                aria-label={t("browse.worksheet")}
                value={sheetIndex}
                onChange={(event) =>
                  setView({
                    target,
                    sheetIndex: Number(event.target.value),
                    // A different worksheet starts from the default one header row.
                    headerRows: 1,
                  })
                }
              >
                {shownTable.sheetNames.map((name, index) => (
                  <option key={index} value={index}>
                    {name ||
                      tr(`工作表 ${index + 1}`, `Worksheet ${index + 1}`)}
                  </option>
                ))}
              </select>
            )}
            <span
              className="preview-table-steps"
              role="group"
              aria-label={t("browse.frozen.header.rows")}
            >
              <button
                type="button"
                className="preview-table-step"
                aria-label={t("browse.fewer.frozen.header.rows")}
                title={t("browse.fewer.frozen.header.rows")}
                disabled={headerRows <= 0}
                onClick={() =>
                  setView({ target, sheetIndex, headerRows: headerRows - 1 })
                }
              >
                <Minus size={14} aria-hidden="true" />
              </button>
              <span className="preview-table-steps-label">
                {tr(
                  `冻结表头 ${headerRows} 行`,
                  `Frozen header rows: ${headerRows}`,
                )}
              </span>
              <button
                type="button"
                className="preview-table-step"
                aria-label={t("browse.more.frozen.header.rows")}
                title={t("browse.more.frozen.header.rows")}
                disabled={headerRows >= headerRowLimit}
                onClick={() =>
                  setView({ target, sheetIndex, headerRows: headerRows + 1 })
                }
              >
                <Plus size={14} aria-hidden="true" />
              </button>
            </span>
          </>
        ) : data?.kind === "image" ? (
          <>
            <Image size={14} />
            <span>
              {data.width} × {data.height}
            </span>
            <button
              aria-label={t("browse.zoom.out")}
              onClick={() => setZoom((n) => Math.max(0.1, (n ?? 1) / 1.25))}
            >
              <Minus size={14} />
            </button>
            <button onClick={() => setZoom(1)}>
              {zoom === null ? t("browse.fit") : `${Math.round(zoom * 100)}%`}
            </button>
            <button
              aria-label={t("browse.zoom.in")}
              onClick={() => setZoom((n) => Math.min(4, (n ?? 1) * 1.25))}
            >
              <Plus size={14} />
            </button>
            <button onClick={() => setZoom(null)}>
              {t("browse.fit.to.window")}
            </button>
          </>
        ) : (
          <>
            <FileText size={14} />
            <span>{data?.encoding ?? "—"}</span>
            <span>
              {lines.length} {t("browse.lines")}
            </span>
          </>
        )}
        <span className="spacer" />
        <span className="preview-toolbar-secondary">
          {data ? formatBytes(data.size) : ""}
        </span>
      </div>
      <section
        className="preview-body"
        aria-busy={loading}
        tabIndex={0}
        {...menu(
          error || imageError || !data
            ? "V07"
            : data.kind === "image"
              ? "V06"
              : data.kind === "table"
                ? table
                  ? "V09"
                  : "V07"
                : data.kind === "text"
                  ? "V05"
                  : "V07",
          target,
          () => ({
            重新加载: action(reload, target ? undefined : "没有预览目标"),
            复制已知路径: copy(target),
            复制所选文本: copy(textSelection.selectedText()),
            全选: action(() =>
              textSelection.selectAll(
                data?.kind === "text"
                  ? data.content
                  : data?.kind === "table" && table
                    ? tableToTsv(normalizeTable(table, headerRows))
                    : "",
              ),
            ),
            "复制整表（TSV）": copyLazy(
              () =>
                table ? tableToTsv(normalizeTable(table, headerRows)) : "",
              table ? undefined : t("browse.nothing.to.copy"),
            ),
            适应窗口: action(() => setZoom(null)),
            原始尺寸: action(() => setZoom(1)),
          }),
        )}
      >
        {error ? (
          <div role="alert" className="preview-empty">
            {t("browse.preview.unavailable")}
            <p>{error}</p>
          </div>
        ) : !target ? (
          <div className="preview-empty">
            {t("browse.select.preview.or.double.click.a")}
          </div>
        ) : loading && !data ? (
          <div role="status" className="preview-empty">
            {t("browse.reading")}
          </div>
        ) : data?.kind === "text" && data.content.length === 0 ? (
          <div role="status" className="preview-empty">
            {t("browse.file.is.empty")}
          </div>
        ) : data?.kind === "text" ? (
          <div className="preview-text" ref={scroll}>
            <div
              className="virtual-spacer"
              style={{ height: virtual.getTotalSize() }}
            >
              {virtual.getVirtualItems().map((row) => (
                <div
                  className="preview-line"
                  key={row.index}
                  style={{
                    transform: `translateY(${row.start}px)`,
                    height: row.size,
                  }}
                >
                  <span>{row.index + 1}</span>
                  <code>
                    {lines[row.index].slice(0, 4000) || " "}
                    {lines[row.index].length > 4000
                      ? t("browse.long.line.truncated")
                      : ""}
                  </code>
                </div>
              ))}
            </div>
          </div>
        ) : data?.kind === "image" ? (
          imageError ? (
            <div role="alert" className="preview-empty">
              {t("browse.invalid.image.or.unsupported.system.decoder")}
            </div>
          ) : (
            <div className={`preview-image ${zoom === null ? "fit" : ""}`}>
              <img
                key={data.content}
                src={data.content}
                alt={target.split(/[\\/]/).pop() ?? target}
                decoding="async"
                onError={() => setImageError(true)}
                style={
                  zoom === null
                    ? undefined
                    : {
                        width: (data.width ?? 1) * zoom,
                        height: (data.height ?? 1) * zoom,
                      }
                }
              />
            </div>
          )
        ) : data?.kind === "table" ? (
          table ? (
            <div className="preview-table-view">
              {notes.length > 0 && (
                <div className="preview-table-notice" role="note">
                  {notes.join(" · ")}
                </div>
              )}
              <PreviewTable
                key={`${target}:${sheetIndex}`}
                table={table}
                zh={zh}
                headerRows={headerRows}
              />
            </div>
          ) : (
            <div role="alert" className="preview-empty">
              {t("browse.table.data.is.incomplete.and.cannot")}
            </div>
          )
        ) : data ? (
          <div role="alert" className="preview-empty">
            {t("browse.this.build.cannot.display.this.preview")}
          </div>
        ) : null}
      </section>
      {textSelection.dialog}
      <footer className="preview-footer">
        {t("browse.text.2.mib.images.8.mib")}
      </footer>
    </section>
  );
}
