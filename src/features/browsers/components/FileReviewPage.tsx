import { GraphInvestigationDialog } from "./GraphInvestigationDialog";
import { GraphFocusPanel } from "./GraphFocusPanel";
import {
  focusEvidence,
  projectGraph,
  GRAPH_BUDGET,
  validGraphPath,
  type GraphFocusMode,
} from "../graphFocus";
import { graphReadKey, readGraph } from "../graphReads";
import { useChangeDetails } from "../../changelists/components/ChangeDetailsDialog";
import type { RevisionComparison } from "../../../app/panels";
import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { RefreshCw, Minus, Plus } from "lucide-react";
import { backend } from "../../../infrastructure/backend";
import type {
  DiffResult,
  RevisionReference,
  RevisionGraph,
  RuntimeInfo,
} from "../../../shared/contracts";

import { useContextMenu } from "../../../app/context-menu/ContextMenu";
import { action, copy } from "../../../app/context-menu/bindings";
import { useRecordSelection } from "../../../app/context-menu/useRecordSelection";
import { PageRefreshSlotContext } from "../../../app/docking/chrome";
import { DiffView } from "./DiffView";
import { makeReviewScope } from "../reviewModel";
import { mergeRevisionGraphs } from "../reviewModel";
import {
  isCancellation,
  reviewRequestIdentity,
  reviewRequestIdentityKey,
  reviewSessionIdentity,
  useReviewRequestOwner,
} from "../reviewRequests";
import { swarmMenuAction } from "../../swarm/SwarmAction";
import { appCache } from "../../../shared/cache/appCache";
import { CACHE_POLICY } from "../../../shared/cache/policy";
import { isFresh, writeSnapshot } from "../../../shared/cache/snapshots";
import { useViewRefresh } from "../../../shared/cache/useViewRefresh";
export type ReviewKind = "diff" | "revgraph";

/**
 * Fixed revisions never change; have/head/shelf move with syncs and submits;
 * the local working copy can change at any time, so it is always revalidated
 * (the cached diff is still shown at once).
 */
export function reviewStaleTime(
  kind: ReviewKind,
  left: RevisionReference,
  right: RevisionReference,
) {
  if (kind === "revgraph") return CACHE_POLICY.target.staleTime;
  if (left.kind === "workspace" || right.kind === "workspace") return 0;
  if (left.kind === "revision" && right.kind === "revision")
    return CACHE_POLICY.immutable.staleTime;
  return CACHE_POLICY.target.staleTime;
}

export function FileReviewPage({
  kind,
  comparison,
  onCompareRevisions,
  target,
  runtime,
  zh,
}: {
  kind: ReviewKind;
  comparison?: RevisionComparison;
  onCompareRevisions?(path: string, comparison: RevisionComparison): void;
  target: string;
  // Path editing lives in the dock target bar; these stay for caller parity.
  locked: boolean;
  onTargetChange(path: string): void;
  runtime: RuntimeInfo;
  zh: boolean;
}) {
  const remoteReady =
    runtime.p4Version !== "loading" && runtime.connection.state === "connected";
  const [queryPath, setQueryPath] = useState(target);
  const refreshSlot = useContext(PageRefreshSlotContext);
  const [ownedData, setOwnedData] = useState<{
    owner: string;
    value: DiffResult | RevisionGraph;
  }>();
  const [loadingOwner, setLoadingOwner] = useState("");
  const [ownedError, setOwnedError] = useState<{
    owner: string;
    message: string;
  }>();
  const [refresh, setRefresh] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [investigationOpen, setInvestigationOpen] = useState(false);
  const [focusMode, setFocusMode] = useState<GraphFocusMode>("target");
  const [graphTarget, setGraphTarget] = useState("");
  const [laneOverride, setLaneOverride] = useState<Set<string>>();
  const graphReads = useRef(0);
  const [readCount, setReadCount] = useState(0);
  const [snapshotTime, setSnapshotTime] = useState(0);

  const [selectedNode, setSelectedNode] = useState("");
  const [leftReference, setLeftReference] = useState<RevisionReference>(
    comparison
      ? { kind: "revision", revision: comparison.left }
      : { kind: "have" },
  );
  const [rightReference, setRightReference] = useState<RevisionReference>(
    comparison
      ? { kind: "revision", revision: comparison.right }
      : { kind: "workspace" },
  );
  const [graphCursor, setGraphCursor] = useState<string>();
  const consumedGraphCursors = useRef(new Set<string>());
  const pendingGraphCursors = useRef(new Set<string>());
  const scope = useMemo(
    () => makeReviewScope(runtime, queryPath),
    [
      queryPath,
      runtime.activeProfileId,
      runtime.context.client,
      runtime.context.cwd,
      runtime.context.server,
      runtime.context.user,
      runtime.contextGeneration,
    ],
  );
  const tab = kind === "diff" ? "diff" : "revgraph";
  const sessionIdentity = reviewSessionIdentity(runtime, tab, scope);
  const primaryIdentity = reviewRequestIdentity(
    runtime,
    scope,
    tab,
    kind === "diff" ? "diff" : "graph",
    kind === "diff"
      ? {
          left: leftReference,
          right: rightReference,
          rightFileIdentity: comparison?.rightPath,
        }
      : undefined,
  );
  const primaryOwner = reviewRequestIdentityKey(primaryIdentity);
  const currentOwner = useRef(primaryOwner);
  currentOwner.current = primaryOwner;
  const requests = useReviewRequestOwner(sessionIdentity);
  const key = useMemo(
    () =>
      kind === "revgraph"
        ? graphReadKey({ scope, revisionLimit: 100 }, runtime.mode)
        : ["target", "review", primaryOwner],
    [primaryOwner, kind, runtime.mode],
  );
  const staleTime = reviewStaleTime(kind, leftReference, rightReference);
  const refreshSeen = useRef(refresh);
  useEffect(() => {
    setInvestigationOpen(false);
    setGraphTarget("");
    setLaneOverride(undefined);
    setFocusMode("target");
    graphReads.current = 0;
    setReadCount(0);
    setSnapshotTime(0);
  }, [primaryOwner]);
  const displayCurrent =
    target === queryPath && runtime.p4Version !== "loading";
  const data =
    displayCurrent && ownedData?.owner === primaryOwner
      ? ownedData.value
      : undefined;
  const loading = displayCurrent && loadingOwner === primaryOwner;
  const error =
    displayCurrent && ownedError?.owner === primaryOwner
      ? ownedError.message
      : "";
  useEffect(() => {
    setQueryPath(target);
  }, [target]);
  useEffect(() => {
    if (!queryPath || runtime.p4Version === "loading") {
      requests.cancel("primary");
      setOwnedData(undefined);
      setOwnedError(undefined);
      setLoadingOwner("");
      return;
    }
    requests.cancel("graph-page");
    requests.cancel("graph-expand");

    const forced = refreshSeen.current !== refresh;
    refreshSeen.current = refresh;
    const cached = appCache.getQueryData<DiffResult | RevisionGraph>(key);
    setSnapshotTime(appCache.getQueryState(key)?.dataUpdatedAt ?? 0);
    if (cached && !forced && isFresh(key, staleTime)) {
      // Fresh target data: show it without asking P4.
      if (ownedData?.owner !== primaryOwner) {
        setSelectedNode("");

        consumedGraphCursors.current.clear();
        pendingGraphCursors.current.clear();
        setOwnedData({ owner: primaryOwner, value: cached });
        if ("nodes" in cached) setGraphCursor(cached.nextCursor);
      }
      setOwnedError(undefined);
      setLoadingOwner("");
      return;
    }
    if (!remoteReady) {
      setOwnedData((previous) =>
        previous?.owner === primaryOwner
          ? previous
          : cached
            ? { owner: primaryOwner, value: cached }
            : undefined,
      );
      setOwnedError(undefined);
      setLoadingOwner("");
      return;
    }
    if (
      kind === "revgraph" &&
      (/[\r\n\0*]/.test(queryPath) ||
        queryPath.includes("...") ||
        graphReads.current >= GRAPH_BUDGET)
    ) {
      setOwnedError({
        owner: primaryOwner,
        message: zh
          ? "请选择单个文件；读取预算已达上限时请手动刷新。"
          : "Select a single file; refresh manually when the read budget is exhausted.",
      });
      return;
    }
    const lease = requests.start(
      "primary",
      primaryIdentity,
      kind !== "revgraph",
    );
    setLoadingOwner(primaryOwner);
    setOwnedError(undefined);
    if (ownedData?.owner !== primaryOwner) {
      setSelectedNode("");
    }
    consumedGraphCursors.current.clear();
    pendingGraphCursors.current.clear();
    // Stale data stays visible while the replacement loads.
    setOwnedData((previous) =>
      previous?.owner === primaryOwner
        ? previous
        : cached
          ? { owner: primaryOwner, value: cached }
          : undefined,
    );
    if (kind === "revgraph") {
      graphReads.current++;
      setReadCount(graphReads.current);
    }
    const request =
      kind === "diff"
        ? backend.getDiff({
            scope,
            rightFileIdentity: comparison?.rightPath,
            left: leftReference,
            right: rightReference,
            refresh: refresh > 0,
            operationId: lease.operationId,
          })
        : readGraph(
            { scope, revisionLimit: 100, refresh: forced },
            runtime.mode,
            lease.signal,
          );
    void request
      .then((result) => {
        if (!requests.isCurrent(lease) || currentOwner.current !== primaryOwner)
          return;
        if (kind === "diff") writeSnapshot(key, result);
        setSnapshotTime(
          appCache.getQueryState(key)?.dataUpdatedAt ?? Date.now(),
        );
        setOwnedData({ owner: primaryOwner, value: result });
        if ("nodes" in result) setGraphCursor(result.nextCursor);
      })
      .catch((cause) => {
        if (
          requests.isCurrent(lease) &&
          currentOwner.current === primaryOwner &&
          !isCancellation(cause)
        )
          setOwnedError({ owner: primaryOwner, message: String(cause) });
      })
      .finally(() => {
        if (requests.finish(lease) && currentOwner.current === primaryOwner)
          setLoadingOwner("");
      });
    return () => requests.cancel("primary");
  }, [primaryOwner, kind, queryPath, remoteReady, refresh]);
  const diff = data && "unified" in data ? data : undefined;
  const rawGraph = data && "nodes" in data ? data : undefined;
  const sourceId =
    selectedNode ||
    rawGraph?.nodes
      .filter((n) => !n.missing)
      .sort(
        (a, b) =>
          (b.depotPath === queryPath ? 1 : 0) -
            (a.depotPath === queryPath ? 1 : 0) || b.revision - a.revision,
      )[0]?.id ||
    "";
  const evidence = useMemo(
    () =>
      rawGraph
        ? focusEvidence(rawGraph, sourceId, graphTarget, focusMode)
        : undefined,
    [rawGraph, sourceId, graphTarget, focusMode],
  );
  const visiblePaths =
    laneOverride ?? evidence?.relevantPaths ?? new Set<string>();
  const graph = useMemo(
    () => (rawGraph ? projectGraph(rawGraph, visiblePaths) : undefined),
    [rawGraph, visiblePaths],
  );
  const graphIndex = useMemo(
    () => new Map(rawGraph?.nodes.map((node) => [node.id, node]) ?? []),
    [rawGraph],
  );
  const bounds = useMemo(
    () =>
      (graph?.nodes ?? []).reduce(
        (box, node) => ({
          width: Math.max(box.width, node.x + 100),
          height: Math.max(box.height, node.y + 90),
        }),
        { width: 640, height: 280 },
      ),
    [graph],
  );
  const selected = graphIndex.get(selectedNode);
  const menu = useContextMenu();
  const openChangeDetails = useChangeDetails();
  const selection = useRecordSelection(
    rawGraph?.nodes ?? [],
    (n) => n.id,
    primaryOwner,
    2,
  );
  const reload = () => {
    if (kind === "revgraph") {
      graphReads.current = 0;
      setReadCount(0);
      setLaneOverride(undefined);
      setSelectedNode("");
    }
    void appCache
      .invalidateQueries(
        kind === "revgraph"
          ? {
              predicate: (query) => {
                const [category, domain, mode, candidate] = query.queryKey;
                return (
                  category === "target" &&
                  domain === "focused-graph" &&
                  mode === runtime.mode &&
                  !!candidate &&
                  typeof candidate === "object" &&
                  JSON.stringify({ ...candidate, fileIdentity: "" }) ===
                    JSON.stringify({ ...scope, fileIdentity: "" })
                );
              },
            }
          : { queryKey: key },
      )
      .then(() => setRefresh((v) => v + 1));
  };
  // Auto-refresh and stale tab activation revalidate in the background.
  useViewRefresh(
    kind,
    key,
    () => {
      if (kind === "diff" && !loading && queryPath) reload();
    },
    staleTime,
    { automatic: kind !== "revgraph" },
  );
  const candidates = selection.selected;
  const canCompare =
    candidates.length === 2 &&
    candidates.every(
      (node) =>
        !node.missing &&
        Number.isSafeInteger(node.revision) &&
        node.revision > 0 &&
        node.depotPath.startsWith("//") &&
        !/[#@*\r\n\0]/.test(node.depotPath) &&
        !node.depotPath.includes("..."),
    ) &&
    (candidates[0].depotPath !== candidates[1].depotPath ||
      candidates[0].revision !== candidates[1].revision);
  const compareGraphNodes = () => {
    if (!canCompare) return;
    const [left, right] = candidates;
    onCompareRevisions?.(left.depotPath, {
      left: left.revision,
      right: right.revision,
      rightPath: right.depotPath,
    });
  };
  const loadMoreGraph = () => {
    const cursor = graphCursor;
    if (
      !cursor ||
      !rawGraph ||
      loading ||
      !remoteReady ||
      graphReads.current >= GRAPH_BUDGET ||
      consumedGraphCursors.current.has(cursor) ||
      pendingGraphCursors.current.has(cursor)
    )
      return;
    pendingGraphCursors.current.add(cursor);
    const identity = reviewRequestIdentity(
      runtime,
      scope,
      "revgraph",
      "graph-page",
      { cursor },
    );
    const lease = requests.start("graph-page", identity, false);
    graphReads.current++;
    setReadCount(graphReads.current);
    const ownerAtStart = primaryOwner;
    setLoadingOwner(ownerAtStart);
    setOwnedError(undefined);
    void readGraph(
      { scope, revisionLimit: 100, cursor },
      runtime.mode,
      lease.signal,
    )
      .then((result) => {
        if (!requests.isCurrent(lease) || currentOwner.current !== ownerAtStart)
          return;
        consumedGraphCursors.current.add(cursor);
        const nonProgressing =
          result.hasMore &&
          (!result.nextCursor ||
            result.nextCursor === cursor ||
            consumedGraphCursors.current.has(result.nextCursor));
        setOwnedData((current) => {
          const base =
            current?.owner === ownerAtStart && "nodes" in current.value
              ? current.value
              : rawGraph;
          const merged = mergeRevisionGraphs(base, result);
          return {
            owner: ownerAtStart,
            value: nonProgressing
              ? {
                  ...merged,
                  hasMore: false,
                  nextCursor: undefined,
                  partial: true,
                }
              : { ...merged, partial: merged.partial || base.partial },
          };
        });
        setGraphCursor(nonProgressing ? undefined : result.nextCursor);
        if (nonProgressing)
          setOwnedError({
            owner: ownerAtStart,
            message: zh
              ? "后端返回了重复游标；已保留当前版本图。"
              : "The backend returned a repeated cursor; the current graph was preserved.",
          });
      })
      .catch((cause) => {
        if (
          requests.isCurrent(lease) &&
          currentOwner.current === ownerAtStart &&
          !isCancellation(cause)
        )
          setOwnedError({ owner: ownerAtStart, message: String(cause) });
      })
      .finally(() => {
        pendingGraphCursors.current.delete(cursor);
        if (requests.finish(lease) && currentOwner.current === ownerAtStart)
          setLoadingOwner("");
      });
  };
  const expandGraphNode = (path = selected?.depotPath) => {
    if (
      !path ||
      !validGraphPath(path) ||
      !rawGraph ||
      loading ||
      !remoteReady ||
      graphReads.current >= GRAPH_BUDGET
    )
      return;
    const expandScope = makeReviewScope(runtime, path);
    const identity = reviewRequestIdentity(
      runtime,
      expandScope,
      "revgraph",
      "graph-expand",
      { expandTarget: path },
    );
    const lease = requests.start("graph-expand", identity, false);
    const ownerAtStart = primaryOwner;
    graphReads.current++;
    setReadCount(graphReads.current);
    setLoadingOwner(ownerAtStart);
    setOwnedError(undefined);
    void readGraph(
      { scope: expandScope, revisionLimit: 100 },
      runtime.mode,
      lease.signal,
    )
      .then((result) => {
        if (!requests.isCurrent(lease) || currentOwner.current !== ownerAtStart)
          return;
        const stamp =
          appCache.getQueryState(
            graphReadKey(
              { scope: expandScope, revisionLimit: 100 },
              runtime.mode,
            ),
          )?.dataUpdatedAt ?? 0;
        setSnapshotTime((previous) => Math.min(previous, stamp));
        setOwnedData((current) => {
          const base =
            current?.owner === ownerAtStart && "nodes" in current.value
              ? current.value
              : rawGraph;
          const merged = mergeRevisionGraphs(base, result);
          return {
            owner: ownerAtStart,
            value: {
              ...merged,
              partial:
                merged.partial ||
                base.partial ||
                result.partial ||
                result.hasMore,
              nextCursor: base.nextCursor,
              hasMore: base.hasMore,
            },
          };
        });
      })
      .catch((cause) => {
        if (
          requests.isCurrent(lease) &&
          currentOwner.current === ownerAtStart &&
          !isCancellation(cause)
        )
          setOwnedError({ owner: ownerAtStart, message: String(cause) });
      })
      .finally(() => {
        if (requests.finish(lease) && currentOwner.current === ownerAtStart)
          setLoadingOwner("");
      });
  };
  const refreshButton =
    refreshSlot &&
    createPortal(
      <button
        type="button"
        title={zh ? "刷新" : "Refresh"}
        aria-label={zh ? "刷新" : "Refresh"}
        aria-busy={loading}
        disabled={loading || !queryPath || !remoteReady}
        onClick={reload}
      >
        <RefreshCw
          size={14}
          className={loading ? "spin" : ""}
          aria-hidden="true"
        />
      </button>,
      refreshSlot,
    );
  if (kind === "diff")
    return (
      <section className="workspaces-page file-review-page diff-page">
        {refreshButton}
        <DiffView
          key={primaryOwner}
          diff={diff}
          path={queryPath}
          loading={loading}
          error={error}
          left={leftReference}
          right={rightReference}
          onLeftChange={setLeftReference}
          onRightChange={setRightReference}
          onRefresh={reload}
          runtime={runtime}
          zh={zh}
        />
      </section>
    );
  return (
    <section className="workspaces-page file-review-page">
      {refreshButton}
      {investigationOpen && rawGraph?.nodes.find((n) => n.id === sourceId) && (
        <GraphInvestigationDialog
          key={primaryOwner}
          seed={rawGraph.nodes.find((n) => n.id === sourceId)!}
          runtime={runtime}
          zh={zh}
          onClose={() => setInvestigationOpen(false)}
        />
      )}
      {error && (
        <div role="alert" className="workspace-load-error">
          {error}
        </div>
      )}
      <section
        className="review-surface"
        aria-busy={loading}
        tabIndex={0}
        {...menu("V08", () => ({
          刷新当前视图: action(reload),
          复制当前目标标识: copy(queryPath),
          "在 Swarm 中打开": swarmMenuAction(runtime, zh, {
            kind: "file",
            depotPath: queryPath,
          }),
          修订图重置缩放: action(() => setZoom(1)),
        }))}
      >
        {rawGraph && evidence && (
          <GraphFocusPanel
            graph={rawGraph}
            sourceId={sourceId}
            onSource={(id) => {
              setSelectedNode(id);
              setLaneOverride(undefined);
            }}
            target={graphTarget}
            onTarget={(value) => {
              setGraphTarget(value);
              setLaneOverride(undefined);
            }}
            mode={focusMode}
            onMode={(value) => {
              setFocusMode(value);
              setLaneOverride(undefined);
            }}
            evidence={evidence}
            paths={[...new Set(rawGraph.nodes.map((n) => n.depotPath))].sort()}
            visible={visiblePaths}
            toggle={(path) =>
              setLaneOverride((previous) => {
                const next = new Set(previous ?? visiblePaths);
                if (next.has(path)) next.delete(path);
                else next.add(path);
                return next;
              })
            }
            solo={(path) => setLaneOverride(path ? new Set([path]) : undefined)}
            onRead={() => expandGraphNode(graphTarget)}
            onInvestigate={() => setInvestigationOpen(true)}
            loading={loading || !remoteReady}
            reads={readCount}
            updatedAt={snapshotTime}
            stale={
              !remoteReady ||
              !snapshotTime ||
              Date.now() - snapshotTime >= staleTime ||
              !isFresh(key, staleTime)
            }
            zh={zh}
          />
        )}
        {loading && kind === "revgraph" && (
          <button
            onClick={() => {
              requests.cancel("primary");
              requests.cancel("graph-page");
              requests.cancel("graph-expand");
              setLoadingOwner("");
            }}
          >
            {zh ? "取消读取" : "Cancel read"}
          </button>
        )}
        <div className="review-toolbar">
          <>
            <span>
              {graph
                ? `${graph.nodes.length} ${zh ? "个版本（已加载）" : "revisions loaded"}`
                : error
                  ? zh
                    ? "版本数量未知（读取失败）"
                    : "Revision count unavailable (read failed)"
                  : zh
                    ? "尚未取得版本数量"
                    : "Revision count not yet available"}
            </span>
            <span className="graph-legend">
              {zh
                ? "实线：版本 / 分支　虚线：合并 / 复制"
                : "Solid: revision / branch · Dashed: merge / copy"}
            </span>
            {(graph?.partial || graph?.truncated) && (
              <span role="status" className="filter-count">
                {graph.truncated
                  ? zh
                    ? "已达到 2,000 版本安全上限"
                    : "2,000-revision safety limit reached"
                  : zh
                    ? "记录不完整或存在尚未展开的引用节点"
                    : "Records are incomplete or references remain unexpanded"}
              </span>
            )}
            <button
              aria-label={zh ? "缩小" : "Zoom out"}
              onClick={() => setZoom((v) => Math.max(0.25, v - 0.25))}
            >
              <Minus size={14} />
            </button>
            <button onClick={() => setZoom(1)}>
              {Math.round(zoom * 100)}%
            </button>
            <button
              aria-label={zh ? "放大" : "Zoom in"}
              onClick={() => setZoom((v) => Math.min(3, v + 0.25))}
            >
              <Plus size={14} />
            </button>
            <button
              disabled={!canCompare || !onCompareRevisions}
              onClick={compareGraphNodes}
              title={
                zh
                  ? "在新页签比较所选版本"
                  : "Compare selected revisions in a new tab"
              }
            >
              {zh ? "比较所选版本" : "Compare selected revisions"}
            </button>
          </>
        </div>
        {!queryPath ? (
          <div className="workspace-empty">
            {zh
              ? "在文件页选中文件后打开此页签，或在上方输入路径。"
              : "Select a file and open this tab, or enter a path above."}
          </div>
        ) : loading && !data ? (
          <div className="workspace-empty" role="status">
            {zh ? "正在加载…" : "Loading…"}
          </div>
        ) : !graph?.nodes.length ? (
          <div className="workspace-empty">
            {error
              ? zh
                ? "加载失败，请重试。"
                : "Loading failed. Retry."
              : zh
                ? "暂无版本记录"
                : "No revisions"}
          </div>
        ) : (
          <div className="graph-scroll">
            <svg
              className="review-graph"
              aria-label="Revision graph"
              width={bounds.width * zoom}
              height={bounds.height * zoom}
              viewBox={`0 0 ${bounds.width} ${bounds.height}`}
            >
              {graph.lanes.map((path, lane) => (
                <g key={path} className="graph-track">
                  <line
                    x1={0}
                    x2={bounds.width}
                    y1={80 + lane * 130}
                    y2={80 + lane * 130}
                  />
                  <text x={8} y={24 + lane * 130}>
                    {path}
                  </text>
                </g>
              ))}
              {graph.edges.map((edge) => {
                const a = graph.nodes.find((n) => n.id === edge.source),
                  b = graph.nodes.find((n) => n.id === edge.target);
                return a && b ? (
                  <line
                    key={edge.id}
                    x1={a.x}
                    y1={a.y}
                    x2={b.x}
                    y2={b.y}
                    className={`${edge.kind} ${evidence?.edges.some((e) => e.id === edge.id) ? "is-evidence" : ""}`}
                  >
                    <title>{edge.relationship}</title>
                  </line>
                ) : null;
              })}
              {graph.nodes.map((node) => (
                <g
                  key={node.id}
                  role="button"
                  tabIndex={0}
                  aria-label={`${node.label}, CL ${node.changelistId}${candidates[0]?.id === node.id ? (zh ? "，先选（左侧）" : ", first selected (left)") : candidates[1]?.id === node.id ? (zh ? "，后选（右侧）" : ", last selected (right)") : ""}`}
                  aria-pressed={selection.isSelected(node)}
                  className={`${candidates[0]?.id === node.id ? "compare-first" : candidates[1]?.id === node.id ? "compare-last" : ""} ${node.id === sourceId ? "selected" : ""} graph-lane-${graph.lanes.indexOf(node.depotPath) % 4}`}
                  transform={`translate(${node.x},${node.y})`}
                  onClick={(event) => {
                    if (node.id !== selectedNode) {
                      requests.cancel("graph-expand");
                    }
                    selection.select(node, event);
                    setSelectedNode(node.id);
                  }}
                  onKeyDownCapture={(event) => {
                    if (selection.keyboard(node, event)) {
                      if (node.id !== selectedNode) {
                        requests.cancel("graph-expand");
                      }
                      setSelectedNode(node.id);
                    }
                  }}
                  {...menu(
                    selection.targets(node).length > 2
                      ? "V03"
                      : selection.targets(node).length === 2
                        ? "V02"
                        : "V01",
                    () => ({
                      "复制 Depot 路径": copy(node.depotPath),
                      复制精确修订标识: copy(
                        `${node.depotPath}#${node.revision}`,
                      ),
                      "打开所属 CL": action((source) =>
                        openChangeDetails?.(
                          { kind: "submitted", changeId: node.changelistId },
                          source,
                        ),
                      ),
                      "复制 CL 编号": copy(node.changelistId),
                      "在 Swarm 中打开": swarmMenuAction(runtime, zh, {
                        kind: "file",
                        depotPath: node.depotPath,
                        revision: node.revision,
                      }),
                      复制所选修订标识: copy(
                        selection
                          .targets(node)
                          .map((n) => `${n.depotPath}#${n.revision}`)
                          .join("\n"),
                      ),
                    }),
                    {
                      onOpen: () => {
                        if (node.id !== selectedNode) {
                          requests.cancel("graph-expand");
                        }
                        selection.context(node);
                        setSelectedNode(node.id);
                      },
                    },
                  )}
                >
                  <title>{node.depotPath}</title>
                  <circle r={23} />
                  <text textAnchor="middle" y={4}>
                    {node.label}
                  </text>
                  <text className="graph-label" textAnchor="middle" y={46}>
                    CL {node.changelistId || "?"}
                  </text>
                </g>
              ))}
            </svg>
            <div className="graph-actions">
              {selected?.missing && selected.revision > 0 && (
                <button
                  disabled={
                    loading || !remoteReady || readCount >= GRAPH_BUDGET
                  }
                  onClick={() => expandGraphNode()}
                >
                  {zh ? "展开所选引用节点" : "Expand selected reference"}
                </button>
              )}
              {graph.hasMore && graphCursor && (
                <button
                  disabled={
                    loading || !remoteReady || readCount >= GRAPH_BUDGET
                  }
                  onClick={loadMoreGraph}
                >
                  {zh ? "展开更多版本" : "Expand more revisions"}
                </button>
              )}
            </div>
          </div>
        )}
        <footer className="review-footer">
          {selected
            ? `${selected.depotPath}#${selected.revision} · CL ${selected.changelistId || "?"} · ${selected.action} · ${selected.fileType || "—"}`
            : queryPath || "—"}
        </footer>
      </section>
    </section>
  );
}
