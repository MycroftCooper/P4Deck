import { t as translate, useIsZh } from "../../../shared/i18n";
import { submittedTags, matchesSubmittedTags } from "../submittedTags";
import { isStreamList } from "../../browsers/components/ReadOnlyPages";
import { useSnapshotQuery } from "../../../shared/cache/useSnapshotQuery";
import { FileText } from "lucide-react";
import { SubmittedReportDialog } from "./SubmittedReportDialog";
import {
  classifySubmission,
  submissionKinds,
  submissionKindLabel,
  type SubmissionKind,
} from "../submittedReport";
import { useWorkspaceList } from "../../workspaces/workspaceList";
import { SubmittedGoTo } from "./SubmittedGoTo";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { QueryKey } from "@tanstack/react-query";
import {
  useOperationSession,
  type OperationLease,
} from "../../../shared/operationSession";

/** The submitted query channel; `lease.epoch` is the wire `requestGeneration`. */
const CHAIN = "submitted";
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
} from "../../../shared/contracts";
import { messages } from "../../../shared/i18n";
import { serverScope, snapshotKey } from "../../../shared/cache/policy";
import {
  hydrateSnapshot,
  isFresh,
  readSnapshot,
  writePagedSnapshot,
} from "../../../shared/cache/snapshots";
import { useViewRefresh } from "../../../shared/cache/useViewRefresh";
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

type SubmittedBase = Omit<
  ClQuery,
  "operationId" | "requestGeneration" | "cursor"
>;

interface SubmittedResults {
  changes: ChangelistSummary[];
  hiddenMergeCount: number;
  hasMore: boolean;
  nextCursor?: string;
  stats: QueryStats;
  truncated: boolean;
  partial: boolean;
}

const emptyResults = (): SubmittedResults => ({
  changes: [],
  hiddenMergeCount: 0,
  hasMore: false,
  stats: emptyStats(),
  truncated: false,
  partial: false,
});

/**
 * Loaded pages of one filter. Live cursors are memory-only; disk copies keep
 * the display data and query, then obtain a new cursor in the background.
 */
export interface SubmittedSnapshot extends SubmittedResults {
  base: SubmittedBase;
  generation: number;
}

/**
 * The untouched default filter means "the last 7 days". Its timestamps move
 * with every mount, so they are replaced by a stable token in the cache key.
 */
export function submittedSnapshotKey(
  scope: string,
  base: SubmittedBase,
  defaultRange: boolean,
) {
  const token = defaultRange ? { ...base, from: "recent:7d", to: "now" } : base;
  return snapshotKey(
    "submitted",
    scope,
    JSON.stringify({ schema: 5, ...token }),
  );
}

/** Disk data is checked before it can become rows or a continuation query. */
export function isSubmittedSnapshot(
  value: unknown,
): value is SubmittedSnapshot {
  const snapshot = value as SubmittedSnapshot | undefined;
  if (!snapshot?.base || !snapshot.stats) return false;
  const { base, stats } = snapshot;
  return (
    Number.isSafeInteger(snapshot.generation) &&
    Number.isFinite(snapshot.hiddenMergeCount) &&
    [snapshot.hasMore, snapshot.truncated, snapshot.partial].every(
      (flag) => typeof flag === "boolean",
    ) &&
    [stats.scannedCount, stats.matchedCount, stats.pageCount].every(
      Number.isFinite,
    ) &&
    typeof base.keyword === "string" &&
    typeof base.from === "string" &&
    typeof base.to === "string" &&
    Number.isFinite(Date.parse(base.from)) &&
    Number.isFinite(Date.parse(base.to)) &&
    Number.isSafeInteger(base.pageSize) &&
    base.pageSize > 0 &&
    (base.streams === undefined ||
      (Array.isArray(base.streams) &&
        base.streams.every((value) => typeof value === "string"))) &&
    Array.isArray(base.clients) &&
    base.clients.length === 0 &&
    [base.depotPath, base.stream].every(
      (text) => text === undefined || typeof text === "string",
    ) &&
    base.hasJob === undefined &&
    (base.jobs === undefined ||
      (Array.isArray(base.jobs) && base.jobs.length === 0)) &&
    Array.isArray(base.users) &&
    base.users.length <= 1 &&
    base.hideReliableMerges === false &&
    Array.isArray(base.mergeClassifications) &&
    base.mergeClassifications.length === 0 &&
    [base.users, base.clients, base.mergeClassifications].every(
      (items) =>
        Array.isArray(items) && items.every((item) => typeof item === "string"),
    ) &&
    Array.isArray(snapshot.changes) &&
    snapshot.changes.every(
      (change) =>
        !!change &&
        Number.isSafeInteger(change.id) &&
        change.status === "submitted" &&
        [change.description, change.user, change.client, change.time].every(
          (text) => typeof text === "string",
        ) &&
        Number.isFinite(Date.parse(change.time)) &&
        Number.isFinite(change.fileCount) &&
        typeof change.hasShelf === "boolean" &&
        ["normal", "reliableMerge", "suspectedMerge", "unknown"].includes(
          change.mergeClassification,
        ) &&
        Array.isArray(change.jobs) &&
        change.jobs.every((job) => typeof job === "string"),
    )
  );
}

function canRestartCursor(cause: unknown) {
  const code = (cause as { code?: string } | null)?.code;
  if (code === "invalidCursor" || code === "cursorExpired") return true;
  // Submitted's current IPC returns strings; the other paged APIs use codes.
  const message = cause instanceof Error ? cause.message : String(cause);
  return (
    message === "invalid submitted query cursor" ||
    message === "submitted query cursor does not match this query or connection"
  );
}

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
  navigation,
}: {
  runtime: RuntimeInfo;
  t: (typeof messages)[keyof typeof messages];
  onOperation(warnings: string[]): Promise<void>;
  navigation?: { changeId: number; nonce: number };
}) {
  const remoteReady =
    runtime.p4Version !== "loading" && runtime.connection.state === "connected";
  const [draft, setDraft] = useState<SubmittedFilterDraft>(() =>
    createDefaultSubmittedFilter(new Date(), runtime.context.user),
  );
  // Timestamps of the last generated default range (see submittedSnapshotKey).
  const [defaultStamp, setDefaultStamp] = useState(() => ({
    from: draft.from,
    to: draft.to,
  }));
  const [defaultPreset, setDefaultPreset] = useState(true);
  const [draftOwner, setDraftOwner] = useState(JSON.stringify(runtime.context));
  const applyDefaultDraft = useCallback((value: SubmittedFilterDraft) => {
    setDefaultPreset(true);
    setDefaultStamp({ from: value.from, to: value.to });
    setDraft(value);
  }, []);
  if (draftOwner !== JSON.stringify(runtime.context)) {
    setDraftOwner(JSON.stringify(runtime.context));
    applyDefaultDraft(
      createDefaultSubmittedFilter(new Date(), runtime.context.user),
    );
  }
  const defaultRange =
    draft.from === defaultStamp.from && draft.to === defaultStamp.to;
  // Subscribe to the existing workspace cache only; never add an implicit lookup.
  const workspaceList = useWorkspaceList(runtime, false);
  const streamList = useSnapshotQuery({
    key: snapshotKey("streams", serverScope(runtime)),
    enabled: false,
    fetch: () => backend.listStreams(),
    persist: isStreamList,
  });
  const currentClient = runtime.context.client || undefined;
  const currentStream =
    workspaceList.data?.find((workspace) => workspace.name === currentClient)
      ?.stream || undefined;
  const validation = useMemo(
    () =>
      defaultPreset && !draft.users.trim()
        ? {
            errors: { users: translate("pending.current.user.unavailable") },
            query: undefined,
          }
        : validateSubmittedFilter(draft, {
            client: currentClient,
            stream: currentStream,
          }),
    [draft, currentClient, currentStream, defaultPreset],
  );
  const querySignature = JSON.stringify(validation.query);
  const stableQuery = useMemo(() => validation.query, [querySignature]);
  const scope = serverScope(runtime);
  const cacheKey = useMemo(
    () =>
      stableQuery
        ? submittedSnapshotKey(scope, stableQuery, defaultRange)
        : undefined,
    [scope, stableQuery, defaultRange],
  );
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
  /**
   * Every submitted query is a lease on one channel. Starting a lease
   * supersedes the previous one, so a filter edit, a reconnect or a refresh
   * retires the chain that was running and its late answer is dropped instead
   * of repainting the page.
   */
  const session = useOperationSession();
  /** The chain whose pages are shown; load-more reuses its lease. */
  const chain = useRef<OperationLease | undefined>(undefined);
  /** True while a query of the live chain is still in flight. */
  const chainBusy = useRef(false);
  /** The query whose pages are shown; load-more must reuse it with its cursor. */
  const currentQuery = useRef<
    { base: SubmittedBase; key: QueryKey } | undefined
  >(undefined);
  const usedCursors = useRef(new Set<string>());
  const changesRef = useRef(changes);
  changesRef.current = changes;
  const nextCursorRef = useRef(nextCursor);
  nextCursorRef.current = nextCursor;
  const hasMoreRef = useRef(hasMore);
  hasMoreRef.current = hasMore;
  const totalsRef = useRef({ hiddenMergeCount, stats, truncated });
  totalsRef.current = { hiddenMergeCount, stats, truncated };
  const editedDraft = useRef(draft);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const pendingNavigation = useRef<
    { changeId: number; nonce: number } | undefined
  >(undefined);
  const handledNavigation = useRef<number | undefined>(undefined);
  const mounted = useRef(true);
  const zh = useIsZh(); // subscribed: re-renders on language switch

  /**
   * Retires the live chain: a newer query, a filter edit, a reconnect or
   * unmount all go through here, and the retired lease cancels its backend
   * operation exactly once.
   */
  const cancelQuery = useCallback(() => {
    const live = chain.current;
    chain.current = undefined;
    chainBusy.current = false;
    if (live) session.abandon(live);
  }, [session]);

  const applyResults = useCallback((results: SubmittedResults) => {
    changesRef.current = results.changes;
    hasMoreRef.current = results.hasMore;
    nextCursorRef.current = results.nextCursor;
    setChanges(results.changes);
    setHiddenMergeCount(results.hiddenMergeCount);
    setHasMore(results.hasMore);
    setNextCursor(results.nextCursor);
    setStats(results.stats);
    setTruncated(results.truncated);
    setPartial(results.partial);
  }, []);

  /** Keeps the selection only if it is still listed; opens a pending target. */
  const reconcileSelection = useCallback((combined: ChangelistSummary[]) => {
    if (
      selectedRef.current !== null &&
      !combined.some((item) => item.id === selectedRef.current)
    ) {
      setSelected(null);
    }
    const navigationTarget = pendingNavigation.current;
    if (
      navigationTarget &&
      combined.some((change) => change.id === navigationTarget.changeId)
    ) {
      pendingNavigation.current = undefined;
      setSelected(navigationTarget.changeId);
    }
  }, []);

  const clearResults = useCallback(() => {
    applyResults(emptyResults());
    setLoading(false);
    setLoadingMore(false);
    setError("");
    setPageError("");
    usedCursors.current.clear();
    if (selectedRef.current !== null) setSelected(null);
  }, [applyResults]);

  /** Shows cached pages at once; the caller decides whether to revalidate. */
  const restoreSnapshot = useCallback(
    (snapshot: SubmittedSnapshot, key: QueryKey) => {
      applyResults(snapshot);
      currentQuery.current = { base: snapshot.base, key };
      usedCursors.current.clear();
      setLoading(false);
      setLoadingMore(false);
      setError("");
      setPageError("");
      reconcileSelection(snapshot.changes);
    },
    [applyResults, reconcileSelection],
  );

  const runQuery = useCallback(
    async (
      base: SubmittedBase,
      key: QueryKey,
      cursor: string | undefined,
      append: boolean,
    ): Promise<void> => {
      if (!remoteReady) return;
      cancelQuery();
      // One lease per chain: `load-more` continues the live chain with the same
      // `requestGeneration`, every other caller starts a chain from page one.
      const lease =
        append && chain.current ? chain.current : session.start(CHAIN);
      chain.current = lease;
      chainBusy.current = true;
      // `lease.epoch` is stable for the whole chain and changes for a new one,
      // which is exactly what the backend's echoed `requestGeneration` needs.
      const requestGeneration = lease.epoch;
      const operationId = lease.operationId;
      const connectionGeneration = runtime.contextGeneration;
      if (cursor) usedCursors.current.add(cursor);
      if (append) setLoadingMore(true);
      else {
        usedCursors.current.clear();
        setLoadingMore(false);
        setLoading(true);
      }
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
          !session.isCurrent(lease) ||
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
        const previous = append
          ? totalsRef.current
          : { hiddenMergeCount: 0, stats: emptyStats(), truncated: false };
        const invalidContinuation =
          result.hasMore &&
          (!result.nextCursor || usedCursors.current.has(result.nextCursor));
        const results: SubmittedResults = {
          changes: combined,
          hiddenMergeCount:
            previous.hiddenMergeCount + result.stats.hiddenReliableMergeCount,
          stats: {
            scannedCount:
              previous.stats.scannedCount + result.stats.scannedCount,
            matchedCount:
              previous.stats.matchedCount + result.stats.matchedCount,
            pageCount: previous.stats.pageCount + 1,
          },
          truncated: previous.truncated || result.stats.truncatedBySafetyLimit,
          hasMore: !invalidContinuation && result.hasMore,
          nextCursor: invalidContinuation ? undefined : result.nextCursor,
          partial: invalidContinuation || result.stats.truncatedBySafetyLimit,
        };
        applyResults(results);
        if (!append) reconcileSelection(combined);
        if (invalidContinuation)
          setPageError(translate("pending.the.backend.returned.a.non"));
        writePagedSnapshot<SubmittedSnapshot>(key, {
          ...results,
          base,
          generation: connectionGeneration,
        });
      } catch (cause) {
        if (!mounted.current || !session.isCurrent(lease)) return;
        if (append && canRestartCursor(cause)) {
          // Retain displayed rows, discard the cursor, and retry page one once.
          hasMoreRef.current = false;
          nextCursorRef.current = undefined;
          setHasMore(false);
          setNextCursor(undefined);
          await runQuery(base, key, undefined, false);
          return;
        }
        if (append) {
          setPageError(String(cause));
          setPartial(true);
        } else {
          setError(String(cause));
        }
      } finally {
        // Only the chain that is still live may clear the spinners.
        if (mounted.current && session.isCurrent(lease)) {
          chainBusy.current = false;
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [
      applyResults,
      cancelQuery,
      reconcileSelection,
      remoteReady,
      runtime.contextGeneration,
      session,
      zh,
    ],
  );

  const startFreshQuery = useCallback(
    (base: SubmittedBase, key: QueryKey) => {
      cancelQuery();
      clearResults();
      currentQuery.current = { base, key };
      void runQuery(base, key, undefined, false);
    },
    [cancelQuery, clearResults, runQuery],
  );

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      cancelQuery();
    };
  }, [cancelQuery]);

  const connectionKey = JSON.stringify(runtime.context);
  // draftOwner above resets all connection-dependent filters together. A second
  // reset based on the old draft would restore currentStreamOnly on reconnect.
  const kindFilter = draft.submissionKind;
  const reportOwner = `${scope}:${connectionKey}:${runtime.contextGeneration}:${runtime.connection.state}`;
  const [report, setReport] = useState<
    { owner: string; source: HTMLElement } | undefined
  >();
  useEffect(() => setReport(undefined), [reportOwner]);
  const tagOptions = [
    ...new Set(changes.flatMap((change) => submittedTags(change.description))),
  ].sort();
  const visibleChanges = changes.filter(
    (change) =>
      (kindFilter === "all" ||
        classifySubmission(change.description).kind === kindFilter) &&
      matchesSubmittedTags(change.description, draft.tags ?? []),
  );

  useEffect(() => {
    cancelQuery();
    const base = stableQuery;
    // Filter edits are debounced; opening the page or reconnecting is not.
    const edited = editedDraft.current !== draft;
    editedDraft.current = draft;
    if (!base || !cacheKey || runtime.p4Version === "loading") {
      clearResults();
      currentQuery.current = undefined;
      return;
    }
    let live = true;
    let timer: number | undefined;
    const showSnapshot = () => {
      if (!live) return;
      const cached = readSnapshot<SubmittedSnapshot>(cacheKey);
      if (cached) {
        // A cursor from another connection generation cannot continue.
        const reusable = cached.data.generation === runtime.contextGeneration;
        restoreSnapshot(
          reusable
            ? cached.data
            : { ...cached.data, hasMore: false, nextCursor: undefined },
          cacheKey,
        );
        if (reusable && isFresh(cacheKey)) return;
        // Restore the rows first; page one and its live cursor arrive later.
        if (remoteReady)
          timer = window.setTimeout(() => {
            currentQuery.current = { base, key: cacheKey };
            void runQuery(base, cacheKey, undefined, false);
          });
      } else {
        currentQuery.current = { base, key: cacheKey };
        if (remoteReady)
          timer = window.setTimeout(
            () => startFreshQuery(base, cacheKey),
            edited ? 300 : 0,
          );
        else setLoading(false);
      }
    };
    if (readSnapshot(cacheKey)) showSnapshot();
    else {
      clearResults();
      currentQuery.current = undefined;
      setLoading(true);
      void hydrateSnapshot(
        cacheKey,
        (value): value is SubmittedSnapshot =>
          isSubmittedSnapshot(value) &&
          JSON.stringify(
            submittedSnapshotKey(scope, value.base, defaultRange),
          ) === JSON.stringify(cacheKey),
        { revalidate: true },
      ).then(showSnapshot);
    }
    return () => {
      live = false;
      window.clearTimeout(timer);
      cancelQuery();
    };
  }, [
    cacheKey,
    stableQuery,
    runtime.p4Version,
    runtime.contextGeneration,
    remoteReady,
    connectionKey,
    cancelQuery,
    clearResults,
    restoreSnapshot,
    runQuery,
    startFreshQuery,
  ]);

  useEffect(() => {
    if (!navigation || handledNavigation.current === navigation.nonce) return;
    handledNavigation.current = navigation.nonce;
    pendingNavigation.current = navigation;
    applyDefaultDraft({
      ...createDefaultSubmittedFilter(),
      keyword: String(navigation.changeId),
    });
  }, [navigation, applyDefaultDraft]);

  const refresh = useCallback(() => {
    if (!stableQuery || !cacheKey || chainBusy.current) return;
    if (defaultPreset) {
      const next = createDefaultSubmittedFilter(
        new Date(),
        runtime.context.user,
      );
      if (next.from !== draft.from || next.to !== draft.to) {
        applyDefaultDraft(next);
        return;
      }
    }
    // Same query: keep rows, selection, and detail until the replacement is ready.
    usedCursors.current.clear();
    currentQuery.current = { base: stableQuery, key: cacheKey };
    void runQuery(stableQuery, cacheKey, undefined, false);
  }, [
    cacheKey,
    runQuery,
    stableQuery,
    defaultPreset,
    runtime.context.user,
    draft.from,
    draft.to,
    applyDefaultDraft,
  ]);

  useEffect(() => {
    window.addEventListener("p4deck:submitted-refresh", refresh);
    return () =>
      window.removeEventListener("p4deck:submitted-refresh", refresh);
  }, [refresh]);

  // Returning to the tab revalidates only stale pages, behind the visible rows.
  useViewRefresh(
    "submitted",
    cacheKey ?? ["snapshot", "submitted"],
    refresh,
    undefined,
    { automatic: false },
  );

  function detailLoaded(value: SubmittedChangeDetail) {
    const previous = changesRef.current.find(
      (change) => change.id === value.changeId,
    );
    if (!mounted.current || !previous) return;
    const effective = conservativeDetailClassification(
      value,
      previous.mergeClassification,
    );
    const next = changesRef.current.map((change) =>
      change.id === value.changeId
        ? { ...change, mergeClassification: effective }
        : change,
    );
    changesRef.current = next;
    setChanges(next);
  }

  async function perform(action: ClAction) {
    // An action only refreshes the view it was started in: a filter edit, a
    // reconnect or unmount in the meantime retires the epoch it captured.
    const started = session.epoch(CHAIN);
    try {
      const result = await backend.performClAction(action);
      await onOperation(result.warnings);
      if (mounted.current && started === session.epoch(CHAIN)) refresh();
    } catch (cause) {
      if (mounted.current && started === session.epoch(CHAIN))
        setError(String(cause));
    }
  }

  function updateSavedFilters(value: SavedSubmittedFilter[]) {
    setSavedFilters(value);
    writeSavedSubmittedFilters(value);
  }

  function loadMore() {
    const current = currentQuery.current;
    const cursor = nextCursorRef.current;
    if (!current || !cursor || !hasMoreRef.current || loadingMore || loading)
      return;
    void runQuery(current.base, current.key, cursor, true);
  }

  return (
    <div className="submitted-page">
      <ChangelistPage
        expansionScope={`${connectionKey}:${runtime.contextGeneration}:${JSON.stringify(cacheKey)}:${loading}`}
        t={t}
        changes={visibleChanges}
        traceCandidates={changes}
        loading={loading}
        loadingMore={loadingMore}
        pageActions={
          <>
            <SubmittedGoTo zh={zh} />
            <button
              className="secondary"
              title={translate("pending.weekly.report.prompt")}
              aria-label={translate("pending.weekly.report.prompt")}
              onClick={(event) =>
                setReport({ owner: reportOwner, source: event.currentTarget })
              }
            >
              <FileText size={15} aria-hidden="true" />
              <span>{translate("pending.weekly.report.prompt")}</span>
            </button>
          </>
        }
        resultSummary={
          <small title={translate("pending.filters.loaded.records.load.more")}>
            {zh
              ? `已加载 ${changes.length} 条中显示 ${visibleChanges.length} 条`
              : `Showing ${visibleChanges.length} of ${changes.length} loaded`}
          </small>
        }
        queryControls={
          <>
            <SubmittedFilterPanel
              tagOptions={tagOptions}
              typeControl={
                <label className="submitted-filter-field submitted-kind-filter">
                  <span>{translate("pending.submission.type")}</span>
                  <select
                    value={kindFilter}
                    onChange={(event) => (
                      setDefaultPreset(false),
                      setDraft({
                        ...draft,
                        submissionKind: event.target.value as
                          SubmissionKind | "all",
                      })
                    )}
                  >
                    <option value="all">{translate("pending.all")}</option>
                    {submissionKinds.map((kind) => (
                      <option key={kind} value={kind}>
                        {submissionKindLabel(kind, zh)}
                      </option>
                    ))}
                  </select>
                </label>
              }
              streamOptions={(streamList.data ?? []).map(
                (stream) => stream.stream,
              )}
              streamLoading={streamList.initialLoading || streamList.refreshing}
              streamError={streamList.error}
              onLoadStreams={() => void streamList.refresh()}
              currentStream={currentStream}
              mock={runtime.mode === "mock"}
              zh={zh}
              draft={draft}
              errors={validation.errors}
              savedFilters={savedFilters}
              defaultSelected={defaultPreset}
              onDraftChange={(value) => {
                setDefaultPreset(false);
                setDraft(value);
              }}
              onReset={() =>
                applyDefaultDraft(
                  createDefaultSubmittedFilter(
                    new Date(),
                    runtime.context.user,
                  ),
                )
              }
              onSavedFiltersChange={updateSavedFilters}
            />
            {error ? (
              <div
                role="alert"
                className="workspace-load-error submitted-query-error"
              >
                <div className="submitted-error-message">
                  <span>
                    {error.includes("must refer to client")
                      ? translate("pending.p4.not.resolve")
                      : translate("pending.query.failed.see.technical.details")}
                  </span>
                  <details>
                    <summary>{translate("pending.technical.details")}</summary>
                    <pre>{error}</pre>
                  </details>
                </div>
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
        onRefresh={refresh}
        onLoadMore={loadMore}
        onAction={(action) => void perform(action)}
        onSelectedChange={setSelected}
        onDetailLoaded={detailLoaded}
      />
      {report?.owner === reportOwner && (
        <SubmittedReportDialog
          key={reportOwner}
          runtime={runtime}
          zh={zh}
          source={report.source}
          initialUser={draft.users.trim() || runtime.context.user || ""}
          onClose={() => setReport(undefined)}
        />
      )}
    </div>
  );
}
