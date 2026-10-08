import { useCommandFocus } from "../../../app/shell/CommandContext";
import { useMemo, useRef, useState, type ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  GitMerge,
  MoreHorizontal,
  Plus,
  RefreshCw,
  ShieldAlert,
  ShieldQuestion,
} from "lucide-react";
import type {
  ChangelistSummary,
  ChangeStatus,
  ClAction,
  SubmittedChangeDetail,
} from "../../../shared/contracts/types";
import type { messages } from "../../../shared/i18n";

import { useContextMenu } from "../../../app/context-menu/ContextMenu";
import { TableHeader } from "../../../app/context-menu/TableHeader";
import { action, copy } from "../../../app/context-menu/bindings";
import { useRecordSelection } from "../../../app/context-menu/useRecordSelection";
import { useMenuEnvironment } from "../../../app/context-menu/environment";
import { RevisionFileList } from "./RevisionFileList";
import { ChangelistFormDialog } from "./ChangelistFormDialog";
import { backend } from "../../../infrastructure/backend";
type Copy = (typeof messages)[keyof typeof messages];

interface Props {
  t: Copy;
  changes: ChangelistSummary[];
  loading: boolean;
  loadingMore: boolean;
  queryControls: ReactNode;
  hiddenMergeCount: number;
  hasMore: boolean;
  partial: boolean;
  truncated: boolean;
  stats: { scannedCount: number; matchedCount: number; pageCount: number };
  pageError: string;
  selected: number | null;
  detail: SubmittedDetailViewState;
  mock: boolean;
  onRefresh(): void;
  onLoadMore(): void;
  onAction(action: ClAction): void;
  onSelectedChange(value: number | null): void;
  onRetryDetail(): void;
}

export type SubmittedDetailViewState =
  | { phase: "idle" }
  | { phase: "loading"; changeId: number }
  | { phase: "error"; changeId: number; message: string }
  | { phase: "success"; changeId: number; value: SubmittedChangeDetail };

export function ChangelistPage(props: Props) {
  const { t, changes } = props;
  const scrollRef = useRef<HTMLDivElement>(null);
  const menu = useContextMenu();
  const env = useMenuEnvironment();
  const selection = useRecordSelection(
    changes,
    (change) => String(change.id),
    env.connectionKey,
  );
  const focus = useCommandFocus();
  const [createSource, setCreateSource] = useState<HTMLElement>();
  const virtualizer = useVirtualizer({
    count: changes.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 64,
    overscan: 10,
    initialRect: { width: 800, height: 480 },
  });
  const measuredRows = virtualizer.getVirtualItems();
  const visibleRows = measuredRows.length
    ? measuredRows
    : Array.from({ length: Math.min(changes.length, 18) }, (_, index) => ({
        index,
        key: changes[index].id,
        start: index * 64,
        size: 64,
        end: (index + 1) * 64,
        lane: 0,
      }));
  const selectedChange = useMemo(
    () => changes.find((change) => change.id === props.selected),
    [changes, props.selected],
  );

  const detailValue =
    props.detail.phase === "success" &&
    props.detail.changeId === selectedChange?.id
      ? props.detail.value
      : undefined;

  const statusLabel = (status: ChangeStatus) =>
    status === "pending"
      ? t.pending
      : status === "shelved"
        ? t.shelved
        : t.submitted;

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
        查看详情: action(() => props.onSelectedChange(change.id)),
        "展开/折叠": action(() =>
          props.onSelectedChange(
            props.selected === change.id ? null : change.id,
          ),
        ),
        "复制 CL 编号": copy(change.id),
        "复制来源 CL 编号": copy(change.id),
        复制描述: copy(change.description),
        刷新: action(props.onRefresh),
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
    <main className="main-content">
      {createSource && (
        <ChangelistFormDialog
          mode="create"
          client={env.runtime.context.client}
          zh={env.preferences.zh}
          source={createSource}
          onDismiss={() => setCreateSource(undefined)}
          onSubmit={async (draft) => {
            try {
              const result = await backend.mutatePendingChange({
                type: "create",
                description: draft.description,
                jobs: draft.jobs,
                operationId: crypto.randomUUID(),
              });
              if (result.refreshError) {
                window.dispatchEvent(new Event("p4deck:pending-refresh"));
                throw new Error(
                  `${env.preferences.zh ? "CL 可能已创建，但刷新失败；请关闭并刷新后确认，不要直接重试。" : "The changelist may have been created, but refresh failed. Close and refresh before retrying."} ${result.refreshError}`,
                );
              }
              window.dispatchEvent(
                new CustomEvent("p4deck:pending-mutation", { detail: result }),
              );
            } catch (cause) {
              window.dispatchEvent(new Event("p4deck:pending-refresh"));
              throw cause;
            }
          }}
        />
      )}
      <header className="page-header">
        <div>
          <p className="eyebrow">{t.defaultScope}</p>
          <h1>{t.title}</h1>
          <p>{t.subtitle}</p>
        </div>
        <div className="header-actions">
          <button className="secondary" onClick={props.onRefresh}>
            <RefreshCw size={15} className={props.loading ? "spin" : ""} />
            {t.refresh}
          </button>
          <button
            className="primary"
            onClick={(event) => setCreateSource(event.currentTarget)}
          >
            <Plus size={16} />
            {t.create}
          </button>
        </div>
      </header>

      {props.queryControls}

      <section className="cl-layout">
        <div className="cl-panel">
          <TableHeader
            className="cl-table-head"
            columns={[
              { id: "change", label: "CL" },
              { id: "status", label: t.status },
              { id: "user", label: t.user },
              { id: "count", label: t.files },
              { id: "time", label: t.time },
            ]}
          />
          <div
            ref={scrollRef}
            className="virtual-scroll"
            data-testid="cl-virtual-list"
            tabIndex={0}
            {...menu("C14", () => ({
              刷新: action(props.onRefresh),
              全选当前筛选结果: action(selection.all),
              清除选择: action(selection.clear),
            }))}
          >
            {changes.length === 0 && props.loading ? (
              <div className="empty-state" role="status">
                {env.preferences.zh
                  ? "正在查询 Submitted…"
                  : "Loading submitted changes…"}
              </div>
            ) : null}
            {changes.length === 0 && !props.loading ? (
              <div className="empty-state">{t.empty}</div>
            ) : null}
            <div
              className="virtual-spacer"
              style={{
                height: `${virtualizer.getTotalSize() || changes.length * 64}px`,
              }}
            >
              {visibleRows.map((row) => {
                const change = changes[row.index];
                return (
                  <button
                    key={change.id}
                    className={`cl-row ${selection.isSelected(change) || props.selected === change.id ? "selected" : ""}`}
                    style={{
                      transform: `translateY(${row.start}px)`,
                      height: `${row.size}px`,
                    }}
                    onFocus={() => focus({ type: "submitted", id: change.id })}
                    {...changeMenu(change)}
                    onClick={(event) => {
                      selection.select(change, event);
                      props.onSelectedChange(change.id);
                      focus({ type: "submitted", id: change.id });
                    }}
                    aria-expanded={props.selected === change.id}
                  >
                    <span className="cl-description">
                      <strong>{change.id}</strong>
                      <span>{change.description}</span>
                      {change.mergeClassification === "reliableMerge" ? (
                        <em className="merge-tag">
                          <GitMerge size={11} />
                          {t.merge}
                        </em>
                      ) : null}
                      {change.mergeClassification === "suspectedMerge" ? (
                        <em
                          className="merge-tag suspected"
                          title={t.suspectedHint}
                        >
                          <ShieldAlert size={11} />
                          {t.suspected}
                        </em>
                      ) : null}
                      {change.mergeClassification === "unknown" ? (
                        <em className="merge-tag unknown" title={t.unknownHint}>
                          <ShieldQuestion size={11} />
                          {t.unknownClassification}
                        </em>
                      ) : null}
                    </span>
                    <span>
                      <i className={`status-pill ${change.status}`}>
                        {statusLabel(change.status)}
                      </i>
                    </span>
                    <span className="muted-cell">
                      {change.user}
                      <small>{change.client}</small>
                    </span>
                    <span className="count-cell">{change.fileCount}</span>
                    <time>
                      {new Intl.DateTimeFormat(undefined, {
                        month: "short",
                        day: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                      }).format(new Date(change.time))}
                    </time>
                  </button>
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
                disabled={props.loadingMore || !props.hasMore}
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

        <aside className={`detail-panel ${selectedChange ? "visible" : ""}`}>
          {selectedChange ? (
            <>
              <header>
                <div>
                  <small>CHANGE</small>
                  <h2>{selectedChange.id}</h2>
                </div>
                <button
                  className="icon-button"
                  aria-label={t.more}
                  onClick={(event) =>
                    changeMenu(selectedChange).onContextMenu(event)
                  }
                >
                  <MoreHorizontal size={18} />
                </button>
              </header>
              <p className="detail-description">{selectedChange.description}</p>
              <dl>
                <div>
                  <dt>{t.user}</dt>
                  <dd>{selectedChange.user}</dd>
                </div>
                <div>
                  <dt>{t.workspace}</dt>
                  <dd>{selectedChange.client}</dd>
                </div>
                <div>
                  <dt>{t.status}</dt>
                  <dd>{statusLabel(selectedChange.status)}</dd>
                </div>
                <div>
                  <dt>{t.files}</dt>
                  <dd>{selectedChange.fileCount}</dd>
                </div>
              </dl>
              {props.mock ? (
                <p className="mock-detail-notice">{t.mockDetailNotice}</p>
              ) : null}
              {props.detail.phase === "loading" &&
              props.detail.changeId === selectedChange.id ? (
                <div className="submitted-detail-state" role="status">
                  <RefreshCw className="spin" size={16} />
                  {t.detailLoading}
                </div>
              ) : null}
              {props.detail.phase === "error" &&
              props.detail.changeId === selectedChange.id ? (
                <div className="submitted-detail-state error" role="alert">
                  <strong>{t.detailError}</strong>
                  <span>{props.detail.message}</span>
                  <button className="secondary" onClick={props.onRetryDetail}>
                    {t.retry}
                  </button>
                </div>
              ) : null}
              {detailValue ? (
                <div className="submitted-detail-content">
                  <dl>
                    <div>
                      <dt>{t.classification}</dt>
                      <dd
                        className={`classification ${detailValue.mergeClassification}`}
                      >
                        {detailValue.mergeClassification === "reliableMerge"
                          ? t.merge
                          : detailValue.mergeClassification === "suspectedMerge"
                            ? t.suspected
                            : detailValue.mergeClassification === "normal"
                              ? t.normalChange
                              : t.unknownClassification}
                      </dd>
                    </div>
                    <div>
                      <dt>{t.inspection}</dt>
                      <dd>
                        {detailValue.inspectionStatus === "complete"
                          ? t.inspectionComplete
                          : detailValue.inspectionStatus === "partial"
                            ? t.inspectionPartial
                            : t.inspectionUnavailable}
                      </dd>
                    </div>
                  </dl>
                  {detailValue.message ? (
                    <p className="inspection-message">{detailValue.message}</p>
                  ) : null}
                  <p className="classification-hint">
                    {detailValue.mergeClassification === "reliableMerge"
                      ? t.reliableEvidenceHint
                      : detailValue.mergeClassification === "suspectedMerge"
                        ? t.suspectedHint
                        : detailValue.mergeClassification === "unknown"
                          ? t.unknownHint
                          : t.noIntegrationEvidence}
                  </p>
                  <section className="submitted-detail-section">
                    <h3>{t.jobs}</h3>
                    {detailValue.jobs.length ? (
                      <ul className="submitted-jobs">
                        {detailValue.jobs.map((job) => (
                          <li key={job}>{job}</li>
                        ))}
                      </ul>
                    ) : (
                      <p className="detail-empty">{t.noJobs}</p>
                    )}
                  </section>
                  <section className="submitted-detail-section">
                    <h3>{t.integrationEvidence}</h3>
                    {detailValue.integrationEvidence.length ? (
                      <ul className="integration-evidence">
                        {detailValue.integrationEvidence.map(
                          (evidence, index) => (
                            <li
                              key={`${evidence.source}:${evidence.depotPath}:${index}`}
                            >
                              <strong>
                                {evidence.source === "describeAction"
                                  ? "describe action"
                                  : "filelog"}
                              </strong>
                              <span>{evidence.depotPath}</span>
                              <code>{evidence.relationship}</code>
                              {evidence.relatedPath ? (
                                <span>→ {evidence.relatedPath}</span>
                              ) : null}
                            </li>
                          ),
                        )}
                      </ul>
                    ) : (
                      <p className="detail-empty">{t.noIntegrationEvidence}</p>
                    )}
                  </section>
                  <section className="submitted-detail-section submitted-files-section">
                    <h3>
                      {t.submittedFiles} · {detailValue.files.length}
                    </h3>
                    <RevisionFileList
                      scope={`${selectedChange.id}:${props.mock ? "mock" : "tauri"}`}
                      demo={props.mock}
                      files={detailValue.files.map((file) => ({
                        ...file,
                        changeId: selectedChange.id,
                      }))}
                    />
                  </section>
                </div>
              ) : null}
            </>
          ) : (
            <div className="detail-placeholder">
              {env.preferences.zh
                ? "选择一个 CL 查看详情与可用操作。"
                : "Select a changelist to inspect and act."}
            </div>
          )}
        </aside>
      </section>
    </main>
  );
}
