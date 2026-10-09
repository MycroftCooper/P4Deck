import { useCallback, useEffect, useRef, useState } from "react";
import { Copy, Download, RefreshCw } from "lucide-react";
import { backend } from "../../../infrastructure/backend";
import type {
  CacheDiagnostics,
  DiagnosticExportResult,
} from "../../../shared/contracts/types";

interface Props {
  zh: boolean;
  connectionKey: string;
  native: boolean;
}

function bytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / 1024 / 1024).toFixed(1)} MiB`;
}

export function DiagnosticsView({ zh, connectionKey, native }: Props) {
  const [cache, setCache] = useState<CacheDiagnostics>();
  const [cacheError, setCacheError] = useState("");
  const [cacheBusy, setCacheBusy] = useState(false);
  const [exportBusy, setExportBusy] = useState(false);
  const [exportResult, setExportResult] = useState<DiagnosticExportResult>();
  const [exportStatus, setExportStatus] = useState("");
  const generation = useRef(0);

  const refresh = useCallback(async () => {
    const request = ++generation.current;
    setCacheBusy(true);
    setCacheError("");
    try {
      const value = await backend.statusCacheDiagnostics();
      if (request === generation.current) setCache(value);
    } catch (cause) {
      if (request === generation.current) setCacheError(String(cause));
    } finally {
      if (request === generation.current) setCacheBusy(false);
    }
  }, []);

  useEffect(() => {
    generation.current += 1;
    setCache(undefined);
    setExportResult(undefined);
    setExportStatus("");
    void refresh();
    return () => void ++generation.current;
  }, [connectionKey, refresh]);

  async function exportDiagnostics() {
    if (exportBusy) return;
    setExportBusy(true);
    setExportResult(undefined);
    setExportStatus(
      zh ? "正在导出脱敏诊断…" : "Exporting redacted diagnostics…",
    );
    try {
      const result = await backend.exportDiagnostics({});
      setExportResult(result);
      setExportStatus(
        result.simulated
          ? zh
            ? "Mock 模拟完成；未写入文件。"
            : "Mock simulation complete; no file was written."
          : zh
            ? "诊断导出完成。"
            : "Diagnostic export completed.",
      );
    } catch (cause) {
      setExportStatus(
        `${zh ? "导出失败：" : "Export failed: "}${String(cause)}`,
      );
    } finally {
      setExportBusy(false);
    }
  }

  const requests = (cache?.hits ?? 0) + (cache?.misses ?? 0);
  const hitRate = requests
    ? `${(((cache?.hits ?? 0) / requests) * 100).toFixed(1)}%`
    : "—";

  return (
    <div className="diagnostic-view diagnostics-view">
      {!native && (
        <div className="mock-disclosure" role="note">
          {zh
            ? "浏览器 Mock：指标和导出均为本地模拟，不访问 P4 Server，也不会创建诊断文件。"
            : "Browser Mock: metrics and export are local simulations; no P4 Server is contacted and no diagnostic file is created."}
        </div>
      )}
      <section aria-labelledby="cache-heading" className="diagnostic-card">
        <header>
          <div>
            <h3 id="cache-heading">
              {zh ? "状态缓存诊断" : "Status cache diagnostics"}
            </h3>
            <p>
              {zh
                ? "仅展示后端实际提供的累计计数与当前占用。"
                : "Only backend-provided cumulative counters and current usage are shown."}
            </p>
          </div>
          <button onClick={() => void refresh()} disabled={cacheBusy}>
            <RefreshCw size={13} /> {zh ? "刷新" : "Refresh"}
          </button>
        </header>
        {cache && (
          <dl className="metric-grid">
            <div>
              <dt>{zh ? "命中 / 未命中" : "Hits / misses"}</dt>
              <dd>
                {cache.hits} / {cache.misses}
              </dd>
            </div>
            <div>
              <dt>{zh ? "命中率（推导）" : "Hit rate (derived)"}</dt>
              <dd>{hitRate}</dd>
            </div>
            <div>
              <dt>{zh ? "当前条目" : "Current entries"}</dt>
              <dd>{cache.entries}</dd>
            </div>
            <div>
              <dt>{zh ? "估算占用" : "Estimated usage"}</dt>
              <dd>{bytes(cache.estimatedBytes)}</dd>
            </div>
            <div>
              <dt>{zh ? "离线 stale 回退" : "Offline stale fallbacks"}</dt>
              <dd>{cache.staleFallbacks}</dd>
            </div>
            <div>
              <dt>{zh ? "淘汰 / 失效" : "Evicted / invalidated"}</dt>
              <dd>
                {cache.evicted} / {cache.invalidated}
              </dd>
            </div>
            <div>
              <dt>{zh ? "合并请求" : "Coalesced requests"}</dt>
              <dd>{cache.coalesced}</dd>
            </div>
            <div>
              <dt>{zh ? "过时代次响应" : "Superseded responses"}</dt>
              <dd>{cache.superseded}</dd>
            </div>
            <div>
              <dt>{zh ? "加载次数 / 总耗时" : "Loads / total time"}</dt>
              <dd>
                {cache.loadCount} / {cache.totalLoadMs} ms
              </dd>
            </div>
          </dl>
        )}
        {cacheBusy && (
          <div role="status" aria-live="polite">
            {zh ? "正在刷新缓存指标…" : "Refreshing cache metrics…"}
          </div>
        )}
        {cacheError && (
          <div className="inline-error" role="alert">
            {cacheError}{" "}
            <button onClick={() => void refresh()}>
              {zh ? "重试" : "Retry"}
            </button>
          </div>
        )}
      </section>

      <section aria-labelledby="export-heading" className="diagnostic-card">
        <header>
          <div>
            <h3 id="export-heading">{zh ? "诊断导出" : "Diagnostic export"}</h3>
            <p>
              {zh
                ? "后端生成受控大小的脱敏 JSON；不包含密码、ticket、完整 fingerprint 或原始环境变量。"
                : "The backend produces a size-bounded redacted JSON file without passwords, tickets, full fingerprints, or raw environment variables."}
            </p>
          </div>
          <button
            onClick={() => void exportDiagnostics()}
            disabled={exportBusy}
          >
            <Download size={13} /> {zh ? "导出" : "Export"}
          </button>
        </header>
        {exportResult && (
          <div className="export-result">
            <code>{exportResult.path}</code>
            <span>
              {bytes(exportResult.sizeBytes)}
              {exportResult.truncated
                ? zh
                  ? " · 已截断"
                  : " · truncated"
                : ""}
            </span>
            {!exportResult.simulated && (
              <button
                onClick={() =>
                  void navigator.clipboard.writeText(exportResult.path)
                }
              >
                <Copy size={13} /> {zh ? "复制路径" : "Copy path"}
              </button>
            )}
          </div>
        )}
        <p className="policy-boundary">
          {zh
            ? "当前安全打开能力仅允许 Workspace 内路径，因此不会用它打开诊断导出目录。"
            : "The existing safe-open capability only permits Workspace paths, so it is not used for the diagnostics export directory."}
        </p>
        <div className="sr-status" role="status" aria-live="polite">
          {exportStatus}
        </div>
      </section>
    </div>
  );
}
