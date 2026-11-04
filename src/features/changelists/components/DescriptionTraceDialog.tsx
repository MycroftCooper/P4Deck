import { t } from "../../../shared/i18n";
import { formatLocalTime } from "../../../shared/lib/localTime";
import { ColumnResizer } from "../../../app/context-menu/ColumnResizer";
import { useColumnWidths } from "../../../app/context-menu/useColumnWidths";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Dialog } from "../../../app/dialogs/Dialog";
import { backend } from "../../../infrastructure/backend";
import type {
  ChangelistSummary,
  ClQueryResult,
  FileReviewScope,
  RuntimeInfo,
} from "../../../shared/contracts";
import { appCache } from "../../../shared/cache/appCache";
import { isFresh, writeSnapshot } from "../../../shared/cache/snapshots";
import { createSharedGraphReader } from "../../browsers/graphReads";
import { makeReviewScope } from "../../browsers/reviewModel";
import { reachableDestinations } from "../descriptionTrace";
import { useChangeDetails } from "./ChangeDetailsDialog";

type PageRequest = {
  scope: FileReviewScope;
  sourceId: number;
  from: string;
  to: string;
  generation: number;
  cursor?: string;
  refresh?: boolean;
  operationId?: string;
};
let lastGeneration = 0;
const nextGeneration = () =>
  (lastGeneration = Math.max(Date.now(), lastGeneration + 1));
export const readDescriptionPage = createSharedGraphReader<
  PageRequest,
  ClQueryResult
>(
  (request) =>
    backend.queryChangelists({
      operationId: request.operationId!,
      requestGeneration: request.generation,
      keyword: "",
      users: [],
      clients: [],
      jobs: [],
      streams: [],
      from: request.from,
      to: request.to,
      mergeClassifications: [],
      hideReliableMerges: false,
      pageSize: 100,
      cursor: request.cursor,
    }),
  (id) => backend.cancelOperation(id).then(() => undefined),
  (request, mode) => [
    "target",
    "ci-reference-destinations-page-v1",
    mode,
    request.scope,
    request.sourceId,
    request.from,
    request.to,
    request.generation,
    request.cursor ?? "",
  ],
);
type Snapshot = {
  description: string;
  from: string;
  to: string;
  generation: number;
  rows: ChangelistSummary[];
  investigated: ChangelistSummary[];
  pages: number;
  scanned: number;
  cursor?: string;
  cursors: string[];
  complete: boolean;
  limited: boolean;
  readAt: number;
};
type Props = {
  seedCandidates?: ChangelistSummary[];
  changeId: number;
  sourceChange: Pick<ChangelistSummary, "description" | "time">;
  runtime: RuntimeInfo;
  zh: boolean;
  onClose(): void;
  source?: HTMLElement;
};

/** The positioning box never lets unmeasured content overlap the next row. */
function MeasuredCandidate({
  children,
  report,
}: {
  children: ReactNode;
  report(height: number): void;
}) {
  const content = useRef<HTMLDivElement>(null);
  const reportRef = useRef(report);
  reportRef.current = report;
  useLayoutEffect(() => {
    const node = content.current!;
    const measure = () => {
      // Virtualizer sizes are layout pixels; bounding rects include CSS zoom.
      const height = node.offsetHeight || node.getBoundingClientRect().height;
      if (Number.isFinite(height) && height > 0)
        reportRef.current(Math.ceil(height));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    const node = content.current!;
    const height = node.offsetHeight || node.getBoundingClientRect().height;
    if (Number.isFinite(height) && height > 0)
      reportRef.current(Math.ceil(height));
  });
  return (
    <div ref={content} className="description-trace-row-content">
      {children}
    </div>
  );
}
export function DescriptionTraceDialog(props: Props) {
  const owner = JSON.stringify([
    props.runtime.mode,
    makeReviewScope(props.runtime, `//change/${props.changeId}`),
    props.sourceChange,
  ]);
  return <DescriptionTraceContent key={owner} {...props} />;
}
function DescriptionTraceContent({
  changeId,
  sourceChange,
  seedCandidates = [],
  runtime,
  zh,
  onClose,
  source,
}: Props) {
  const tr = (cn: string, en: string) => (zh ? cn : en);
  const scope = makeReviewScope(runtime, `//change/${changeId}`);
  const key = [
    "target",
    "ci-reference-destinations-v1",
    runtime.mode,
    scope,
    changeId,
    sourceChange,
  ];
  function seedSnapshot(): Snapshot | undefined {
    const to = new Date().toISOString();
    if (
      !Number.isFinite(Date.parse(sourceChange.time)) ||
      Date.parse(sourceChange.time) > Date.parse(to)
    )
      return;
    const rows = [
      ...new Map(
        seedCandidates
          .filter(
            (row) =>
              Date.parse(row.time) >= Date.parse(sourceChange.time) &&
              Date.parse(row.time) <= Date.parse(to),
          )
          .map((row) => [row.id, row]),
      ).values(),
    ];
    return {
      description: sourceChange.description,
      from: new Date(sourceChange.time).toISOString(),
      to,
      generation: nextGeneration(),
      rows: reachableDestinations(changeId, rows),
      investigated: rows,
      pages: 0,
      scanned: 0,
      cursors: [],
      complete: false,
      limited: false,
      readAt: Date.now(),
    };
  }
  const [snapshot, setSnapshot] = useState<Snapshot | undefined>(
    () =>
      (isFresh(key, 15_000)
        ? appCache.getQueryData<Snapshot>(key)
        : undefined) ?? seedSnapshot(),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [expandedDescriptions, setExpandedDescriptions] = useState<Set<number>>(
    () => new Set(),
  );
  const active = useRef<AbortController | undefined>(undefined);
  const openDetails = useChangeDetails();
  const scroll = useRef<HTMLDivElement>(null);
  const columns = useColumnWidths([80, 280, 170, 280], [64, 160, 120, 160], {
    id: "cl-reference-destinations",
    gutter: 0,
  });
  const virtualizer = useVirtualizer({
    count: snapshot?.rows.length ?? 0,
    getScrollElement: () => scroll.current,
    estimateSize: () => 112,
    getItemKey: (index) => snapshot!.rows[index].id,
    overscan: 5,
    initialRect: { width: 800, height: 320 },
  });
  useEffect(() => {
    virtualizer.measure();
  }, [columns.widths, virtualizer]);
  const measured = virtualizer.getVirtualItems();
  const visibleRows = measured.length
    ? measured
    : Array.from(
        { length: Math.min(snapshot?.rows.length ?? 0, 15) },
        (_, index) => ({ index, start: index * 112, size: 112 }),
      );
  useEffect(() => () => active.current?.abort(), []);
  async function load(refresh = false) {
    if (active.current) return;
    if (runtime.mode !== "mock" && runtime.connection.state !== "connected") {
      setError(t("pending.connection.unavailable"));
      return;
    }
    if (!refresh && snapshot?.complete) return;
    if (!refresh && snapshot?.limited && !snapshot.cursor) return;
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    setError("");
    try {
      let previous = refresh ? undefined : snapshot;
      if (!previous) {
        const to = new Date().toISOString();
        const detail = sourceChange;
        if (
          !Number.isFinite(Date.parse(detail.time)) ||
          Date.parse(detail.time) > Date.parse(to)
        )
          throw new Error(
            tr(
              "源CL提交时间无效，无法限定后续查询",
              "Invalid source submission time; cannot bound the investigation",
            ),
          );
        previous = {
          description: detail.description,
          from: new Date(detail.time).toISOString(),
          to,
          generation: nextGeneration(),
          rows: seedSnapshot()?.rows ?? [],
          investigated: seedSnapshot()?.investigated ?? [],
          pages: 0,
          scanned: 0,
          cursors: [],
          complete: false,
          limited: false,
          readAt: Date.now(),
        };
      }
      for (let attempt = 0; attempt < 10; attempt++) {
        const page = await readDescriptionPage(
          {
            scope,
            sourceId: changeId,
            from: previous.from,
            to: previous.to,
            generation: previous.generation,
            cursor: previous.cursor,
            refresh,
          },
          runtime.mode,
          controller.signal,
        );
        if (controller.signal.aborted) return;
        if (
          page.requestGeneration !== previous.generation ||
          !Array.isArray(page.items)
        )
          throw new Error(
            tr(
              "查询响应不兼容或连接已变化",
              "Incompatible response or changed connection",
            ),
          );
        if (
          page.hasMore &&
          (!page.nextCursor || previous.cursors.includes(page.nextCursor))
        )
          throw new Error(
            tr(
              "分页游标无效，请刷新调查",
              "Invalid page cursor; refresh the investigation",
            ),
          );
        const rows = new Map(previous.investigated.map((row) => [row.id, row]));
        for (const row of page.items) {
          const time = Date.parse(row.time);
          if (!Number.isFinite(time))
            throw new Error(
              tr(
                "候选提交时间无效，请刷新核对",
                "Invalid candidate submission time; refresh to recheck",
              ),
            );
          if (
            time >= Date.parse(previous.from) &&
            time <= Date.parse(previous.to)
          )
            rows.set(row.id, row);
        }
        const pages = previous.pages + 1;
        const next: Snapshot = {
          ...previous,
          rows: reachableDestinations(changeId, [...rows.values()]),
          investigated: [...rows.values()],
          pages,
          scanned: previous.scanned + page.stats.scannedCount,
          cursor: page.nextCursor,
          cursors: page.nextCursor
            ? [...previous.cursors, page.nextCursor]
            : previous.cursors,
          complete: !page.hasMore && !page.stats.truncatedBySafetyLimit,
          limited:
            page.stats.truncatedBySafetyLimit ||
            (page.hasMore && attempt === 9),
          readAt: Date.now(),
        };
        writeSnapshot(key, next);
        setSnapshot(next);
        previous = next;
        if (next.complete || next.limited) break;
      }
    } catch (cause) {
      if (!controller.signal.aborted) setError(String(cause));
    } finally {
      if (active.current === controller) {
        active.current = undefined;
        setBusy(false);
      }
    }
  }
  return (
    <Dialog
      title={`${t("pending.trace.integration.destinations")} · CL ${changeId}`}
      zh={zh}
      source={source}
      onRequestClose={() => {
        active.current?.abort();
        onClose();
      }}
      footer={
        <>
          <button
            disabled={
              busy ||
              snapshot?.complete ||
              (snapshot?.limited && !snapshot.cursor)
            }
            onClick={() => void load()}
          >
            {snapshot && snapshot.pages > 0
              ? t("pending.continue.search.up.to.10")
              : t("pending.find.destinations")}
          </button>
          <button disabled={busy} onClick={() => void load(true)}>
            {t("pending.refresh.investigation")}
          </button>
          {busy && (
            <button
              onClick={() => {
                active.current?.abort();
                setError(
                  tr(
                    "已取消；当前结果可能不完整",
                    "Cancelled; current results may be incomplete",
                  ),
                );
              }}
            >
              {t("pending.cancel.reads")}
            </button>
          )}
        </>
      }
    >
      {error && <p role="alert">{error}</p>}
      {snapshot && (
        <>
          <div className="description-trace-toolbar">
            <div
              className="description-trace-summary"
              title={tr(
                "按 CI 元数据中的来源 CL 引用链查找直接和间接合并提交",
                "Direct and indirect submissions linked by CI source CL metadata",
              )}
            >
              {t("pending.cl.reference.chain")}
            </div>
            <small>
              {t("pending.range")}:{" "}
              {formatLocalTime(snapshot.from, zh ? "zh-CN" : "en-US")} →{" "}
              {formatLocalTime(snapshot.to, zh ? "zh-CN" : "en-US")}
            </small>
            <p role="status">
              {t("pending.candidates")}: {snapshot.rows.length} ·{" "}
              {t("pending.scanned")}: {snapshot.scanned} · {t("pending.pages")}:{" "}
              {snapshot.pages} ·{" "}
              {formatLocalTime(snapshot.readAt, zh ? "zh-CN" : "en-US")}
            </p>
            {(!snapshot.complete || !!error) && (
              <small role="status">
                {snapshot.limited
                  ? tr(
                      "达到本轮上限 · 未完成",
                      "Query limit reached · Incomplete",
                    )
                  : t("pending.incomplete")}
              </small>
            )}
          </div>
          {!snapshot.rows.length && (
            <p>
              {tr(
                "已查询范围内未发现CL引用链候选。",
                "No CL-reference candidates in the queried range.",
              )}
            </p>
          )}
          <div
            ref={scroll}
            className="description-trace-results"
            style={{ overflow: "auto", maxHeight: "50vh" }}
            role="table"
            aria-label={t("pending.cl.reference.candidates")}
          >
            <div
              role="row"
              style={{
                display: "grid",
                ...columns.style,
              }}
            >
              {[
                "CL",
                "Workspace / Client",
                t("pending.time"),
                t("pending.description"),
              ].map((label, index) => (
                <strong
                  role="columnheader"
                  key={label}
                  style={{ position: "relative" }}
                >
                  {label}
                  <ColumnResizer resize={columns} index={index} label={label} />
                </strong>
              ))}
            </div>
            <div
              style={{
                height: virtualizer.getTotalSize(),
                position: "relative",
                minWidth: columns.style.minWidth,
              }}
            >
              {visibleRows.map((item) => {
                const row = snapshot.rows[item.index];
                return (
                  <div
                    role="row"
                    key={row.id}
                    data-index={item.index}
                    style={{
                      position: "absolute",
                      top: item.start,
                      height: item.size,
                      overflow: "hidden",
                      width: "100%",
                      minWidth: columns.style.minWidth,
                    }}
                  >
                    <MeasuredCandidate
                      report={(height) =>
                        virtualizer.resizeItem(item.index, height)
                      }
                    >
                      <div
                        style={{
                          display: "grid",
                          minHeight: 112,
                          ...columns.style,
                        }}
                      >
                        <div role="cell">
                          <button
                            disabled={!openDetails}
                            onClick={(event) =>
                              openDetails?.(
                                { kind: "submitted", changeId: row.id },
                                event.currentTarget,
                              )
                            }
                          >
                            {row.id}
                          </button>
                        </div>
                        <div
                          role="cell"
                          title={row.client}
                          style={{
                            overflowWrap: "anywhere",
                            whiteSpace: "pre-wrap",
                          }}
                        >
                          {row.client || t("pending.unknown")}
                        </div>
                        <div role="cell">
                          {formatLocalTime(row.time, zh ? "zh-CN" : "en-US")}
                        </div>
                        <div
                          role="cell"
                          title={row.description}
                          style={{
                            whiteSpace: "pre-wrap",
                            overflowWrap: "anywhere",
                          }}
                        >
                          <div
                            className={
                              expandedDescriptions.has(row.id)
                                ? "description-trace-text expanded"
                                : "description-trace-text"
                            }
                          >
                            {row.description}
                          </div>
                          <button
                            type="button"
                            aria-expanded={expandedDescriptions.has(row.id)}
                            onClick={() =>
                              setExpandedDescriptions((previous) => {
                                const next = new Set(previous);
                                if (next.has(row.id)) next.delete(row.id);
                                else next.add(row.id);
                                return next;
                              })
                            }
                          >
                            {expandedDescriptions.has(row.id)
                              ? t("pending.collapse.description")
                              : t("pending.expand.description")}
                          </button>
                        </div>
                      </div>
                    </MeasuredCandidate>
                  </div>
                );
              })}
            </div>
          </div>
        </>
      )}
    </Dialog>
  );
}
