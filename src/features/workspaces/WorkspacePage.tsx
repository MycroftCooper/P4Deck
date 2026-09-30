import { useEffect, useMemo, useRef, useState } from "react";
import { QueryClient } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Monitor, RefreshCw, Search } from "lucide-react";
import { backend } from "../../infrastructure/backend";
import type {
  ClientWorkspace,
  RuntimeInfo,
} from "../../shared/contracts/types";
import type { messages } from "../../shared/i18n";

import { useContextMenu } from "../../app/context-menu/ContextMenu";
import { TableHeader } from "../../app/context-menu/TableHeader";
import { action, copy } from "../../app/context-menu/bindings";
import { useRecordSelection } from "../../app/context-menu/useRecordSelection";
const cache = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 60_000, gcTime: 300_000, retry: false },
  },
});

export function WorkspacePage({
  t,
  runtime,
}: {
  t: (typeof messages)[keyof typeof messages];
  runtime: RuntimeInfo;
}) {
  const zh = t.files === "文件";
  const [items, setItems] = useState<ClientWorkspace[]>([]);
  const [search, setSearch] = useState("");
  const [selectedName, setSelectedName] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const key = useMemo(
    () => ["user-workspaces", runtime.mode, runtime.context],
    [runtime],
  );
  useEffect(() => {
    if (runtime.p4Version === "loading") return;
    let active = true;
    setItems(cache.getQueryData<ClientWorkspace[]>(key) ?? []);
    setLoading(true);
    setError("");
    void cache
      .fetchQuery({
        queryKey: key,
        queryFn: () => backend.listUserWorkspaces(),
      })
      .then((data) => {
        if (active) setItems(data);
      })
      .catch((cause) => {
        if (active) setError(String(cause));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [key, runtime.p4Version, refresh]);
  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return items.filter((item) =>
      [
        item.name,
        item.owner,
        item.host,
        item.root,
        item.stream,
        item.description,
      ].some((value) => value.toLowerCase().includes(term)),
    );
  }, [items, search]);
  const menu = useContextMenu();
  const selection = useRecordSelection(
    filtered,
    (item) => item.name,
    JSON.stringify(key),
  );
  const selected = items.find((item) => item.name === selectedName);
  const virtual = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 48,
    overscan: 8,
  });
  const date = (value: number | null) =>
    value == null
      ? "—"
      : new Date(value * 1000).toLocaleString(zh ? "zh-CN" : "en-US");
  const reload = async () => {
    await cache.invalidateQueries({ queryKey: key });
    setRefresh((value) => value + 1);
  };
  return (
    <main className="workspaces-page">
      <header className="section-title">
        <div>
          <span className="workspace-eyebrow">
            PERFORCE / CLIENT WORKSPACES
          </span>
          <h1>
            Workspace <span className="heading-count">{items.length}</span>
          </h1>
          <p>
            {zh
              ? "当前用户拥有的工作区，跨主机集中查看。"
              : "Workspaces owned by the current user, across hosts."}
          </p>
        </div>
        <button disabled={loading} onClick={() => void reload()}>
          <RefreshCw size={15} className={loading ? "spin" : ""} />
          {t.refresh}
        </button>
      </header>
      <div className="query-bar">
        <label className="search-field">
          <Search size={15} />
          <input
            aria-label={zh ? "搜索工作区" : "Search workspaces"}
            placeholder={
              zh ? "搜索工作区、主机、路径…" : "Search workspace, host, path…"
            }
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              scrollRef.current?.scrollTo(0, 0);
            }}
          />
        </label>
        <span className="owner-scope">
          {zh ? "归属：当前用户" : "Owner: current user"}
        </span>
        <span className="filter-count">
          {runtime.mode === "mock" ? t.mock : runtime.context.server}
        </span>
      </div>
      {error && (
        <div role="alert" className="workspace-load-error">
          {error}
        </div>
      )}
      <div className={`workspace-layout ${selected ? "with-detail" : ""}`}>
        <section className="workspace-panel" aria-busy={loading}>
          <div
            className="workspace-table-scroll"
            ref={scrollRef}
            tabIndex={0}
            {...menu("W03", () => ({
              刷新: action(reload),
              全选结果: action(selection.all),
              清除选择: action(selection.clear),
            }))}
          >
            <TableHeader
              className="workspace-columns workspace-head"
              columns={[
                { id: "name", label: "Workspace" },
                { id: "owner", label: "Owner" },
                { id: "host", label: "Host" },
                { id: "root", label: zh ? "根目录" : "Root" },
                { id: "updated", label: zh ? "更新时间" : "Updated" },
              ]}
            />
            <div
              className="virtual-spacer"
              style={{ height: virtual.getTotalSize(), minWidth: 750 }}
            >
              {virtual.getVirtualItems().map((row) => {
                const item = filtered[row.index];
                return (
                  <button
                    key={item.name}
                    className={`workspace-columns workspace-row ${selection.isSelected(item) ? "selected" : ""}`}
                    style={{
                      height: row.size,
                      transform: `translateY(${row.start}px)`,
                    }}
                    aria-pressed={selection.isSelected(item)}
                    onClick={(event) => {
                      selection.select(item, event);
                      setSelectedName(item.name);
                    }}
                    {...menu(
                      selection.targets(item).length > 1 ? "W02" : "W01",
                      () => ({
                        查看详情: action(() => setSelectedName(item.name)),
                        复制名称: copy(item.name),
                        复制根路径: copy(item.root),
                        "复制 Stream 路径": copy(item.stream),
                        刷新: action(reload),
                        复制名称列表: copy(
                          selection
                            .targets(item)
                            .map((value) => value.name)
                            .join("\n"),
                        ),
                        复制根路径列表: copy(
                          selection
                            .targets(item)
                            .map((value) => value.root)
                            .join("\n"),
                        ),
                      }),
                      {
                        title: item.name,
                        onOpen: () => {
                          selection.context(item);
                          setSelectedName(item.name);
                        },
                      },
                    )}
                  >
                    <span>
                      <Monitor size={16} />
                      <strong>{item.name}</strong>
                      {item.name === runtime.context.client && (
                        <em>{zh ? "当前" : "Current"}</em>
                      )}
                    </span>
                    <span>{item.owner || "—"}</span>
                    <span>{item.host || (zh ? "不限主机" : "Any host")}</span>
                    <span title={item.root}>{item.root}</span>
                    <time>{date(item.updated)}</time>
                  </button>
                );
              })}
            </div>
            {!filtered.length && (
              <div className="workspace-empty" role="status">
                {loading
                  ? zh
                    ? "正在加载工作区…"
                    : "Loading workspaces…"
                  : error
                    ? zh
                      ? "加载失败，请刷新重试。"
                      : "Loading failed. Refresh to retry."
                    : search
                      ? zh
                        ? "没有匹配的工作区"
                        : "No matching workspaces"
                      : zh
                        ? "当前用户尚无工作区"
                        : "No workspaces owned by the current user"}
              </div>
            )}
          </div>
          <footer className="list-footer">
            {filtered.length} / {items.length} Workspace{" "}
            <span className="virtual-proof">
              {zh ? "仅显示当前用户所有" : "Owned by current user"}
            </span>
          </footer>
        </section>
        {selected && (
          <aside className="file-details workspace-details">
            <div className="detail-caption">
              {zh ? "工作区详情" : "Workspace details"}
              <button aria-label={t.close} onClick={() => setSelectedName("")}>
                ×
              </button>
            </div>
            <div className="file-preview-icon">
              <Monitor size={30} />
            </div>
            <h2>{selected.name}</h2>
            <dl>
              {[
                ["Owner", selected.owner],
                ["Host", selected.host || (zh ? "不限主机" : "Any host")],
                [
                  "Stream",
                  selected.stream || (zh ? "传统工作区" : "Classic workspace"),
                ],
                [zh ? "更新时间" : "Updated", date(selected.updated)],
                [zh ? "访问时间" : "Accessed", date(selected.accessed)],
              ].map(([label, value]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>{value || "—"}</dd>
                </div>
              ))}
            </dl>
            <div className="detail-path-label">ROOT</div>
            <p className="detail-path">{selected.root}</p>
            <div className="detail-path-label">
              {zh ? "描述" : "DESCRIPTION"}
            </div>
            <p className="workspace-description">
              {selected.description || "—"}
            </p>
          </aside>
        )}
      </div>
    </main>
  );
}
