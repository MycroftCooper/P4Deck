import { t } from "../../../shared/i18n";
import { ResizeHeader } from "../../../app/context-menu/ResizeHeader";
import { useColumnWidths } from "../../../app/context-menu/useColumnWidths";
import { ResizableTable } from "../../../app/context-menu/ResizableTable";
import { FixedPageHeader } from "../../../app/docking/chrome";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  AlertTriangle,
  ArrowLeftRight,
  ChevronDown,
  Edit3,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const branchRowHeights = new WeakMap<HTMLElement, number>();
/** Hidden dock tabs report zero. Keep their last positive layout measurement. */
export function measureBranchMappingRow(element: HTMLElement) {
  const height = element.offsetHeight;
  if (Number.isFinite(height) && height > 0)
    branchRowHeights.set(element, Math.max(70, height));
  return branchRowHeights.get(element) ?? 70;
}
import type { QueryKey } from "@tanstack/react-query";
import { backend } from "../../../infrastructure/backend";
import type {
  BranchImpactDirection,
  BranchImpactPreview,
  BranchMappingDetail,
  BranchMappingPage,
  BranchMappingQuery,
  BranchMutationResult,
  RuntimeInfo,
} from "../../../shared/contracts";
import { invalidateData } from "../../../shared/cache/dataEffects";
import { serverScope, snapshotKey } from "../../../shared/cache/policy";
import {
  hydrateSnapshot,
  isFresh,
  readSnapshot,
  writePagedSnapshot,
} from "../../../shared/cache/snapshots";
import { useViewRefresh } from "../../../shared/cache/useViewRefresh";
import { BranchMappingMutationDialog } from "./BranchMappingMutationDialog";
import {
  branchMappingError,
  isBranchMappingSnapshot,
  mergeBranchMappingPages,
} from "../branchMappingModel";

const PAGE_SIZE = 100;
const PREVIEW_LIMIT = 200;
type ListPhase = "idle" | "loading" | "loadingMore" | "ready" | "error";
type DetailPhase = "idle" | "loading" | "ready" | "error";
type ListQuery = Pick<BranchMappingQuery, "nameFilter" | "owner" | "pageSize">;

/** Loaded pages per filter; disk copies omit the session-bound cursor. */
export function branchMappingsKey(scope: string, query: ListQuery) {
  return snapshotKey("branchMappings", scope, JSON.stringify(query));
}

function operationId(kind: string) {
  return `branch-mapping-${kind}-${crypto.randomUUID()}`;
}

export function BranchMappingsPage({
  runtime,
  zh,
}: {
  runtime: RuntimeInfo;
  zh: boolean;
}) {
  const tableColumns = useColumnWidths(
    [24, 90, 240, 24, 240],
    [24, 70, 140, 24, 140],
    { id: "branch-view", gutter: 48 },
  );
  const tr = (cn: string, en: string) => (zh ? cn : en);
  const remoteReady =
    runtime.p4Version !== "loading" && runtime.connection.state === "connected";
  const [nameInput, setNameInput] = useState("");
  const [ownerInput, setOwnerInput] = useState("");
  const [filters, setFilters] = useState({ nameFilter: "", owner: "" });
  const [page, setPage] = useState<BranchMappingPage>();
  const [listPhase, setListPhase] = useState<ListPhase>("idle");
  const [listError, setListError] = useState("");
  const [notice, setNotice] = useState("");
  const [selectedName, setSelectedName] = useState<string>();
  const [detail, setDetail] = useState<BranchMappingDetail>();
  const [detailPhase, setDetailPhase] = useState<DetailPhase>("idle");
  const [detailError, setDetailError] = useState("");
  const [previewDirection, setPreviewDirection] =
    useState<BranchImpactDirection>("forward");
  const [preview, setPreview] = useState<BranchImpactPreview>();
  const [previewPhase, setPreviewPhase] = useState<DetailPhase>("idle");
  const [previewError, setPreviewError] = useState("");
  const [mutation, setMutation] = useState<{
    mode: "create" | "edit" | "delete";
    detail?: BranchMappingDetail;
    source: HTMLElement | null;
  }>();
  const [clearSelectionOnDismiss, setClearSelectionOnDismiss] = useState(false);
  const requestGeneration = useRef(0);
  const listSequence = useRef(0);
  const detailSequence = useRef(0);
  const previewSequence = useRef(0);
  const activeOperations = useRef(new Set<string>());
  const detailOperation = useRef<string | undefined>(undefined);
  const previewOperation = useRef<string | undefined>(undefined);
  const consumedCursors = useRef(new Set<string>());
  const pendingCursors = useRef(new Set<string>());
  const listSession = useRef<
    | {
        sequence: number;
        generation: number;
        query: ListQuery;
        key: QueryKey;
      }
    | undefined
  >(undefined);
  const listRef = useRef<HTMLDivElement>(null);
  const scope = serverScope(runtime);
  const query = useMemo<ListQuery>(
    () => ({
      nameFilter: filters.nameFilter || undefined,
      owner: filters.owner || undefined,
      pageSize: PAGE_SIZE,
    }),
    [filters.nameFilter, filters.owner],
  );
  const listKey = useMemo(
    () => branchMappingsKey(scope, query),
    [scope, query],
  );
  const connectionOwner = useMemo(
    () =>
      JSON.stringify([
        runtime.mode,
        runtime.activeProfileId,
        runtime.contextGeneration,
        runtime.context.server,
        runtime.context.user,
        runtime.context.client,
        runtime.connection.state,
        runtime.connection.server,
      ]),
    [
      runtime.activeProfileId,
      runtime.connection.server,
      runtime.connection.state,
      runtime.context.client,
      runtime.context.server,
      runtime.context.user,
      runtime.contextGeneration,
      runtime.mode,
    ],
  );

  const scopeMatches = useCallback(
    (scope: BranchMappingPage["scope"]) =>
      scope.activeProfileId === runtime.activeProfileId &&
      scope.contextGeneration === runtime.contextGeneration &&
      scope.server === runtime.context.server &&
      scope.user === runtime.context.user &&
      scope.client === runtime.context.client,
    [
      runtime.activeProfileId,
      runtime.context.client,
      runtime.context.server,
      runtime.context.user,
      runtime.contextGeneration,
    ],
  );

  const cancelAll = useCallback(() => {
    for (const id of activeOperations.current)
      void backend.cancelOperation(id).catch(() => undefined);
    activeOperations.current.clear();
    detailOperation.current = undefined;
    previewOperation.current = undefined;
  }, []);

  const startFresh = useCallback(
    async (preserveSelection: boolean) => {
      if (!remoteReady) {
        setListPhase((current) => (current === "ready" ? "ready" : "idle"));
        return;
      }
      cancelAll();
      detailSequence.current += 1;
      previewSequence.current += 1;
      const sequence = ++listSequence.current;
      const generation = ++requestGeneration.current;
      const id = operationId("list");
      listSession.current = { sequence, generation, query, key: listKey };
      consumedCursors.current.clear();
      pendingCursors.current.clear();
      activeOperations.current.add(id);
      setListPhase("loading");
      setListError("");
      setNotice("");
      if (!preserveSelection) {
        setPage(undefined);
        setPreview(undefined);
        setPreviewError("");
        setPreviewPhase("idle");
        setSelectedName(undefined);
        setDetail(undefined);
        setDetailError("");
        setDetailPhase("idle");
      }
      try {
        const result = await backend.queryBranchMappings({
          ...query,
          operationId: id,
          requestGeneration: generation,
        });
        if (
          sequence !== listSequence.current ||
          result.requestGeneration !== generation ||
          !scopeMatches(result.scope)
        )
          return;
        writePagedSnapshot(listKey, result);
        setPage(result);
        setListPhase("ready");
      } catch (cause) {
        if (sequence !== listSequence.current) return;
        const failure = branchMappingError(cause);
        if (failure.code === "cancelled") {
          setListPhase("idle");
          return;
        }
        setListError(failure.message);
        setListPhase("error");
      } finally {
        activeOperations.current.delete(id);
      }
    },
    [cancelAll, listKey, query, remoteReady, scopeMatches],
  );

  /** Shows cached pages and resumes their paging session without P4. */
  const restore = useCallback(
    (cached: BranchMappingPage) => {
      cancelAll();
      requestGeneration.current = Math.max(
        requestGeneration.current,
        cached.requestGeneration,
      );
      listSession.current = {
        sequence: ++listSequence.current,
        generation: cached.requestGeneration,
        query,
        key: listKey,
      };
      consumedCursors.current.clear();
      pendingCursors.current.clear();
      setPage(cached);
      setListPhase("ready");
      setListError("");
      setNotice("");
    },
    [cancelAll, listKey, query],
  );

  useEffect(() => {
    let live = true;
    const showSnapshot = () => {
      if (!live) return;
      const cached = readSnapshot<BranchMappingPage>(listKey);
      if (!cached && remoteReady) void startFresh(false);
      else if (!cached) setListPhase("idle");
      else {
        restore(cached.data);
        // Stale pages, or pages from another connection, refresh behind the list.
        if (
          remoteReady &&
          (!scopeMatches(cached.data.scope) || !isFresh(listKey))
        )
          void startFresh(true);
      }
    };
    if (runtime.p4Version !== "loading") {
      if (readSnapshot(listKey)) showSnapshot();
      else {
        setPage(undefined);
        setListPhase("loading");
        void hydrateSnapshot(
          listKey,
          (value): value is BranchMappingPage =>
            isBranchMappingSnapshot(value) &&
            value.scope.server === runtime.context.server &&
            value.scope.user === runtime.context.user &&
            value.scope.activeProfileId === runtime.activeProfileId,
          { revalidate: true },
        ).then(showSnapshot);
      }
    }
    return () => {
      live = false;
      listSequence.current += 1;
      detailSequence.current += 1;
      previewSequence.current += 1;
      cancelAll();
    };
  }, [
    connectionOwner,
    listKey,
    runtime.p4Version,
    remoteReady,
    restore,
    scopeMatches,
    startFresh,
    cancelAll,
  ]);

  useViewRefresh("branchmappings", listKey, () => {
    if (remoteReady && listPhase !== "loading" && listPhase !== "loadingMore")
      void startFresh(true);
  });

  const loadMore = useCallback(async () => {
    const cursor = page?.nextCursor;
    const session = listSession.current;
    if (
      !remoteReady ||
      listPhase === "loading" ||
      listPhase === "loadingMore" ||
      !cursor ||
      !page?.hasMore ||
      !session ||
      pendingCursors.current.has(cursor) ||
      consumedCursors.current.has(cursor)
    )
      return;
    pendingCursors.current.add(cursor);
    const id = operationId("page");
    activeOperations.current.add(id);
    setListPhase("loadingMore");
    setListError("");
    try {
      const next = await backend.queryBranchMappings({
        ...session.query,
        operationId: id,
        requestGeneration: session.generation,
        cursor,
      });
      if (
        session.sequence !== listSequence.current ||
        next.requestGeneration !== session.generation ||
        !scopeMatches(next.scope)
      )
        return;
      consumedCursors.current.add(cursor);
      const nonProgressing =
        next.hasMore &&
        (!next.nextCursor ||
          next.nextCursor === cursor ||
          consumedCursors.current.has(next.nextCursor));
      const merged = mergeBranchMappingPages(page, next);
      const value = nonProgressing
        ? { ...merged, hasMore: false, nextCursor: undefined }
        : merged;
      writePagedSnapshot(session.key, value);
      setPage(value);
      setListPhase("ready");
      if (nonProgressing)
        setNotice(
          tr(
            "后端返回了未前进的游标；已保留当前列表并停止分页。",
            "The backend returned a non-progressing cursor; the current list was preserved and paging stopped.",
          ),
        );
    } catch (cause) {
      if (session.sequence !== listSequence.current) return;
      const failure = branchMappingError(cause);
      if (
        failure.code === "invalidCursor" ||
        failure.code === "cursorExpired"
      ) {
        // Restored pages can outlive the backend paging snapshot (120 s).
        void startFresh(true);
        return;
      }
      if (failure.code !== "cancelled") setListError(failure.message);
      setListPhase("ready");
    } finally {
      pendingCursors.current.delete(cursor);
      activeOperations.current.delete(id);
    }
  }, [listPhase, page, remoteReady, scopeMatches, startFresh, tr]);

  const loadDetail = useCallback(
    async (name: string) => {
      if (!remoteReady) {
        setSelectedName(name);
        setDetail(undefined);
        setDetailError("");
        setDetailPhase("idle");
        return;
      }
      if (detailOperation.current) {
        activeOperations.current.delete(detailOperation.current);
        void backend
          .cancelOperation(detailOperation.current)
          .catch(() => undefined);
      }
      if (previewOperation.current) {
        activeOperations.current.delete(previewOperation.current);
        void backend
          .cancelOperation(previewOperation.current)
          .catch(() => undefined);
        previewOperation.current = undefined;
      }
      const sequence = ++detailSequence.current;
      previewSequence.current += 1;
      const generation = ++requestGeneration.current;
      const id = operationId("detail");
      activeOperations.current.add(id);
      detailOperation.current = id;
      setSelectedName(name);
      setDetail(undefined);
      setDetailError("");
      setDetailPhase("loading");
      setPreview(undefined);
      setPreviewError("");
      setPreviewPhase("idle");
      try {
        const result = await backend.getBranchMappingDetail({
          operationId: id,
          requestGeneration: generation,
          name,
        });
        if (
          sequence !== detailSequence.current ||
          result.requestGeneration !== generation ||
          !scopeMatches(result.scope)
        )
          return;
        setDetail(result.detail);
        setDetailPhase("ready");
      } catch (cause) {
        if (sequence !== detailSequence.current) return;
        const failure = branchMappingError(cause);
        if (failure.code !== "cancelled") setDetailError(failure.message);
        setDetailPhase(failure.code === "cancelled" ? "idle" : "error");
      } finally {
        activeOperations.current.delete(id);
        if (detailOperation.current === id) detailOperation.current = undefined;
      }
    },
    [remoteReady, scopeMatches],
  );

  const loadPreview = useCallback(
    async (direction = previewDirection) => {
      if (!selectedName || !remoteReady) return;
      if (previewOperation.current) {
        activeOperations.current.delete(previewOperation.current);
        void backend
          .cancelOperation(previewOperation.current)
          .catch(() => undefined);
      }
      const sequence = ++previewSequence.current;
      const generation = ++requestGeneration.current;
      const id = operationId("preview");
      activeOperations.current.add(id);
      previewOperation.current = id;
      setPreview(undefined);
      setPreviewError("");
      setPreviewPhase("loading");
      try {
        const result = await backend.previewBranchMappingImpact({
          operationId: id,
          requestGeneration: generation,
          name: selectedName,
          direction,
          limit: PREVIEW_LIMIT,
        });
        if (
          sequence !== previewSequence.current ||
          result.requestGeneration !== generation ||
          result.name !== selectedName ||
          result.direction !== direction
        )
          return;
        setPreview(result);
        setPreviewPhase("ready");
      } catch (cause) {
        if (sequence !== previewSequence.current) return;
        const failure = branchMappingError(cause);
        if (failure.code !== "cancelled") setPreviewError(failure.message);
        setPreviewPhase(failure.code === "cancelled" ? "idle" : "error");
      } finally {
        activeOperations.current.delete(id);
        if (previewOperation.current === id)
          previewOperation.current = undefined;
      }
    },
    [previewDirection, remoteReady, selectedName],
  );

  const cancel = () => {
    listSequence.current += 1;
    detailSequence.current += 1;
    previewSequence.current += 1;
    cancelAll();
    const cancelled = tr(
      "请求已取消；可以重试或刷新。",
      "The request was cancelled; retry or refresh to continue.",
    );
    setListPhase(page ? "ready" : "error");
    setListError(page ? "" : cancelled);
    if (page?.hasMore)
      setPage({ ...page, hasMore: false, nextCursor: undefined });
    setDetailPhase(detail ? "ready" : selectedName ? "error" : "idle");
    setDetailError(detail || !selectedName ? "" : cancelled);
    setPreviewPhase(preview ? "ready" : selectedName ? "error" : "idle");
    setPreviewError(preview || !selectedName ? "" : cancelled);
    setNotice(t("browse.current.request.was.cancelled"));
  };

  const items = page?.items ?? [];
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => listRef.current,
    getItemKey: (index) => items[index].name,
    measureElement: measureBranchMappingRow,
    estimateSize: () => 70,
    overscan: 8,
    initialRect: { width: 430, height: 520 },
  });
  const virtualItems = virtualizer.getVirtualItems();
  const visibleItems = virtualItems.length
    ? virtualItems
    : Array.from({ length: Math.min(items.length, 18) }, (_, index) => ({
        index,
        key: items[index].name,
        start: index * 70,
        size: 70,
        end: (index + 1) * 70,
        lane: 0,
      }));
  const focusIndex = (index: number) => {
    const bounded = Math.max(0, Math.min(items.length - 1, index));
    const mounted = listRef.current?.querySelector<HTMLButtonElement>(
      `[data-branch-index="${bounded}"]`,
    );
    if (mounted) return mounted.focus();
    virtualizer.scrollToIndex(bounded, { align: "auto" });
    requestAnimationFrame(() =>
      listRef.current
        ?.querySelector<HTMLButtonElement>(`[data-branch-index="${bounded}"]`)
        ?.focus(),
    );
  };
  const restoreSelectedFocus = () => {
    const index = items.findIndex((item) => item.name === selectedName);
    if (index >= 0) focusIndex(index);
    else listRef.current?.focus();
  };
  const closeDetail = () => {
    detailSequence.current += 1;
    previewSequence.current += 1;
    if (detailOperation.current) {
      activeOperations.current.delete(detailOperation.current);
      void backend
        .cancelOperation(detailOperation.current)
        .catch(() => undefined);
      detailOperation.current = undefined;
    }
    if (previewOperation.current) {
      activeOperations.current.delete(previewOperation.current);
      void backend
        .cancelOperation(previewOperation.current)
        .catch(() => undefined);
      previewOperation.current = undefined;
    }
    setSelectedName(undefined);
    setDetail(undefined);
    setDetailError("");
    setDetailPhase("idle");
    setPreview(undefined);
    setPreviewError("");
    setPreviewPhase("idle");
    restoreSelectedFocus();
    requestAnimationFrame(restoreSelectedFocus);
  };
  const busy =
    listPhase === "loading" ||
    listPhase === "loadingMore" ||
    detailPhase === "loading" ||
    previewPhase === "loading";

  if (runtime.p4Version === "loading")
    return (
      <section className="branch-mappings-page">
        <div className="workspace-empty" role="status">
          {t("browse.loading.connection.runtime")}
        </div>
      </section>
    );

  return (
    <section className="branch-mappings-page">
      <FixedPageHeader
        description={tr(
          "查看、预览并通过专用安全状态机维护 Branch Mapping。",
          "Inspect, preview, and maintain Branch Mappings through dedicated safety workflows.",
        )}
      >
        <button
          onClick={(event) => {
            setClearSelectionOnDismiss(false);
            setMutation({ mode: "create", source: event.currentTarget });
          }}
        >
          <Plus size={15} /> {t("browse.create")}
        </button>
        <button
          disabled={busy || !remoteReady}
          onClick={() => {
            void startFresh(true);
            if (selectedName) void loadDetail(selectedName);
          }}
        >
          <RefreshCw
            size={15}
            className={listPhase === "loading" ? "spin" : ""}
          />
          {t("browse.refresh")}
        </button>
      </FixedPageHeader>

      <form
        className="branch-mapping-query"
        onSubmit={(event) => {
          event.preventDefault();
          const next = {
            nameFilter: nameInput.trim(),
            owner: ownerInput.trim(),
          };
          if (
            next.nameFilter === filters.nameFilter &&
            next.owner === filters.owner
          )
            void startFresh(false);
          else setFilters(next);
        }}
      >
        <label>
          <span>{t("browse.name.filter")}</span>
          <span className="search-field">
            <Search size={15} />
            <input
              aria-label={tr(
                "Branch Mapping 名称过滤",
                "Branch Mapping name filter",
              )}
              value={nameInput}
              maxLength={128}
              onChange={(event) => setNameInput(event.target.value)}
            />
          </span>
        </label>
        <label>
          <span>Owner</span>
          <input
            className="search-field"
            aria-label="Branch Mapping owner filter"
            value={ownerInput}
            maxLength={128}
            onChange={(event) => setOwnerInput(event.target.value)}
          />
        </label>
        <button type="submit" className="secondary">
          {t("browse.apply.filters")}
        </button>
        {busy && (
          <button type="button" className="secondary" onClick={cancel}>
            <X size={14} /> {t("browse.cancel")}
          </button>
        )}
      </form>

      <div className="branch-mapping-status" aria-live="polite">
        {page?.simulated && (
          <span className="status-warning">Browser Mock simulated data</span>
        )}
        {page && (
          <span>
            {page.items.length} / {page.stats.matchedCount}
          </span>
        )}
        {page?.partial && <span>{t("browse.partial")}</span>}
        {page?.truncated && (
          <span className="status-warning">
            {t("browse.safety.limit.reached")} {page.stats.safetyLimit}
          </span>
        )}
        {!!page?.stats.invalidRecordCount && (
          <span>
            {t("browse.invalid.records")}: {page.stats.invalidRecordCount}
          </span>
        )}
        {listPhase === "loading" && <span>{t("browse.loading")}</span>}
        {listPhase === "loadingMore" && <span>{t("browse.loading.more")}</span>}
      </div>
      {notice && (
        <div className="branch-mapping-notice" role="status">
          {notice}
        </div>
      )}
      {listError && (
        <div className="workspace-load-error" role="alert">
          <span>{listError}</span>
          <button
            onClick={() =>
              listPhase === "error" ? void startFresh(!!page) : void loadMore()
            }
          >
            {t("browse.retry")}
          </button>
        </div>
      )}

      <div
        className={`branch-mapping-layout ${selectedName ? "with-detail" : ""}`}
      >
        <section
          className="branch-mapping-list-panel"
          aria-label={t("browse.branch.mapping.list.panel")}
        >
          <div
            ref={listRef}
            className="branch-mapping-list"
            role="listbox"
            tabIndex={0}
            aria-label={t("browse.branch.mappings")}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                closeDetail();
                return;
              }
              const index = Number(
                (event.target as HTMLElement).closest<HTMLElement>(
                  "[data-branch-index]",
                )?.dataset.branchIndex,
              );
              if (!Number.isSafeInteger(index) || !items[index]) return;
              let next: number | undefined;
              if (event.key === "ArrowDown") next = index + 1;
              else if (event.key === "ArrowUp") next = index - 1;
              else if (event.key === "Home") next = 0;
              else if (event.key === "End") next = items.length - 1;
              else if (event.key === "Enter") {
                event.preventDefault();
                void loadDetail(items[index].name);
                return;
              }
              if (next !== undefined) {
                event.preventDefault();
                focusIndex(next);
              }
            }}
          >
            {!items.length && listPhase !== "loading" ? (
              <div className="workspace-empty" role="status">
                {tr(
                  "没有匹配的 Branch Mapping。",
                  "No matching Branch Mappings.",
                )}
              </div>
            ) : (
              <div
                className="branch-mapping-list-spacer"
                style={{
                  height: virtualizer.getTotalSize() || items.length * 70,
                }}
              >
                {visibleItems.map((virtualRow) => {
                  const item = items[virtualRow.index];
                  return (
                    <div
                      key={item.name}
                      ref={virtualizer.measureElement}
                      className="branch-mapping-window-row"
                      data-index={virtualRow.index}
                      style={{
                        minHeight: 70,
                        transform: `translateY(${virtualRow.start}px)`,
                      }}
                    >
                      <button
                        role="option"
                        aria-selected={selectedName === item.name}
                        data-branch-index={virtualRow.index}
                        className={selectedName === item.name ? "selected" : ""}
                        onClick={() => void loadDetail(item.name)}
                      >
                        <strong>{item.name}</strong>
                        <span>{item.owner || t("browse.unknown.owner")}</span>
                        <small>{item.description || "—"}</small>
                        <span className="branch-mapping-summary-meta">
                          <code>{item.options || "—"}</code>
                          <span>Update {item.update || "—"}</span>
                          <span>Access {item.access || "—"}</span>
                        </span>
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          {page?.hasMore && (
            <button
              className="load-more-button"
              disabled={
                listPhase === "loading" ||
                listPhase === "loadingMore" ||
                !page.nextCursor
              }
              onClick={() => void loadMore()}
            >
              <ChevronDown size={14} /> {t("browse.load.more")}
            </button>
          )}
        </section>

        {selectedName && (
          <aside
            className="branch-mapping-detail"
            aria-label={t("browse.branch.mapping.details")}
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              event.preventDefault();
              closeDetail();
            }}
          >
            <header>
              <div>
                <span>{t("browse.selected.mapping")}</span>
                <h2>{selectedName}</h2>
              </div>
              <button
                aria-label={tr(
                  "关闭 Branch Mapping 详情",
                  "Close Branch Mapping details",
                )}
                onClick={() => {
                  closeDetail();
                }}
              >
                <X size={16} />
              </button>
            </header>
            {detailPhase === "loading" && (
              <div role="status">{t("browse.loading.details")}</div>
            )}
            {detailError && (
              <div className="workspace-load-error" role="alert">
                <span>{detailError}</span>
                <button onClick={() => void loadDetail(selectedName)}>
                  {t("browse.retry")}
                </button>
              </div>
            )}
            {detail && (
              <>
                {detail.simulated && (
                  <div className="branch-simulated">
                    Browser Mock simulated detail
                  </div>
                )}
                <dl className="branch-detail-meta">
                  <div>
                    <dt>Name</dt>
                    <dd>{detail.name}</dd>
                  </div>
                  <div>
                    <dt>Owner</dt>
                    <dd>{detail.owner}</dd>
                  </div>
                  <div>
                    <dt>Update</dt>
                    <dd>{detail.update || "—"}</dd>
                  </div>
                  <div>
                    <dt>Access</dt>
                    <dd>{detail.access || "—"}</dd>
                  </div>
                  <div>
                    <dt>Options</dt>
                    <dd>{detail.locked ? "locked" : "unlocked"}</dd>
                  </div>
                </dl>
                <p className="branch-description">
                  {detail.description || "—"}
                </p>
                {!!detail.unknownFields.length && (
                  <div className="branch-unknown-fields" role="note">
                    <strong>{t("browse.unknown.fields.read.only")}</strong>
                    {detail.unknownFields.map((field, index) => (
                      <div key={`${field.name}-${index}`}>
                        <code>{field.name}</code>
                        <span>{field.value}</span>
                      </div>
                    ))}
                  </div>
                )}
                {!detail.editable && (
                  <div className="branch-mapping-notice" role="note">
                    <AlertTriangle size={14} />{" "}
                    {tr(
                      "含未知或无法往返的字段/View 行，编辑已禁用。",
                      "Unknown or non-round-trippable fields/View lines are present; editing is disabled.",
                    )}
                  </div>
                )}
                <div className="branch-detail-actions">
                  <button
                    disabled={!detail.editable}
                    title={
                      !detail.editable
                        ? tr(
                            "未知字段阻止安全编辑",
                            "Unknown fields block safe editing",
                          )
                        : undefined
                    }
                    onClick={(event) => {
                      setClearSelectionOnDismiss(false);
                      setMutation({
                        mode: "edit",
                        detail,
                        source: event.currentTarget,
                      });
                    }}
                  >
                    <Edit3 size={14} /> {t("browse.edit")}
                  </button>
                  <button
                    className="danger"
                    onClick={(event) => {
                      setClearSelectionOnDismiss(false);
                      setMutation({
                        mode: "delete",
                        detail,
                        source: event.currentTarget,
                      });
                    }}
                  >
                    <Trash2 size={14} /> {t("browse.delete")}
                  </button>
                </div>
                <section
                  className="branch-view-section"
                  aria-label="Branch View"
                >
                  <h3>View · {detail.view.length}</h3>
                  <ResizeHeader
                    columns={[
                      "#",
                      t("browse.mode"),
                      t("browse.source"),
                      "↔",
                      t("browse.target"),
                    ]}
                    resize={tableColumns}
                  />
                  <ol>
                    {detail.view.map((line, index) => (
                      <li
                        key={index}
                        className={`modifier-${line.modifier}`}
                        style={tableColumns.style}
                      >
                        <span className="branch-view-index">{index + 1}</span>
                        <strong>{line.modifier}</strong>
                        {line.modifier === "unknown" ? (
                          <code>{line.unknown || "—"}</code>
                        ) : line.comment ? (
                          <span className="branch-view-comment">
                            {line.comment}
                          </span>
                        ) : (
                          <>
                            <code>{line.source || "—"}</code>
                            <ArrowLeftRight size={13} aria-hidden="true" />
                            <code>{line.target || "—"}</code>
                          </>
                        )}
                      </li>
                    ))}
                  </ol>
                </section>

                <section
                  className="branch-impact"
                  aria-label={t("browse.impact.preview")}
                >
                  <header>
                    <div>
                      <h3>{t("browse.impact.preview")}</h3>
                      <p>
                        {tr(
                          "只运行 integrate -n；不会修改 workspace，也不会打开文件。",
                          "Runs integrate -n only; it never modifies the workspace or opens files.",
                        )}
                      </p>
                    </div>
                    <div
                      className="branch-direction"
                      role="group"
                      aria-label={t("browse.preview.direction")}
                    >
                      {(["forward", "reverse"] as const).map((direction) => (
                        <button
                          key={direction}
                          aria-pressed={previewDirection === direction}
                          onClick={() => {
                            previewSequence.current += 1;
                            if (previewOperation.current) {
                              activeOperations.current.delete(
                                previewOperation.current,
                              );
                              void backend
                                .cancelOperation(previewOperation.current)
                                .catch(() => undefined);
                              previewOperation.current = undefined;
                            }
                            setPreviewDirection(direction);
                            setPreview(undefined);
                            setPreviewError("");
                            setPreviewPhase("idle");
                          }}
                        >
                          {direction}
                        </button>
                      ))}
                    </div>
                  </header>
                  <button
                    disabled={previewPhase === "loading"}
                    onClick={() => void loadPreview()}
                  >
                    {previewPhase === "loading"
                      ? t("browse.previewing")
                      : t("browse.run.read.only.preview")}
                  </button>
                  {previewError && (
                    <div className="workspace-load-error" role="alert">
                      <span>{previewError}</span>
                      <button onClick={() => void loadPreview()}>
                        {t("browse.retry")}
                      </button>
                    </div>
                  )}
                  {preview && (
                    <div className="branch-impact-result">
                      {preview.simulated && (
                        <div className="branch-simulated">
                          Browser Mock simulated impact preview
                        </div>
                      )}
                      {(preview.partial || preview.truncated) && (
                        <div className="branch-mapping-notice" role="status">
                          {tr(
                            "预览为部分或截断结果",
                            "Preview is partial or truncated",
                          )}{" "}
                          · {preview.scannedCount} / {preview.safetyLimit}
                        </div>
                      )}
                      {!!preview.blockers.length && (
                        <div className="branch-preview-blockers" role="alert">
                          {preview.blockers.map((blocker) => (
                            <p key={`${blocker.code}-${blocker.message}`}>
                              <strong>{blocker.code}</strong> ·{" "}
                              {blocker.message}
                            </p>
                          ))}
                        </div>
                      )}
                      {!preview.blockers.length && !preview.items.length && (
                        <div className="workspace-empty">
                          {t("browse.no.affected.files")}
                        </div>
                      )}
                      {!!preview.items.length && (
                        <div className="branch-impact-table-wrap">
                          <ResizableTable
                            tableId="branch-impact"
                            defaults={[300, 100, 260, 260]}
                            minimums={[140, 80, 140, 140]}
                          >
                            <thead>
                              <tr>
                                <th>File</th>
                                <th>Action</th>
                                <th>Source</th>
                                <th>Target</th>
                              </tr>
                            </thead>
                            <tbody>
                              {preview.items.map((item, index) => (
                                <tr
                                  key={`${item.file}-${item.source}-${item.target}-${index}`}
                                >
                                  <td>
                                    <code>{item.file || "—"}</code>
                                  </td>
                                  <td>{item.action || "—"}</td>
                                  <td>
                                    <code>{item.source || "—"}</code>
                                  </td>
                                  <td>
                                    <code>{item.target || "—"}</code>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </ResizableTable>
                        </div>
                      )}
                    </div>
                  )}
                </section>
              </>
            )}
          </aside>
        )}
      </div>

      {mutation && (
        <BranchMappingMutationDialog
          mode={mutation.mode}
          detail={mutation.detail}
          runtime={runtime}
          connectionKey={connectionOwner}
          source={mutation.source}
          zh={zh}
          onDismiss={() => {
            setMutation(undefined);
            if (clearSelectionOnDismiss) closeDetail();
            setClearSelectionOnDismiss(false);
          }}
          onResult={(result: BranchMutationResult, nextSelection) => {
            // Every cached filter may list the changed mapping.
            void invalidateData(["branchMappings"]);
            void startFresh(true);
            if (nextSelection) void loadDetail(nextSelection);
            else if (
              mutation.mode === "delete" &&
              result.outcome === "succeeded"
            ) {
              setClearSelectionOnDismiss(true);
            } else if (selectedName) void loadDetail(selectedName);
          }}
        />
      )}
    </section>
  );
}
