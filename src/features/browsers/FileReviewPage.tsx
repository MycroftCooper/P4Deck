import { useEffect, useMemo, useRef, useState } from "react";
import { QueryClient } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { RefreshCw, Minus, Plus } from "lucide-react";
import { backend } from "../../infrastructure/backend";
import type {
  DiffResult,
  RevisionReference,
  RevisionGraph,
  RuntimeInfo,
} from "../../shared/contracts/types";

import { useContextMenu } from "../../app/context-menu/ContextMenu";
import { action, copy } from "../../app/context-menu/bindings";
import { useRecordSelection } from "../../app/context-menu/useRecordSelection";
import { useFullTextSelection } from "../../app/context-menu/FullTextSelection";
import { graphNodeDiffPair, makeReviewScope } from "./reviewModel";
export type ReviewKind = "diff" | "revgraph";
const cache = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, gcTime: 120_000, retry: false },
  },
});

export function FileReviewPage({
  kind,
  target,
  locked,
  onTargetChange,
  runtime,
  zh,
}: {
  kind: ReviewKind;
  target: string;
  locked: boolean;
  onTargetChange(path: string): void;
  runtime: RuntimeInfo;
  zh: boolean;
}) {
  const [path, setPath] = useState(() => target);
  const [queryPath, setQueryPath] = useState(path);
  const [data, setData] = useState<DiffResult | RevisionGraph>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [selectedNode, setSelectedNode] = useState("");
  const [leftReference, setLeftReference] = useState<RevisionReference>({
    kind: "have",
  });
  const [rightReference, setRightReference] = useState<RevisionReference>({
    kind: "workspace",
  });
  const [graphCursor, setGraphCursor] = useState<string>();
  const [nodeDiff, setNodeDiff] = useState<DiffResult>();
  const scroll = useRef<HTMLDivElement>(null);
  const key = useMemo(
    () => [
      "file-review",
      kind,
      runtime.mode,
      runtime.activeProfileId,
      runtime.contextGeneration,
      runtime.context,
      queryPath,
      leftReference,
      rightReference,
    ],
    [kind, runtime, queryPath, leftReference, rightReference],
  );
  useEffect(() => {
    setPath(target);
    setQueryPath(target);
  }, [target]);
  useEffect(() => {
    if (!queryPath || runtime.p4Version === "loading") {
      setData(undefined);
      return;
    }
    let active = true;
    const operationId = crypto.randomUUID();
    setLoading(true);
    setError("");
    setSelectedNode("");
    setData(cache.getQueryData<DiffResult | RevisionGraph>(key));
    void cache
      .fetchQuery<DiffResult | RevisionGraph>({
        queryKey: key,
        queryFn: () =>
          kind === "diff"
            ? backend.getDiff({
                scope: makeReviewScope(runtime, queryPath),
                left: leftReference,
                right: rightReference,
                refresh: refresh > 0,
                operationId,
              })
            : backend.getRevisionGraph({
                scope: makeReviewScope(runtime, queryPath),
                revisionLimit: 100,
                refresh: refresh > 0,
                operationId,
              }),
      })
      .then((result) => {
        if (active) {
          setData(result);
          if ("nodes" in result) setGraphCursor(result.nextCursor);
        }
      })
      .catch((cause) => {
        if (active) setError(String(cause));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      void backend.cancelOperation(operationId);
    };
  }, [
    key,
    kind,
    queryPath,
    runtime,
    runtime.p4Version,
    refresh,
    leftReference,
    rightReference,
  ]);
  const diff = data && "unified" in data ? data : undefined;
  const graph = data && "nodes" in data ? data : undefined;
  const lines = useMemo(
    () => (diff?.unified ? diff.unified.split("\n") : []),
    [diff],
  );
  const virtual = useVirtualizer({
    count: lines.length,
    getScrollElement: () => scroll.current,
    estimateSize: () => 24,
    overscan: 15,
  });
  const graphIndex = useMemo(
    () => new Map(graph?.nodes.map((node) => [node.id, node]) ?? []),
    [graph],
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
  const textSelection = useFullTextSelection();
  const selection = useRecordSelection(
    graph?.nodes ?? [],
    (n) => n.id,
    queryPath,
  );
  const reload = () => {
    void cache
      .invalidateQueries({ queryKey: key })
      .then(() => setRefresh((v) => v + 1));
  };
  return (
    <main
      className="workspaces-page file-review-page"
      ref={textSelection.surfaceRef}
    >
      <header className="section-title">
        <div>
          <span className="workspace-eyebrow">PERFORCE / FILE REVIEW</span>
          <h1>{kind === "diff" ? "Diff" : "Rev Graph"}</h1>
          <p>
            {kind === "diff"
              ? zh
                ? "查看文件差异，新增与删除逐行高亮。"
                : "Inspect file differences with highlighted additions and deletions."
              : zh
                ? "查看文件版本与分支、合并关系。"
                : "Explore file revisions, branches and integration relationships."}
          </p>
        </div>
        <button disabled={loading || !queryPath} onClick={reload}>
          <RefreshCw size={15} className={loading ? "spin" : ""} />
          {zh ? "刷新" : "Refresh"}
        </button>
      </header>
      <form
        className="history-path"
        onSubmit={(event) => {
          event.preventDefault();
          const value = path.trim();
          if (!value || locked) return;
          onTargetChange(value);
          if (value === queryPath) reload();
          else {
            setQueryPath(value);
            scroll.current?.scrollTo(0, 0);
          }
        }}
      >
        <input
          disabled={locked}
          aria-label={kind === "diff" ? "Diff 文件路径" : "Rev Graph 文件路径"}
          value={path}
          onChange={(event) => setPath(event.target.value)}
          placeholder={
            zh
              ? "输入 Depot 或本地文件路径"
              : "Enter a depot or local file path"
          }
        />
        <button type="submit" disabled={locked || !path.trim() || loading}>
          {zh ? "查看" : "Load"}
        </button>
      </form>
      {kind === "diff" && (
        <div
          className="review-selectors"
          aria-label={zh ? "差异版本选择" : "Diff references"}
        >
          <ReferenceSelector
            label={zh ? "左侧" : "Left"}
            value={leftReference}
            onChange={setLeftReference}
          />
          <span aria-hidden="true">↔</span>
          <ReferenceSelector
            label={zh ? "右侧" : "Right"}
            value={rightReference}
            onChange={setRightReference}
          />
        </div>
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
          修订图重置缩放: action(() => setZoom(1)),
        }))}
      >
        <div className="review-toolbar">
          {kind === "diff" ? (
            <>
              <span>{diff?.left.label ?? "—"}</span>
              <span>→</span>
              <span>{diff?.right.label ?? "—"}</span>
              <span className="filter-count">
                +{diff?.stats.additions ?? 0} / -{diff?.stats.deletions ?? 0} ·{" "}
                {diff?.stats.hunks ?? 0} {zh ? "个区块" : "hunks"}
              </span>
            </>
          ) : (
            <>
              <span>
                {graph?.nodes.length ?? 0} {zh ? "个版本" : "revisions"}
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
                      ? "已达到 2,000 节点安全上限"
                      : "2,000-node safety limit reached"
                    : zh
                      ? "存在尚未展开的引用节点"
                      : "Some referenced nodes are not expanded"}
                </span>
              )}
              <button
                aria-label="缩小"
                onClick={() => setZoom((v) => Math.max(0.25, v - 0.25))}
              >
                <Minus size={14} />
              </button>
              <button onClick={() => setZoom(1)}>
                {Math.round(zoom * 100)}%
              </button>
              <button
                aria-label="放大"
                onClick={() => setZoom((v) => Math.min(3, v + 0.25))}
              >
                <Plus size={14} />
              </button>
            </>
          )}
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
        ) : kind === "diff" ? (
          diff?.binary || diff?.unsupported ? (
            <div className="workspace-empty">
              <strong>
                {diff.reason ??
                  (zh ? "无法显示文本差异" : "Text diff unavailable")}
              </strong>
              <div>
                {diff.left.label}: {diff.left.fileType ?? "unknown"} ·{" "}
                {diff.left.size ?? 0} bytes · {diff.left.digest ?? "no digest"}
              </div>
              <div>
                {diff.right.label}: {diff.right.fileType ?? "unknown"} ·{" "}
                {diff.right.size ?? 0} bytes ·{" "}
                {diff.right.digest ?? "no digest"}
              </div>
            </div>
          ) : !lines.length ? (
            <div className="workspace-empty">
              {error
                ? zh
                  ? "加载失败，请重试。"
                  : "Loading failed. Retry."
                : zh
                  ? diff?.identical
                    ? "两侧内容相同"
                    : "没有文本差异"
                  : diff?.identical
                    ? "Both sides are identical"
                    : "No text differences"}
            </div>
          ) : (
            <div
              ref={scroll}
              className="diff-scroll"
              tabIndex={0}
              {...menu(
                "V04",
                () => ({
                  复制所选文本: copy(textSelection.selectedText()),
                  全选当前侧: {
                    ...action(() =>
                      textSelection.selectAll(diff?.unified ?? ""),
                    ),
                    label: zh ? "全选差异文本" : "Select all diff text",
                  },
                  "复制当前侧文件/修订标识": {
                    ...copy(`${diff?.left.label} ↔ ${diff?.right.label}`),
                    label: zh
                      ? "复制两侧文件/修订标识"
                      : "Copy both file/revision identifiers",
                  },
                }),
                { title: "统一差异 / Unified diff" },
              )}
            >
              <div
                className="virtual-spacer"
                style={{ height: virtual.getTotalSize() }}
              >
                {virtual.getVirtualItems().map((row) => {
                  const line = lines[row.index];
                  const style =
                    line.startsWith("@@") ||
                    line.startsWith("+++") ||
                    line.startsWith("---")
                      ? "meta"
                      : line.startsWith("+")
                        ? "added"
                        : line.startsWith("-")
                          ? "removed"
                          : "context";
                  return (
                    <div
                      key={row.index}
                      className={`diff-line ${style}`}
                      style={{
                        height: row.size,
                        transform: `translateY(${row.start}px)`,
                      }}
                    >
                      <span className="diff-line-number">{row.index + 1}</span>
                      <code>{line || " "}</code>
                    </div>
                  );
                })}
              </div>
            </div>
          )
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
              {graph.edges.map((edge) => {
                const a = graphIndex.get(edge.source),
                  b = graphIndex.get(edge.target);
                return a && b ? (
                  <line
                    key={edge.id}
                    x1={a.x}
                    y1={a.y}
                    x2={b.x}
                    y2={b.y}
                    className={edge.kind}
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
                  aria-label={`${node.label}, CL ${node.changelistId}`}
                  className={selection.isSelected(node) ? "selected" : ""}
                  transform={`translate(${node.x},${node.y})`}
                  onClick={(event) => {
                    selection.select(node, event);
                    setSelectedNode(node.id);
                  }}
                  onKeyDownCapture={(event) => {
                    if (selection.keyboard(node, event))
                      setSelectedNode(node.id);
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
                      "复制 CL 编号": copy(node.changelistId),
                      复制所选修订标识: copy(
                        selection
                          .targets(node)
                          .map((n) => `${n.depotPath}#${n.revision}`)
                          .join("\n"),
                      ),
                    }),
                    {
                      onOpen: () => {
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
                    CL {node.changelistId}
                  </text>
                </g>
              ))}
            </svg>
            <div className="graph-actions">
              <button
                disabled={!selected || selected.missing}
                onClick={() => {
                  if (!selected) return;
                  const pair = graphNodeDiffPair(selected);
                  if (!pair) return;
                  const operationId = crypto.randomUUID();
                  void backend
                    .getDiff({
                      scope: makeReviewScope(runtime, selected.depotPath),
                      ...pair,
                      operationId,
                    })
                    .then(setNodeDiff)
                    .catch((cause) => setError(String(cause)));
                }}
              >
                {zh ? "比较所选版本与上一版" : "Diff selected against previous"}
              </button>
              {graph.hasMore && graphCursor && (
                <button
                  disabled={loading}
                  onClick={() => {
                    const operationId = crypto.randomUUID();
                    setLoading(true);
                    void backend
                      .getRevisionGraph({
                        scope: makeReviewScope(runtime, queryPath),
                        revisionLimit: 100,
                        cursor: graphCursor,
                        operationId,
                      })
                      .then((result) => {
                        setData(result);
                        setGraphCursor(result.nextCursor);
                      })
                      .catch((cause) => setError(String(cause)))
                      .finally(() => setLoading(false));
                  }}
                >
                  {zh ? "展开更多版本" : "Expand more revisions"}
                </button>
              )}
            </div>
            {nodeDiff && (
              <pre
                className="graph-node-diff"
                aria-label={zh ? "节点差异" : "Node diff"}
              >
                {nodeDiff.unified ||
                  nodeDiff.reason ||
                  (zh ? "无差异" : "No differences")}
              </pre>
            )}
          </div>
        )}
        {textSelection.dialog}
        <footer className="review-footer">
          {selected
            ? `${selected.depotPath}#${selected.revision} · CL ${selected.changelistId}`
            : queryPath || "—"}
        </footer>
      </section>
    </main>
  );
}

function ReferenceSelector({
  label,
  value,
  onChange,
}: {
  label: string;
  value: RevisionReference;
  onChange(value: RevisionReference): void;
}) {
  return (
    <label>
      <span>{label}</span>
      <select
        aria-label={`${label} reference`}
        value={value.kind}
        onChange={(event) => {
          const kind = event.target.value as RevisionReference["kind"];
          onChange(
            kind === "revision"
              ? {
                  kind,
                  revision: value.kind === "revision" ? value.revision : 1,
                }
              : { kind },
          );
        }}
      >
        <option value="workspace">Workspace</option>
        <option value="have">Have</option>
        <option value="head">Head</option>
        <option value="revision">Revision</option>
      </select>
      {value.kind === "revision" && (
        <input
          aria-label={`${label} revision number`}
          type="number"
          min={1}
          step={1}
          value={value.revision}
          onChange={(event) =>
            onChange({
              kind: "revision",
              revision: Math.max(1, Number(event.target.value) || 1),
            })
          }
        />
      )}
    </label>
  );
}
