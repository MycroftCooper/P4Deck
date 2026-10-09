import { useCallback, useEffect, useRef, useState } from "react";
import { Copy, RefreshCw } from "lucide-react";
import { backend } from "../../../infrastructure/backend";
import type {
  LogEntry,
  LogLevel,
  LogPolicy,
  OperationSource,
} from "../../../shared/contracts/types";

const PAGE_SIZE = 100;

interface Props {
  zh: boolean;
  connectionKey: string;
  refreshKey: number;
  operationFilter?: string;
  onOperationFilter(value?: string): void;
  onOpenJournal(operationId: string): void;
  onPolicy(policy: LogPolicy): void;
}

export function LogView({
  zh,
  connectionKey,
  refreshKey,
  operationFilter,
  onOperationFilter,
  onOpenJournal,
  onPolicy,
}: Props) {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [nextCursor, setNextCursor] = useState<string>();
  const [keyword, setKeyword] = useState("");
  const [level, setLevel] = useState<LogLevel | "">("");
  const [source, setSource] = useState<OperationSource | "">("");
  const [command, setCommand] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [appendError, setAppendError] = useState("");
  const [policy, setPolicy] = useState<LogPolicy>();
  const [draft, setDraft] = useState<LogPolicy>();
  const [policyBusy, setPolicyBusy] = useState(false);
  const [policyStatus, setPolicyStatus] = useState("");
  const generation = useRef(0);
  const policyGeneration = useRef(0);

  const load = useCallback(
    async (cursor?: string) => {
      const request = ++generation.current;
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
        if (request !== generation.current) return;
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
        if (request !== generation.current) return;
        if (cursor) setAppendError(String(cause));
        else {
          setEntries([]);
          setNextCursor(undefined);
          setError(String(cause));
        }
      } finally {
        if (request === generation.current) setLoading(false);
      }
    },
    [command, keyword, level, operationFilter, source],
  );

  useEffect(() => {
    generation.current += 1;
    setEntries([]);
    setNextCursor(undefined);
    void load();
    return () => void ++generation.current;
  }, [connectionKey, load, refreshKey]);

  useEffect(() => {
    const request = ++policyGeneration.current;
    setPolicy(undefined);
    setDraft(undefined);
    setPolicyStatus("");
    void backend
      .getLogPolicy()
      .then((value) => {
        if (request !== policyGeneration.current) return;
        setPolicy(value);
        setDraft(value);
        onPolicy(value);
      })
      .catch((cause) => {
        if (request === policyGeneration.current)
          setPolicyStatus(String(cause));
      });
    return () => void ++policyGeneration.current;
  }, [connectionKey, onPolicy]);

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
        zh
          ? "保留期必须为 1–30 天，容量必须为 5–50 MiB。"
          : "Retention must be 1–30 days and capacity 5–50 MiB.",
      );
      return;
    }
    setPolicyBusy(true);
    setPolicyStatus(zh ? "正在保存…" : "Saving…");
    try {
      const saved = await backend.setLogPolicy(draft);
      setPolicy(saved);
      setDraft(saved);
      onPolicy(saved);
      setPolicyStatus(zh ? "日志策略已保存。" : "Log policy saved.");
    } catch (cause) {
      setDraft(policy);
      setPolicyStatus(
        `${zh ? "保存失败，已恢复原策略：" : "Save failed; previous policy restored: "}${String(cause)}`,
      );
    } finally {
      setPolicyBusy(false);
    }
  }

  return (
    <div className="diagnostic-view log-view">
      <div
        className="diagnostic-toolbar"
        aria-label={zh ? "日志筛选" : "Log filters"}
      >
        <input
          aria-label={zh ? "搜索日志" : "Search logs"}
          value={keyword}
          placeholder={zh ? "消息或命令" : "Message or command"}
          onChange={(event) => setKeyword(event.target.value)}
        />
        <select
          aria-label={zh ? "日志级别" : "Log level"}
          value={level}
          onChange={(event) => setLevel(event.target.value as LogLevel | "")}
        >
          <option value="">{zh ? "全部级别" : "All levels"}</option>
          <option value="info">Info</option>
          <option value="warning">Warning</option>
          <option value="error">Error</option>
        </select>
        <select
          aria-label={zh ? "日志来源" : "Log source"}
          value={source}
          onChange={(event) =>
            setSource(event.target.value as OperationSource | "")
          }
        >
          <option value="">{zh ? "全部来源" : "All sources"}</option>
          <option value="gui">GUI</option>
          <option value="terminal">Terminal</option>
        </select>
        <input
          aria-label={zh ? "命令或类别" : "Command or category"}
          value={command}
          placeholder={zh ? "命令 / 类别" : "Command / category"}
          onChange={(event) => setCommand(event.target.value)}
        />
        <button onClick={() => void load()} disabled={loading}>
          <RefreshCw size={13} /> {zh ? "应用 / 刷新" : "Apply / refresh"}
        </button>
        <button
          onClick={() => {
            generation.current += 1;
            setEntries([]);
            setNextCursor(undefined);
            setLoading(false);
            setError("");
            setAppendError("");
          }}
        >
          {zh ? "清空显示" : "Clear view"}
        </button>
      </div>

      {operationFilter && (
        <div className="active-filter" role="status">
          <span>
            {zh ? "操作筛选" : "Operation filter"}: {operationFilter}
          </span>
          <button onClick={() => onOpenJournal(operationFilter)}>
            {zh ? "查看操作" : "View operation"}
          </button>
          <button onClick={() => onOperationFilter(undefined)}>
            {zh ? "清除" : "Clear"}
          </button>
        </div>
      )}

      <details className="policy-panel">
        <summary>
          {zh ? "日志与自动展开策略" : "Logging and auto-expand policy"}
        </summary>
        {draft ? (
          <div className="policy-grid">
            <label>
              <span>{zh ? "保留天数（1–30）" : "Retention days (1–30)"}</span>
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
              <span>{zh ? "容量上限（5–50 MiB）" : "Capacity (5–50 MiB)"}</span>
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
            <label className="check-field">
              <input
                type="checkbox"
                checked={draft.autoExpandWarning}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    autoExpandWarning: event.target.checked,
                  })
                }
              />
              <span>
                {zh ? "Warning 时展开工具区" : "Expand tools on Warning"}
              </span>
            </label>
            <label className="check-field">
              <input
                type="checkbox"
                checked={draft.autoExpandError}
                onChange={(event) =>
                  setDraft({ ...draft, autoExpandError: event.target.checked })
                }
              />
              <span>{zh ? "Error 时展开工具区" : "Expand tools on Error"}</span>
            </label>
            <p className="policy-boundary">
              {zh
                ? "保留/容量由后端强制执行；自动展开仅控制前端展示，不移动键盘焦点。"
                : "Retention/capacity are enforced by the backend; auto-expand only changes frontend visibility and never moves keyboard focus."}
            </p>
            <button onClick={() => void savePolicy()} disabled={policyBusy}>
              {zh ? "保存策略" : "Save policy"}
            </button>
          </div>
        ) : (
          <p>{zh ? "正在读取策略…" : "Loading policy…"}</p>
        )}
        <div className="sr-status" role="status" aria-live="polite">
          {policyStatus}
        </div>
      </details>

      <div className="diagnostic-scroll">
        <table className="diagnostic-table">
          <caption className="sr-only">{zh ? "P4 日志" : "P4 log"}</caption>
          <thead>
            <tr>
              <th>{zh ? "时间" : "Time"}</th>
              <th>{zh ? "级别" : "Level"}</th>
              <th>{zh ? "来源" : "Source"}</th>
              <th>{zh ? "命令 / 消息" : "Command / message"}</th>
              <th>{zh ? "操作" : "Operation"}</th>
              <th>
                <span className="sr-only">{zh ? "动作" : "Actions"}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => (
              <tr key={entry.id} className={entry.level}>
                <td>
                  <time dateTime={entry.timestamp}>
                    {new Date(entry.timestamp).toLocaleString()}
                  </time>
                </td>
                <td>{entry.level}</td>
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
                    aria-label={zh ? "复制日志" : "Copy log"}
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
            ))}
          </tbody>
        </table>
        {!entries.length && !loading && !error && (
          <div className="empty-state">
            {zh ? "暂无匹配日志" : "No matching logs"}
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
            : `${entries.length} ${zh ? "条" : "records"}`}
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
