import { useEffect, useMemo, useRef, useState } from "react";
import { QueryClient } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { RefreshCw, Search } from "lucide-react";
import { backend } from "../../infrastructure/backend";
import type {
  FileRevision,
  RuntimeInfo,
  StreamSummary,
} from "../../shared/contracts/types";

import { useContextMenu } from "../../app/context-menu/ContextMenu";
import { TableHeader } from "../../app/context-menu/TableHeader";
import { action, copy } from "../../app/context-menu/bindings";
import { useRecordSelection } from "../../app/context-menu/useRecordSelection";
const cache = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 60_000, gcTime: 300_000, retry: false },
  },
});
export function ReadOnlyPage({
  kind,
  runtime,
  target = "",
  locked = false,
  onTargetChange,
  zh,
}: {
  kind: "history" | "streams";
  runtime: RuntimeInfo;
  target?: string;
  locked?: boolean;
  onTargetChange?(path: string): void;
  zh: boolean;
}) {
  const [path, setPath] = useState(target);
  const [queryPath, setQueryPath] = useState(target);
  useEffect(() => {
    setPath(target);
    setQueryPath(target);
  }, [target]);
  const [search, setSearch] = useState("");
  const [rows, setRows] = useState<(FileRevision | StreamSummary)[]>([]);
  const [selected, setSelected] = useState<FileRevision | StreamSummary>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const scroll = useRef<HTMLDivElement>(null);
  const key = useMemo(
    () => [kind, runtime.mode, runtime.context, queryPath],
    [kind, runtime, queryPath],
  );
  useEffect(() => {
    if (runtime.p4Version === "loading" || (kind === "history" && !queryPath)) {
      setRows([]);
      setSelected(undefined);
      setLoading(false);
      return;
    }
    let live = true;
    setLoading(true);
    setError("");
    setSelected(undefined);
    setRows(cache.getQueryData<(FileRevision | StreamSummary)[]>(key) ?? []);
    void cache
      .fetchQuery<(FileRevision | StreamSummary)[]>({
        queryKey: key,
        queryFn: () =>
          kind === "history"
            ? backend.getFileHistory(queryPath)
            : backend.listStreams(),
      })
      .then((data) => {
        if (live) setRows(data);
      })
      .catch((cause) => {
        if (live) setError(String(cause));
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [key, kind, queryPath, refresh, runtime.p4Version]);
  const filtered = useMemo(
    () =>
      rows.filter((row) =>
        Object.values(row)
          .join(" ")
          .toLowerCase()
          .includes(search.toLowerCase()),
      ),
    [rows, search],
  );
  const menu = useContextMenu();
  const selection = useRecordSelection(
    filtered,
    (item) => ("stream" in item ? item.stream : String(item.revision)),
    JSON.stringify(key),
  );
  const reload = async () => {
    await cache.invalidateQueries({ queryKey: key });
    setRefresh((v) => v + 1);
  };
  const virtual = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => scroll.current,
    estimateSize: () => 52,
    overscan: 8,
  });
  return (
    <main className="workspaces-page">
      <header className="section-title">
        <div>
          <span className="workspace-eyebrow">
            PERFORCE / {kind.toUpperCase()}
          </span>
          <h1>{kind === "history" ? "History" : "Streams"}</h1>
          <p>
            {kind === "history"
              ? zh
                ? "查看所选文件的版本、提交记录与作者。"
                : "Revisions, changelists and authors for a file."
              : zh
                ? "查看服务器上的分支流、类型和父子关系。"
                : "Streams, types and parent relationships on this server."}
          </p>
        </div>
        <button
          disabled={loading || (kind === "history" && !queryPath)}
          onClick={() => {
            void cache
              .invalidateQueries({ queryKey: key })
              .then(() => setRefresh((v) => v + 1));
          }}
        >
          <RefreshCw size={15} className={loading ? "spin" : ""} />
          {zh ? "刷新" : "Refresh"}
        </button>
      </header>
      {kind === "history" && (
        <form
          className="history-path"
          onSubmit={(event) => {
            event.preventDefault();
            if (path.trim() && !locked) {
              setQueryPath(path.trim());
              onTargetChange?.(path.trim());
            }
          }}
        >
          <input
            disabled={locked}
            aria-label="Depot path"
            placeholder="//depot/project/file"
            value={path}
            onChange={(event) => setPath(event.target.value)}
          />
          <button type="submit" disabled={locked}>
            {zh ? "查看历史" : "Show history"}
          </button>
        </form>
      )}
      <div className="query-bar">
        <label className="search-field">
          <Search size={15} />
          <input
            aria-label={zh ? "搜索当前列表" : "Search list"}
            placeholder={zh ? "搜索当前列表…" : "Search list…"}
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              scroll.current?.scrollTo(0, 0);
            }}
          />
        </label>
        <span className="filter-count">
          {filtered.length} {zh ? "条记录" : "records"}
        </span>
      </div>
      {error && (
        <div role="alert" className="workspace-load-error">
          {error}
        </div>
      )}
      <div className={`workspace-layout ${selected ? "with-detail" : ""}`}>
        <section className="workspace-panel">
          <div
            ref={scroll}
            className="workspace-table-scroll"
            tabIndex={0}
            {...menu(kind === "streams" ? "W06" : "V08", () => ({
              刷新: action(reload),
              刷新当前视图: action(reload),
              复制当前目标标识: copy(queryPath),
              全选结果: action(selection.all),
              清除选择: action(selection.clear),
            }))}
          >
            <TableHeader
              className="browser-columns workspace-head"
              columns={
                kind === "history"
                  ? [
                      { id: "revision", label: "Revision / CL" },
                      { id: "user", label: "User" },
                      { id: "description", label: zh ? "描述" : "Description" },
                    ]
                  : [
                      { id: "stream", label: "Stream" },
                      { id: "parent", label: "Type / Parent" },
                      { id: "description", label: zh ? "描述" : "Description" },
                    ]
              }
            />
            <div
              className="virtual-spacer"
              style={{ height: virtual.getTotalSize(), minWidth: 620 }}
            >
              {virtual.getVirtualItems().map((row) => {
                const item = filtered[row.index];
                return (
                  <button
                    key={"stream" in item ? item.stream : item.revision}
                    className={`browser-columns workspace-row ${selection.isSelected(item) ? "selected" : ""}`}
                    style={{
                      height: row.size,
                      transform: `translateY(${row.start}px)`,
                    }}
                    onClick={(event) => {
                      selection.select(item, event);
                      setSelected(item);
                    }}
                    {...menu(
                      "stream" in item
                        ? selection.targets(item).length > 1
                          ? "W05"
                          : "W04"
                        : selection.targets(item).length > 2
                          ? "V03"
                          : selection.targets(item).length === 2
                            ? "V02"
                            : "V01",
                      () =>
                        "stream" in item
                          ? {
                              查看详情: action(() => setSelected(item)),
                              "复制 Stream 路径": copy(item.stream),
                              复制名称: copy(item.name),
                              "复制父 Stream 路径": copy(item.parent),
                              刷新: action(reload),
                              "复制 Stream 路径列表": copy(
                                selection
                                  .targets(item)
                                  .map((v) => ("stream" in v ? v.stream : ""))
                                  .join("\n"),
                              ),
                              复制名称列表: copy(
                                selection
                                  .targets(item)
                                  .map((v) => ("stream" in v ? v.name : ""))
                                  .join("\n"),
                              ),
                            }
                          : {
                              "复制 Depot 路径": copy(queryPath),
                              复制精确修订标识: copy(
                                `${queryPath}#${item.revision}`,
                              ),
                              "复制 CL 编号": copy(item.changelistId),
                              复制所选修订标识: copy(
                                selection
                                  .targets(item)
                                  .map((v) =>
                                    "revision" in v
                                      ? `${queryPath}#${v.revision}`
                                      : "",
                                  )
                                  .join("\n"),
                              ),
                            },
                      {
                        onOpen: () => {
                          selection.context(item);
                          setSelected(item);
                        },
                      },
                    )}
                  >
                    <span>
                      {"stream" in item
                        ? item.stream
                        : `#${item.revision} · CL ${item.changelistId}`}
                    </span>
                    <span>
                      {"stream" in item
                        ? `${item.kind} · ${item.parent}`
                        : item.user}
                    </span>
                    <span>{item.description}</span>
                  </button>
                );
              })}
            </div>
            {!filtered.length && (
              <div className="workspace-empty">
                {loading
                  ? zh
                    ? "加载中…"
                    : "Loading…"
                  : error
                    ? zh
                      ? "加载失败，可刷新重试"
                      : "Loading failed. Refresh to retry."
                    : kind === "history" && !queryPath
                      ? zh
                        ? "从文件页选择文件后打开 History，或输入 Depot 文件路径。"
                        : "Select a file before opening History, or enter its depot path."
                      : zh
                        ? "没有匹配记录"
                        : "No matching records"}
              </div>
            )}
          </div>
          <footer className="list-footer">
            {kind === "history" ? queryPath : runtime.context.server}
          </footer>
        </section>
        {selected && (
          <aside className="file-details workspace-details">
            <div className="detail-caption">
              {zh ? "详情" : "Details"}
              <button
                aria-label={zh ? "关闭详情" : "Close details"}
                onClick={() => setSelected(undefined)}
              >
                ×
              </button>
            </div>
            <dl>
              {Object.entries(selected)
                .filter(([name]) => name !== "description")
                .map(([name, value]) => (
                  <div key={name}>
                    <dt>{name}</dt>
                    <dd>{String(value)}</dd>
                  </div>
                ))}
            </dl>
            <p className="workspace-description">{selected.description}</p>
          </aside>
        )}
      </div>
    </main>
  );
}
