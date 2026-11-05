import { t } from "../../../shared/i18n";
import { FixedPageHeader } from "../../../app/docking/chrome";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  AlertTriangle,
  ArrowDownToLine,
  ChevronDown,
  ChevronRight,
  LocateFixed,
  Minus,
  Network,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { backend } from "../../../infrastructure/backend";
import type {
  RuntimeInfo,
  StreamGraphQuery,
  StreamGraphResult,
  StreamSummary,
} from "../../../shared/contracts";
import type { QueryKey } from "@tanstack/react-query";
import { serverScope, snapshotKey } from "../../../shared/cache/policy";
import {
  hydrateSnapshot,
  isFresh,
  readSnapshot,
  writePagedSnapshot,
} from "../../../shared/cache/snapshots";
import { useViewRefresh } from "../../../shared/cache/useViewRefresh";
import { cachedWorkspaceList } from "../../workspaces/workspaceList";
import { StreamSwitchDialog } from "./StreamSwitchDialog";
import {
  isStreamGraphSnapshot,
  layoutStreamGraph,
  mergeStreamGraphResults,
  streamGraphError,
} from "../streamGraphModel";

const PAGE_SIZE = 100;
const ZOOM_LEVELS = [0.8, 1, 1.25, 1.5] as const;
type Phase = "idle" | "loading" | "loadingMore" | "ready" | "error";
type GraphFilters = {
  depotPrefix: string;
  text: string;
  includeDeleted: boolean;
};
type GraphQuery = Pick<
  StreamGraphQuery,
  "depotPrefix" | "text" | "includeDeleted" | "pageSize"
>;

function graphQuery(filters: GraphFilters): GraphQuery {
  return {
    depotPrefix: filters.depotPrefix || undefined,
    text: filters.text || undefined,
    includeDeleted: filters.includeDeleted,
    pageSize: PAGE_SIZE,
  };
}

/** Loaded pages per filter; disk copies omit the session-bound cursor. */
export function streamGraphKey(scope: string, query: GraphQuery) {
  return snapshotKey("streamGraph", scope, JSON.stringify(query));
}

function operationId() {
  return `stream-graph-${crypto.randomUUID()}`;
}

function streamSummary(
  node: StreamGraphResult["nodes"][number],
): StreamSummary {
  return {
    stream: node.stream,
    name: node.name ?? node.stream.split("/").at(-1) ?? node.stream,
    owner: node.owner ?? "",
    parent: node.parent ?? "",
    kind: node.kind ?? "unknown",
    description: node.description ?? "",
  };
}

function boolLabel(value: boolean | undefined, _zh: boolean) {
  if (value === undefined) return t("browse.unknown");
  return value ? t("browse.yes") : t("browse.no");
}

export function StreamGraphPage({
  runtime,
  onRuntime,
  onLocateStream,
  zh,
}: {
  runtime: RuntimeInfo;
  onRuntime(runtime: RuntimeInfo): void;
  onLocateStream(stream: string): void;
  zh: boolean;
}) {
  const remoteReady =
    runtime.p4Version !== "loading" && runtime.connection.state === "connected";
  const [depotInput, setDepotInput] = useState("");
  const [textInput, setTextInput] = useState("");
  const [filters, setFilters] = useState({
    depotPrefix: "",
    text: "",
    includeDeleted: false,
  });
  const [result, setResult] = useState<StreamGraphResult>();
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [selectedPath, setSelectedPath] = useState<string>();
  const [currentStream, setCurrentStream] = useState<string>();
  const [zoomIndex, setZoomIndex] = useState(1);
  const [switchTarget, setSwitchTarget] = useState<{
    stream: StreamSummary;
    source: HTMLElement | null;
  }>();
  const activeOperations = useRef(new Set<string>());
  const requestToken = useRef(0);
  const requestGeneration = useRef(0);
  const consumedCursors = useRef(new Set<string>());
  const pendingCursors = useRef(new Set<string>());
  const session = useRef<
    | {
        token: number;
        generation: number;
        query: GraphQuery;
        key: QueryKey;
      }
    | undefined
  >(undefined);
  const scrollRef = useRef<HTMLDivElement>(null);
  const latestRuntime = useRef(runtime);
  latestRuntime.current = runtime;
  const scope = serverScope(runtime);
  const query = useMemo(
    () => graphQuery(filters),
    [filters.depotPrefix, filters.text, filters.includeDeleted],
  );
  const graphKey = useMemo(() => streamGraphKey(scope, query), [scope, query]);
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
      runtime.context.client,
      runtime.context.server,
      runtime.context.user,
      runtime.contextGeneration,
      runtime.connection.server,
      runtime.connection.state,
      runtime.mode,
    ],
  );

  const cancelOperations = useCallback(() => {
    for (const id of activeOperations.current)
      void backend.cancelOperation(id).catch(() => undefined);
    activeOperations.current.clear();
  }, []);

  /** The current workspace stream comes from the shared workspace snapshot. */
  const loadCurrentStream = useCallback((token: number) => {
    const current = latestRuntime.current;
    const allowRefresh =
      current.p4Version !== "loading" &&
      current.connection.state === "connected";
    void cachedWorkspaceList(current, allowRefresh)
      .then((workspaces) => {
        if (requestToken.current !== token) return;
        setCurrentStream(
          workspaces.find(
            (workspace) => workspace.name === current.context.client,
          )?.stream,
        );
      })
      .catch(() => undefined);
  }, []);

  const scopeMatches = useCallback(
    (page: StreamGraphResult) =>
      page.scope.contextGeneration === runtime.contextGeneration &&
      page.scope.activeProfileId === runtime.activeProfileId &&
      page.scope.server === runtime.context.server &&
      page.scope.user === runtime.context.user &&
      page.scope.client === runtime.context.client,
    [
      runtime.activeProfileId,
      runtime.context.client,
      runtime.context.server,
      runtime.context.user,
      runtime.contextGeneration,
    ],
  );

  const startFresh = useCallback(
    async (refresh: boolean) => {
      cancelOperations();
      const token = ++requestToken.current;
      const generation = ++requestGeneration.current;
      const id = operationId();
      session.current = { token, generation, query, key: graphKey };
      consumedCursors.current.clear();
      pendingCursors.current.clear();
      activeOperations.current.add(id);
      setPhase("loading");
      setError("");
      setNotice("");
      if (!refresh) {
        setSelectedPath(undefined);
        setResult(undefined);
        setCurrentStream(undefined);
      }
      loadCurrentStream(token);
      try {
        const page = await backend.queryStreamGraph({
          ...query,
          operationId: id,
          requestGeneration: generation,
          refresh,
        });
        if (
          requestToken.current !== token ||
          page.requestGeneration !== generation ||
          !scopeMatches(page)
        )
          return;
        writePagedSnapshot(graphKey, page);
        setResult(page);
        setPhase("ready");
      } catch (cause) {
        if (requestToken.current !== token) return;
        const failure = streamGraphError(cause);
        if (failure.code === "cancelled") {
          setPhase("idle");
          return;
        }
        setError(failure.message);
        setPhase("error");
      } finally {
        activeOperations.current.delete(id);
      }
    },
    [cancelOperations, graphKey, loadCurrentStream, query, scopeMatches],
  );

  /** Shows cached pages and resumes their paging session without P4. */
  const restore = useCallback(
    (cached: StreamGraphResult) => {
      cancelOperations();
      const token = ++requestToken.current;
      requestGeneration.current = Math.max(
        requestGeneration.current,
        cached.requestGeneration,
      );
      session.current = {
        token,
        generation: cached.requestGeneration,
        query,
        key: graphKey,
      };
      consumedCursors.current.clear();
      pendingCursors.current.clear();
      setResult(cached);
      setPhase("ready");
      setError("");
      setNotice("");
      setSelectedPath((path) =>
        path && cached.nodes.some((node) => node.stream === path)
          ? path
          : undefined,
      );
      loadCurrentStream(token);
    },
    [cancelOperations, graphKey, loadCurrentStream, query],
  );

  useEffect(() => {
    let live = true;
    const showSnapshot = () => {
      if (!live) return;
      const cached = readSnapshot<StreamGraphResult>(graphKey);
      if (!cached && remoteReady) void startFresh(false);
      else if (!cached) setPhase("idle");
      else {
        restore(cached.data);
        // Stale pages, or pages from another connection, refresh behind the graph.
        if (remoteReady && (!scopeMatches(cached.data) || !isFresh(graphKey)))
          void startFresh(true);
      }
    };
    if (runtime.p4Version !== "loading") {
      if (readSnapshot(graphKey)) showSnapshot();
      else {
        setResult(undefined);
        setPhase("loading");
        void hydrateSnapshot(
          graphKey,
          (value): value is StreamGraphResult =>
            isStreamGraphSnapshot(value) &&
            value.scope.server === runtime.context.server &&
            value.scope.user === runtime.context.user &&
            value.scope.activeProfileId === runtime.activeProfileId,
          { revalidate: true },
        ).then(showSnapshot);
      }
    }
    return () => {
      live = false;
      requestToken.current += 1;
      cancelOperations();
    };
  }, [
    connectionOwner,
    graphKey,
    runtime.p4Version,
    remoteReady,
    restore,
    scopeMatches,
    startFresh,
    cancelOperations,
  ]);

  useViewRefresh("streamgraph", graphKey, () => {
    if (remoteReady && phase !== "loading" && phase !== "loadingMore")
      void startFresh(true);
  });

  const loadMore = useCallback(async () => {
    const cursor = result?.nextCursor;
    const active = session.current;
    if (
      !remoteReady ||
      phase === "loading" ||
      phase === "loadingMore" ||
      !cursor ||
      !result?.hasMore ||
      !active ||
      pendingCursors.current.has(cursor) ||
      consumedCursors.current.has(cursor)
    )
      return;
    pendingCursors.current.add(cursor);
    const id = operationId();
    activeOperations.current.add(id);
    setPhase("loadingMore");
    setError("");
    try {
      const page = await backend.queryStreamGraph({
        ...active.query,
        operationId: id,
        requestGeneration: active.generation,
        cursor,
      });
      if (
        requestToken.current !== active.token ||
        page.requestGeneration !== active.generation ||
        !scopeMatches(page)
      )
        return;
      consumedCursors.current.add(cursor);
      const nonProgressing =
        page.hasMore &&
        (!page.nextCursor ||
          page.nextCursor === cursor ||
          consumedCursors.current.has(page.nextCursor));
      const merged = mergeStreamGraphResults(result, page);
      const next = nonProgressing
        ? { ...merged, hasMore: false, nextCursor: undefined }
        : merged;
      writePagedSnapshot(active.key, next);
      setResult(next);
      setPhase("ready");
      if (nonProgressing) setNotice(t("browse.the.backend.returned.a.non"));
    } catch (cause) {
      if (requestToken.current !== active.token) return;
      const failure = streamGraphError(cause);
      if (
        failure.code === "invalidCursor" ||
        failure.code === "cursorExpired"
      ) {
        // Restored pages can outlive the backend paging snapshot (120 s).
        void startFresh(true);
        return;
      }
      if (failure.code !== "cancelled") setError(failure.message);
      setPhase("ready");
    } finally {
      pendingCursors.current.delete(cursor);
      activeOperations.current.delete(id);
    }
  }, [phase, remoteReady, result, scopeMatches, startFresh, zh]);

  const rows = useMemo(
    () =>
      result
        ? layoutStreamGraph(
            result.nodes,
            result.edges,
            result.roots,
            result.orphans,
          )
        : [],
    [result],
  );
  const selected = rows.find(({ node }) => node.stream === selectedPath);
  const zoom = ZOOM_LEVELS[zoomIndex];
  const rowHeight = 70 * zoom;
  const maxDepth = rows.reduce((depth, row) => Math.max(depth, row.depth), 0);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: 8,
    initialRect: { width: 720, height: 440 },
  });
  useEffect(() => virtualizer.measure(), [virtualizer, zoom]);
  const measured = virtualizer.getVirtualItems();
  const visibleRows = measured.length
    ? measured
    : Array.from({ length: Math.min(rows.length, 18) }, (_, index) => ({
        index,
        key: rows[index].node.stream,
        start: index * rowHeight,
        size: rowHeight,
        end: (index + 1) * rowHeight,
        lane: 0,
      }));
  const focusIndex = (index: number) => {
    const bounded = Math.max(0, Math.min(rows.length - 1, index));
    const mounted = scrollRef.current?.querySelector<HTMLButtonElement>(
      `[data-stream-index="${bounded}"]`,
    );
    if (mounted) {
      mounted.focus();
      return;
    }
    virtualizer.scrollToIndex(bounded, { align: "auto" });
    requestAnimationFrame(() =>
      scrollRef.current
        ?.querySelector<HTMLButtonElement>(`[data-stream-index="${bounded}"]`)
        ?.focus(),
    );
  };
  const locateInStreams = () => {
    if (!selected) return;
    onLocateStream(selected.node.stream);
  };
  const cancel = () => {
    const token = ++requestToken.current;
    if (session.current) session.current.token = token;
    cancelOperations();
    setPhase(result ? "ready" : "idle");
    setNotice(t("browse.current.query.was.cancelled"));
  };

  if (runtime.p4Version === "loading")
    return (
      <section className="stream-graph-page">
        <div className="workspace-empty" role="status">
          {t("browse.loading.connection.runtime")}
        </div>
      </section>
    );

  return (
    <section className="stream-graph-page">
      <FixedPageHeader
        description={t("browse.explore.the.official.parent.child")}
      >
        <button
          onClick={() => void startFresh(true)}
          disabled={
            !remoteReady || phase === "loading" || phase === "loadingMore"
          }
        >
          <RefreshCw size={15} className={phase === "loading" ? "spin" : ""} />
          {t("browse.refresh")}
        </button>
      </FixedPageHeader>

      <form
        className="stream-graph-query"
        onSubmit={(event) => {
          event.preventDefault();
          setFilters((current) => ({
            ...current,
            depotPrefix: depotInput.trim(),
            text: textInput.trim(),
          }));
        }}
      >
        <label>
          <span>{t("browse.depot.scope")}</span>
          <input
            aria-label={t("browse.depot.scope")}
            placeholder="//depot"
            value={depotInput}
            onChange={(event) => setDepotInput(event.target.value)}
          />
        </label>
        <label className="stream-graph-text-filter">
          <span>{t("browse.text.filter")}</span>
          <span className="search-field">
            <Search size={15} />
            <input
              aria-label={t("browse.stream.text.filter")}
              placeholder={t("browse.name.path.owner")}
              value={textInput}
              onChange={(event) => setTextInput(event.target.value)}
            />
          </span>
        </label>
        <label className="stream-graph-check">
          <input
            type="checkbox"
            checked={filters.includeDeleted}
            onChange={(event) =>
              setFilters((current) => ({
                ...current,
                includeDeleted: event.target.checked,
              }))
            }
          />
          {t("browse.include.deleted")}
        </label>
        <button type="submit">{t("browse.apply.filters")}</button>
        {(phase === "loading" || phase === "loadingMore") && (
          <button type="button" onClick={cancel}>
            <X size={14} /> {t("browse.cancel")}
          </button>
        )}
      </form>

      <div className="stream-graph-status" aria-live="polite">
        {result?.simulated && (
          <span className="status-warning">
            {t("browse.browser.mock.simulated.data")}
          </span>
        )}
        {result && (
          <>
            <span>
              {result.nodes.length} / {result.stats.matchedCount}
            </span>
            <span>
              {result.cacheFreshness === "cached"
                ? t("browse.cached")
                : t("browse.fresh")}
            </span>
            {result.partial && <span>{t("browse.partial")}</span>}
            {result.truncated && (
              <span className="status-warning">
                {zh
                  ? `达到 ${result.stats.safetyLimit} 条安全上限`
                  : `Safety limit ${result.stats.safetyLimit} reached`}
              </span>
            )}
            {!!result.stats.invalidRelationCount && (
              <span>
                {t("browse.invalid.relations")}:{" "}
                {result.stats.invalidRelationCount}
              </span>
            )}
          </>
        )}
        {phase === "loading" && <span>{t("browse.loading")}</span>}
        {phase === "loadingMore" && <span>{t("browse.loading.more")}</span>}
      </div>
      {notice && (
        <div className="stream-graph-notice" role="status">
          {notice}
        </div>
      )}
      {error && (
        <div className="workspace-load-error" role="alert">
          <span>{error}</span>
          <button
            onClick={() =>
              phase === "error" ? void startFresh(!!result) : void loadMore()
            }
          >
            {t("browse.retry")}
          </button>
        </div>
      )}

      <div className={`stream-graph-layout ${selected ? "with-detail" : ""}`}>
        <section
          className="stream-graph-panel"
          aria-label={t("browse.stream.graph.visualization")}
        >
          <div className="stream-graph-toolbar">
            <span>
              {t("browse.zoom")}: {Math.round(zoom * 100)}%
            </span>
            <button
              aria-label={t("browse.zoom.out.stream.graph")}
              disabled={zoomIndex === 0}
              onClick={() => setZoomIndex((value) => Math.max(0, value - 1))}
            >
              <Minus size={14} />
            </button>
            <button
              aria-label={t("browse.zoom.in.stream.graph")}
              disabled={zoomIndex === ZOOM_LEVELS.length - 1}
              onClick={() =>
                setZoomIndex((value) =>
                  Math.min(ZOOM_LEVELS.length - 1, value + 1),
                )
              }
            >
              <Plus size={14} />
            </button>
            <button
              aria-label={t("browse.reset.stream.graph.zoom")}
              onClick={() => {
                setZoomIndex(1);
                scrollRef.current?.scrollTo({ top: 0, left: 0 });
              }}
            >
              <RotateCcw size={14} /> {t("browse.reset")}
            </button>
            <span className="stream-graph-scroll-hint">
              {t("browse.use.to.pan")}
            </span>
          </div>
          <div
            ref={scrollRef}
            className="stream-graph-viewport"
            role="tree"
            tabIndex={0}
            aria-label={t("browse.directed.stream.forest")}
            data-testid="stream-graph-virtual-list"
            onKeyDown={(event) => {
              const index = Number(
                (event.target as HTMLElement).closest<HTMLElement>(
                  "[data-stream-index]",
                )?.dataset.streamIndex,
              );
              if (event.key === "Escape") {
                event.preventDefault();
                setSelectedPath(undefined);
                scrollRef.current?.focus();
                return;
              }
              if (!Number.isSafeInteger(index) || !rows[index]) return;
              let next: number | undefined;
              if (event.key === "ArrowDown") next = index + 1;
              else if (event.key === "ArrowUp") next = index - 1;
              else if (event.key === "ArrowLeft")
                next = rows[index].parentIndex;
              else if (event.key === "ArrowRight")
                next = rows[index].childIndices[0];
              else if (event.key === "Home") next = 0;
              else if (event.key === "End") next = rows.length - 1;
              else if (event.key === "Enter") {
                event.preventDefault();
                setSelectedPath(rows[index].node.stream);
                return;
              }
              if (next !== undefined) {
                event.preventDefault();
                focusIndex(next);
              }
            }}
          >
            {!rows.length && phase !== "loading" ? (
              <div className="workspace-empty" role="status">
                {t("browse.no.matching.streams")}
              </div>
            ) : (
              <div
                className="stream-graph-spacer"
                style={
                  {
                    height:
                      virtualizer.getTotalSize() || rows.length * rowHeight,
                    minWidth: Math.max(
                      560,
                      Math.min(maxDepth, 48) * 36 * zoom + 430,
                    ),
                    "--stream-graph-zoom": zoom,
                  } as CSSProperties
                }
              >
                {visibleRows.map((virtualRow) => {
                  const row = rows[virtualRow.index];
                  const node = row.node;
                  const selectedNode = selectedPath === node.stream;
                  const current = currentStream === node.stream;
                  return (
                    <div
                      key={node.stream}
                      className="stream-graph-window-row"
                      data-index={virtualRow.index}
                      ref={virtualizer.measureElement}
                      style={{
                        height: virtualRow.size,
                        transform: `translateY(${virtualRow.start}px)`,
                      }}
                    >
                      <button
                        type="button"
                        role="treeitem"
                        aria-level={row.depth + 1}
                        aria-posinset={row.siblingIndex + 1}
                        aria-setsize={row.siblingCount}
                        aria-selected={selectedNode}
                        data-stream-index={virtualRow.index}
                        className={`stream-graph-node ${selectedNode ? "selected" : ""}`}
                        style={{
                          marginLeft: Math.min(row.depth, 48) * 36 * zoom,
                        }}
                        onClick={() => setSelectedPath(node.stream)}
                      >
                        <span className="stream-graph-edge" aria-hidden="true">
                          {row.relation === "child" ? (
                            <ChevronRight size={16} />
                          ) : row.relation === "root" ? (
                            <ArrowDownToLine size={16} />
                          ) : (
                            <AlertTriangle size={16} />
                          )}
                        </span>
                        <Network size={17} aria-hidden="true" />
                        <span className="stream-graph-node-copy">
                          <strong>{node.name || node.stream}</strong>
                          <small>{node.stream}</small>
                        </span>
                        <span className="stream-graph-badges">
                          <span>{node.kind || t("browse.unknown.type")}</span>
                          {current && (
                            <span className="current">
                              {t("browse.current")}
                            </span>
                          )}
                          {node.deleted && (
                            <span className="deleted">
                              {t("browse.deleted")}
                            </span>
                          )}
                          {row.relation === "orphan" && (
                            <span>{t("browse.orphan")}</span>
                          )}
                          {row.relation === "unloadedParent" && (
                            <span>{t("browse.parent.not.loaded")}</span>
                          )}
                          {row.depth > 48 && <span>Layer {row.depth + 1}</span>}
                        </span>
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          {result?.hasMore && (
            <button
              className="load-more-button"
              disabled={
                phase === "loading" ||
                phase === "loadingMore" ||
                !result.nextCursor
              }
              onClick={() => void loadMore()}
            >
              <ChevronDown size={14} />
              {t("browse.load.more.streams")}
            </button>
          )}
        </section>

        {selected && (
          <aside
            className="stream-graph-details"
            aria-label={t("browse.stream.details")}
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              event.preventDefault();
              event.stopPropagation();
              const index = rows.indexOf(selected);
              setSelectedPath(undefined);
              requestAnimationFrame(() => focusIndex(index));
            }}
          >
            <header>
              <div>
                <span>{t("browse.selected.node")}</span>
                <h2>{selected.node.name || selected.node.stream}</h2>
              </div>
              <button
                aria-label={t("browse.close.stream.details")}
                onClick={() => {
                  setSelectedPath(undefined);
                  focusIndex(rows.indexOf(selected));
                }}
              >
                <X size={16} />
              </button>
            </header>
            <dl>
              <div>
                <dt>Path</dt>
                <dd>{selected.node.stream}</dd>
              </div>
              <div>
                <dt>Owner</dt>
                <dd>{selected.node.owner || "—"}</dd>
              </div>
              <div>
                <dt>Type</dt>
                <dd>{selected.node.kind || t("browse.unknown")}</dd>
              </div>
              <div>
                <dt>Parent</dt>
                <dd>{selected.node.parent || "—"}</dd>
              </div>
              <div>
                <dt>ParentView</dt>
                <dd>{selected.node.parentView || "—"}</dd>
              </div>
              <div>
                <dt>To parent</dt>
                <dd>{boolLabel(selected.node.flowOptions.toParent, zh)}</dd>
              </div>
              <div>
                <dt>From parent</dt>
                <dd>{boolLabel(selected.node.flowOptions.fromParent, zh)}</dd>
              </div>
              <div>
                <dt>Merge mode</dt>
                <dd>{selected.node.flowOptions.mergeMode || "—"}</dd>
              </div>
              <div>
                <dt>Locked</dt>
                <dd>{boolLabel(selected.node.flowOptions.locked, zh)}</dd>
              </div>
              <div>
                <dt>All submit</dt>
                <dd>{boolLabel(selected.node.flowOptions.allSubmit, zh)}</dd>
              </div>
            </dl>
            {selected.node.description && <p>{selected.node.description}</p>}
            <div className="stream-graph-detail-actions">
              <button onClick={locateInStreams}>
                <LocateFixed size={14} /> {t("browse.locate.in.streams")}
              </button>
              <button
                onClick={(event) =>
                  setSwitchTarget({
                    stream: streamSummary(selected.node),
                    source: event.currentTarget,
                  })
                }
              >
                {t("browse.open.safe.switch.flow")}
              </button>
            </div>
          </aside>
        )}
      </div>

      {switchTarget && (
        <StreamSwitchDialog
          stream={switchTarget.stream}
          runtime={runtime}
          connectionKey={connectionOwner}
          source={switchTarget.source}
          zh={zh}
          onDismiss={() => setSwitchTarget(undefined)}
          onRuntime={onRuntime}
          onRefresh={() => void startFresh(true)}
        />
      )}
    </section>
  );
}
