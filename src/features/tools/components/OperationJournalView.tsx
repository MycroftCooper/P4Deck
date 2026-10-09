import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { backend } from "../../../infrastructure/backend";
import type {
  JournalState,
  OperationCategory,
  OperationRecord,
} from "../../../shared/contracts/types";

const PAGE_SIZE = 50;

interface Props {
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

export function OperationJournalView({
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

      <div className="diagnostic-scroll">
        <table className="diagnostic-table journal-table">
          <caption className="sr-only">
            {zh ? "操作记录" : "Operation journal"}
          </caption>
          <thead>
            <tr>
              <th>{zh ? "状态" : "State"}</th>
              <th>{zh ? "操作摘要" : "Summary"}</th>
              <th>{zh ? "开始 / 结束" : "Started / finished"}</th>
              <th>{zh ? "耗时" : "Duration"}</th>
              <th>{zh ? "错误" : "Error"}</th>
              <th>{zh ? "关联日志" : "Logs"}</th>
            </tr>
          </thead>
          <tbody>
            {records.map((record) => (
              <tr key={record.operationId} className={record.state}>
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
                <td>{record.failure ?? "—"}</td>
                <td>
                  <button
                    className="link-button"
                    onClick={() => onOpenLogs(record.operationId)}
                  >
                    {zh ? "查看日志" : "View logs"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
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
