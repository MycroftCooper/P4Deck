import { t } from "../../../shared/i18n";
import type { RevisionGraph } from "../../../shared/contracts";
import {
  focusEvidence,
  GRAPH_BUDGET,
  GRAPH_DEPTH,
  validGraphPath,
  type GraphFocusMode,
} from "../graphFocus";

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
  onInvestigate,
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
  onInvestigate(): void;
  loading: boolean;
  reads: number;
  updatedAt: number;
  stale: boolean;
  zh: boolean;
}) {
  const index = new Map(graph.nodes.map((n) => [n.id, n]));
  return (
    <div className="graph-focus-panel">
      <button disabled={loading || !sourceId} onClick={onInvestigate}>
        {t("browse.branch.cl.investigation")}
      </button>
      <div className="graph-focus-controls">
        <label>
          {t("browse.mode")}
          <select
            value={mode}
            onChange={(e) => onMode(e.target.value as GraphFocusMode)}
          >
            <option value="target">{t("browse.trace.to.target")}</option>
            <option value="sources">{t("browse.trace.origins")}</option>
          </select>
        </label>
        <label>
          {t("browse.selected.file.revision")}
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
            {t("browse.full.file.path.in.target")}
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
                {t("browse.read.target")}
              </button>
            </div>
          </label>
        )}
      </div>
      <div className="graph-evidence" role="status">
        <strong>
          {!sourceId
            ? t("browse.select.a.revision")
            : mode === "target" && !target
              ? t("browse.enter.a.target.file")
              : evidence.edges.length
                ? t(
                    "browse.integration.records.found.current.content.inclusion",
                  )
                : t("browse.unknown.no.path.in.loaded.records")}
        </strong>
        <span>{t("browse.this.file.only.not.the.whole")}</span>
        <span>
          {stale
            ? t("browse.stale.cache.freshness.unverified")
            : t("browse.recent.snapshot")}{" "}
          ·{" "}
          {updatedAt
            ? new Date(updatedAt).toLocaleString(zh ? "zh-CN" : "en-US")
            : "—"}{" "}
          · {t("browse.read.attempts")} {reads}/{GRAPH_BUDGET} ·{" "}
          {t("browse.depth.limit")} {GRAPH_DEPTH}
        </span>
        {(evidence.incomplete || evidence.caution) && (
          <span>
            {t("browse.incomplete.evidence.or.actions.requiring.review")}
          </span>
        )}
        <details>
          <summary>
            {t("browse.inspect.evidence")} ({evidence.edges.length})
          </summary>
          <ul>
            {evidence.edges.map((e) => {
              const a = index.get(e.source),
                b = index.get(e.target);
              return (
                <li key={e.id}>
                  {a?.depotPath}#{a?.revision} → {b?.depotPath}#{b?.revision} ·
                  CL {b?.changelistId || "?"} · {e.relationship} ·{" "}
                  {t("browse.related.file.range")} ({e.startRevision ?? "?"},{" "}
                  {e.endRevision ?? "?"}]
                </li>
              );
            })}
          </ul>
        </details>
      </div>
      <details className="graph-lane-picker">
        <summary>
          {t("browse.visible.lanes")} ({visible.size}/{paths.length})
        </summary>
        <button onClick={() => solo()}>
          {t("browse.restore.query.focus")}
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
              title={t("browse.show.only.this.lane")}
            >
              Solo
            </button>
          </div>
        ))}
      </details>
    </div>
  );
}
