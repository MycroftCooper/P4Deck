import { tFor } from "../../../shared/i18n";
import { useCallback, useEffect, useState } from "react";
import { Copy, Download, RefreshCw } from "lucide-react";
import { backend } from "../../../infrastructure/backend";
import { useOperationSession } from "../../../shared/operationSession";
import type {
  CacheDiagnostics,
  DiagnosticExportResult,
} from "../../../shared/contracts";
import type { ConnectionSnapshot } from "../../companySubmit/model";
import {
  lookupControlPlaneAction,
  type ControlPlaneActionLookup,
} from "../../actions/workflowReceipt";
import {
  controlPlaneCommitted,
  controlPlaneDetails,
  controlPlaneLegacy,
  runControlPlaneAction,
} from "../../settings/controlPlaneLifecycle";

interface Props {
  zh: boolean;
  connectionKey: string;
  native: boolean;
  /** Exact dispatching connection snapshot; captured once per export. */
  connection?(): Promise<ConnectionSnapshot>;
  /** Durable receipt recovery by the SAME operationId. */
  lookup?(request: {
    operationId: string;
    connection: ConnectionSnapshot;
  }): Promise<ControlPlaneActionLookup>;
}

function bytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / 1024 / 1024).toFixed(1)} MiB`;
}

export function DiagnosticsView({
  zh,
  connectionKey,
  native,
  connection: connectionProvider,
  lookup: lookupReceipt,
}: Props) {
  const [cache, setCache] = useState<CacheDiagnostics>();
  const [cacheError, setCacheError] = useState("");
  const [cacheBusy, setCacheBusy] = useState(false);
  const [exportBusy, setExportBusy] = useState(false);
  const [exportResult, setExportResult] = useState<DiagnosticExportResult>();
  const [exportStatus, setExportStatus] = useState("");
  /**
   * One channel for the cache readback. Each refresh or invalidation (connection
   * change, unmount) retires the previous lease, so a late answer can never
   * paint the view it no longer belongs to.
   */
  const session = useOperationSession();
  const CACHE = "diagnostics-cache";

  const refresh = useCallback(async () => {
    // The read is local and idempotent: cancel it locally only, never ask the
    // host to cancel a diagnostics readback.
    const lease = session.start(CACHE, { cancelBackend: false });
    setCacheBusy(true);
    setCacheError("");
    try {
      const value = await backend.statusCacheDiagnostics();
      if (!session.isCurrent(lease)) return;
      setCache(value);
    } catch (cause) {
      if (!session.isCurrent(lease)) return;
      setCacheError(String(cause));
    } finally {
      // Clear the busy flag BEFORE retiring the lease: `finish` makes the lease
      // non-current, so it can no longer gate this update.
      if (session.isCurrent(lease)) setCacheBusy(false);
      session.finish(lease);
    }
  }, [session]);

  useEffect(() => {
    session.invalidate(CACHE);
    setCache(undefined);
    setExportResult(undefined);
    setExportStatus("");
    void refresh();
    return () => session.invalidate(CACHE);
  }, [connectionKey, refresh, session]);

  async function exportDiagnostics() {
    if (exportBusy) return;
    setExportBusy(true);
    setExportResult(undefined);
    setExportStatus(
      tFor(zh ? "zh-CN" : "en-US", "tools.exporting.redacted.diagnostics"),
    );
    const operationId = crypto.randomUUID();
    try {
      const dispatching = await (
        connectionProvider ?? (() => backend.companySubmitConnectionSnapshot())
      )();
      const run = await runControlPlaneAction({
        kind: "diagnosticsExport",
        operationId,
        connection: dispatching,
        execute: () => backend.exportDiagnostics({ request: {}, operationId }),
        lookup: lookupReceipt ?? lookupControlPlaneAction,
      });
      const result = run.result;
      if (controlPlaneCommitted(result)) {
        const artifact = result.artifact;
        const details = controlPlaneDetails<{
          truncated?: boolean;
          format?: string;
          simulated?: boolean;
        }>(result);
        setExportResult({
          path: artifact.path ?? "—",
          sizeBytes: artifact.sizeBytes,
          truncated: details?.truncated === true,
          format: "json",
        });
        setExportStatus(
          tFor(
            zh ? "zh-CN" : "en-US",
            "tools.diagnostic.export.verified.by.readback",
          ),
        );
      } else if (result.state === "legacy") {
        const legacy = controlPlaneLegacy<DiagnosticExportResult>(result);
        if (legacy) setExportResult(legacy);
        setExportStatus(
          legacy?.simulated
            ? tFor(
                zh ? "zh-CN" : "en-US",
                "tools.mock.simulation.complete.no.file",
              )
            : tFor(
                zh ? "zh-CN" : "en-US",
                "tools.diagnostic.export.completed.legacy.result",
              ),
        );
      } else {
        setExportStatus(
          tFor(
            zh ? "zh-CN" : "en-US",
            "tools.export.outcome.uncertain.the.file",
          ),
        );
      }
    } catch (cause) {
      setExportStatus(
        `${tFor(zh ? "zh-CN" : "en-US", "tools.export.failed")}${String(cause)}`,
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
          {tFor(
            zh ? "zh-CN" : "en-US",
            "tools.browser.mock.metrics.and.export",
          )}
        </div>
      )}
      <section aria-labelledby="cache-heading" className="diagnostic-card">
        <header>
          <div>
            <h3 id="cache-heading">
              {tFor(zh ? "zh-CN" : "en-US", "tools.status.cache.diagnostics")}
            </h3>
            <p>
              {tFor(
                zh ? "zh-CN" : "en-US",
                "tools.only.backend.provided.cumulative.counters",
              )}
            </p>
          </div>
          <button onClick={() => void refresh()} disabled={cacheBusy}>
            <RefreshCw size={13} />{" "}
            {tFor(zh ? "zh-CN" : "en-US", "tools.refresh")}
          </button>
        </header>
        {cache && (
          <dl className="metric-grid">
            <div>
              <dt>{tFor(zh ? "zh-CN" : "en-US", "tools.hits.misses")}</dt>
              <dd>
                {cache.hits} / {cache.misses}
              </dd>
            </div>
            <div>
              <dt>{tFor(zh ? "zh-CN" : "en-US", "tools.hit.rate.derived")}</dt>
              <dd>{hitRate}</dd>
            </div>
            <div>
              <dt>{tFor(zh ? "zh-CN" : "en-US", "tools.current.entries")}</dt>
              <dd>{cache.entries}</dd>
            </div>
            <div>
              <dt>{tFor(zh ? "zh-CN" : "en-US", "tools.estimated.usage")}</dt>
              <dd>{bytes(cache.estimatedBytes)}</dd>
            </div>
            <div>
              <dt>
                {tFor(zh ? "zh-CN" : "en-US", "tools.offline.stale.fallbacks")}
              </dt>
              <dd>{cache.staleFallbacks}</dd>
            </div>
            <div>
              <dt>
                {tFor(zh ? "zh-CN" : "en-US", "tools.evicted.invalidated")}
              </dt>
              <dd>
                {cache.evicted} / {cache.invalidated}
              </dd>
            </div>
            <div>
              <dt>
                {tFor(zh ? "zh-CN" : "en-US", "tools.coalesced.requests")}
              </dt>
              <dd>{cache.coalesced}</dd>
            </div>
            <div>
              <dt>
                {tFor(zh ? "zh-CN" : "en-US", "tools.superseded.responses")}
              </dt>
              <dd>{cache.superseded}</dd>
            </div>
            <div>
              <dt>{tFor(zh ? "zh-CN" : "en-US", "tools.loads.total.time")}</dt>
              <dd>
                {cache.loadCount} / {cache.totalLoadMs} ms
              </dd>
            </div>
          </dl>
        )}
        {cacheBusy && (
          <div role="status" aria-live="polite">
            {tFor(zh ? "zh-CN" : "en-US", "tools.refreshing.cache.metrics")}
          </div>
        )}
        {cacheError && (
          <div className="inline-error" role="alert">
            {cacheError}{" "}
            <button onClick={() => void refresh()}>
              {tFor(zh ? "zh-CN" : "en-US", "tools.retry")}
            </button>
          </div>
        )}
      </section>

      <section aria-labelledby="export-heading" className="diagnostic-card">
        <header>
          <div>
            <h3 id="export-heading">
              {tFor(zh ? "zh-CN" : "en-US", "tools.diagnostic.export")}
            </h3>
            <p>
              {tFor(
                zh ? "zh-CN" : "en-US",
                "tools.the.backend.produces.a.size",
              )}
            </p>
          </div>
          <button
            onClick={() => void exportDiagnostics()}
            disabled={exportBusy}
          >
            <Download size={13} />{" "}
            {tFor(zh ? "zh-CN" : "en-US", "tools.export")}
          </button>
        </header>
        {exportResult && (
          <div className="export-result">
            <code>{exportResult.path}</code>
            <span>
              {bytes(exportResult.sizeBytes)}
              {exportResult.truncated
                ? tFor(zh ? "zh-CN" : "en-US", "tools.truncated")
                : ""}
            </span>
            {!exportResult.simulated && (
              <button
                onClick={() =>
                  void navigator.clipboard.writeText(exportResult.path)
                }
              >
                <Copy size={13} />{" "}
                {tFor(zh ? "zh-CN" : "en-US", "tools.copy.path")}
              </button>
            )}
          </div>
        )}
        <p className="policy-boundary">
          {tFor(
            zh ? "zh-CN" : "en-US",
            "tools.the.existing.safe.open.capability",
          )}
        </p>
        <div className="sr-status" role="status" aria-live="polite">
          {exportStatus}
        </div>
      </section>
    </div>
  );
}
