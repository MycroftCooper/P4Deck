import { ActionAdmission } from "../../actions/ActionAdmission";
import { ResizableTable } from "../../../app/context-menu/ResizableTable";
import { useCallback, useEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { RefreshCw } from "lucide-react";
import { backend } from "../../../infrastructure/backend";
import type {
  JournalState,
  OperationCategory,
  OperationFailureKind,
  OperationRecord,
} from "../../../shared/contracts";

const PAGE_SIZE = 50;

interface Props {
  native?: boolean;
  zh: boolean;
  connectionKey: string;
  focusOperationId?: string;
  onOpenLogs(operationId: string): void;
}

function duration(record: OperationRecord) {
  if (!record.finishedAt) return "—";
  const milliseconds =
    Date.parse(record.finishedAt) - Date.parse(record.startedAt);
  return Number.isFinite(milliseconds)
    ? `${Math.max(0, milliseconds)} ms`
    : "—";
}

function iso(value: string) {
  if (!value) return undefined;
  const timestamp = new Date(value);
  return Number.isNaN(timestamp.valueOf())
    ? undefined
    : timestamp.toISOString();
}

export interface RecoveryGuidance {
  title: string;
  steps: string;
  tone: "warning" | "danger";
}

export function operationRecoveryGuidance(
  record: OperationRecord,
  zh: boolean,
): RecoveryGuidance | undefined {
  const failure: OperationFailureKind | undefined =
    record.failure ??
    (record.state === "interrupted" ? "interrupted" : undefined);
  if (!failure) return undefined;
  if (failure === "unknown" || failure === "interrupted") {
    return {
      tone: "danger",
      title: zh ? "结果未知，必须人工核对" : "Unknown result: verify manually",
      steps: zh
        ? "不要直接重试写操作。打开关联日志，刷新 Pending 与 Workspace，再到 P4 Server 侧核对实际结果。应用不会自动重放。"
        : "Do not immediately retry a mutation. Open related logs, refresh Pending and Workspace, then verify the server-side result. P4Deck never replays automatically.",
    };
  }
  if (failure === "cancelled") {
    return {
      tone: "warning",
      title: zh
        ? "已请求取消，执行范围可能不完整"
        : "Cancel requested; execution may be partial",
      steps: zh
        ? "刷新 Pending 和 Workspace 后再决定是否继续。取消只停止剩余工作，不会撤销已完成部分。"
        : "Refresh Pending and Workspace before continuing. Cancel stops remaining work and does not undo completed work.",
    };
  }
  if (failure === "authExpired") {
    return {
      tone: "warning",
      title: zh ? "认证已失效" : "Authentication expired",
      steps: zh
        ? "重新登录后先刷新。若中断的是写操作，请先从服务器侧核对，再明确决定是否重试。"
        : "Log in again and refresh first. If a mutation was interrupted, verify it server-side before explicitly retrying.",
    };
  }
  if (failure === "offline" || failure === "serverUnreachable") {
    return {
      tone: "warning",
      title: zh ? "连接已中断" : "Connection interrupted",
      steps: zh
        ? "恢复网络或 Server 后重新连接并刷新。只读请求可重试；写操作不会自动重放。"
        : "Reconnect and refresh after the network or server returns. Reads may retry; mutations are not replayed automatically.",
    };
  }
  return undefined;
}

export function OperationJournalView({
  native,
  zh,
  connectionKey,
  focusOperationId,
  onOpenLogs,
}: Props) {
  const [records, setRecords] = useState<OperationRecord[]>([]);
  const [nextCursor, setNextCursor] = useState<string>();
  const [state, setState] = useState<JournalState | "">("");
  const [category, setCategory] = useState<OperationCategory | "">("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [keyword, setKeyword] = useState(focusOperationId ?? "");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [appendError, setAppendError] = useState("");
  const generation = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: records.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 96,
    overscan: 8,
    initialRect: { width: 900, height: 480 },
  });
  const measuredRows = virtualizer.getVirtualItems();
  const virtualRows = measuredRows.length
    ? measuredRows
    : Array.from({ length: Math.min(records.length, 24) }, (_, index) => ({
        index,
        key: records[index].operationId,
        start: index * 96,
        size: 96,
        end: (index + 1) * 96,
        lane: 0,
      }));
  const totalSize = virtualizer.getTotalSize() || records.length * 96;
  const paddingTop = virtualRows.length ? virtualRows[0].start : 0;
  const paddingBottom = virtualRows.length
    ? totalSize - virtualRows.at(-1)!.end
    : 0;
  const recoveryRecords = records.filter((record) =>
    operationRecoveryGuidance(record, zh),
  );

  const load = useCallback(
    async (cursor?: string) => {
      const request = ++generation.current;
      setLoading(true);
      if (cursor) setAppendError("");
      else setError("");
      try {
        const page = await backend.queryOperationJournal({
          state: state || undefined,
          category: category || undefined,
          from: iso(from),
          to: iso(to),
          keyword: keyword.trim() || undefined,
          cursor,
          limit: PAGE_SIZE,
        });
        if (request !== generation.current) return;
        setRecords((current) => {
          const incoming = cursor
            ? [...current, ...page.records]
            : page.records;
          return incoming.filter(
            (record, index) =>
              incoming.findIndex(
                (candidate) => candidate.operationId === record.operationId,
              ) === index,
          );
        });
        setNextCursor(page.nextCursor);
      } catch (cause) {
        if (request !== generation.current) return;
        if (cursor) setAppendError(String(cause));
        else {
          setRecords([]);
          setNextCursor(undefined);
          setError(String(cause));
        }
      } finally {
        if (request === generation.current) setLoading(false);
      }
    },
    [category, from, keyword, state, to],
  );

  useEffect(() => {
    if (focusOperationId) setKeyword(focusOperationId);
  }, [focusOperationId]);

  useEffect(() => {
    generation.current += 1;
    setRecords([]);
    setNextCursor(undefined);
    void load();
    return () => void ++generation.current;
  }, [connectionKey, load]);

  return (
    <div className="diagnostic-view journal-view">
      <ActionAdmission
        native={native ?? false}
        zh={zh}
        connectionKey={connectionKey}
      />
      <div
        className="diagnostic-toolbar"
        aria-label={zh ? "操作筛选" : "Operation filters"}
      >
        <input
          aria-label={zh ? "搜索操作" : "Search operations"}
          value={keyword}
          placeholder={
            zh
              ? "操作 ID、工作区、状态或错误"
              : "ID, workspace, state, or error"
          }
          onChange={(event) => setKeyword(event.target.value)}
        />
        <select
          aria-label={zh ? "操作状态" : "Operation state"}
          value={state}
          onChange={(event) =>
            setState(event.target.value as JournalState | "")
          }
        >
          <option value="">{zh ? "全部状态" : "All states"}</option>
          {(
            [
              "queued",
              "running",
              "succeeded",
              "failed",
              "cancelled",
              "interrupted",
            ] as JournalState[]
          ).map((value) => (
            <option key={value}>{value}</option>
          ))}
        </select>
        <select
          aria-label={zh ? "操作类型" : "Operation type"}
          value={category}
          onChange={(event) =>
            setCategory(event.target.value as OperationCategory | "")
          }
        >
          <option value="">{zh ? "全部类型" : "All types"}</option>
          {(
            [
              "query",
              "fileMutation",
              "changelistMutation",
              "submit",
              "authentication",
              "localFile",
            ] as OperationCategory[]
          ).map((value) => (
            <option key={value}>{value}</option>
          ))}
        </select>
        <label className="compact-field">
          <span>{zh ? "开始" : "From"}</span>
          <input
            type="datetime-local"
            value={from}
            onChange={(event) => setFrom(event.target.value)}
          />
        </label>
        <label className="compact-field">
          <span>{zh ? "结束" : "To"}</span>
          <input
            type="datetime-local"
            value={to}
            onChange={(event) => setTo(event.target.value)}
          />
        </label>
        <button onClick={() => void load()} disabled={loading}>
          <RefreshCw size={13} /> {zh ? "应用 / 刷新" : "Apply / refresh"}
        </button>
      </div>

      {recoveryRecords.length > 0 && (
        <div className="journal-recovery-banner" role="alert">
          <strong>
            {zh
              ? `${recoveryRecords.length} 条操作需要人工恢复`
              : `${recoveryRecords.length} operation(s) need manual recovery`}
          </strong>
          <span>
            {zh
              ? "先核对日志和服务器实际状态，再决定是否重试；写操作不会自动重放。"
              : "Verify logs and server state before retrying. Mutations are never replayed automatically."}
          </span>
        </div>
      )}
      <div
        ref={scrollRef}
        className="diagnostic-scroll"
        data-testid="journal-virtual-list"
      >
        <ResizableTable
          tableId="operation-journal"
          defaults={[100, 280, 180, 90, 300, 120]}
          minimums={[80, 160, 120, 70, 160, 90]}
          className="diagnostic-table journal-table"
          aria-rowcount={records.length + 1}
        >
          <caption className="sr-only">
            {zh ? "操作记录" : "Operation journal"}
          </caption>
          <thead>
            <tr>
              <th>{zh ? "状态" : "State"}</th>
              <th>{zh ? "操作摘要" : "Summary"}</th>
              <th>{zh ? "开始 / 结束" : "Started / finished"}</th>
              <th>{zh ? "耗时" : "Duration"}</th>
              <th>{zh ? "错误 / 恢复" : "Error / recovery"}</th>
              <th>{zh ? "关联日志" : "Logs"}</th>
            </tr>
          </thead>
          <tbody>
            {paddingTop > 0 && (
              <tr aria-hidden="true" className="virtual-table-spacer">
                <td colSpan={6} style={{ height: paddingTop }} />
              </tr>
            )}
            {virtualRows.map((row) => {
              const record = records[row.index];
              return (
                <tr
                  key={record.operationId}
                  className={record.state}
                  data-index={row.index}
                  ref={virtualizer.measureElement}
                  aria-rowindex={row.index + 2}
                >
                  <td>
                    <strong>{record.state}</strong>
                  </td>
                  <td>
                    <code>{record.operationId}</code>
                    <span>
                      {record.category} · {record.source} · {record.workspace}
                    </span>
                  </td>
                  <td>
                    <time dateTime={record.startedAt}>
                      {new Date(record.startedAt).toLocaleString()}
                    </time>
                    <span>
                      {record.finishedAt
                        ? new Date(record.finishedAt).toLocaleString()
                        : zh
                          ? "进行中"
                          : "In progress"}
                    </span>
                  </td>
                  <td>{duration(record)}</td>
                  <td>
                    <span>{record.failure ?? "—"}</span>
                    {(() => {
                      const guidance = operationRecoveryGuidance(record, zh);
                      return guidance ? (
                        <div
                          className={`journal-recovery ${guidance.tone}`}
                          data-testid={`recovery-${record.operationId}`}
                        >
                          <strong>{guidance.title}</strong>
                          <small>{guidance.steps}</small>
                        </div>
                      ) : null;
                    })()}
                  </td>
                  <td>
                    <button
                      className="link-button"
                      onClick={() => onOpenLogs(record.operationId)}
                    >
                      {zh ? "查看日志" : "View logs"}
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
        {!records.length && !loading && !error && (
          <div className="empty-state">
            {zh ? "暂无匹配操作" : "No matching operations"}
          </div>
        )}
      </div>
      {error && (
        <div className="inline-error" role="alert">
          {error}{" "}
          <button onClick={() => void load()}>{zh ? "重试" : "Retry"}</button>
        </div>
      )}
      {appendError && (
        <div className="inline-error" role="alert">
          {appendError}{" "}
          <button onClick={() => void load(nextCursor)}>
            {zh ? "重试继续加载" : "Retry load more"}
          </button>
        </div>
      )}
      <div className="diagnostic-footer" role="status" aria-live="polite">
        <span>
          {loading
            ? zh
              ? "正在加载…"
              : "Loading…"
            : `${records.length} ${zh ? "条" : "records"}`}
        </span>
        {nextCursor && !appendError && (
          <button onClick={() => void load(nextCursor)} disabled={loading}>
            {zh ? "继续加载" : "Load more"}
          </button>
        )}
      </div>
    </div>
  );
}
