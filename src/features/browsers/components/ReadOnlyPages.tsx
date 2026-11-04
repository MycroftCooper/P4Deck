import { t } from "../../../shared/i18n";
import { useColumnWidths } from "../../../app/context-menu/useColumnWidths";
import {
  SyncDialog,
  type SyncDialogRequest,
} from "../../files/components/SyncDialog";
import {
  UndoDialog,
  type UndoDialogRequest,
} from "../../files/components/UndoDialog";
import { useChangeDetails } from "../../changelists/components/ChangeDetailsDialog";
import { commandActions } from "../../../app/commands/actionCatalog";
import {
  CommandExecutionContext,
  useCommandFocus,
} from "../../../app/shell/CommandContext";
import { PageActiveContext } from "../../../app/docking/chrome";
import { HistoryTable } from "./HistoryTable";
import { FixedPageHeader } from "../../../app/docking/chrome";
import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { PageRefreshSlotContext } from "../../../app/docking/chrome";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Network, RefreshCw, Search } from "lucide-react";
import { backend } from "../../../infrastructure/backend";
import type {
  FileHistoryPage,
  FileRevision,
  RuntimeInfo,
  StreamSummary,
} from "../../../shared/contracts";

import { useContextMenu } from "../../../app/context-menu/ContextMenu";
import { TableHeader } from "../../../app/context-menu/TableHeader";
import { action, copy } from "../../../app/context-menu/bindings";
import { useRecordSelection } from "../../../app/context-menu/useRecordSelection";
import {
  historyDiffPair,
  historyMenuQueue,
  makeReviewScope,
  mergeHistoryRows,
} from "../reviewModel";
import {
  isCancellation,
  reviewRequestIdentity,
  reviewRequestIdentityKey,
  reviewSessionIdentity,
  useReviewRequestOwner,
} from "../reviewRequests";
import { StreamSwitchDialog } from "./StreamSwitchDialog";
import { swarmMenuAction } from "../../swarm/SwarmAction";
import { appCache } from "../../../shared/cache/appCache";
import {
  CACHE_POLICY,
  serverScope,
  snapshotKey,
} from "../../../shared/cache/policy";
import { isFresh, writeSnapshot } from "../../../shared/cache/snapshots";
import { useSnapshotQuery } from "../../../shared/cache/useSnapshotQuery";
import { useViewRefresh } from "../../../shared/cache/useViewRefresh";
import { invalidateData } from "../../../shared/cache/dataEffects";
import { pageActions } from "../../../app/commands/actionCatalog";

export function isStreamList(value: unknown): value is StreamSummary[] {
  return (
    Array.isArray(value) &&
    value.every(
      (item) =>
        !!item &&
        typeof item.stream === "string" &&
        typeof item.name === "string" &&
        typeof item.parent === "string" &&
        typeof item.kind === "string",
    )
  );
}

function historyNoticeFor(page: FileHistoryPage, _zh: boolean) {
  return page.truncated
    ? t("browse.history.reached.its.safety.limit")
    : page.partial
      ? t("browse.history.results.are.partial")
      : "";
}

export function ReadOnlyPage({
  kind,
  runtime,
  target = "",
  locked,
  onRuntime,
  onPreviewChange,
  onOpenStreamGraph,
  onOpenBranchMappings,
  navigation,
  zh,
}: {
  kind: "history" | "streams";
  runtime: RuntimeInfo;
  target?: string;
  locked?: boolean;
  onTargetChange?(path: string): void;
  onRuntime?(runtime: RuntimeInfo): void;
  onPreviewChange?(changeId: number): void | Promise<void>;
  onOpenStreamGraph?(): void;
  onOpenBranchMappings?(): void;
  navigation?: { stream: string; nonce: number };
  zh: boolean;
}) {
  const remoteReady =
    runtime.p4Version !== "loading" && runtime.connection.state === "connected";
  const refreshSlot = useContext(PageRefreshSlotContext);
  const streamColumns = useColumnWidths([300, 260, 420], [160, 150, 180], {
    id: "streams",
  });
  const [queryPath, setQueryPath] = useState(target);
  useEffect(() => {
    setQueryPath(target);
  }, [target]);
  const [search, setSearch] = useState("");
  const [undoRequest, setUndoRequest] = useState<UndoDialogRequest>();
  const [syncRequest, setSyncRequest] = useState<SyncDialogRequest>();
  const [ownedRows, setOwnedRows] = useState<{
    owner: string;
    value: (FileRevision | StreamSummary)[];
    loaded?: boolean;
  }>();
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
  useEffect(() => {
    setSyncRequest(undefined);
    setUndoRequest(undefined);
  }, [viewOwner]);
  const currentOwner = useRef(viewOwner);
  currentOwner.current = viewOwner;
  const requests = useReviewRequestOwner(historySession);
  const displayCurrent = kind !== "history" || target === queryPath;
  // Streams are a server snapshot shared by every Streams tab and restarts.
  const streamKey = useMemo(
    () => snapshotKey("streams", serverScope(runtime)),
    [
      runtime.mode,
      runtime.activeProfileId,
      runtime.context.server,
      runtime.context.user,
    ],
  );
  const streams = useSnapshotQuery({
    key: streamKey,
    enabled: kind === "streams" && remoteReady,
    fetch: () => backend.listStreams(),
    persist: kind === "streams" ? isStreamList : undefined,
  });
  // History is target data: fresh pages are shown without asking P4.
  const historyKey = useMemo(
    () => ["target", "history", historyOwner],
    [historyOwner],
  );
  const key = kind === "history" ? historyKey : streamKey;
  const refreshSeen = useRef(refresh);
  const rows =
    kind === "streams"
      ? displayCurrent
        ? (streams.data ?? [])
        : []
      : displayCurrent && ownedRows?.owner === viewOwner
        ? ownedRows.value
        : [];
  const rowsLoaded =
    kind === "streams"
      ? streams.data !== undefined
      : ownedRows?.owner === viewOwner && !!ownedRows.loaded;
  const loading =
    displayCurrent &&
    (kind === "streams"
      ? streams.initialLoading || streams.refreshing
      : loadingOwner === viewOwner);
  const error =
    displayCurrent && ownedError?.owner === viewOwner
      ? ownedError.message
      : displayCurrent && kind === "streams"
        ? streams.error
        : "";
  const historyNotice =
    displayCurrent && ownedHistoryNotice?.owner === viewOwner
      ? ownedHistoryNotice.message
      : "";
  useEffect(() => {
    if (kind !== "history") return;
    if (kind === "history" && !queryPath) {
      requests.cancelAll();
      setOwnedRows(undefined);
      setHistoryCursor(undefined);
      setHistoryHasMore(false);
      setOwnedHistoryNotice(undefined);

      setLoadingOwner("");
      return;
    }
    const forced = refreshSeen.current !== refresh;
    refreshSeen.current = refresh;
    const cached = appCache.getQueryData<FileHistoryPage>(historyKey);
    if (
      cached &&
      !forced &&
      isFresh(historyKey, CACHE_POLICY.target.staleTime)
    ) {
      if (ownedRows?.owner !== viewOwner) {
        consumedHistoryCursors.current.clear();
        pendingHistoryCursors.current.clear();
        setOwnedRows({ owner: viewOwner, value: cached.items, loaded: true });
        setHistoryCursor(cached.nextCursor);
        setHistoryHasMore(cached.hasMore);
        setOwnedHistoryNotice({
          owner: viewOwner,
          message: historyNoticeFor(cached, zh),
        });
      }
      setOwnedError(undefined);
      setLoadingOwner("");
      return;
    }
    if (!remoteReady) {
      setOwnedRows((previous) =>
        previous?.owner === viewOwner
          ? previous
          : {
              owner: viewOwner,
              value: cached?.items ?? [],
              loaded: cached !== undefined,
            },
      );
      if (cached && ownedRows?.owner !== viewOwner) {
        setHistoryCursor(cached.nextCursor);
        setHistoryHasMore(cached.hasMore);
        setOwnedHistoryNotice({
          owner: viewOwner,
          message: historyNoticeFor(cached, zh),
        });
      }
      setOwnedError(undefined);
      setLoadingOwner("");
      return;
    }
    let live = true;
    const lease = requests.start("primary", historyIdentity);
    setLoadingOwner(viewOwner);
    setOwnedError(undefined);
    consumedHistoryCursors.current.clear();
    pendingHistoryCursors.current.clear();
    // Stale rows stay visible while the replacement page loads.
    setOwnedRows((previous) =>
      previous?.owner === viewOwner
        ? previous
        : {
            owner: viewOwner,
            value: cached?.items ?? [],
            loaded: cached !== undefined,
          },
    );
    void backend
      .getFileHistory({
        scope,
        pageSize: 100,
        refresh: refresh > 0,
        operationId: lease.operationId,
      })
      .then((page) => {
        if (
          !live ||
          currentOwner.current !== viewOwner ||
          !requests.isCurrent(lease)
        )
          return;
        writeSnapshot(historyKey, page);
        setOwnedRows({ owner: viewOwner, value: page.items, loaded: true });
        setHistoryCursor(page.nextCursor);
        setHistoryHasMore(page.hasMore);
        setOwnedHistoryNotice({
          owner: viewOwner,
          message: historyNoticeFor(page, zh),
        });
      })
      .catch((cause) => {
        if (
          live &&
          currentOwner.current === viewOwner &&
          requests.isCurrent(lease) &&
          !isCancellation(cause)
        )
          setOwnedError({ owner: viewOwner, message: String(cause) });
      })
      .finally(() => {
        if (requests.finish(lease) && currentOwner.current === viewOwner)
          setLoadingOwner("");
      });
    return () => {
      live = false;
      requests.cancelAll();
    };
  }, [viewOwner, kind, queryPath, refresh, remoteReady]);
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
  const streamNavigationNotice =
    kind === "streams" && navigation && search === navigation.stream && !loading
      ? rows.some((row) => "stream" in row && row.stream === navigation.stream)
        ? zh
          ? `已定位 Stream：${navigation.stream}`
          : `Located stream: ${navigation.stream}`
        : zh
          ? `已在 Streams 中搜索 ${navigation.stream}，当前列表没有精确匹配。`
          : `Searching Streams for ${navigation.stream}; the current list has no exact match.`
      : "";
  const menu = useContextMenu();
  const openChangeDetails = useChangeDetails();
  const selection = useRecordSelection(
    filtered,
    (item) =>
      "stream" in item ? item.stream : `${item.depotPath}#${item.revision}`,
    JSON.stringify(key),
    kind === "history" ? 2 : Infinity,
  );
  const focus = useCommandFocus();
  const execute = useContext(CommandExecutionContext);
  const active = useContext(PageActiveContext);
  const selectedHistory = selection.selected.filter(
    (item): item is FileRevision => "revision" in item,
  );
  const selectionKey = selectedHistory
    .map((item) => `${item.depotPath}#${item.revision}`)
    .join(",");
  useEffect(() => {
    if (kind !== "history" || !active) return;
    const path = selectedHistory[0]?.depotPath ?? queryPath;
    focus({
      type: "history",
      path: selectedHistory.every((item) => item.depotPath === path)
        ? path
        : "",
      revisions: selectedHistory.map((item) => item.revision),
    });
  }, [active, kind, historyOwner, selectionKey, locked, focus]);
  const compareHistory = (items: (FileRevision | StreamSummary)[]) => {
    const revisions = items.filter(
      (item): item is FileRevision => "revision" in item,
    );
    if (historyDiffPair(revisions))
      execute("diff", {
        type: "history",
        path: revisions[0].depotPath,
        revisions: revisions.map((item) => item.revision),
      });
  };
  const reload = async () => {
    if (!remoteReady) return;
    if (kind === "streams") {
      await streams.refresh();
      return;
    }
    await appCache.invalidateQueries({ queryKey: historyKey });
    setRefresh((v) => v + 1);
  };
  const refreshAfterStreamSwitch = () => {
    // A stream switch is a barrier: every snapshot may describe the old view.
    void invalidateData(pageActions.switchStream.effects);
    void reload();
  };
  // Auto-refresh and stale tab activation revalidate without clearing rows.
  useViewRefresh(
    kind,
    key,
    () => {
      if (remoteReady && !loading && (kind === "streams" || queryPath))
        void reload();
    },
    kind === "history" ? CACHE_POLICY.target.staleTime : undefined,
  );
  useEffect(() => {
    if (kind !== "streams" || !navigation) return;
    setSearch(navigation.stream);
    scroll.current?.scrollTo?.(0, 0);
  }, [kind, navigation]);
  const historyMenu = (item: FileRevision) =>
    menu(
      "H01",
      () => {
        const queue = historyMenuQueue(selectedHistory, item);
        const newest = queue.at(-1)!;
        const valid =
          Number.isSafeInteger(newest.revision) &&
          newest.revision > 0 &&
          newest.depotPath.startsWith("//");
        return {
          "预览 CL": action(
            (source) =>
              openChangeDetails
                ? openChangeDetails(
                    { kind: "submitted", changeId: item.changelistId },
                    source,
                  )
                : onPreviewChange?.(item.changelistId),
            item.changelistId > 0 && (openChangeDetails || onPreviewChange)
              ? undefined
              : t("browse.no.submitted.cl.is.available"),
          ),
          获取这个版本: action(
            (source) =>
              setSyncRequest({
                nodes: [
                  {
                    id: newest.depotPath,
                    name: newest.depotPath.split("/").pop() || newest.depotPath,
                    kind: "file",
                    absolutePath: "",
                    relativePath: newest.depotPath,
                    depotPath: newest.depotPath,
                    state: "controlled",
                  },
                ],
                revisionMode: "choose",
                fixedRevision: newest.revision,
                scopeLabel: `${t("browse.most.recently.selected")}: ${newest.depotPath}#${newest.revision}`,
                source: source ?? null,
              }),
            remoteReady && valid
              ? undefined
              : t("browse.connection.or.file.revision.is"),
          ),
          Undo: action(
            (source) =>
              setUndoRequest({
                depotPath: item.depotPath,
                revision: item.revision,
                changelistId: item.changelistId,
                source: source ?? null,
              }),
            remoteReady ? undefined : t("browse.connection.unavailable"),
          ),
          Diff: action(
            () => compareHistory(queue),
            historyDiffPair(queue)
              ? undefined
              : t("browse.select.two.valid.revisions.of"),
          ),
        };
      },
      {
        title: `${item.depotPath}#${item.revision} · ${t("browse.get.target.latest.selection")} #${historyMenuQueue(selectedHistory, item).at(-1)!.revision}`,
        onOpen: () => selection.context(item),
      },
    );
  const recordMenu = (item: StreamSummary) =>
    menu(
      selection.targets(item).length > 1 ? "W05" : "W04",
      () => ({
        查看详情: { hidden: true },
        "复制 Stream 路径": copy(item.stream),
        复制名称: copy(item.name),
        "复制父 Stream 路径": copy(item.parent),
        "W04-08": action(() => setStreamSwitch({ stream: item, source: null })),
        刷新: action(reload),
        "复制 Stream 路径列表": copy(
          selection
            .targets(item)
            .map((value) => ("stream" in value ? value.stream : ""))
            .join("\n"),
        ),
        复制名称列表: copy(
          selection
            .targets(item)
            .map((value) => ("stream" in value ? value.name : ""))
            .join("\n"),
        ),
      }),
      {
        onOpen: () => {
          selection.context(item);
        },
      },
    );
  const virtual = useVirtualizer({
    enabled: kind === "streams",
    count: kind === "streams" ? filtered.length : 0,
    getScrollElement: () => scroll.current,
    estimateSize: () => 52,
    overscan: 8,
  });
  const refreshButton = (
    <button
      type="button"
      title={t("browse.refresh")}
      aria-label={t("browse.refresh")}
      aria-busy={loading}
      disabled={loading || !remoteReady || (kind === "history" && !queryPath)}
      onClick={() => void reload()}
    >
      <RefreshCw
        size={15}
        className={loading ? "spin" : ""}
        aria-hidden="true"
      />
      {kind === "streams" || !refreshSlot ? (
        <span>{t("browse.refresh")}</span>
      ) : null}
    </button>
  );
  return (
    <section
      className={`workspaces-page${kind === "history" ? " history-page" : ""}`}
    >
      {undoRequest && (
        <UndoDialog
          request={undoRequest}
          zh={zh}
          onDismiss={() => setUndoRequest(undefined)}
          onRefresh={() => invalidateData(commandActions.getRevision.effects)}
        />
      )}
      {syncRequest && (
        <SyncDialog
          request={syncRequest}
          connectionKey={viewOwner}
          demo={runtime.mode === "mock"}
          zh={zh}
          onDismiss={() => setSyncRequest(undefined)}
          onRefresh={() => invalidateData(commandActions.getRevision.effects)}
        />
      )}
      {kind === "history" ? (
        refreshSlot ? (
          createPortal(refreshButton, refreshSlot)
        ) : (
          refreshButton
        )
      ) : (
        <FixedPageHeader
          description={t("browse.streams.types.and.parent.relationships")}
        >
          <div className="section-title-actions">
            <button disabled={!onOpenStreamGraph} onClick={onOpenStreamGraph}>
              <Network size={15} />
              {t("browse.open.stream.graph")}
            </button>
            <button
              disabled={!onOpenBranchMappings}
              onClick={onOpenBranchMappings}
            >
              {t("browse.open.branch.mappings")}
            </button>
          </div>
          {refreshButton}
        </FixedPageHeader>
      )}
      <div className="query-bar">
        <label className="search-field">
          <Search size={15} />
          <input
            aria-label={t("browse.search.list")}
            placeholder={t("browse.search.list.2")}
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              scroll.current?.scrollTo(0, 0);
            }}
          />
        </label>
        <span className="filter-count">
          {filtered.length} {t("browse.records")}
        </span>
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
                  loaded: true,
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
                    message: t("browse.the.backend.returned.a.repeated.2"),
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
          {t("browse.load.more.history")}
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
      {streamNavigationNotice && (
        <div role="status" className="workspace-load-error">
          {streamNavigationNotice}
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
      <div className="workspace-layout">
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
            {kind === "history" ? (
              <HistoryTable
                key={historyOwner}
                rows={filtered as FileRevision[]}
                scroll={scroll}
                zh={zh}
                isSelected={selection.isSelected}
                selectionOrder={(item) =>
                  selectedHistory.findIndex(
                    (selected) =>
                      selected.depotPath === item.depotPath &&
                      selected.revision === item.revision,
                  ) + 1
                }
                rowMenu={historyMenu}
                onSelect={(item, event) => {
                  selection.select(item, event);
                }}
              />
            ) : (
              <>
                <TableHeader
                  className="browser-columns workspace-head"
                  resize={streamColumns}
                  columns={[
                    { id: "stream", label: "Stream" },
                    { id: "parent", label: "Type / Parent" },
                    { id: "description", label: t("browse.description") },
                  ]}
                />
                <div
                  className="virtual-spacer"
                  style={{
                    height: virtual.getTotalSize(),
                    minWidth: streamColumns.style.minWidth,
                  }}
                >
                  {virtual.getVirtualItems().map((row) => {
                    const item = filtered[row.index];
                    return (
                      <button
                        key={"stream" in item ? item.stream : item.revision}
                        className={`browser-columns workspace-row ${selection.isSelected(item) ? "selected" : ""}`}
                        style={{
                          ...streamColumns.style,
                          height: row.size,
                          transform: `translateY(${row.start}px)`,
                        }}
                        onClick={(event) => {
                          selection.select(item, event);
                        }}
                        {...recordMenu(item as StreamSummary)}
                      >
                        <span
                          title={
                            "stream" in item
                              ? item.stream
                              : String(item.revision)
                          }
                        >
                          {"stream" in item
                            ? item.stream
                            : `#${item.revision} · CL ${item.changelistId}`}
                        </span>
                        <span
                          title={
                            "stream" in item
                              ? `${item.kind} · ${item.parent}`
                              : item.user
                          }
                        >
                          {"stream" in item
                            ? `${item.kind} · ${item.parent}`
                            : item.user}
                        </span>
                        <span title={item.description}>{item.description}</span>
                      </button>
                    );
                  })}
                </div>
              </>
            )}
            {!filtered.length && (
              <div className="workspace-empty">
                {loading && !rowsLoaded
                  ? t("browse.loading.2")
                  : error
                    ? t("browse.loading.failed.refresh.to.retry")
                    : kind === "history" && !queryPath
                      ? t("browse.select.a.file.before.opening")
                      : t("browse.no.matching.records")}
              </div>
            )}
          </div>
          <footer className="list-footer">
            {kind === "history" ? queryPath : runtime.context.server}
          </footer>
        </section>
      </div>
    </section>
  );
}
