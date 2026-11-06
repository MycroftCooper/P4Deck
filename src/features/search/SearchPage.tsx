import { t, tFor, type MsgKey } from "../../shared/i18n";
import { FixedPageHeader } from "../../app/docking/chrome";
import {
  AlertTriangle,
  ArrowDown,
  ChevronRight,
  File,
  FolderSearch,
  Hash,
  LoaderCircle,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { backend } from "../../infrastructure/backend";
import {
  useOperationSession,
  type OperationLease,
} from "../../shared/operationSession";
import type {
  GlobalSearchItem,
  GlobalSearchKind,
  GlobalSearchResult,
  GlobalSearchTarget,
} from "../../shared/contracts";
import {
  errorMessage,
  GLOBAL_SEARCH_KINDS,
  GLOBAL_SEARCH_MAX_CHARACTERS,
  GLOBAL_SEARCH_PAGE_SIZE,
  highlightedSegments,
  itemsFromGroups,
  mergeSearchItems,
  validateSearchText,
} from "./searchModel";

type SearchFacet = GlobalSearchResult["facets"][number];
type SearchPhase = "idle" | "loading" | "ready" | "error";
type RequestMode = "fresh" | "append" | "category";

/** The search session channel: one lease per submitted query. */
const SEARCH = "search";

const KIND_ICON: Record<GlobalSearchKind, typeof File> = {
  submittedChange: Hash,
  pendingChange: Hash,
  workspaceFile: File,
  depotFile: File,
  job: Hash,
  stream: FolderSearch,
  shelf: Hash,
};

function kindLabel(kind: GlobalSearchKind, zh: boolean): string {
  const labels: Record<GlobalSearchKind, [string, string]> = {
    submittedChange: ["search.submittedChange", "search.submittedChange"],
    pendingChange: ["search.pendingChange", "search.pendingChange"],
    workspaceFile: ["search.workspaceFile", "search.workspaceFile"],
    depotFile: ["search.depotFile", "search.depotFile"],
    job: ["Job", "Jobs"],
    stream: ["Stream", "Streams"],
    shelf: ["Shelf", "Shelves"],
  };
  return tFor(zh ? "zh-CN" : "en-US", labels[kind][0] as MsgKey);
}
function fieldLabel(field: string, zh: boolean): string {
  const labels: Record<string, [string, string]> = {
    title: ["search.title", "search.title"],
    summary: ["search.summary", "search.summary"],
    description: ["search.description", "search.description"],
    user: ["search.user", "search.user"],
    client: ["search.client", "search.client"],
    jobs: ["Job", "Jobs"],
    jobId: ["Job ID", "Job ID"],
    status: ["search.status", "search.status"],
    absolutePath: ["search.absolutePath", "search.absolutePath"],
    depotPath: ["search.depotPath", "search.depotPath"],
    streamPath: ["search.streamPath", "search.streamPath"],
    name: ["search.name", "search.name"],
    owner: ["search.owner", "search.owner"],
    type: ["search.type", "search.type"],
    parent: ["search.parent", "search.parent"],
    changeId: ["search.changeId", "search.changeId"],
    time: ["search.time", "search.time"],
  };
  return labels[field]
    ? tFor(zh ? "zh-CN" : "en-US", labels[field][0] as MsgKey)
    : field;
}

function HighlightedText({
  value,
  field,
  item,
}: {
  value: string;
  field: string;
  item: GlobalSearchItem;
}) {
  return highlightedSegments(value, field, item.highlights).map(
    (segment, index) =>
      segment.highlighted ? (
        <mark key={index}>{segment.text}</mark>
      ) : (
        <span key={index}>{segment.text}</span>
      ),
  );
}

function ResultIdentity({ item, zh }: { item: GlobalSearchItem; zh: boolean }) {
  if (item.target.type === "stream")
    return (
      <span className="search-result-identity">
        <span className="search-result-kind">Stream</span>
        <span>
          {t("search.path")}
          <HighlightedText
            value={item.target.streamPath}
            field="streamPath"
            item={item}
          />
        </span>
      </span>
    );
  if (item.target.type === "shelf") {
    const changeId = String(item.target.changeId);
    return (
      <span className="search-result-identity">
        <span className="search-result-kind">Shelf</span>
        <span>
          {t("search.numbered.cl")}
          <HighlightedText value={changeId} field="changeId" item={item} />
        </span>
      </span>
    );
  }
  return <span className="search-result-kind">{kindLabel(item.kind, zh)}</span>;
}

function VirtualSearchResults({
  items,
  zh,
  navigationBusy,
  onOpen,
}: {
  items: GlobalSearchItem[];
  zh: boolean;
  navigationBusy?: string;
  onOpen(item: GlobalSearchItem): Promise<void>;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 104,
    overscan: 8,
    initialRect: { width: 720, height: 410 },
  });
  const measuredRows = virtualizer.getVirtualItems();
  const rows = measuredRows.length
    ? measuredRows
    : Array.from({ length: Math.min(items.length, 18) }, (_, index) => ({
        index,
        key: items[index].identity,
        start: index * 104,
        size: 104,
        end: (index + 1) * 104,
        lane: 0,
      }));
  const focusIndex = (index: number) => {
    const mounted = scrollRef.current?.querySelector<HTMLButtonElement>(
      `[data-search-index="${index}"]`,
    );
    if (mounted) {
      mounted.focus();
      return;
    }
    virtualizer.scrollToIndex(index, { align: "auto" });
    requestAnimationFrame(() =>
      scrollRef.current
        ?.querySelector<HTMLButtonElement>(`[data-search-index="${index}"]`)
        ?.focus(),
    );
  };
  return (
    <div
      ref={scrollRef}
      className="search-result-list"
      data-testid="search-result-virtual-list"
      role="list"
      style={{ height: Math.min(410, Math.max(82, items.length * 82)) }}
      onKeyDown={(event) => {
        if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key))
          return;
        const current = Number(
          (event.target as HTMLElement).closest<HTMLElement>(
            "[data-search-index]",
          )?.dataset.searchIndex,
        );
        // Search jobs are not listed, so every rendered row is navigable.
        const enabled = items.map((_, index) => index);
        const position = enabled.indexOf(current);
        const next =
          event.key === "Home"
            ? enabled[0]
            : event.key === "End"
              ? enabled.at(-1)!
              : event.key === "ArrowUp"
                ? enabled[Math.max(0, position - 1)]
                : enabled[Math.min(enabled.length - 1, position + 1)];
        if (next !== undefined) {
          event.preventDefault();
          focusIndex(next);
        }
      }}
    >
      <div
        className="search-result-spacer"
        style={{ height: virtualizer.getTotalSize() || items.length * 104 }}
      >
        {rows.map((row) => {
          const item = items[row.index];
          const Icon = KIND_ICON[item.kind];
          return (
            <div
              key={item.identity}
              ref={virtualizer.measureElement}
              data-index={row.index}
              role="listitem"
              aria-setsize={items.length}
              aria-posinset={row.index + 1}
              className="search-result-window-row"
              style={{ transform: `translateY(${row.start}px)` }}
            >
              <button
                data-search-index={row.index}
                className="search-result-row"
                disabled={navigationBusy === item.identity}
                title={tFor(zh ? "zh-CN" : "en-US", "search.open", {
                  p1: item.title,
                })}
                onClick={() => void onOpen(item)}
              >
                <Icon size={16} />
                <span className="search-result-copy">
                  <strong>
                    <HighlightedText
                      value={item.title}
                      field="title"
                      item={item}
                    />
                  </strong>
                  <ResultIdentity item={item} zh={zh} />
                  <span>
                    <HighlightedText
                      value={item.summary}
                      field="summary"
                      item={item}
                    />
                  </span>
                  <small>
                    {t("search.matched")}
                    {item.matchedFields
                      .map((field) => fieldLabel(field, zh))
                      .join(" · ")}
                  </small>
                </span>
                {navigationBusy === item.identity ? (
                  <LoaderCircle className="spin" size={15} />
                ) : (
                  <ChevronRight size={15} />
                )}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function validationMessage(
  reason: "empty" | "control" | "tooLong",
  zh: boolean,
): string {
  if (reason === "control")
    return tFor(
      zh ? "zh-CN" : "en-US",
      "search.search.text.cannot.contain.control",
    );
  if (reason === "tooLong")
    return tFor(
      zh ? "zh-CN" : "en-US",
      "search.search.text.is.limited.to.unicode",
      { p1: zh ? GLOBAL_SEARCH_MAX_CHARACTERS : GLOBAL_SEARCH_MAX_CHARACTERS },
    );
  return tFor(zh ? "zh-CN" : "en-US", "search.enter.a.search.query");
}

export function SearchPage({
  zh,
  runtimeMode,
  onNavigate,
}: {
  zh: boolean;
  runtimeMode: "mock" | "tauri";
  onNavigate(target: GlobalSearchTarget): Promise<void>;
}) {
  const tr = (cn: string, en: string) => (zh ? cn : en);
  const [draft, setDraft] = useState("");
  const [kinds, setKinds] = useState<GlobalSearchKind[]>([
    ...GLOBAL_SEARCH_KINDS,
  ]);
  const [phase, setPhase] = useState<SearchPhase>("idle");
  const [items, setItems] = useState<GlobalSearchItem[]>([]);
  const [facets, setFacets] = useState<SearchFacet[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string>();
  const [partial, setPartial] = useState(false);
  const [safetyLimit, setSafetyLimit] = useState(1000);
  const [simulated, setSimulated] = useState(runtimeMode === "mock");
  const [error, setError] = useState("");
  const [pageError, setPageError] = useState("");
  const [loadingMore, setLoadingMore] = useState(false);
  const [categoryLoading, setCategoryLoading] = useState<GlobalSearchKind>();
  const [navigationBusy, setNavigationBusy] = useState<string>();
  const [navigationNotice, setNavigationNotice] = useState("");

  /**
   * One lease per search session, on a single channel. Submitting starts a
   * lease, append/category requests continue it, and typing or re-filtering
   * abandons it, which is exactly the "later answer must not paint" rule.
   */
  const session = useOperationSession();
  const currentSession = useRef<OperationLease | undefined>(undefined);
  const itemsRef = useRef(items);
  const facetsRef = useRef(facets);
  const nextCursorRef = useRef(nextCursor);
  const hasMoreRef = useRef(hasMore);
  const loadingMoreRef = useRef(loadingMore);
  const usedCursors = useRef(new Set<string>());
  const current = useRef<
    { text: string; kinds: GlobalSearchKind[] } | undefined
  >(undefined);
  itemsRef.current = items;
  facetsRef.current = facets;
  nextCursorRef.current = nextCursor;
  hasMoreRef.current = hasMore;
  loadingMoreRef.current = loadingMore;

  const validation = useMemo(() => validateSearchText(draft), [draft]);
  const kindSignature = kinds.join(",");

  const cancelOperations = useCallback(() => {
    const live = currentSession.current;
    currentSession.current = undefined;
    // `finish` rather than `abandon`: the session may have already published
    // its result, and a published operation must never be cancelled. A request
    // that is still in flight is simply ignored by the lease check below.
    if (live) session.finish(live);
  }, [session]);

  const resetResults = useCallback(() => {
    itemsRef.current = [];
    facetsRef.current = [];
    nextCursorRef.current = undefined;
    hasMoreRef.current = false;
    loadingMoreRef.current = false;
    usedCursors.current.clear();
    setItems([]);
    setFacets([]);
    setHasMore(false);
    setNextCursor(undefined);
    setPartial(false);
    setError("");
    setPageError("");
    setLoadingMore(false);
    setCategoryLoading(undefined);
    setNavigationNotice("");
  }, []);

  const execute = useCallback(
    async (
      lease: OperationLease,
      text: string,
      requestedKinds: GlobalSearchKind[],
      cursor: string | undefined,
      mode: RequestMode,
    ) => {
      const operationId = crypto.randomUUID();
      // The session is the lease, not a counter: a request that outlived its
      // session never writes UI state.
      const live = () => session.isCurrent(lease);
      // The backend only echoes this value, so the session's stable id is used:
      // every request in one session shares it and a new session gets a new
      // one. It is reduced into the safe-integer range so the wire value stays
      // an exact JSON number (`2 ** 53` keeps `Number(x)` idempotent across the
      // send/echo round trip); the lease, not this number, decides staleness.
      const requestGeneration = Number(
        BigInt(`0x${lease.operationId.replace(/-/g, "")}`) % (1n << 53n),
      );
      if (cursor) usedCursors.current.add(cursor);
      if (mode === "append") {
        loadingMoreRef.current = true;
        setLoadingMore(true);
        setPageError("");
      } else if (mode === "category") {
        setCategoryLoading(requestedKinds[0]);
      } else {
        setPhase("loading");
      }
      try {
        const result = await backend.globalSearch({
          operationId,
          requestGeneration,
          text,
          kinds: requestedKinds,
          pageSize: GLOBAL_SEARCH_PAGE_SIZE,
          cursor,
        });
        if (!live() || result.requestGeneration !== requestGeneration) return;
        const incoming = itemsFromGroups(result.groups);
        const invalidContinuation =
          result.hasMore &&
          (!result.nextCursor || usedCursors.current.has(result.nextCursor));

        if (mode === "category") {
          const retriedKind = requestedKinds[0];
          const retained = itemsRef.current.filter(
            (item) => item.kind !== retriedKind,
          );
          const merged = mergeSearchItems(retained, incoming);
          const replacement = result.facets.find(
            (facet) => facet.kind === retriedKind,
          );
          const nextFacets = replacement
            ? facetsRef.current.map((facet) =>
                facet.kind === retriedKind ? replacement : facet,
              )
            : facetsRef.current;
          itemsRef.current = merged;
          facetsRef.current = nextFacets;
          setItems(merged);
          setFacets(nextFacets);
          setPartial(
            nextFacets.some((facet) => facet.partial) || result.hasMore,
          );
          if (result.hasMore)
            setPageError(
              tFor(
                zh ? "zh-CN" : "en-US",
                "search.retry.restored.the.first.items.retry",
                {
                  p1: kindLabel(retriedKind, true),
                  p2: GLOBAL_SEARCH_PAGE_SIZE,
                },
              ),
            );
        } else {
          const merged =
            mode === "append"
              ? mergeSearchItems(itemsRef.current, incoming)
              : mergeSearchItems([], incoming);
          itemsRef.current = merged;
          facetsRef.current = result.facets;
          setItems(merged);
          setFacets(result.facets);
          setPartial(result.partial || invalidContinuation);
          if (invalidContinuation) {
            hasMoreRef.current = false;
            nextCursorRef.current = undefined;
            setHasMore(false);
            setNextCursor(undefined);
            setPageError(t("search.the.backend.returned.a.non.progressing"));
          } else {
            hasMoreRef.current = result.hasMore;
            nextCursorRef.current = result.nextCursor;
            setHasMore(result.hasMore);
            setNextCursor(result.nextCursor);
          }
          setPhase("ready");
        }
        setSafetyLimit(result.stats.safetyLimit);
        setSimulated(result.simulated);
        setError("");
      } catch (cause) {
        if (!live()) return;
        const message = errorMessage(cause);
        if (mode === "append") {
          setPageError(message);
          setPartial(true);
        } else if (mode === "category") {
          setPageError(message);
        } else {
          setError(message);
          setPhase("error");
        }
      } finally {
        // Clear the spinners before nothing else has to: the lease is only
        // retired by the caller, so `live()` still answers honestly here.
        if (live()) {
          if (mode === "append") {
            loadingMoreRef.current = false;
            setLoadingMore(false);
          }
          if (mode === "category") setCategoryLoading(undefined);
        }
      }
    },
    [session, zh],
  );

  /**
   * Search runs only on an explicit submit (Enter or the search button); typing
   * and re-filtering cancel the in-flight request and return to idle instead of
   * chasing the draft with new queries.
   */
  const startSession = useCallback(
    (value: string, selectedKinds: GlobalSearchKind[]) => {
      cancelOperations();
      const lease = session.start(SEARCH);
      currentSession.current = lease;
      resetResults();
      const checked = validateSearchText(value);
      if (!checked.valid || !selectedKinds.length) {
        current.current = undefined;
        cancelOperations();
        setPhase("idle");
        return;
      }
      const query = { text: checked.text, kinds: [...selectedKinds] };
      current.current = query;
      void execute(lease, query.text, query.kinds, undefined, "fresh");
    },
    [cancelOperations, execute, resetResults, session],
  );

  useEffect(() => {
    // A changed draft or category invalidates the previous session outright:
    // its results describe a query the user can no longer see.
    cancelOperations();
    current.current = undefined;
    resetResults();
    setPhase("idle");
  }, [cancelOperations, draft, resetResults, kindSignature]);

  useEffect(
    () => () => {
      cancelOperations();
    },
    [cancelOperations],
  );

  const submit = () => startSession(draft, kinds);
  const loadMore = () => {
    const query = current.current;
    const cursor = nextCursorRef.current;
    const lease = currentSession.current;
    if (
      !query ||
      !lease ||
      !cursor ||
      !hasMoreRef.current ||
      loadingMoreRef.current
    )
      return;
    void execute(lease, query.text, query.kinds, cursor, "append");
  };
  const retryCategory = (kind: GlobalSearchKind) => {
    const query = current.current;
    const lease = currentSession.current;
    if (!query || !lease || categoryLoading) return;
    void execute(lease, query.text, [kind], undefined, "category");
  };

  const grouped = useMemo(
    () =>
      kinds.map((kind) => ({
        kind,
        items: items.filter((item) => item.kind === kind),
        facet: facets.find((facet) => facet.kind === kind),
      })),
    [facets, items, kindSignature],
  );
  const totalMatched = facets.reduce(
    (sum, facet) => sum + facet.matchedCount,
    0,
  );
  const totalScanned = facets.reduce(
    (sum, facet) => sum + facet.scannedCount,
    0,
  );
  const failures = facets.filter((facet) => facet.error).length;
  const validationError =
    draft && !validation.valid ? validationMessage(validation.reason, zh) : "";
  const noKinds = kinds.length === 0;
  const mock = runtimeMode === "mock" || simulated;
  const statusText = navigationNotice
    ? navigationNotice
    : phase === "loading"
      ? t("search.searching")
      : loadingMore
        ? t("search.loading.more.results")
        : phase === "error"
          ? t("search.search.failed")
          : phase === "ready"
            ? tFor(zh ? "zh-CN" : "en-US", "search.loaded.matched", {
                p1: items.length,
                p2: totalMatched,
              })
            : t("search.ready.to.search");

  const openItem = async (item: GlobalSearchItem) => {
    setNavigationBusy(item.identity);
    setNavigationNotice("");
    try {
      await onNavigate(item.target);
      setNavigationNotice(
        tFor(zh ? "zh-CN" : "en-US", "search.opened", { p1: item.title }),
      );
    } catch (cause) {
      setNavigationNotice(
        tFor(zh ? "zh-CN" : "en-US", "search.could.not.open", {
          p1: item.title,
          p2: errorMessage(cause),
        }),
      );
    } finally {
      setNavigationBusy(undefined);
    }
  };

  return (
    <section className="search-page">
      <div className="search-live" role="status" aria-live="polite">
        {statusText}
      </div>
      <div className="search-body">
        <FixedPageHeader
          description={t(
            "search.search.submitted.and.pending.changelists.workspace",
          )}
        >
          {mock ? (
            <span className="search-ui-badge">
              {t("search.simulated.no.p4.access")}
            </span>
          ) : (
            <span className="search-production-badge">
              {t("search.live.p4.search")}
            </span>
          )}
        </FixedPageHeader>

        {mock ? (
          <div className="search-ui-note">
            <AlertTriangle size={15} />
            <span>{t("search.mock.mode.is.active.results.validate")}</span>
          </div>
        ) : null}

        <section
          className="search-card"
          aria-label={t("search.search.controls")}
        >
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (validation.valid && !noKinds) submit();
            }}
          >
            <label className="search-query-label" htmlFor="global-search-input">
              <span className="sr-only">{t("search.search.query")}</span>
            </label>
            <div className="search-input-row">
              <Search size={18} aria-hidden="true" />
              <input
                id="global-search-input"
                value={draft}
                aria-invalid={!!validationError}
                aria-describedby="global-search-help global-search-error"
                autoComplete="off"
                maxLength={256}
                onChange={(event) => setDraft(event.target.value)}
                placeholder={t("search.file.path.changelist.user.stream")}
              />
              {draft ? (
                <button
                  type="button"
                  className="search-clear"
                  aria-label={t("search.clear.search")}
                  onClick={() => setDraft("")}
                >
                  <X size={14} />
                </button>
              ) : null}
              <button
                className="search-primary"
                disabled={!validation.valid || noKinds || phase === "loading"}
              >
                {phase === "loading" ? (
                  <LoaderCircle className="spin" size={14} />
                ) : (
                  <Search size={14} />
                )}
                {t("search.search")}
              </button>
            </div>
            <div id="global-search-help" className="search-help">
              {t("search.enter.or.press.search.to.start.queries")}
            </div>
            <div
              id="global-search-error"
              className="search-validation"
              role={validationError || noKinds ? "alert" : undefined}
            >
              {validationError ||
                (noKinds ? t("search.select.at.least.one.category") : "")}
            </div>
            <fieldset
              className="search-kind-picker"
              aria-label={t("search.categories")}
            >
              {GLOBAL_SEARCH_KINDS.map((kind) => (
                <label key={kind}>
                  <input
                    type="checkbox"
                    checked={kinds.includes(kind)}
                    onChange={() =>
                      setKinds((currentKinds) =>
                        currentKinds.includes(kind)
                          ? currentKinds.filter((value) => value !== kind)
                          : GLOBAL_SEARCH_KINDS.filter(
                              (value) =>
                                value === kind || currentKinds.includes(value),
                            ),
                      )
                    }
                  />
                  {kindLabel(kind, zh)}
                </label>
              ))}
            </fieldset>
            {kinds.includes("shelf") ? (
              <p className="search-bounded-note" id="search-shelf-bounds">
                {t("search.shelf.deep.search.is.bounded.if")}
              </p>
            ) : null}
          </form>
        </section>

        <section
          className="search-card search-results"
          aria-label={t("search.search.results")}
          aria-busy={phase === "loading" || loadingMore}
        >
          <div className="search-results-heading">
            <div>
              <h2>{t("search.results")}</h2>
              {phase === "ready" ? (
                <p>
                  {tFor(
                    zh ? "zh-CN" : "en-US",
                    "search.loaded.matched.scanned",
                    {
                      p1: items.length,
                      p2: totalMatched,
                      p3: totalScanned,
                    },
                  )}
                </p>
              ) : null}
            </div>
            {phase === "ready" || phase === "error" ? (
              <button className="secondary" onClick={submit}>
                <RefreshCw size={14} />
                {t("search.retry.all")}
              </button>
            ) : null}
          </div>

          {partial ? (
            <div className="search-partial" role="status">
              <AlertTriangle size={15} />
              {tr(
                failures
                  ? `${failures} 个类别失败，当前结果不完整。`
                  : "当前结果不完整；部分类别达到扫描上限或后端只返回了部分数据。",
                failures
                  ? `${failures} categories failed; results are incomplete.`
                  : "Results are incomplete because a category hit its scan limit or returned partial data.",
              )}
            </div>
          ) : null}

          {phase === "loading" ? (
            <div className="search-empty">
              <LoaderCircle className="spin" size={32} />
              <h3>{t("search.searching.2")}</h3>
              <p>{t("search.querying.selected.categories")}</p>
            </div>
          ) : phase === "error" ? (
            <div className="search-error" role="alert">
              <AlertTriangle size={22} />
              <div>
                <strong>{t("search.search.failed.2")}</strong>
                <p>{error}</p>
              </div>
              <button onClick={submit}>{t("search.retry")}</button>
            </div>
          ) : phase === "ready" && !items.length && !failures ? (
            <div className="search-empty">
              <FolderSearch size={32} />
              <h3>{t("search.no.results")}</h3>
              <p>{t("search.try.another.query.or.category")}</p>
            </div>
          ) : phase === "idle" ? (
            <div className="search-empty">
              <FolderSearch size={32} />
              <h3>{t("search.enter.a.query.to.search")}</h3>
              <p>{t("search.six.result.categories.are.available.use")}</p>
            </div>
          ) : null}

          {phase === "ready" ? (
            <div className="search-groups">
              {grouped.map(({ kind, items: groupItems, facet }) => {
                const Icon = KIND_ICON[kind];
                const truncated =
                  !!facet?.partial &&
                  !facet.error &&
                  facet.scannedCount >= safetyLimit;
                return (
                  <section
                    className="search-group"
                    key={kind}
                    aria-labelledby={`search-group-${kind}`}
                  >
                    <header>
                      <div>
                        <Icon size={16} />
                        <h3 id={`search-group-${kind}`}>
                          {kindLabel(kind, zh)}
                        </h3>
                        <span className="search-facet-count">
                          {facet?.matchedCount ?? 0}
                        </span>
                      </div>
                      <small>
                        {t("search.scanned")} {facet?.scannedCount ?? 0}
                        {truncated
                          ? t("search.scan.limit.reached")
                          : facet?.partial && !facet.error
                            ? t("search.partial")
                            : ""}
                      </small>
                    </header>
                    {facet?.partialReason ? (
                      <div className="search-category-partial" role="status">
                        <AlertTriangle size={14} />
                        <span>
                          <strong>{t("search.partial.reason")}</strong>
                          {facet.partialReason}
                        </span>
                      </div>
                    ) : null}
                    {facet?.error ? (
                      <div className="search-category-error" role="alert">
                        <span>
                          <strong>{facet.error.code}</strong> ·{" "}
                          {facet.error.message}
                        </span>
                        <button
                          disabled={categoryLoading === kind}
                          onClick={() => retryCategory(kind)}
                        >
                          <RefreshCw
                            size={13}
                            className={categoryLoading === kind ? "spin" : ""}
                          />
                          {t("search.retry.category")}
                        </button>
                      </div>
                    ) : null}
                    {groupItems.length ? (
                      <VirtualSearchResults
                        items={groupItems}
                        zh={zh}
                        navigationBusy={navigationBusy}
                        onOpen={openItem}
                      />
                    ) : !facet?.error ? (
                      <p className="search-group-empty">
                        {t("search.no.matches.in.this.category")}
                      </p>
                    ) : null}
                  </section>
                );
              })}
            </div>
          ) : null}

          {pageError ? (
            <div className="search-page-error" role="alert">
              <span>{pageError}</span>
              {hasMore ? (
                <>
                  <button onClick={loadMore}>{t("search.retry.page")}</button>
                  <button onClick={submit}>{t("search.restart.search")}</button>
                </>
              ) : null}
            </div>
          ) : null}
          {phase === "ready" && hasMore ? (
            <button
              className="search-load-more"
              disabled={loadingMore}
              onClick={loadMore}
            >
              {loadingMore ? (
                <LoaderCircle className="spin" size={14} />
              ) : (
                <ArrowDown size={14} />
              )}
              {loadingMore ? t("search.loading") : t("search.load.more")}
            </button>
          ) : null}
        </section>
      </div>
    </section>
  );
}
