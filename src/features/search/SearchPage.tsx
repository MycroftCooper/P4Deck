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
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { backend } from "../../infrastructure/backend";
import type {
  GlobalSearchItem,
  GlobalSearchKind,
  GlobalSearchResult,
  GlobalSearchTarget,
} from "../../shared/contracts/types";
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

const KIND_ICON: Record<GlobalSearchKind, typeof File> = {
  submittedChange: Hash,
  pendingChange: Hash,
  workspaceFile: File,
  depotFile: File,
  job: Hash,
};

function kindLabel(kind: GlobalSearchKind, zh: boolean): string {
  const labels: Record<GlobalSearchKind, [string, string]> = {
    submittedChange: ["已提交 CL", "Submitted"],
    pendingChange: ["待提交 CL", "Pending"],
    workspaceFile: ["工作区文件", "Workspace files"],
    depotFile: ["Depot 文件", "Depot files"],
    job: ["Job", "Jobs"],
  };
  return labels[kind][zh ? 0 : 1];
}

function fieldLabel(field: string, zh: boolean): string {
  const labels: Record<string, [string, string]> = {
    title: ["标题", "Title"],
    summary: ["摘要", "Summary"],
    description: ["描述", "Description"],
    user: ["用户", "User"],
    client: ["工作区", "Client"],
    jobs: ["Job", "Jobs"],
    jobId: ["Job ID", "Job ID"],
    status: ["状态", "Status"],
    absolutePath: ["本地路径", "Local path"],
    depotPath: ["Depot 路径", "Depot path"],
  };
  return labels[field]?.[zh ? 0 : 1] ?? field;
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

function validationMessage(
  reason: "empty" | "control" | "tooLong",
  zh: boolean,
): string {
  if (reason === "control")
    return zh
      ? "搜索内容不能包含控制字符。"
      : "Search text cannot contain control characters.";
  if (reason === "tooLong")
    return zh
      ? `搜索内容最多 ${GLOBAL_SEARCH_MAX_CHARACTERS} 个 Unicode 字符。`
      : `Search text is limited to ${GLOBAL_SEARCH_MAX_CHARACTERS} Unicode characters.`;
  return zh ? "请输入搜索内容。" : "Enter a search query.";
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

  const generation = useRef(0);
  const operations = useRef(new Set<string>());
  const timer = useRef<number | undefined>(undefined);
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
    if (timer.current !== undefined) window.clearTimeout(timer.current);
    timer.current = undefined;
    for (const operationId of operations.current)
      void backend.cancelOperation(operationId).catch(() => undefined);
    operations.current.clear();
  }, []);

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
      session: number,
      text: string,
      requestedKinds: GlobalSearchKind[],
      cursor: string | undefined,
      mode: RequestMode,
    ) => {
      const operationId = crypto.randomUUID();
      operations.current.add(operationId);
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
          requestGeneration: session,
          text,
          kinds: requestedKinds,
          pageSize: GLOBAL_SEARCH_PAGE_SIZE,
          cursor,
        });
        if (
          generation.current !== session ||
          result.requestGeneration !== session
        )
          return;
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
              tr(
                `${kindLabel(retriedKind, true)}重试只恢复了前 ${GLOBAL_SEARCH_PAGE_SIZE} 条；请整体重试以继续分页。`,
                `${kindLabel(retriedKind, false)} retry restored the first ${GLOBAL_SEARCH_PAGE_SIZE} items; retry all to continue paging.`,
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
            setPageError(
              tr(
                "后端返回了不可继续的游标；已保留当前部分结果。",
                "The backend returned a non-progressing cursor; current partial results were preserved.",
              ),
            );
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
        if (generation.current !== session) return;
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
        operations.current.delete(operationId);
        if (generation.current === session) {
          if (mode === "append") {
            loadingMoreRef.current = false;
            setLoadingMore(false);
          }
          if (mode === "category") setCategoryLoading(undefined);
        }
      }
    },
    [zh],
  );

  const startSession = useCallback(
    (value: string, selectedKinds: GlobalSearchKind[], delay: number) => {
      cancelOperations();
      generation.current += 1;
      const session = generation.current;
      resetResults();
      const checked = validateSearchText(value);
      if (!checked.valid || !selectedKinds.length) {
        current.current = undefined;
        setPhase("idle");
        return;
      }
      const query = { text: checked.text, kinds: [...selectedKinds] };
      current.current = query;
      const run = () => {
        timer.current = undefined;
        void execute(session, query.text, query.kinds, undefined, "fresh");
      };
      if (delay) timer.current = window.setTimeout(run, delay);
      else run();
    },
    [cancelOperations, execute, resetResults],
  );

  useEffect(() => {
    startSession(draft, kinds, 300);
    return () => {
      if (timer.current !== undefined) window.clearTimeout(timer.current);
    };
  }, [draft, kindSignature, startSession]);

  useEffect(
    () => () => {
      generation.current += 1;
      cancelOperations();
    },
    [cancelOperations],
  );

  const submit = () => startSession(draft, kinds, 0);
  const loadMore = () => {
    const query = current.current;
    const cursor = nextCursorRef.current;
    if (!query || !cursor || !hasMoreRef.current || loadingMoreRef.current)
      return;
    void execute(generation.current, query.text, query.kinds, cursor, "append");
  };
  const retryCategory = (kind: GlobalSearchKind) => {
    const query = current.current;
    if (!query || categoryLoading) return;
    void execute(generation.current, query.text, [kind], undefined, "category");
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
      ? tr("正在搜索。", "Searching.")
      : loadingMore
        ? tr("正在加载更多结果。", "Loading more results.")
        : phase === "error"
          ? tr("搜索失败。", "Search failed.")
          : phase === "ready"
            ? tr(
                `已加载 ${items.length} 条，共匹配 ${totalMatched} 条。`,
                `${items.length} loaded, ${totalMatched} matched.`,
              )
            : tr("等待搜索。", "Ready to search.");

  const openItem = async (item: GlobalSearchItem) => {
    if (item.target.type === "job") return;
    setNavigationBusy(item.identity);
    setNavigationNotice("");
    try {
      await onNavigate(item.target);
      setNavigationNotice(
        tr(`已打开 ${item.title}。`, `Opened ${item.title}.`),
      );
    } catch (cause) {
      setNavigationNotice(
        tr(
          `无法打开 ${item.title}：${errorMessage(cause)}`,
          `Could not open ${item.title}: ${errorMessage(cause)}`,
        ),
      );
    } finally {
      setNavigationBusy(undefined);
    }
  };

  const renderText = (
    value: string,
    field: string,
    item: GlobalSearchItem,
  ): ReactNode => <HighlightedText value={value} field={field} item={item} />;

  return (
    <main className="search-page">
      <div className="search-live" role="status" aria-live="polite">
        {statusText}
      </div>
      <header className="search-heading">
        <div>
          <span className="search-eyebrow">P4DECK / SEARCH</span>
          <h1>{tr("全局搜索", "Global search")}</h1>
          <p>
            {tr(
              "搜索已提交与待提交 CL、工作区与 Depot 文件以及 Job。",
              "Search Submitted and Pending changelists, workspace and depot files, and jobs.",
            )}
          </p>
        </div>
        {mock ? (
          <span className="search-ui-badge">
            {tr("模拟结果 · 未访问 P4", "Simulated · No P4 access")}
          </span>
        ) : (
          <span className="search-production-badge">
            {tr("真实 P4 搜索", "Live P4 search")}
          </span>
        )}
      </header>

      {mock ? (
        <div className="search-ui-note">
          <AlertTriangle size={15} />
          <span>
            {tr(
              "当前为 Mock 模式；结果用于交互验证，不代表服务器数据。",
              "Mock mode is active. Results validate interaction only and do not represent server data.",
            )}
          </span>
        </div>
      ) : null}

      <section
        className="search-card"
        aria-label={tr("搜索条件", "Search controls")}
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (validation.valid && !noKinds) submit();
          }}
        >
          <label className="search-query-label" htmlFor="global-search-input">
            {tr("搜索内容", "Search query")}
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
              placeholder={tr(
                "文件名、路径、CL、用户或 Job…",
                "File, path, changelist, user, or job…",
              )}
            />
            {draft ? (
              <button
                type="button"
                className="search-clear"
                aria-label={tr("清空搜索", "Clear search")}
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
              {tr("搜索", "Search")}
            </button>
          </div>
          <div id="global-search-help" className="search-help">
            {tr(
              "输入停止 300ms 后自动搜索；Enter 立即搜索。最多 128 个 Unicode 字符。",
              "Search starts after a 300ms pause; Enter searches immediately. Maximum 128 Unicode characters.",
            )}
          </div>
          <div
            id="global-search-error"
            className="search-validation"
            role={validationError || noKinds ? "alert" : undefined}
          >
            {validationError ||
              (noKinds
                ? tr("请至少选择一个类别。", "Select at least one category.")
                : "")}
          </div>
          <fieldset className="search-kind-picker">
            <legend>{tr("搜索类别", "Categories")}</legend>
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
        </form>
      </section>

      <section
        className="search-card search-results"
        aria-label={tr("搜索结果", "Search results")}
        aria-busy={phase === "loading" || loadingMore}
      >
        <div className="search-results-heading">
          <div>
            <h2>{tr("搜索结果", "Results")}</h2>
            {phase === "ready" ? (
              <p>
                {tr(
                  `已载入 ${items.length} · 匹配 ${totalMatched} · 扫描 ${totalScanned}`,
                  `${items.length} loaded · ${totalMatched} matched · ${totalScanned} scanned`,
                )}
              </p>
            ) : null}
          </div>
          {phase === "ready" || phase === "error" ? (
            <button className="secondary" onClick={submit}>
              <RefreshCw size={14} />
              {tr("整体重试", "Retry all")}
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
            <h3>{tr("正在搜索", "Searching")}</h3>
            <p>{tr("正在查询所选类别…", "Querying selected categories…")}</p>
          </div>
        ) : phase === "error" ? (
          <div className="search-error" role="alert">
            <AlertTriangle size={22} />
            <div>
              <strong>{tr("搜索失败", "Search failed")}</strong>
              <p>{error}</p>
            </div>
            <button onClick={submit}>{tr("重试", "Retry")}</button>
          </div>
        ) : phase === "ready" && !items.length && !failures ? (
          <div className="search-empty">
            <FolderSearch size={32} />
            <h3>{tr("没有匹配结果", "No results")}</h3>
            <p>
              {tr("请尝试其他关键词或类别。", "Try another query or category.")}
            </p>
          </div>
        ) : phase === "idle" ? (
          <div className="search-empty">
            <FolderSearch size={32} />
            <h3>{tr("输入内容开始搜索", "Enter a query to search")}</h3>
            <p>
              {tr(
                "Stream 与 Shelf 尚未纳入全局搜索。",
                "Stream and Shelf search are not supported yet.",
              )}
            </p>
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
                      <h3 id={`search-group-${kind}`}>{kindLabel(kind, zh)}</h3>
                      <span className="search-facet-count">
                        {facet?.matchedCount ?? 0}
                      </span>
                    </div>
                    <small>
                      {tr("扫描", "Scanned")} {facet?.scannedCount ?? 0}
                      {truncated
                        ? tr(" · 达到扫描上限", " · scan limit reached")
                        : facet?.partial && !facet.error
                          ? tr(" · 部分结果", " · partial")
                          : ""}
                    </small>
                  </header>
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
                        {tr("重试此类别", "Retry category")}
                      </button>
                    </div>
                  ) : null}
                  {groupItems.length ? (
                    <div
                      className="search-result-list"
                      onKeyDown={(event) => {
                        if (
                          !["ArrowDown", "ArrowUp", "Home", "End"].includes(
                            event.key,
                          )
                        )
                          return;
                        const buttons = [
                          ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
                            ".search-result-row:not(:disabled)",
                          ),
                        ];
                        if (!buttons.length) return;
                        const active =
                          event.currentTarget.ownerDocument.activeElement;
                        const index = buttons.findIndex(
                          (button) => button === active,
                        );
                        const next =
                          event.key === "Home"
                            ? 0
                            : event.key === "End"
                              ? buttons.length - 1
                              : event.key === "ArrowUp"
                                ? Math.max(0, index - 1)
                                : Math.min(buttons.length - 1, index + 1);
                        if (next >= 0) {
                          event.preventDefault();
                          buttons[next]?.focus();
                        }
                      }}
                    >
                      {groupItems.map((item) => {
                        const disabled = item.target.type === "job";
                        return (
                          <button
                            key={item.identity}
                            className="search-result-row"
                            disabled={
                              disabled || navigationBusy === item.identity
                            }
                            title={
                              disabled
                                ? tr(
                                    "尚无 Job 详情页，无法导航。",
                                    "No Job details page exists yet; navigation is unavailable.",
                                  )
                                : tr(`打开 ${item.title}`, `Open ${item.title}`)
                            }
                            onClick={() => void openItem(item)}
                          >
                            <Icon size={16} />
                            <span className="search-result-copy">
                              <strong>
                                {renderText(item.title, "title", item)}
                              </strong>
                              <span>
                                {renderText(item.summary, "summary", item)}
                              </span>
                              <small>
                                {tr("匹配：", "Matched: ")}
                                {item.matchedFields
                                  .map((field) => fieldLabel(field, zh))
                                  .join(" · ")}
                                {disabled
                                  ? tr(
                                      " · 暂无可用详情页",
                                      " · no destination page",
                                    )
                                  : ""}
                              </small>
                            </span>
                            {disabled ? (
                              <span className="search-navigation-unavailable">
                                {tr("不可导航", "Unavailable")}
                              </span>
                            ) : navigationBusy === item.identity ? (
                              <LoaderCircle className="spin" size={15} />
                            ) : (
                              <ChevronRight size={15} />
                            )}
                          </button>
                        );
                      })}
                    </div>
                  ) : !facet?.error ? (
                    <p className="search-group-empty">
                      {tr("此类别没有匹配项。", "No matches in this category.")}
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
              <button onClick={loadMore}>{tr("重试加载", "Retry page")}</button>
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
            {loadingMore
              ? tr("加载中…", "Loading…")
              : tr("继续加载", "Load more")}
          </button>
        ) : null}
      </section>
    </main>
  );
}
