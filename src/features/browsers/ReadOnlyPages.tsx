import { useEffect, useMemo, useRef, useState } from "react";
import { QueryClient } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Network, RefreshCw, Search } from "lucide-react";
import { backend } from "../../infrastructure/backend";
import type {
  DiffResult,
  FileHistoryPage,
  FileRevision,
  RuntimeInfo,
  StreamSummary,
} from "../../shared/contracts/types";

import { useContextMenu } from "../../app/context-menu/ContextMenu";
import { TableHeader } from "../../app/context-menu/TableHeader";
import { action, copy } from "../../app/context-menu/bindings";
import { useRecordSelection } from "../../app/context-menu/useRecordSelection";
import {
  historyDiffPair,
  makeReviewScope,
  mergeHistoryRows,
} from "./reviewModel";
import {
  isCancellation,
  reviewRequestIdentity,
  reviewRequestIdentityKey,
  reviewSessionIdentity,
  useReviewRequestOwner,
} from "./reviewRequests";
import { StreamSwitchDialog } from "./StreamSwitchDialog";
import { SwarmAction, swarmMenuAction } from "../swarm/SwarmAction";
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
  onRuntime,
  onOpenStreamGraph,
  navigation,
  zh,
}: {
  kind: "history" | "streams";
  runtime: RuntimeInfo;
  target?: string;
  locked?: boolean;
  onTargetChange?(path: string): void;
  onRuntime?(runtime: RuntimeInfo): void;
  onOpenStreamGraph?(): void;
  navigation?: { stream: string; nonce: number };
  zh: boolean;
}) {
  const [path, setPath] = useState(target);
  const [queryPath, setQueryPath] = useState(target);
  useEffect(() => {
    setPath(target);
    setQueryPath(target);
  }, [target]);
  const [search, setSearch] = useState("");
  const [ownedRows, setOwnedRows] = useState<{
    owner: string;
    value: (FileRevision | StreamSummary)[];
  }>();
  const [selected, setSelected] = useState<FileRevision | StreamSummary>();
  const [loadingOwner, setLoadingOwner] = useState("");
  const [ownedError, setOwnedError] = useState<{
    owner: string;
    message: string;
  }>();
  const [refresh, setRefresh] = useState(0);
  const [historyCursor, setHistoryCursor] = useState<string>();
  const [historyHasMore, setHistoryHasMore] = useState(false);
  const [ownedHistoryNotice, setOwnedHistoryNotice] = useState<{
    owner: string;
    message: string;
  }>();
  const [ownedHistoryDiff, setOwnedHistoryDiff] = useState<{
    owner: string;
    pair: string;
    value: DiffResult;
  }>();
  const [historyDiffLoadingOwner, setHistoryDiffLoadingOwner] = useState("");
  const [streamSwitch, setStreamSwitch] = useState<{
    stream: StreamSummary;
    source: HTMLElement | null;
  }>();
  const consumedHistoryCursors = useRef(new Set<string>());
  const pendingHistoryCursors = useRef(new Set<string>());
  const scroll = useRef<HTMLDivElement>(null);
  const scope = useMemo(
    () => makeReviewScope(runtime, queryPath),
    [
      queryPath,
      runtime.activeProfileId,
      runtime.context.client,
      runtime.context.cwd,
      runtime.context.server,
      runtime.context.user,
      runtime.contextGeneration,
    ],
  );
  const historySession = reviewSessionIdentity(runtime, "history", scope);
  const historyIdentity = reviewRequestIdentity(
    runtime,
    scope,
    "history",
    "history",
  );
  const historyOwner = reviewRequestIdentityKey(historyIdentity);
  const streamOwner = JSON.stringify([
    "streams",
    runtime.mode,
    runtime.activeProfileId,
    runtime.contextGeneration,
    runtime.context,
  ]);
  const viewOwner = kind === "history" ? historyOwner : streamOwner;
  const currentOwner = useRef(viewOwner);
  currentOwner.current = viewOwner;
  const requests = useReviewRequestOwner(historySession);
  const displayCurrent =
    (kind !== "history" || target === queryPath) &&
    runtime.p4Version !== "loading";
  const rows =
    displayCurrent && ownedRows?.owner === viewOwner ? ownedRows.value : [];
  const loading = displayCurrent && loadingOwner === viewOwner;
  const error =
    displayCurrent && ownedError?.owner === viewOwner ? ownedError.message : "";
  const historyNotice =
    displayCurrent && ownedHistoryNotice?.owner === viewOwner
      ? ownedHistoryNotice.message
      : "";
  const historyDiff =
    displayCurrent && ownedHistoryDiff?.owner === historyOwner
      ? ownedHistoryDiff.value
      : undefined;
  const historyDiffLoading =
    displayCurrent && historyDiffLoadingOwner === historyOwner;
  const key = useMemo(() => ["read-only", viewOwner], [viewOwner]);
  useEffect(() => {
    if (runtime.p4Version === "loading" || (kind === "history" && !queryPath)) {
      requests.cancelAll();
      setOwnedRows(undefined);
      setSelected(undefined);
      setHistoryCursor(undefined);
      setHistoryHasMore(false);
      setOwnedHistoryNotice(undefined);
      setOwnedHistoryDiff(undefined);
      setHistoryDiffLoadingOwner("");
      setLoadingOwner("");
      return;
    }
    let live = true;
    const lease =
      kind === "history"
        ? requests.start("primary", historyIdentity)
        : undefined;
    setLoadingOwner(viewOwner);
    setOwnedError(undefined);
    setSelected(undefined);
    setOwnedHistoryDiff(undefined);
    setHistoryDiffLoadingOwner("");
    consumedHistoryCursors.current.clear();
    pendingHistoryCursors.current.clear();
    const cached = cache.getQueryData<FileHistoryPage | StreamSummary[]>(key);
    const cachedRows =
      kind === "history"
        ? ((cached as FileHistoryPage | undefined)?.items ?? [])
        : ((cached as StreamSummary[] | undefined) ?? []);
    setOwnedRows({ owner: viewOwner, value: cachedRows });
    const request =
      kind === "history"
        ? backend.getFileHistory({
            scope,
            pageSize: 100,
            refresh: refresh > 0,
            operationId: lease!.operationId,
          })
        : backend.listStreams();
    void request
      .then((data) => {
        if (
          !live ||
          currentOwner.current !== viewOwner ||
          (lease && !requests.isCurrent(lease))
        )
          return;
        cache.setQueryData(key, data);
        if (kind === "history") {
          const page = data as FileHistoryPage;
          setOwnedRows({ owner: viewOwner, value: page.items });
          setHistoryCursor(page.nextCursor);
          setHistoryHasMore(page.hasMore);
          setOwnedHistoryNotice({
            owner: viewOwner,
            message: page.truncated
              ? zh
                ? "历史结果达到安全上限，当前结果已截断。"
                : "History reached its safety limit and was truncated."
              : page.partial
                ? zh
                  ? "历史结果不完整。"
                  : "History results are partial."
                : "",
          });
        } else
          setOwnedRows({ owner: viewOwner, value: data as StreamSummary[] });
      })
      .catch((cause) => {
        if (
          live &&
          currentOwner.current === viewOwner &&
          (!lease || requests.isCurrent(lease)) &&
          !isCancellation(cause)
        )
          setOwnedError({ owner: viewOwner, message: String(cause) });
      })
      .finally(() => {
        const finished = lease ? requests.finish(lease) : live;
        if (finished && currentOwner.current === viewOwner) setLoadingOwner("");
      });
    return () => {
      live = false;
      if (kind === "history") requests.cancelAll();
    };
  }, [viewOwner, kind, queryPath, refresh, runtime.p4Version]);
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
  const visibleSelected =
    displayCurrent && selected && rows.includes(selected)
      ? selected
      : undefined;
  const menu = useContextMenu();
  const selection = useRecordSelection(
    filtered,
    (item) => ("stream" in item ? item.stream : String(item.revision)),
    JSON.stringify(key),
  );
  const compareHistory = async (items: (FileRevision | StreamSummary)[]) => {
    const revisions = items.filter(
      (item): item is FileRevision => "revision" in item,
    );
    const pair = historyDiffPair(revisions);
    if (!pair) return;
    const pairIdentity = JSON.stringify(pair);
    const diffScope = makeReviewScope(runtime, revisions[0].depotPath);
    const identity = reviewRequestIdentity(
      runtime,
      diffScope,
      "history",
      "history-diff",
      { ...pair },
    );
    const lease = requests.start("history-diff", identity);
    const ownerAtStart = historyOwner;
    setHistoryDiffLoadingOwner(ownerAtStart);
    setOwnedHistoryDiff(undefined);
    setOwnedError(undefined);
    try {
      const result = await backend.getDiff({
        scope: diffScope,
        ...pair,
        operationId: lease.operationId,
      });
      if (requests.isCurrent(lease) && currentOwner.current === ownerAtStart)
        setOwnedHistoryDiff({
          owner: ownerAtStart,
          pair: pairIdentity,
          value: result,
        });
    } catch (cause) {
      if (
        requests.isCurrent(lease) &&
        currentOwner.current === ownerAtStart &&
        !isCancellation(cause)
      )
        setOwnedError({ owner: ownerAtStart, message: String(cause) });
    } finally {
      if (requests.finish(lease) && currentOwner.current === ownerAtStart)
        setHistoryDiffLoadingOwner("");
    }
  };
  const reload = async () => {
    await cache.invalidateQueries({ queryKey: key });
    setRefresh((v) => v + 1);
  };
  const refreshAfterStreamSwitch = () => {
    for (const activePage of [
      "streams",
      "workspaces",
      "pending",
      "submitted",
      "search",
      "files",
      "depot",
    ])
      window.dispatchEvent(
        new CustomEvent("p4deck:auto-refresh", { detail: { activePage } }),
      );
    window.dispatchEvent(new Event("p4deck:pending-refresh"));
    void reload();
  };
  useEffect(() => {
    const autoRefresh = (event: Event) => {
      const detail = (event as CustomEvent<{ activePage?: string }>).detail;
      if (detail?.activePage === kind) void reload();
    };
    window.addEventListener("p4deck:auto-refresh", autoRefresh);
    return () => window.removeEventListener("p4deck:auto-refresh", autoRefresh);
  }, [kind, viewOwner]);
  useEffect(() => {
    if (kind !== "streams" || !navigation) return;
    setSearch(navigation.stream);
    scroll.current?.scrollTo(0, 0);
  }, [kind, navigation]);
  const virtual = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => scroll.current,
    estimateSize: () => 52,
    overscan: 8,
  });
  return (
    <section className="workspaces-page">
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
        {kind === "streams" && (
          <button disabled={!onOpenStreamGraph} onClick={onOpenStreamGraph}>
            <Network size={15} />
            {zh ? "打开 Stream 图" : "Open Stream Graph"}
          </button>
        )}
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
        {kind === "history" && (
          <SwarmAction
            runtime={runtime}
            zh={zh}
            target={{ kind: "file", depotPath: queryPath }}
          />
        )}
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
        {kind === "history" && (
          <button
            disabled={
              historyDiffLoading ||
              !historyDiffPair(selection.selected as FileRevision[])
            }
            onClick={() => void compareHistory(selection.selected)}
          >
            {historyDiffLoading
              ? zh
                ? "比较中…"
                : "Comparing…"
              : zh
                ? "比较所选两个版本"
                : "Compare two selected revisions"}
          </button>
        )}
        {historyDiffLoading && (
          <button
            onClick={() => {
              requests.cancel("history-diff");
              setHistoryDiffLoadingOwner("");
            }}
          >
            {zh ? "取消比较" : "Cancel comparison"}
          </button>
        )}
      </div>
      {kind === "history" && historyHasMore && (
        <button
          className="load-more-button"
          disabled={loading || !historyCursor}
          onClick={() => {
            const cursor = historyCursor;
            if (
              !cursor ||
              consumedHistoryCursors.current.has(cursor) ||
              pendingHistoryCursors.current.has(cursor)
            )
              return;
            pendingHistoryCursors.current.add(cursor);
            const identity = reviewRequestIdentity(
              runtime,
              scope,
              "history",
              "history-page",
              { cursor },
            );
            const lease = requests.start("history-page", identity);
            const ownerAtStart = historyOwner;
            setLoadingOwner(ownerAtStart);
            setOwnedError(undefined);
            void backend
              .getFileHistory({
                scope,
                pageSize: 100,
                cursor,
                operationId: lease.operationId,
              })
              .then((page) => {
                if (
                  !requests.isCurrent(lease) ||
                  currentOwner.current !== ownerAtStart
                )
                  return;
                consumedHistoryCursors.current.add(cursor);
                const nonProgressing =
                  page.hasMore &&
                  (!page.nextCursor ||
                    page.nextCursor === cursor ||
                    consumedHistoryCursors.current.has(page.nextCursor));
                setOwnedRows((current) => ({
                  owner: ownerAtStart,
                  value: mergeHistoryRows(
                    current?.owner === ownerAtStart
                      ? (current.value as FileRevision[])
                      : [],
                    page.items,
                  ),
                }));
                setHistoryCursor(nonProgressing ? undefined : page.nextCursor);
                setHistoryHasMore(nonProgressing ? false : page.hasMore);
                if (nonProgressing)
                  setOwnedError({
                    owner: ownerAtStart,
                    message: zh
                      ? "后端返回了重复游标；已保留当前历史记录。"
                      : "The backend returned a repeated cursor; current history was preserved.",
                  });
              })
              .catch((cause) => {
                if (
                  requests.isCurrent(lease) &&
                  currentOwner.current === ownerAtStart &&
                  !isCancellation(cause)
                )
                  setOwnedError({
                    owner: ownerAtStart,
                    message: String(cause),
                  });
              })
              .finally(() => {
                pendingHistoryCursors.current.delete(cursor);
                if (
                  requests.finish(lease) &&
                  currentOwner.current === ownerAtStart
                )
                  setLoadingOwner("");
              });
          }}
        >
          {zh ? "加载更多历史" : "Load more history"}
        </button>
      )}
      {error && (
        <div role="alert" className="workspace-load-error">
          {error}
        </div>
      )}
      {historyNotice && (
        <div role="status" className="workspace-load-error">
          {historyNotice}
        </div>
      )}
      {streamSwitch && (
        <StreamSwitchDialog
          stream={streamSwitch.stream}
          runtime={runtime}
          connectionKey={streamOwner}
          source={streamSwitch.source}
          zh={zh}
          onDismiss={() => setStreamSwitch(undefined)}
          onRuntime={onRuntime}
          onRefresh={refreshAfterStreamSwitch}
        />
      )}
      <div
        className={`workspace-layout ${visibleSelected ? "with-detail" : ""}`}
      >
        <section className="workspace-panel">
          <div
            ref={scroll}
            className="workspace-table-scroll"
            tabIndex={0}
            {...menu(kind === "streams" ? "W06" : "V08", () => ({
              刷新: action(reload),
              刷新当前视图: action(reload),
              复制当前目标标识: copy(queryPath),
              ...(kind === "history"
                ? {
                    "在 Swarm 中打开": swarmMenuAction(runtime, zh, {
                      kind: "file",
                      depotPath: queryPath,
                    }),
                  }
                : {}),
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
                      if (kind === "history") {
                        requests.cancel("history-diff");
                        setHistoryDiffLoadingOwner("");
                        setOwnedHistoryDiff(undefined);
                      }
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
                              "切换当前工作区到此 Stream": action(() =>
                                setStreamSwitch({ stream: item, source: null }),
                              ),
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
                              ...(historyDiffPair(
                                selection.targets(item) as FileRevision[],
                              )
                                ? {
                                    比较所选两个版本: action(
                                      () =>
                                        void compareHistory(
                                          selection.targets(item),
                                        ),
                                    ),
                                  }
                                : {}),
                              "复制 Depot 路径": copy(queryPath),
                              复制精确修订标识: copy(
                                `${queryPath}#${item.revision}`,
                              ),
                              "复制 CL 编号": copy(item.changelistId),
                              "在 Swarm 中打开": swarmMenuAction(runtime, zh, {
                                kind: "file",
                                depotPath: queryPath,
                                revision: item.revision,
                              }),
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
                          if (kind === "history") {
                            requests.cancel("history-diff");
                            setHistoryDiffLoadingOwner("");
                            setOwnedHistoryDiff(undefined);
                          }
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
        {visibleSelected && (
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
              {Object.entries(visibleSelected)
                .filter(([name]) => name !== "description")
                .map(([name, value]) => (
                  <div key={name}>
                    <dt>{name}</dt>
                    <dd>{String(value)}</dd>
                  </div>
                ))}
            </dl>
            <p className="workspace-description">
              {visibleSelected.description}
            </p>
            {"stream" in visibleSelected && (
              <button
                onClick={(event) =>
                  setStreamSwitch({
                    stream: visibleSelected,
                    source: event.currentTarget,
                  })
                }
              >
                {zh
                  ? "切换当前工作区到此 Stream…"
                  : "Switch current workspace to this stream…"}
              </button>
            )}
          </aside>
        )}
      </div>
      {historyDiff && (
        <pre
          className="graph-node-diff"
          aria-label={zh ? "历史版本差异" : "History revision diff"}
        >
          {historyDiff.unified ||
            historyDiff.reason ||
            (zh ? "无差异" : "No differences")}
        </pre>
      )}
    </section>
  );
}
