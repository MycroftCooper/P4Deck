import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChangelistPage } from "./ChangelistPage";
import { SubmittedFilterPanel } from "./SubmittedFilterPanel";
import { backend } from "../../../infrastructure/backend";
import type {
  ClAction,
  ChangelistSummary,
  ClQuery,
  MergeClassification,
  RuntimeInfo,
  SubmittedChangeDetail,
} from "../../../shared/contracts/types";
import { messages } from "../../../shared/i18n";
import type { SubmittedDetailViewState } from "./ChangelistPage";
import {
  createDefaultSubmittedFilter,
  readSavedSubmittedFilters,
  validateSubmittedFilter,
  writeSavedSubmittedFilters,
  type SavedSubmittedFilter,
  type SubmittedFilterDraft,
} from "../submittedFilters";

interface QueryStats {
  scannedCount: number;
  matchedCount: number;
  pageCount: number;
}

const emptyStats = (): QueryStats => ({
  scannedCount: 0,
  matchedCount: 0,
  pageCount: 0,
});

export function conservativeDetailClassification(
  detail: SubmittedChangeDetail,
  previous: MergeClassification,
): MergeClassification {
  if (
    detail.mergeClassification === "reliableMerge" &&
    detail.integrationEvidence.length === 0
  )
    return previous === "suspectedMerge" ? "suspectedMerge" : "unknown";
  if (
    detail.mergeClassification === "normal" &&
    detail.inspectionStatus !== "complete"
  )
    return previous === "suspectedMerge" ? "suspectedMerge" : "unknown";
  return detail.mergeClassification;
}

export function SubmittedPage({
  runtime,
  t,
  onOperation,
}: {
  runtime: RuntimeInfo;
  t: (typeof messages)[keyof typeof messages];
  onOperation(warnings: string[]): Promise<void>;
}) {
  const [draft, setDraft] = useState<SubmittedFilterDraft>(() =>
    createDefaultSubmittedFilter(),
  );
  const validation = useMemo(() => validateSubmittedFilter(draft), [draft]);
  const [savedFilters, setSavedFilters] = useState<SavedSubmittedFilter[]>(() =>
    readSavedSubmittedFilters(),
  );
  const [changes, setChanges] = useState<ChangelistSummary[]>([]);
  const [hiddenMergeCount, setHiddenMergeCount] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string>();
  const [stats, setStats] = useState<QueryStats>(emptyStats);
  const [truncated, setTruncated] = useState(false);
  const [partial, setPartial] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [pageError, setPageError] = useState("");
  const [selected, setSelected] = useState<number | null>(null);
  const [detail, setDetail] = useState<SubmittedDetailViewState>({
    phase: "idle",
  });
  const [detailRetry, setDetailRetry] = useState(0);
  const generation = useRef(0);
  const queryOperation = useRef<string | undefined>(undefined);
  const currentQuery = useRef<
    Omit<ClQuery, "operationId" | "requestGeneration" | "cursor"> | undefined
  >(undefined);
  const usedCursors = useRef(new Set<string>());
  const changesRef = useRef(changes);
  changesRef.current = changes;
  const nextCursorRef = useRef(nextCursor);
  nextCursorRef.current = nextCursor;
  const hasMoreRef = useRef(hasMore);
  hasMoreRef.current = hasMore;
  const detailGeneration = useRef(0);
  const detailRequest = useRef<
    | {
        token: number;
        operationId: string;
        changeId: number;
      }
    | undefined
  >(undefined);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const mounted = useRef(true);
  const zh = t.language === "Switch to English";

  const cancelDetail = useCallback(() => {
    detailGeneration.current++;
    const request = detailRequest.current;
    detailRequest.current = undefined;
    if (request)
      void backend.cancelOperation(request.operationId).catch(() => undefined);
  }, []);

  const cancelQuery = useCallback(() => {
    generation.current++;
    const operationId = queryOperation.current;
    queryOperation.current = undefined;
    if (operationId)
      void backend.cancelOperation(operationId).catch(() => undefined);
  }, []);

  const clearResults = useCallback(() => {
    changesRef.current = [];
    setChanges([]);
    setHiddenMergeCount(0);
    setHasMore(false);
    hasMoreRef.current = false;
    setNextCursor(undefined);
    nextCursorRef.current = undefined;
    setStats(emptyStats());
    setTruncated(false);
    setPartial(false);
    setLoading(false);
    setLoadingMore(false);
    setError("");
    setPageError("");
    usedCursors.current.clear();
    if (selectedRef.current !== null) setSelected(null);
    cancelDetail();
    setDetail({ phase: "idle" });
  }, [cancelDetail]);

  const runQuery = useCallback(
    async (
      base: Omit<ClQuery, "operationId" | "requestGeneration" | "cursor">,
      cursor: string | undefined,
      append: boolean,
    ) => {
      if (runtime.p4Version === "loading") return;
      cancelQuery();
      const requestGeneration = generation.current;
      const operationId = crypto.randomUUID();
      queryOperation.current = operationId;
      if (cursor) usedCursors.current.add(cursor);
      if (append) setLoadingMore(true);
      else setLoading(true);
      setPageError("");
      if (!append) setError("");
      try {
        const result = await backend.queryChangelists({
          ...base,
          operationId,
          requestGeneration,
          cursor,
        });
        if (
          !mounted.current ||
          requestGeneration !== generation.current ||
          result.requestGeneration !== requestGeneration
        )
          return;
        const prior = append ? changesRef.current : [];
        const known = new Set(prior.map((change) => change.id));
        const added = result.items.filter((change) => {
          if (known.has(change.id)) return false;
          known.add(change.id);
          return true;
        });
        const combined = [...prior, ...added];
        changesRef.current = combined;
        setChanges(combined);
        setHiddenMergeCount((value) =>
          append
            ? value + result.stats.hiddenReliableMergeCount
            : result.stats.hiddenReliableMergeCount,
        );
        setStats((value) => ({
          scannedCount:
            (append ? value.scannedCount : 0) + result.stats.scannedCount,
          matchedCount:
            (append ? value.matchedCount : 0) + result.stats.matchedCount,
          pageCount: (append ? value.pageCount : 0) + 1,
        }));
        setTruncated((value) =>
          append
            ? value || result.stats.truncatedBySafetyLimit
            : result.stats.truncatedBySafetyLimit,
        );
        const invalidContinuation =
          result.hasMore &&
          (!result.nextCursor || usedCursors.current.has(result.nextCursor));
        if (invalidContinuation) {
          setHasMore(false);
          hasMoreRef.current = false;
          setNextCursor(undefined);
          nextCursorRef.current = undefined;
          setPartial(true);
          setPageError(
            zh
              ? "后端返回了不可继续的游标；已保留当前部分结果。"
              : "The backend returned a non-progressing cursor; current partial results were preserved.",
          );
        } else {
          setHasMore(result.hasMore);
          hasMoreRef.current = result.hasMore;
          setNextCursor(result.nextCursor);
          nextCursorRef.current = result.nextCursor;
          setPartial(result.stats.truncatedBySafetyLimit);
        }
      } catch (cause) {
        if (!mounted.current || requestGeneration !== generation.current)
          return;
        if (append) {
          setPageError(String(cause));
          setPartial(true);
        } else {
          setError(String(cause));
        }
      } finally {
        if (queryOperation.current === operationId)
          queryOperation.current = undefined;
        if (requestGeneration === generation.current) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [cancelQuery, runtime.p4Version, zh],
  );

  const startFreshQuery = useCallback(
    (base: Omit<ClQuery, "operationId" | "requestGeneration" | "cursor">) => {
      cancelQuery();
      clearResults();
      currentQuery.current = base;
      void runQuery(base, undefined, false);
    },
    [cancelQuery, clearResults, runQuery],
  );

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      cancelQuery();
      cancelDetail();
    };
  }, [cancelDetail, cancelQuery]);

  const connectionKey = JSON.stringify(runtime.context);
  useEffect(() => {
    cancelQuery();
    clearResults();
    currentQuery.current = validation.query;
    if (!validation.query || runtime.p4Version === "loading") return;
    const timer = window.setTimeout(
      () => startFreshQuery(validation.query!),
      300,
    );
    return () => {
      window.clearTimeout(timer);
      cancelQuery();
    };
  }, [
    draft,
    validation.query,
    runtime.p4Version,
    connectionKey,
    cancelQuery,
    clearResults,
    startFreshQuery,
  ]);

  const refresh = useCallback(() => {
    if (validation.query) startFreshQuery(validation.query);
  }, [startFreshQuery, validation.query]);

  useEffect(() => {
    window.addEventListener("p4deck:submitted-refresh", refresh);
    return () =>
      window.removeEventListener("p4deck:submitted-refresh", refresh);
  }, [refresh]);

  useEffect(() => {
    if (selected === null) {
      cancelDetail();
      setDetail({ phase: "idle" });
      return;
    }
    cancelDetail();
    const token = detailGeneration.current;
    const operationId = crypto.randomUUID();
    detailRequest.current = { token, operationId, changeId: selected };
    setDetail({ phase: "loading", changeId: selected });
    void backend
      .getSubmittedChangeDetail({ changeId: selected, operationId })
      .then((value) => {
        if (
          !mounted.current ||
          detailGeneration.current !== token ||
          detailRequest.current?.changeId !== selected ||
          value.changeId !== selected
        )
          return;
        detailRequest.current = undefined;
        const previous = changesRef.current.find(
          (change) => change.id === selected,
        );
        if (!previous) return;
        const effective = conservativeDetailClassification(
          value,
          previous.mergeClassification,
        );
        const nextChanges =
          draft.hideReliableMerges && effective === "reliableMerge"
            ? changesRef.current.filter((change) => change.id !== selected)
            : changesRef.current.map((change) =>
                change.id === selected
                  ? { ...change, mergeClassification: effective }
                  : change,
              );
        changesRef.current = nextChanges;
        setChanges(nextChanges);
        const safeValue = { ...value, mergeClassification: effective };
        if (draft.hideReliableMerges && effective === "reliableMerge") {
          setHiddenMergeCount((count) => count + 1);
          setSelected(null);
          return;
        }
        if (value.inspectionStatus === "unavailable") {
          setDetail({
            phase: "error",
            changeId: selected,
            message: value.message ?? t.detailError,
          });
          return;
        }
        setDetail({ phase: "success", changeId: selected, value: safeValue });
      })
      .catch((cause) => {
        if (
          mounted.current &&
          detailGeneration.current === token &&
          detailRequest.current?.changeId === selected
        ) {
          detailRequest.current = undefined;
          const nextChanges = changesRef.current.map((change) =>
            change.id === selected
              ? { ...change, mergeClassification: "unknown" as const }
              : change,
          );
          changesRef.current = nextChanges;
          setChanges(nextChanges);
          setDetail({
            phase: "error",
            changeId: selected,
            message: String(cause),
          });
        }
      });
    return cancelDetail;
  }, [
    selected,
    detailRetry,
    draft.hideReliableMerges,
    cancelDetail,
    t.detailError,
  ]);

  async function perform(action: ClAction) {
    const started = generation.current;
    try {
      const result = await backend.performClAction(action);
      await onOperation(result.warnings);
      if (mounted.current && started === generation.current) refresh();
    } catch (cause) {
      if (mounted.current && started === generation.current)
        setError(String(cause));
    }
  }

  function updateSavedFilters(value: SavedSubmittedFilter[]) {
    setSavedFilters(value);
    writeSavedSubmittedFilters(value);
  }

  function loadMore() {
    const base = currentQuery.current;
    const cursor = nextCursorRef.current;
    if (!base || !cursor || !hasMoreRef.current || loadingMore) return;
    void runQuery(base, cursor, true);
  }

  return (
    <div className="submitted-page">
      <ChangelistPage
        t={t}
        changes={changes}
        loading={loading}
        loadingMore={loadingMore}
        queryControls={
          <>
            <SubmittedFilterPanel
              zh={zh}
              mock={runtime.mode === "mock"}
              draft={draft}
              errors={validation.errors}
              savedFilters={savedFilters}
              onDraftChange={setDraft}
              onReset={() => setDraft(createDefaultSubmittedFilter())}
              onSavedFiltersChange={updateSavedFilters}
            />
            {error ? (
              <div
                role="alert"
                className="workspace-load-error submitted-query-error"
              >
                <span>{error}</span>
                <button className="secondary" onClick={refresh}>
                  {t.retry}
                </button>
              </div>
            ) : null}
          </>
        }
        hiddenMergeCount={hiddenMergeCount}
        hasMore={hasMore}
        partial={partial}
        truncated={truncated}
        stats={stats}
        pageError={pageError}
        selected={selected}
        detail={detail}
        mock={runtime.mode === "mock"}
        onRefresh={refresh}
        onLoadMore={loadMore}
        onAction={(action) => void perform(action)}
        onSelectedChange={setSelected}
        onRetryDetail={() => setDetailRetry((value) => value + 1)}
      />
    </div>
  );
}
