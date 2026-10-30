import { DescriptionTraceDialog } from "./DescriptionTraceDialog";
import { submittedDescriptionParts } from "../submittedTags";
import { useColumnWidths } from "../../../app/context-menu/useColumnWidths";
import { classifySubmission, submissionKindLabel } from "../submittedReport";
import { SubmittedChangeFiles } from "./SubmittedChangeFiles";
import { useChangeDetails } from "./ChangeDetailsDialog";
import { useCommandFocus } from "../../../app/shell/CommandContext";
import {
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronDown, ChevronRight, RefreshCw } from "lucide-react";
import type {
  ChangelistSummary,
  ClAction,
  SubmittedChangeDetail,
} from "../../../shared/contracts";
import type { messages } from "../../../shared/i18n";

import { useContextMenu } from "../../../app/context-menu/ContextMenu";
import { TableHeader } from "../../../app/context-menu/TableHeader";
import { action, copy } from "../../../app/context-menu/bindings";
import { useRecordSelection } from "../../../app/context-menu/useRecordSelection";
import { useMenuEnvironment } from "../../../app/context-menu/environment";
import { swarmMenuAction } from "../../swarm/SwarmAction";
import { PageHeaderActionsContext } from "../../../app/docking/chrome";
type Copy = (typeof messages)[keyof typeof messages];

interface Props {
  traceCandidates?: ChangelistSummary[];
  expansionScope: string;
  t: Copy;
  changes: ChangelistSummary[];
  loading: boolean;
  loadingMore: boolean;
  queryControls: ReactNode;
  resultSummary?: ReactNode;
  pageActions?: ReactNode;
  hiddenMergeCount: number;
  hasMore: boolean;
  partial: boolean;
  truncated: boolean;
  stats: { scannedCount: number; matchedCount: number; pageCount: number };
  pageError: string;
  selected: number | null;
  onRefresh(): void;
  onLoadMore(): void;
  onAction(action: ClAction): void;
  onSelectedChange(value: number | null): void;
  onDetailLoaded(value: SubmittedChangeDetail): void;
}

export function ChangelistPage(props: Props) {
  const { t, changes } = props;
  const columns = useColumnWidths(
    [120, 110, 400, 160, 160],
    [90, 90, 160, 100, 120],
    { id: "submitted" },
  );
  const scrollRef = useRef<HTMLDivElement>(null);
  const [trace, setTrace] = useState<{
    changeId: number;
    sourceChange: ChangelistSummary;
    owner: string;
    source?: HTMLElement;
  }>();
  const menu = useContextMenu();
  const openChangeDetails = useChangeDetails();
  const inspect = (id: number, source?: HTMLElement | null) =>
    openChangeDetails?.(
      { kind: "submitted", changeId: id, onLoaded: props.onDetailLoaded },
      source,
    );
  const env = useMenuEnvironment();
  const [expansion, setExpansion] = useState<{
    scope: string;
    ids: Set<number>;
  }>({ scope: props.expansionScope, ids: new Set() });
  const expanded =
    expansion.scope === props.expansionScope
      ? expansion.ids
      : new Set<number>();
  const fileCache = useRef({
    scope: props.expansionScope,
    entries: new Map<number, SubmittedChangeDetail>(),
  });
  if (fileCache.current.scope !== props.expansionScope)
    fileCache.current = { scope: props.expansionScope, entries: new Map() };
  const toggle = (id: number) =>
    setExpansion((previous) => {
      const ids = new Set(
        previous.scope === props.expansionScope ? previous.ids : [],
      );
      if (ids.has(id)) ids.delete(id);
      else ids.add(id);
      return { scope: props.expansionScope, ids };
    });

  const selection = useRecordSelection(
    changes,
    (change) => String(change.id),
    env.connectionKey,
  );
  const focus = useCommandFocus();
  const headerTarget = useContext(PageHeaderActionsContext);
  const [measured, setMeasured] = useState<{
    scope: string;
    heights: Map<number, number>;
  }>({ scope: props.expansionScope, heights: new Map() });
  const rowHeight = (id: number) =>
    expanded.has(id)
      ? 64 +
        (measured.scope === props.expansionScope
          ? (measured.heights.get(id) ?? 40)
          : 40)
      : 64;
  const reportHeight = (id: number, height: number) =>
    setMeasured((previous) => {
      const heights =
        previous.scope === props.expansionScope
          ? previous.heights
          : new Map<number, number>();
      if (heights.get(id) === height) return previous;
      return {
        scope: props.expansionScope,
        heights: new Map(heights).set(id, height),
      };
    });
  const virtualizer = useVirtualizer({
    count: changes.length,
    getScrollElement: () => scrollRef.current,
    getItemKey: (index) => changes[index].id,
    estimateSize: (index) => rowHeight(changes[index].id),
    overscan: 10,
    initialRect: { width: 800, height: 480 },
  });
  // Positive content measurements survive hidden tabs; the 64px CL row never collapses to zero.
  useLayoutEffect(() => {
    virtualizer.measure();
  }, [virtualizer, expansion, props.expansionScope, changes, measured]);
  const measuredRows = virtualizer.getVirtualItems();
  const visibleRows = measuredRows.length
    ? measuredRows
    : Array.from({ length: Math.min(changes.length, 18) }, (_, index) => ({
        index,
        key: changes[index].id,
        start: changes
          .slice(0, index)
          .reduce((height, change) => height + rowHeight(change.id), 0),
        size: rowHeight(changes[index].id),
        end: changes
          .slice(0, index + 1)
          .reduce((height, change) => height + rowHeight(change.id), 0),
        lane: 0,
      }));
  const changeMenu = (change: ChangelistSummary) =>
    menu(
      selection.targets(change).length > 1
        ? "C12"
        : change.status === "submitted"
          ? "C09"
          : change.status === "shelved"
            ? "C06"
            : change.user === env.runtime.context.user &&
                change.client === env.runtime.context.client
              ? "C02"
              : "C03",
      () => ({
        查看详情: action((source) => inspect(change.id, source)),
        追踪合并去向: action((source) =>
          setTrace({
            changeId: change.id,
            sourceChange: change,
            owner: props.expansionScope,
            source,
          }),
        ),
        "展开/折叠": action(() => toggle(change.id)),
        "复制 CL 编号": copy(change.id),
        "复制来源 CL 编号": copy(change.id),
        复制描述: copy(change.description),
        刷新: action(props.onRefresh),
        "在 Swarm 中打开": swarmMenuAction(env.runtime, env.preferences.zh, {
          kind:
            change.status === "shelved"
              ? "shelf"
              : change.status === "pending"
                ? "pendingChange"
                : "submittedChange",
          changeId: change.id,
        }),
        "复制 CL 编号列表": copy(
          selection
            .targets(change)
            .map((value) => value.id)
            .join("\n"),
        ),
        复制摘要列表: copy(
          selection
            .targets(change)
            .map((value) => `${value.id} ${value.description}`)
            .join("\n"),
        ),
      }),
      {
        title: `CL ${change.id}`,
        onOpen: () => {
          selection.context(change);
          props.onSelectedChange(change.id);
        },
      },
    );

  return (
    <section className="main-content">
      {trace?.owner === props.expansionScope && (
        <DescriptionTraceDialog
          key={trace.owner + trace.changeId}
          changeId={trace.changeId}
          sourceChange={trace.sourceChange}
          seedCandidates={props.traceCandidates ?? props.changes}
          runtime={env.runtime}
          zh={env.preferences.zh}
          source={trace.source}
          onClose={() => setTrace(undefined)}
        />
      )}
      {headerTarget &&
        createPortal(
          <>
            {props.pageActions}
            <button
              title={t.refresh}
              aria-label={t.refresh}
              onClick={props.onRefresh}
            >
              <RefreshCw
                size={15}
                aria-hidden="true"
                className={props.loading ? "spin" : ""}
              />
              <span>{t.refresh}</span>
            </button>
          </>,
          headerTarget,
        )}

      {!headerTarget && props.pageActions && (
        <div className="submitted-page-actions target-controls">
          {props.pageActions}
        </div>
      )}
      {props.queryControls}
      {props.resultSummary && (
        <div className="submitted-result-summary" role="status">
          {props.resultSummary}
        </div>
      )}

      <section
        className="cl-layout"
        style={{ gridTemplateColumns: "minmax(0, 1fr)" }}
      >
        <div className="cl-panel">
          <div
            className="submitted-table-header"
            style={{ minWidth: columns.style.minWidth }}
          >
            <TableHeader
              className="cl-table-head"
              resize={columns}
              columns={[
                { id: "change", label: "CL" },
                {
                  id: "submissionKind",
                  label: env.preferences.zh ? "提交类型" : "Submission type",
                },
                {
                  id: "description",
                  label: env.preferences.zh ? "描述" : "Description",
                },
                { id: "user", label: t.user },
                { id: "time", label: t.time },
              ]}
            />
          </div>
          <div
            ref={scrollRef}
            className="virtual-scroll"
            style={{ minWidth: columns.style.minWidth }}
            data-testid="cl-virtual-list"
            tabIndex={0}
            {...menu("C14", () => ({
              刷新: action(props.onRefresh),
              全选当前筛选结果: action(selection.all),
              清除选择: action(selection.clear),
            }))}
          >
            {changes.length === 0 &&
            props.loading &&
            props.stats.pageCount === 0 ? (
              <div className="empty-state" role="status">
                {env.preferences.zh
                  ? "正在查询 Submitted…"
                  : "Loading submitted changes…"}
              </div>
            ) : null}
            {changes.length === 0 &&
            (!props.loading || props.stats.pageCount > 0) ? (
              <div className="empty-state">{t.empty}</div>
            ) : null}
            <div
              className="virtual-spacer"
              style={{
                height: `${virtualizer.getTotalSize() || changes.reduce((sum, change) => sum + rowHeight(change.id), 0)}px`,
              }}
            >
              {visibleRows.map((row) => {
                const change = changes[row.index];
                return (
                  <div
                    key={change.id}
                    data-index={row.index}
                    className="submitted-change-row"
                    style={{
                      transform: `translateY(${row.start}px)`,
                      height: rowHeight(change.id),
                    }}
                  >
                    <button
                      style={columns.style}
                      className={`cl-row ${selection.isSelected(change) || props.selected === change.id ? "selected" : ""}`}
                      onFocus={() =>
                        focus({ type: "submitted", id: change.id })
                      }
                      {...changeMenu(change)}
                      onClick={(event) => {
                        selection.select(change, event);
                        props.onSelectedChange(change.id);
                        focus({ type: "submitted", id: change.id });
                      }}
                      onDoubleClick={(event) =>
                        inspect(change.id, event.currentTarget)
                      }
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          inspect(change.id, event.currentTarget);
                        }
                      }}
                    >
                      <span
                        className="submitted-cl-number"
                        title={String(change.id)}
                      >
                        <strong>{change.id}</strong>
                      </span>
                      <span
                        className="submission-kind-tag"
                        title={submissionKindLabel(
                          classifySubmission(change.description).kind,
                          env.preferences.zh,
                        )}
                      >
                        {submissionKindLabel(
                          classifySubmission(change.description).kind,
                          env.preferences.zh,
                        )}
                      </span>
                      <span
                        className="cl-description"
                        title={change.description}
                      >
                        <span>
                          {submittedDescriptionParts(change.description).map(
                            (part, index) =>
                              part.tag ? (
                                <span
                                  key={index}
                                  className="submitted-description-tag"
                                  title={part.tag}
                                >
                                  {part.tag}
                                </span>
                              ) : (
                                part.text
                              ),
                          )}
                        </span>
                      </span>
                      <span
                        className="submitted-author"
                        title={`${change.user} · ${change.client}`}
                      >
                        {change.user}
                        <small>{change.client}</small>
                      </span>
                      <time>
                        {new Intl.DateTimeFormat(undefined, {
                          month: "short",
                          day: "numeric",
                          hour: "2-digit",
                          minute: "2-digit",
                        }).format(new Date(change.time))}
                      </time>
                    </button>
                    <button
                      className="secondary submitted-expand"
                      aria-expanded={expanded.has(change.id)}
                      aria-label={`${env.preferences.zh ? (expanded.has(change.id) ? "收起文件" : "展开文件") : expanded.has(change.id) ? "Collapse files" : "Expand files"} · CL ${change.id}`}
                      title={
                        env.preferences.zh
                          ? "展开/收起改动文件"
                          : "Expand/collapse changed files"
                      }
                      onClick={(event) => {
                        event.stopPropagation();
                        toggle(change.id);
                      }}
                    >
                      {expanded.has(change.id) ? (
                        <ChevronDown size={15} aria-hidden="true" />
                      ) : (
                        <ChevronRight size={15} aria-hidden="true" />
                      )}
                    </button>
                    {expanded.has(change.id) && (
                      <SubmittedChangeFiles
                        key={`${props.expansionScope}:${change.id}`}
                        changeId={change.id}
                        scope={props.expansionScope}
                        cache={fileCache.current.entries}
                        runtime={env.runtime}
                        zh={env.preferences.zh}
                        outerScroll={scrollRef}
                        onHeight={(height) => reportHeight(change.id, height)}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          </div>
          <footer className="list-footer">
            <span>
              {changes.length.toLocaleString()} {t.changesUnit}
              {props.hasMore ? "+" : ""}
            </span>
            {props.hiddenMergeCount ? (
              <span>
                {t.hidden} {props.hiddenMergeCount} {t.changesUnit}
              </span>
            ) : null}
            <span className="submitted-query-stats" role="status">
              {env.preferences.zh
                ? `${props.stats.pageCount} 页 · 扫描 ${props.stats.scannedCount.toLocaleString()} · 匹配 ${props.stats.matchedCount.toLocaleString()}`
                : `${props.stats.pageCount} pages · ${props.stats.scannedCount.toLocaleString()} scanned · ${props.stats.matchedCount.toLocaleString()} matched`}
            </span>
            {props.truncated ? (
              <strong className="submitted-truncated" role="alert">
                {env.preferences.zh
                  ? "达到 5,000 条扫描上限，结果可能被截断。"
                  : "The 5,000-item scan limit was reached; results may be truncated."}
              </strong>
            ) : null}
            {props.partial && !props.truncated ? (
              <strong className="submitted-partial">
                {env.preferences.zh ? "当前为部分结果" : "Partial results"}
              </strong>
            ) : null}
            {props.pageError ? (
              <span className="submitted-page-error" role="alert">
                {props.pageError}
              </span>
            ) : null}
            {props.hasMore || props.pageError ? (
              <button
                className="secondary submitted-load-more"
                disabled={props.loading || props.loadingMore || !props.hasMore}
                onClick={props.onLoadMore}
              >
                {props.loadingMore
                  ? env.preferences.zh
                    ? "正在加载…"
                    : "Loading…"
                  : props.pageError
                    ? env.preferences.zh
                      ? "重试加载更多"
                      : "Retry load more"
                    : env.preferences.zh
                      ? "加载更多"
                      : "Load more"}
              </button>
            ) : null}
          </footer>
        </div>
      </section>
    </section>
  );
}
