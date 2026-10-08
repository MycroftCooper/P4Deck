import { useCallback, useEffect, useRef, useState } from "react";
import { ChangelistPage } from "./ChangelistPage";
import { backend } from "../../../infrastructure/backend";
import type {
  ClAction,
  ChangelistSummary,
  MergeClassification,
  RuntimeInfo,
  SubmittedChangeDetail,
} from "../../../shared/contracts/types";
import type { messages } from "../../../shared/i18n";
import type { SubmittedDetailViewState } from "./ChangelistPage";

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
  const [changes, setChanges] = useState<ChangelistSummary[]>([]);
  const [keyword, setKeyword] = useState("");
  const [hideMerges, setHideMerges] = useState(false);
  const [hiddenMergeCount, setHiddenMergeCount] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<number | null>(null);
  const [detail, setDetail] = useState<SubmittedDetailViewState>({
    phase: "idle",
  });
  const [detailRetry, setDetailRetry] = useState(0);
  const generation = useRef(0);
  const queryOperation = useRef<string | undefined>(undefined);
  const changesRef = useRef(changes);
  changesRef.current = changes;
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
  const cancelDetail = useCallback(() => {
    detailGeneration.current++;
    const request = detailRequest.current;
    detailRequest.current = undefined;
    if (request)
      void backend.cancelOperation(request.operationId).catch(() => undefined);
  }, []);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current++;
      if (queryOperation.current)
        void backend
          .cancelOperation(queryOperation.current)
          .catch(() => undefined);
      cancelDetail();
    };
  }, [cancelDetail]);
  const connectionKey = JSON.stringify(runtime.context);
  const query = useCallback(async () => {
    if (runtime.p4Version === "loading") return;
    if (selectedRef.current !== null) setSelected(null);
    cancelDetail();
    if (queryOperation.current)
      void backend
        .cancelOperation(queryOperation.current)
        .catch(() => undefined);
    const requestGeneration = ++generation.current;
    const operationId = crypto.randomUUID();
    queryOperation.current = operationId;
    setLoading(true);
    setError("");
    try {
      const result = await backend.queryChangelists({
        operationId,
        requestGeneration,
        keyword,
        users: [],
        clients: [],
        stream: runtime.mode === "mock" ? "//atlas/main" : undefined,
        from: new Date(Date.now() - 30 * 86_400_000).toISOString(),
        to: new Date().toISOString(),
        jobs: [],
        mergeClassifications: [],
        hideReliableMerges: hideMerges,
        pageSize: 200,
      });
      if (requestGeneration === generation.current) {
        changesRef.current = result.items;
        setChanges(result.items);
        setHiddenMergeCount(result.stats.hiddenReliableMergeCount);
        setHasMore(result.hasMore);
        if (
          selectedRef.current !== null &&
          !result.items.some((change) => change.id === selectedRef.current)
        )
          setSelected(null);
      }
    } catch (e) {
      if (requestGeneration === generation.current) setError(String(e));
    } finally {
      if (queryOperation.current === operationId)
        queryOperation.current = undefined;
      if (requestGeneration === generation.current) setLoading(false);
    }
  }, [
    keyword,
    hideMerges,
    runtime.mode,
    runtime.p4Version,
    connectionKey,
    cancelDetail,
  ]);
  useEffect(() => {
    changesRef.current = [];
    setChanges([]);
    const timer = setTimeout(() => void query(), keyword ? 250 : 0);
    return () => {
      clearTimeout(timer);
      generation.current++;
    };
  }, [query, keyword]);
  useEffect(() => {
    const refresh = () => void query();
    window.addEventListener("p4deck:submitted-refresh", refresh);
    return () =>
      window.removeEventListener("p4deck:submitted-refresh", refresh);
  }, [query]);
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
          hideMerges && effective === "reliableMerge"
            ? changesRef.current.filter((change) => change.id !== selected)
            : changesRef.current.map((change) =>
                change.id === selected
                  ? { ...change, mergeClassification: effective }
                  : change,
              );
        changesRef.current = nextChanges;
        setChanges(nextChanges);
        const safeValue = { ...value, mergeClassification: effective };
        if (hideMerges && effective === "reliableMerge") {
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
  }, [selected, detailRetry, hideMerges, cancelDetail, t.detailError]);
  async function perform(action: ClAction) {
    const started = generation.current;
    try {
      const result = await backend.performClAction(action);
      await onOperation(result.warnings);
      if (mounted.current && started === generation.current) await query();
    } catch (e) {
      if (mounted.current && started === generation.current)
        setError(String(e));
    }
  }
  return (
    <div className="submitted-page">
      {error && (
        <div role="alert" className="workspace-load-error">
          {error}
        </div>
      )}
      <ChangelistPage
        t={t}
        changes={changes}
        loading={loading}
        keyword={keyword}
        status="submitted"
        hideMerges={hideMerges}
        hiddenMergeCount={hiddenMergeCount}
        hasMore={hasMore}
        selected={selected}
        detail={detail}
        mock={runtime.mode === "mock"}
        onKeywordChange={(value) => {
          setSelected(null);
          setKeyword(value);
        }}
        onStatusChange={() => undefined}
        onHideMergesChange={(value) => {
          setSelected(null);
          setHideMerges(value);
        }}
        onRefresh={() => void query()}
        onAction={(action) => void perform(action)}
        onSelectedChange={setSelected}
        onRetryDetail={() => setDetailRetry((value) => value + 1)}
      />
    </div>
  );
}
