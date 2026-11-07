import { tFor } from "../../../shared/i18n";
import { formatLocalTime } from "../../../shared/lib/localTime";
import { ResizableTable } from "../../../app/context-menu/ResizableTable";
import { useCallback, useEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Copy, RefreshCw } from "lucide-react";
import { backend } from "../../../infrastructure/backend";
import { useOperationSession } from "../../../shared/operationSession";
import { LOG_LEVELS, logLevelLabel } from "../logLevels";
import type {
  LogEntry,
  LogLevel,
  LogPolicy,
  OperationSource,
} from "../../../shared/contracts";
import { storage } from "../../../shared/lib/storage";
import { readLogViewPreferences } from "../logPreferences";
import { subscribeSafely } from "../../../shared/lib/subscription";
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

const PAGE_SIZE = 100;

interface Props {
  zh: boolean;
  connectionKey: string;
  refreshKey: number;
  operationFilter?: string;
  onOperationFilter(value?: string): void;
  onOpenJournal(operationId: string): void;
  /** Exact dispatching connection snapshot; captured once per policy save. */
  connection?(): Promise<ConnectionSnapshot>;
  /** Durable receipt recovery by the SAME operationId. */
  lookup?(request: {
    operationId: string;
    connection: ConnectionSnapshot;
  }): Promise<ControlPlaneActionLookup>;
}

export function LogView({
  zh,
  connectionKey,
  refreshKey,
  operationFilter,
  onOperationFilter,
  onOpenJournal,
  connection: connectionProvider,
  lookup: lookupReceipt,
}: Props) {
  const saved = useRef(
    readLogViewPreferences(storage.getItem("p4deck.p4Log.view.v1")),
  );
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [nextCursor, setNextCursor] = useState<string>();
  const [keyword, setKeyword] = useState("");
  const [level, setLevel] = useState<LogLevel | "">(saved.current.level);
  const [source, setSource] = useState<OperationSource | "">(
    saved.current.source,
  );
  const [followTail, setFollowTail] = useState(saved.current.followTail);
  const [command, setCommand] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [appendError, setAppendError] = useState("");
  const [policy, setPolicy] = useState<LogPolicy>();
  const [draft, setDraft] = useState<LogPolicy>();
  const [policyBusy, setPolicyBusy] = useState(false);
  const [policyStatus, setPolicyStatus] = useState("");
  /**
   * Two independent channels: the log page reads and the policy readback. Each
   * new request or invalidation retires the previous one, so a late answer can
   * never paint the view it no longer belongs to.
   */
  const session = useOperationSession();
  const LOGS = "logs",
    POLICY = "logs-policy";
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 58,
    overscan: 8,
    initialRect: { width: 900, height: 480 },
  });
  const measuredRows = virtualizer.getVirtualItems();
  const virtualRows = measuredRows.length
    ? measuredRows
    : Array.from({ length: Math.min(entries.length, 24) }, (_, index) => ({
        index,
        key: entries[index].id,
        start: index * 58,
        size: 58,
        end: (index + 1) * 58,
        lane: 0,
      }));
  const totalSize = virtualizer.getTotalSize() || entries.length * 58;
  const paddingTop = virtualRows.length ? virtualRows[0].start : 0;
  const paddingBottom = virtualRows.length
    ? totalSize - virtualRows.at(-1)!.end
    : 0;

  useEffect(() => {
    storage.setItem(
      "p4deck.p4Log.view.v1",
      JSON.stringify({ level, source, followTail }),
    );
  }, [followTail, level, source]);

  useEffect(() => {
    if (followTail && entries.length)
      scrollRef.current?.scrollTo?.({ top: scrollRef.current.scrollHeight });
  }, [entries.length, followTail]);

  const load = useCallback(
    async (cursor?: string) => {
      // Reading the epoch before the request makes a supersede or an
      // invalidation (connection, refresh, clear, unmount) visible below.
      const review = session.epoch(LOGS);
      const isCurrent = () => review === session.epoch(LOGS);
      setLoading(true);
      if (cursor) setAppendError("");
      else setError("");
      try {
        const page = await backend.queryLogPage({
          keyword: keyword.trim() || undefined,
          levels: level ? [level] : undefined,
          sources: source ? [source] : undefined,
          command: command.trim() || undefined,
          operationId: operationFilter,
          cursor,
          limit: PAGE_SIZE,
        });
        if (!isCurrent()) return;
        setEntries((current) => {
          const incoming = cursor
            ? [...current, ...page.entries]
            : page.entries;
          return incoming.filter(
            (entry, index) =>
              incoming.findIndex((candidate) => candidate.id === entry.id) ===
              index,
          );
        });
        setNextCursor(page.nextCursor);
      } catch (cause) {
        if (!isCurrent()) return;
        if (cursor) setAppendError(String(cause));
        else {
          setEntries([]);
          setNextCursor(undefined);
          setError(String(cause));
        }
      } finally {
        if (isCurrent()) setLoading(false);
      }
    },
    [command, keyword, level, operationFilter, session, source],
  );

  useEffect(() => {
    session.invalidate(LOGS);
    setEntries([]);
    setNextCursor(undefined);
    void load();
    return () => session.invalidate(LOGS);
  }, [connectionKey, load, refreshKey, session]);

  useEffect(
    () =>
      subscribeSafely(
        () =>
          backend.subscribeLogsCleared(() => {
            session.invalidate(LOGS);
            setEntries([]);
            setNextCursor(undefined);
            void load();
          }),
        (cause) => setError(String(cause)),
      ),
    [load, session],
  );

  useEffect(() => {
    const review = session.epoch(POLICY);
    setPolicy(undefined);
    setDraft(undefined);
    setPolicyStatus("");
    void backend
      .getLogPolicy()
      .then((value) => {
        if (review !== session.epoch(POLICY)) return;
        setPolicy(value);
        setDraft(value);
      })
      .catch((cause) => {
        if (review === session.epoch(POLICY)) setPolicyStatus(String(cause));
      });
    return () => session.invalidate(POLICY);
  }, [connectionKey, session]);

  async function savePolicy() {
    if (!draft || policyBusy) return;
    if (
      !Number.isInteger(draft.retentionDays) ||
      draft.retentionDays < 1 ||
      draft.retentionDays > 30 ||
      !Number.isInteger(draft.maxMib) ||
      draft.maxMib < 5 ||
      draft.maxMib > 50
    ) {
      setPolicyStatus(
        tFor(zh ? "zh-CN" : "en-US", "tools.retention.must.be.1.30"),
      );
      return;
    }
    setPolicyBusy(true);
    setPolicyStatus(tFor(zh ? "zh-CN" : "en-US", "tools.saving"));
    const operationId = crypto.randomUUID();
    try {
      const dispatching = await (
        connectionProvider ?? (() => backend.companySubmitConnectionSnapshot())
      )();
      const run = await runControlPlaneAction({
        kind: "logPolicySet",
        operationId,
        connection: dispatching,
        execute: () => backend.setLogPolicy({ policy: draft, operationId }),
        lookup: lookupReceipt ?? lookupControlPlaneAction,
      });
      const result = run.result;
      if (controlPlaneCommitted(result)) {
        const readback = controlPlaneDetails<LogPolicy>(result) ?? draft;
        setPolicy(readback);
        setDraft(readback);
        setPolicyStatus(
          tFor(
            zh ? "zh-CN" : "en-US",
            "tools.log.policy.saved.readback.matches",
          ),
        );
      } else if (result.state === "legacy") {
        const savedLegacy = controlPlaneLegacy<LogPolicy>(result) ?? draft;
        setPolicy(savedLegacy);
        setDraft(savedLegacy);
        setPolicyStatus(tFor(zh ? "zh-CN" : "en-US", "tools.log.policy.saved"));
      } else {
        // Uncertain: never show "saved"; restore the last known policy and be explicit.
        setDraft(policy);
        setPolicyStatus(
          tFor(
            zh ? "zh-CN" : "en-US",
            "tools.save.outcome.uncertain.the.readback",
          ),
        );
      }
    } catch (cause) {
      setDraft(policy);
      setPolicyStatus(
        `${tFor(zh ? "zh-CN" : "en-US", "tools.save.failed.previous.policy.restored")}${String(cause)}`,
      );
    } finally {
      setPolicyBusy(false);
    }
  }

  return (
    <div className="diagnostic-view log-view">
      <div
        className="diagnostic-toolbar log-toolbar"
        aria-label={tFor(zh ? "zh-CN" : "en-US", "tools.log.filters")}
      >
        <span className="muted">
          {tFor(zh ? "zh-CN" : "en-US", "tools.current.session.logs")}
        </span>
        <input
          className="log-search"
          aria-label={tFor(zh ? "zh-CN" : "en-US", "tools.search.logs")}
          value={keyword}
          placeholder={tFor(zh ? "zh-CN" : "en-US", "tools.message.or.command")}
          onChange={(event) => setKeyword(event.target.value)}
        />
        <select
          aria-label={tFor(zh ? "zh-CN" : "en-US", "tools.log.level")}
          value={level}
          onChange={(event) => setLevel(event.target.value as LogLevel | "")}
        >
          <option value="">
            {tFor(zh ? "zh-CN" : "en-US", "tools.all.levels")}
          </option>
          {LOG_LEVELS.map((value) => (
            <option key={value} value={value}>
              {logLevelLabel(value, zh)}
            </option>
          ))}
        </select>
        <select
          aria-label={tFor(zh ? "zh-CN" : "en-US", "tools.log.source")}
          value={source}
          onChange={(event) =>
            setSource(event.target.value as OperationSource | "")
          }
        >
          <option value="">
            {tFor(zh ? "zh-CN" : "en-US", "tools.all.sources")}
          </option>
          <option value="gui">GUI</option>
          <option value="terminal">Terminal</option>
        </select>
        <input
          className="log-command"
          aria-label={tFor(zh ? "zh-CN" : "en-US", "tools.command.or.category")}
          value={command}
          placeholder={tFor(zh ? "zh-CN" : "en-US", "tools.command.category")}
          onChange={(event) => setCommand(event.target.value)}
        />
        <button onClick={() => void load()} disabled={loading}>
          <RefreshCw size={13} />{" "}
          {tFor(zh ? "zh-CN" : "en-US", "tools.apply.refresh")}
        </button>
        <button
          onClick={() => {
            // Clearing the view retires the read it was showing.
            session.invalidate(LOGS);
            setEntries([]);
            setNextCursor(undefined);
            setLoading(false);
            setError("");
            setAppendError("");
          }}
        >
          {tFor(zh ? "zh-CN" : "en-US", "tools.clear.view")}
        </button>
        <label className="check-field log-follow-tail">
          <input
            type="checkbox"
            checked={followTail}
            onChange={(event) => setFollowTail(event.target.checked)}
          />
          <span>{tFor(zh ? "zh-CN" : "en-US", "tools.follow.tail")}</span>
        </label>
      </div>

      {operationFilter && (
        <div className="active-filter" role="status">
          <span>
            {tFor(zh ? "zh-CN" : "en-US", "tools.operation.filter")}:{" "}
            {operationFilter}
          </span>
          <button onClick={() => onOpenJournal(operationFilter)}>
            {tFor(zh ? "zh-CN" : "en-US", "tools.view.operation")}
          </button>
          <button onClick={() => onOperationFilter(undefined)}>
            {tFor(zh ? "zh-CN" : "en-US", "tools.clear")}
          </button>
        </div>
      )}

      <details className="policy-panel">
        <summary>
          {tFor(zh ? "zh-CN" : "en-US", "tools.log.retention.policy")}
        </summary>
        {draft ? (
          <div className="policy-grid">
            <label>
              <span>
                {tFor(zh ? "zh-CN" : "en-US", "tools.retention.days.1.30")}
              </span>
              <input
                type="number"
                min={1}
                max={30}
                value={draft.retentionDays}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    retentionDays: Number(event.target.value),
                  })
                }
              />
            </label>
            <label>
              <span>
                {tFor(zh ? "zh-CN" : "en-US", "tools.capacity.5.50.mib")}
              </span>
              <input
                type="number"
                min={5}
                max={50}
                value={draft.maxMib}
                onChange={(event) =>
                  setDraft({ ...draft, maxMib: Number(event.target.value) })
                }
              />
            </label>
            <p className="policy-boundary">
              {tFor(
                zh ? "zh-CN" : "en-US",
                "tools.retention.and.capacity.are.enforced",
              )}
            </p>
            <button onClick={() => void savePolicy()} disabled={policyBusy}>
              {tFor(zh ? "zh-CN" : "en-US", "tools.save.policy")}
            </button>
          </div>
        ) : (
          <p>{tFor(zh ? "zh-CN" : "en-US", "tools.loading.policy")}</p>
        )}
        <div className="sr-status" role="status" aria-live="polite">
          {policyStatus}
        </div>
      </details>

      <div
        ref={scrollRef}
        className="diagnostic-scroll"
        data-testid="log-virtual-list"
      >
        <ResizableTable
          tableId="p4-log"
          defaults={[160, 90, 100, 360, 160, 90]}
          minimums={[110, 70, 80, 180, 100, 70]}
          className="diagnostic-table"
          aria-rowcount={entries.length + 1}
        >
          <caption className="sr-only">
            {tFor(zh ? "zh-CN" : "en-US", "tools.p4.log")}
          </caption>
          <thead>
            <tr>
              <th>{tFor(zh ? "zh-CN" : "en-US", "tools.time")}</th>
              <th>{tFor(zh ? "zh-CN" : "en-US", "tools.level")}</th>
              <th>{tFor(zh ? "zh-CN" : "en-US", "tools.source")}</th>
              <th>{tFor(zh ? "zh-CN" : "en-US", "tools.command.message")}</th>
              <th>{tFor(zh ? "zh-CN" : "en-US", "tools.operation")}</th>
              <th>
                <span className="sr-only">
                  {tFor(zh ? "zh-CN" : "en-US", "tools.actions")}
                </span>
              </th>
            </tr>
          </thead>
          <tbody>
            {paddingTop > 0 && (
              <tr aria-hidden="true" className="virtual-table-spacer">
                <td colSpan={6} style={{ height: paddingTop }} />
              </tr>
            )}
            {virtualRows.map((row) => {
              const entry = entries[row.index];
              return (
                <tr
                  key={entry.id}
                  className={entry.level}
                  data-level={entry.level}
                  data-index={row.index}
                  ref={virtualizer.measureElement}
                  aria-rowindex={row.index + 2}
                >
                  <td>
                    <time dateTime={entry.timestamp}>
                      {formatLocalTime(entry.timestamp, zh ? "zh-CN" : "en-US")}
                    </time>
                  </td>
                  <td>{logLevelLabel(entry.level, zh)}</td>
                  <td>{entry.source}</td>
                  <td>
                    <code>{entry.command}</code>
                    <span>{entry.message}</span>
                    {entry.repeatCount > 1 && <b> ×{entry.repeatCount}</b>}
                  </td>
                  <td>
                    <button
                      className="link-button"
                      onClick={() => onOpenJournal(entry.operationId)}
                    >
                      {entry.operationId}
                    </button>
                  </td>
                  <td>
                    <button
                      aria-label={tFor(
                        zh ? "zh-CN" : "en-US",
                        "tools.copy.log",
                      )}
                      onClick={() =>
                        void navigator.clipboard.writeText(
                          `${entry.timestamp}\n${entry.command}\n${entry.message}`,
                        )
                      }
                    >
                      <Copy size={12} />
                    </button>
                  </td>
                </tr>
              );
            })}
            {paddingBottom > 0 && (
              <tr aria-hidden="true" className="virtual-table-spacer">
                <td colSpan={6} style={{ height: paddingBottom }} />
              </tr>
            )}
          </tbody>
        </ResizableTable>
        {!entries.length && !loading && !error && (
          <div className="empty-state">
            {tFor(zh ? "zh-CN" : "en-US", "tools.no.matching.logs")}
          </div>
        )}
      </div>
      {error && (
        <div className="inline-error" role="alert">
          {error}{" "}
          <button onClick={() => void load()}>
            {tFor(zh ? "zh-CN" : "en-US", "tools.retry")}
          </button>
        </div>
      )}
      {appendError && (
        <div className="inline-error" role="alert">
          {appendError}{" "}
          <button onClick={() => void load(nextCursor)}>
            {tFor(zh ? "zh-CN" : "en-US", "tools.retry.load.more")}
          </button>
        </div>
      )}
      <div className="diagnostic-footer" role="status" aria-live="polite">
        <span>
          {loading
            ? tFor(zh ? "zh-CN" : "en-US", "tools.loading")
            : `${entries.length} ${tFor(zh ? "zh-CN" : "en-US", "tools.records")}`}
        </span>
        {nextCursor && !appendError && (
          <button onClick={() => void load(nextCursor)} disabled={loading}>
            {tFor(zh ? "zh-CN" : "en-US", "tools.load.more")}
          </button>
        )}
      </div>
    </div>
  );
}
