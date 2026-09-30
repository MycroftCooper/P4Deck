import { useCallback, useEffect, useRef, useState } from "react";
import { ChangelistPage } from "./ChangelistPage";
import { backend } from "../../../infrastructure/backend";
import type {
  ClAction,
  ChangelistSummary,
  RuntimeInfo,
} from "../../../shared/contracts/types";
import type { messages } from "../../../shared/i18n";

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
  const generation = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current++;
    };
  }, []);
  const connectionKey = JSON.stringify(runtime.context);
  const query = useCallback(async () => {
    if (runtime.p4Version === "loading") return;
    const requestGeneration = ++generation.current;
    setLoading(true);
    setError("");
    try {
      const result = await backend.queryChangelists({
        requestGeneration,
        keyword,
        statuses: ["submitted"],
        users: [],
        clients: [],
        stream: runtime.mode === "mock" ? "//atlas/main" : undefined,
        from: new Date(Date.now() - 30 * 86_400_000).toISOString(),
        to: new Date().toISOString(),
        hideReliableMerges: hideMerges,
        limit: 20_000,
      });
      if (requestGeneration === generation.current) {
        setChanges(result.changes);
        setHiddenMergeCount(result.hiddenMergeCount);
        setHasMore(result.hasMore);
      }
    } catch (e) {
      if (requestGeneration === generation.current) setError(String(e));
    } finally {
      if (requestGeneration === generation.current) setLoading(false);
    }
  }, [keyword, hideMerges, runtime.mode, runtime.p4Version, connectionKey]);
  useEffect(() => {
    setChanges([]);
    const timer = setTimeout(() => void query(), keyword ? 250 : 0);
    return () => {
      clearTimeout(timer);
      generation.current++;
    };
  }, [query, keyword]);
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
        onKeywordChange={setKeyword}
        onStatusChange={() => undefined}
        onHideMergesChange={setHideMerges}
        onRefresh={() => void query()}
        onAction={(action) => void perform(action)}
      />
    </div>
  );
}
