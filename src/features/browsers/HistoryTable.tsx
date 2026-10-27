import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent,
  type RefObject,
} from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { FileRevision } from "../../shared/contracts/types";
import type { useContextMenu } from "../../app/context-menu/ContextMenu";

const minimums = [140, 190, 100, 180];
const defaults = [170, 210, 120, 360];

export function historyTime(value: string, locale?: string) {
  const date = new Date(value);
  return !value || !Number.isFinite(date.getTime())
    ? "—"
    : new Intl.DateTimeFormat(locale, {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      }).format(date);
}

function Description({
  text,
  expanded,
  toggle,
  zh,
  controls,
}: {
  text: string;
  expanded: boolean;
  toggle(): void;
  zh: boolean;
  controls: string;
}) {
  const preview = useRef<HTMLSpanElement>(null);
  const [truncated, setTruncated] = useState(false);
  useLayoutEffect(() => {
    const element = preview.current!;
    const measure = () =>
      setTruncated(
        !!text &&
          (/\r|\n/.test(text) || element.scrollWidth > element.clientWidth),
      );
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    let live = true;
    void element.ownerDocument.fonts?.ready.then(() => {
      if (live) measure();
    });
    return () => {
      live = false;
      observer.disconnect();
    };
  }, [text]);
  const label = expanded
    ? zh
      ? "折叠描述"
      : "Collapse description"
    : zh
      ? "展开描述"
      : "Expand description";
  return (
    <div className="history-description-cell" role="gridcell">
      <span ref={preview} className="history-description-preview">
        {text || "—"}
      </span>
      <span className="history-description-toggle-slot">
        {(truncated || expanded) && (
          <button
            type="button"
            title={label}
            aria-label={label}
            aria-expanded={expanded}
            aria-controls={expanded ? controls : undefined}
            onPointerDown={(event) => event.stopPropagation()}
            onKeyDown={(event) => event.stopPropagation()}
            onContextMenu={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              toggle();
            }}
          >
            {expanded ? (
              <ChevronUp size={15} aria-hidden="true" />
            ) : (
              <ChevronDown size={15} aria-hidden="true" />
            )}
          </button>
        )}
      </span>
    </div>
  );
}

/** History-only presentation. No backend calls; widths follow Pending's local pointer-capture model. */
export function HistoryTable({
  rows,
  scroll,
  zh,
  isSelected,
  selectionOrder,
  onSelect,
  rowMenu,
}: {
  rows: FileRevision[];
  scroll: RefObject<HTMLDivElement | null>;
  zh: boolean;
  isSelected(row: FileRevision): boolean;
  selectionOrder?(row: FileRevision): number;
  onSelect(
    row: FileRevision,
    event: Pick<MouseEvent, "shiftKey" | "ctrlKey" | "metaKey">,
  ): void;
  rowMenu(row: FileRevision): ReturnType<ReturnType<typeof useContextMenu>>;
}) {
  const [widths, setWidths] = useState(defaults);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const drag = useRef<{
    pointer: number;
    index: number;
    x: number;
    widths: number[];
  } | null>(null);
  const identity = (row: FileRevision) => `${row.depotPath}#${row.revision}`;
  const instance = useId();
  const labels = zh
    ? ["版本号 / CL号", "时间", "提交人", "描述"]
    : ["Revision / CL", "Time", "User", "Description"];
  const virtual = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroll.current,
    estimateSize: () => 52,
    getItemKey: (index) => identity(rows[index]),
    overscan: 8,
  });
  // Expanded text wraps at the new column/table width; discard stale virtual heights.
  useEffect(() => {
    virtual.measure();
  }, [widths, expanded, virtual]);
  const updateDrag = (x: number) => {
    const current = drag.current;
    if (!current) return;
    const next = [...current.widths];
    next[current.index] = Math.max(
      minimums[current.index],
      next[current.index] + x - current.x,
    );
    setWidths(next);
  };
  const style = {
    gridTemplateColumns: widths
      .map((width, i) => (i === 3 ? `minmax(${width}px, 1fr)` : `${width}px`))
      .join(" "),
  };
  return (
    <div
      className="history-table"
      style={{ minWidth: widths.reduce((sum, value) => sum + value, 0) }}
      role="grid"
      aria-label={zh ? "文件历史" : "File history"}
      aria-multiselectable="true"
    >
      <div className="history-columns workspace-head" role="row" style={style}>
        {labels.map((label, index) => (
          <div role="columnheader" key={label}>
            {label}
            <div
              role="separator"
              tabIndex={0}
              aria-orientation="vertical"
              aria-label={zh ? `调整${label}列宽` : `Resize ${label} column`}
              aria-valuemin={minimums[index]}
              aria-valuenow={widths[index]}
              className="history-column-resizer"
              onClick={(event) => event.stopPropagation()}
              onPointerDown={(event) => {
                if (event.button !== 0) return;
                event.preventDefault();
                event.stopPropagation();
                const cells =
                  event.currentTarget.parentElement!.parentElement!.children;
                const measured = Array.from(cells, (cell, i) =>
                  Math.max(
                    minimums[i],
                    cell.getBoundingClientRect().width || widths[i],
                  ),
                );
                drag.current = {
                  pointer: event.pointerId,
                  index,
                  x: event.clientX,
                  widths: measured,
                };
                event.currentTarget.setPointerCapture(event.pointerId);
              }}
              onPointerMove={(event) => {
                if (drag.current?.pointer === event.pointerId)
                  updateDrag(event.clientX);
              }}
              onPointerUp={(event) => {
                if (drag.current?.pointer !== event.pointerId) return;
                updateDrag(event.clientX);
                drag.current = null;
                event.currentTarget.releasePointerCapture(event.pointerId);
              }}
              onPointerCancel={() => {
                drag.current = null;
              }}
              onLostPointerCapture={() => {
                drag.current = null;
              }}
              onKeyDown={(event) => {
                if (!["ArrowLeft", "ArrowRight", "Home"].includes(event.key))
                  return;
                event.preventDefault();
                event.stopPropagation();
                setWidths((current) =>
                  current.map((width, i) =>
                    i !== index
                      ? width
                      : event.key === "Home"
                        ? minimums[i]
                        : Math.max(
                            minimums[i],
                            width + (event.key === "ArrowLeft" ? -10 : 10),
                          ),
                  ),
                );
              }}
            />
          </div>
        ))}
      </div>
      <div
        className="virtual-spacer"
        style={{ height: virtual.getTotalSize() }}
      >
        {virtual.getVirtualItems().map((row) => {
          const item = rows[row.index],
            key = identity(item),
            open = expanded.has(key),
            events = rowMenu(item);
          return (
            <div
              key={key}
              data-index={row.index}
              ref={virtual.measureElement}
              className="history-record"
              role="rowgroup"
              style={{ transform: `translateY(${row.start}px)` }}
            >
              <div
                role="row"
                tabIndex={0}
                aria-selected={isSelected(item)}
                data-selection-order={selectionOrder?.(item) || undefined}
                aria-label={`${item.depotPath}#${item.revision}${selectionOrder?.(item) ? (selectionOrder(item) === 1 ? (zh ? "，先选版本" : ", first selected") : zh ? "，后选版本，获取此版本的目标" : ", last selected, Get this revision target") : ""}`}
                title={
                  selectionOrder?.(item)
                    ? selectionOrder(item) === 1
                      ? zh
                        ? "先选版本"
                        : "First selected"
                      : zh
                        ? "后选版本 · 获取此版本的目标"
                        : "Last selected · Get this revision target"
                    : undefined
                }
                className={`history-columns workspace-row history-row ${isSelected(item) ? "selected" : ""}`}
                style={style}
                {...events}
                onClick={(event) => onSelect(item, event)}
                onKeyDown={(event) => {
                  events.onKeyDown(event);
                  if (
                    event.defaultPrevented ||
                    event.target !== event.currentTarget ||
                    !["Enter", " "].includes(event.key)
                  )
                    return;
                  event.preventDefault();
                  onSelect(item, event);
                }}
              >
                <span role="gridcell">
                  #{item.revision} · CL {item.changelistId}
                </span>
                <time
                  role="gridcell"
                  title={
                    item.time
                      ? historyTime(item.time, zh ? "zh-CN" : "en-US")
                      : undefined
                  }
                >
                  {historyTime(item.time, zh ? "zh-CN" : "en-US")}
                </time>
                <span role="gridcell">{item.user || "—"}</span>
                <Description
                  controls={`${instance}-${row.index}`}
                  text={item.description}
                  expanded={open}
                  zh={zh}
                  toggle={() =>
                    setExpanded((current) => {
                      const next = new Set(current);
                      if (next.has(key)) next.delete(key);
                      else next.add(key);
                      return next;
                    })
                  }
                />
              </div>
              {open && (
                <div
                  role="row"
                  className="history-description-row"
                  id={`${instance}-${row.index}`}
                >
                  <div role="gridcell" aria-colspan={4}>
                    {item.description}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
