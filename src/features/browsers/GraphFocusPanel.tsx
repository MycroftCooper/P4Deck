import type { RevisionGraph } from "../../shared/contracts/types";
import {
  focusEvidence,
  GRAPH_BUDGET,
  GRAPH_DEPTH,
  validGraphPath,
  type GraphFocusMode,
} from "./graphFocus";

export function GraphFocusPanel({
  graph,
  sourceId,
  onSource,
  target,
  onTarget,
  mode,
  onMode,
  evidence,
  paths,
  visible,
  toggle,
  solo,
  onRead,
  loading,
  reads,
  updatedAt,
  stale,
  zh,
}: {
  graph: RevisionGraph;
  sourceId: string;
  onSource(id: string): void;
  target: string;
  onTarget(value: string): void;
  mode: GraphFocusMode;
  onMode(mode: GraphFocusMode): void;
  evidence: ReturnType<typeof focusEvidence>;
  paths: string[];
  visible: Set<string>;
  toggle(path: string): void;
  solo(path?: string): void;
  onRead(): void;
  loading: boolean;
  reads: number;
  updatedAt: number;
  stale: boolean;
  zh: boolean;
}) {
  const tr = (cn: string, en: string) => (zh ? cn : en);
  const index = new Map(graph.nodes.map((n) => [n.id, n]));
  return (
    <div className="graph-focus-panel">
      <div className="graph-focus-controls">
        <label>
          {tr("模式", "Mode")}
          <select
            value={mode}
            onChange={(e) => onMode(e.target.value as GraphFocusMode)}
          >
            <option value="target">
              {tr("目标合入查询", "Trace to target")}
            </option>
            <option value="sources">{tr("来源追溯", "Trace origins")}</option>
          </select>
        </label>
        <label>
          {tr("选定文件版本", "Selected file revision")}
          <select value={sourceId} onChange={(e) => onSource(e.target.value)}>
            {graph.nodes.map((n) => (
              <option key={n.id} value={n.id}>
                {n.depotPath}#{n.revision} · CL {n.changelistId}
              </option>
            ))}
          </select>
        </label>
        {mode === "target" && (
          <label>
            {tr("目标分支中的完整文件路径", "Full file path in target branch")}
            <div className="graph-target-input">
              <input
                value={target}
                placeholder="//depot/branch/file"
                onChange={(e) => onTarget(e.target.value)}
                onKeyDown={(e) => {
                  if (
                    e.key === "Enter" &&
                    validGraphPath(target) &&
                    !loading &&
                    reads < GRAPH_BUDGET
                  )
                    onRead();
                }}
              />
              <button
                disabled={
                  !validGraphPath(target) || loading || reads >= GRAPH_BUDGET
                }
                onClick={onRead}
              >
                {tr("查询目标", "Read target")}
              </button>
            </div>
          </label>
        )}
      </div>
      <div className="graph-evidence" role="status">
        <strong>
          {!sourceId
            ? tr("请选择版本", "Select a revision")
            : mode === "target" && !target
              ? tr("输入目标文件后查询", "Enter a target file")
              : evidence.edges.length
                ? tr(
                    "发现集成记录路径；内容是否仍包含：未知",
                    "Integration records found; current content inclusion: unknown",
                  )
                : tr(
                    "未知：当前记录中未找到路径，不代表未合入",
                    "Unknown: no path in loaded records; this does not prove absence",
                  )}
        </strong>
        <span>
          {tr(
            "仅此文件，不代表整个 CL；忽略、回退和部分解决可能改变最终内容。",
            "This file only, not the whole CL; ignored integrations, undo and partial resolves can change final content.",
          )}
        </span>
        <span>
          {stale
            ? tr("旧缓存 / 新鲜度未确认", "Stale cache / freshness unverified")
            : tr("近期快照", "Recent snapshot")}{" "}
          ·{" "}
          {updatedAt
            ? new Date(updatedAt).toLocaleString(zh ? "zh-CN" : "en-US")
            : "—"}{" "}
          · {tr("读取尝试", "Read attempts")} {reads}/{GRAPH_BUDGET} ·{" "}
          {tr("追溯深度上限", "Depth limit")} {GRAPH_DEPTH}
        </span>
        {(evidence.incomplete || evidence.caution) && (
          <span>
            {tr(
              "证据不完整或含需复核动作；请按需展开并检查范围。",
              "Incomplete evidence or actions requiring review; expand on demand and inspect ranges.",
            )}
          </span>
        )}
        <details>
          <summary>
            {tr("查看原始证据", "Inspect evidence")} ({evidence.edges.length})
          </summary>
          <ul>
            {evidence.edges.map((e) => {
              const a = index.get(e.source),
                b = index.get(e.target);
              return (
                <li key={e.id}>
                  {a?.depotPath}#{a?.revision} → {b?.depotPath}#{b?.revision} ·
                  CL {b?.changelistId || "?"} · {e.relationship} ·{" "}
                  {tr("关联文件范围", "Related-file range")} (
                  {e.startRevision ?? "?"}, {e.endRevision ?? "?"}]
                </li>
              );
            })}
          </ul>
        </details>
      </div>
      <details className="graph-lane-picker">
        <summary>
          {tr("显示轨道", "Visible lanes")} ({visible.size}/{paths.length})
        </summary>
        <button onClick={() => solo()}>
          {tr("恢复查询聚焦", "Restore query focus")}
        </button>
        {paths.map((path) => (
          <div key={path}>
            <label>
              <input
                type="checkbox"
                checked={visible.has(path)}
                onChange={() => toggle(path)}
              />
              {path}
            </label>
            <button
              onClick={() => solo(path)}
              title={tr("只显示此轨道", "Show only this lane")}
            >
              Solo
            </button>
          </div>
        ))}
      </details>
    </div>
  );
}
