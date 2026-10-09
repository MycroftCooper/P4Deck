import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Copy, RefreshCw } from "lucide-react";
import { backend } from "../../../infrastructure/backend";
import { writeClipboardText } from "../../../infrastructure/clipboard";
import type {
  DiffResult,
  RevisionReference,
  RuntimeInfo,
  ShelfDetail,
  ShelfDetailFile,
  ShelfFilePreview,
} from "../../../shared/contracts/types";
import { makeReviewScope } from "../../browsers/reviewModel";

const PAGE_SIZE = 500;

export function ShelfDetailPage({
  target,
  runtime,
  zh,
}: {
  target: string;
  runtime: RuntimeInfo;
  zh: boolean;
}) {
  const [changeText, encodedInitialPath] = target.split("::", 2);
  const changeId = Number(changeText);
  const initialPath = encodedInitialPath
    ? decodeURIComponent(encodedInitialPath)
    : undefined;
  const [detail, setDetail] = useState<ShelfDetail>();
  const [selected, setSelected] = useState<ShelfDetailFile>();
  const [preview, setPreview] = useState<ShelfFilePreview>();
  const [diff, setDiff] = useState<DiffResult>();
  const [baseline, setBaseline] = useState<RevisionReference>({ kind: "have" });
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [contentLoading, setContentLoading] = useState(false);
  const [cancelled, setCancelled] = useState(false);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const operations = useRef(new Set<string>());
  const requestGeneration = useRef(0);
  const files = detail?.files ?? [];
  const rows = useVirtualizer({
    count: files.length,
    getScrollElement: () => listRef.current,
    estimateSize: () => 38,
    overscan: 12,
    initialRect: { width: 420, height: 480 },
  });
  const contentLines = useMemo(
    () => (preview?.content ?? diff?.unified ?? "").split("\n"),
    [preview, diff],
  );
  const contentRows = useVirtualizer({
    count: contentLines.length,
    getScrollElement: () => contentRef.current,
    estimateSize: () => 24,
    overscan: 20,
    initialRect: { width: 720, height: 480 },
  });
  const visibleContentRows = contentRows.getVirtualItems().length
    ? contentRows.getVirtualItems()
    : contentLines.slice(0, 40).map((_, index) => ({
        index,
        key: index,
        start: index * 24,
        size: 24,
        end: (index + 1) * 24,
        lane: 0,
      }));

  useEffect(() => {
    requestGeneration.current += 1;
    setCancelled(false);
    setDetail(undefined);
    setSelected(undefined);
    setPreview(undefined);
    setDiff(undefined);
  }, [changeId, runtime.contextGeneration]);

  useEffect(() => {
    if (!Number.isSafeInteger(changeId) || changeId <= 0) {
      setError(zh ? "Shelf 编号无效。" : "Invalid shelf changelist ID.");
      return;
    }
    if (runtime.p4Version === "loading") {
      setError("");
      return;
    }
    let active = true;
    const generation = requestGeneration.current;
    const operationId = crypto.randomUUID();
    operations.current.add(operationId);
    setLoading(true);
    setError("");
    void backend
      .getShelfDetail({
        changeId,
        offset: 0,
        pageSize: PAGE_SIZE,
        refresh: refresh > 0,
        operationId,
      })
      .then((value) => {
        if (active && generation === requestGeneration.current)
          setDetail(value);
      })
      .catch((cause) => {
        if (active && generation === requestGeneration.current)
          setError(String(cause));
      })
      .finally(() => {
        operations.current.delete(operationId);
        if (active && generation === requestGeneration.current)
          setLoading(false);
      });
    return () => {
      active = false;
      void backend.cancelOperation(operationId);
    };
  }, [changeId, refresh, runtime.contextGeneration, runtime.p4Version, zh]);

  useEffect(() => {
    if (!selected) return;
    let active = true;
    const generation = requestGeneration.current;
    const operationId = crypto.randomUUID();
    operations.current.add(operationId);
    setPreview(undefined);
    setDiff(undefined);
    setContentLoading(true);
    setError("");
    void backend
      .getShelfFilePreview({
        scope: makeReviewScope(runtime, selected.depotPath),
        changeId,
        refresh: refresh > 0,
        operationId,
      })
      .then((value) => {
        if (active && generation === requestGeneration.current)
          setPreview(value);
      })
      .catch((cause) => {
        if (active && generation === requestGeneration.current)
          setError(String(cause));
      })
      .finally(() => {
        operations.current.delete(operationId);
        if (active && generation === requestGeneration.current)
          setContentLoading(false);
      });
    return () => {
      active = false;
      void backend.cancelOperation(operationId);
    };
  }, [selected, changeId, refresh, runtime]);

  const loadMore = useCallback(() => {
    if (!detail?.hasMore || loadingMore) return;
    const generation = requestGeneration.current;
    const operationId = crypto.randomUUID();
    operations.current.add(operationId);
    setLoadingMore(true);
    void backend
      .getShelfDetail({
        changeId,
        offset: detail.files.length,
        pageSize: PAGE_SIZE,
        operationId,
      })
      .then((page) => {
        if (generation !== requestGeneration.current) return;
        setDetail((current) =>
          current
            ? {
                ...page,
                offset: 0,
                files: [...current.files, ...page.files],
              }
            : page,
        );
      })
      .catch((cause) => {
        if (generation === requestGeneration.current) setError(String(cause));
      })
      .finally(() => {
        operations.current.delete(operationId);
        if (generation === requestGeneration.current) setLoadingMore(false);
      });
  }, [changeId, detail, loadingMore]);

  useEffect(() => {
    if (cancelled || selected || !initialPath || !detail) return;
    const file = detail.files.find((item) => item.depotPath === initialPath);
    if (file) setSelected(file);
    else if (detail.hasMore && !loadingMore) loadMore();
  }, [cancelled, detail, initialPath, loadMore, loadingMore, selected]);

  const supersedeOperations = () => {
    requestGeneration.current += 1;
    for (const operationId of operations.current)
      void backend.cancelOperation(operationId);
    operations.current.clear();
    setLoading(false);
    setLoadingMore(false);
    setContentLoading(false);
  };

  const compare = () => {
    if (!selected) return;
    const generation = requestGeneration.current;
    const operationId = crypto.randomUUID();
    operations.current.add(operationId);
    setContentLoading(true);
    setError("");
    void backend
      .getDiff({
        scope: makeReviewScope(runtime, selected.depotPath),
        left: baseline,
        right: { kind: "shelf", changeId },
        refresh: refresh > 0,
        operationId,
      })
      .then((value) => {
        if (generation !== requestGeneration.current) return;
        setPreview(undefined);
        setDiff(value);
      })
      .catch((cause) => {
        if (generation === requestGeneration.current) setError(String(cause));
      })
      .finally(() => {
        operations.current.delete(operationId);
        if (generation === requestGeneration.current) setContentLoading(false);
      });
  };

  const cancel = () => {
    supersedeOperations();
    setCancelled(true);
    setLoading(false);
    setLoadingMore(false);
    setContentLoading(false);
    setError(zh ? "操作已取消。" : "Operation cancelled.");
  };

  useEffect(
    () => () => {
      requestGeneration.current += 1;
      for (const operationId of operations.current)
        void backend.cancelOperation(operationId);
      operations.current.clear();
    },
    [],
  );

  return (
    <main className="workspaces-page shelf-detail-page">
      <header className="section-title">
        <div>
          <span className="workspace-eyebrow">PERFORCE / SHELF</span>
          <h1>Shelf CL {Number.isFinite(changeId) ? changeId : target}</h1>
          <p>
            {detail?.description ||
              (zh
                ? "独立 Shelf 详情与内容预览"
                : "Shelf detail and content preview")}
          </p>
        </div>
        <button
          disabled={loading}
          onClick={() => {
            supersedeOperations();
            setCancelled(false);
            setRefresh((value) => value + 1);
          }}
        >
          <RefreshCw size={15} className={loading ? "spin" : ""} />
          {zh ? "刷新" : "Refresh"}
        </button>
        <button
          disabled={!loading && !loadingMore && !contentLoading}
          onClick={cancel}
        >
          {zh ? "取消" : "Cancel"}
        </button>
      </header>
      {error && (
        <div role="alert" className="workspace-load-error">
          {error}
        </div>
      )}
      {detail && (
        <div className="review-toolbar" role="status">
          <span>
            {detail.owner} · {detail.client}
          </span>
          <span>{detail.time}</span>
          <span>
            {detail.totalFiles} {zh ? "个文件" : "files"}
          </span>
          <span>
            {detail.cacheFreshness === "cached"
              ? zh
                ? "缓存"
                : "cached"
              : zh
                ? "最新"
                : "fresh"}
          </span>
          {(detail.inspectionStatus === "partial" || detail.truncated) && (
            <strong>
              {detail.message ?? (zh ? "部分结果" : "Partial result")}
            </strong>
          )}
        </div>
      )}
      {loading && !detail ? (
        <div className="workspace-empty" role="status">
          {zh ? "正在读取 Shelf…" : "Loading shelf…"}
        </div>
      ) : detail && !detail.totalFiles ? (
        <div className="workspace-empty">
          {zh ? "Shelf 为空" : "Shelf is empty"}
        </div>
      ) : detail ? (
        <div className="shelf-detail-layout">
          <section className="review-surface">
            <div
              ref={listRef}
              className="shelf-file-scroll"
              role="listbox"
              aria-label="Shelved files"
            >
              <div
                className="virtual-spacer"
                style={{ height: rows.getTotalSize() }}
              >
                {rows.getVirtualItems().map((row) => {
                  const file = files[row.index];
                  return (
                    <button
                      key={file.depotPath}
                      role="option"
                      aria-selected={selected?.depotPath === file.depotPath}
                      className={
                        selected?.depotPath === file.depotPath ? "selected" : ""
                      }
                      style={{
                        height: row.size,
                        transform: `translateY(${row.start}px)`,
                      }}
                      onClick={() => {
                        supersedeOperations();
                        setCancelled(false);
                        setSelected(file);
                      }}
                      onKeyDown={(event) => {
                        if (
                          event.key !== "ArrowDown" &&
                          event.key !== "ArrowUp"
                        )
                          return;
                        event.preventDefault();
                        const next = Math.max(
                          0,
                          Math.min(
                            files.length - 1,
                            row.index + (event.key === "ArrowDown" ? 1 : -1),
                          ),
                        );
                        setSelected(files[next]);
                        rows.scrollToIndex(next, { align: "auto" });
                      }}
                    >
                      <span>{file.depotPath}</span>
                      <em>
                        {file.action} · {file.fileType ?? "unknown"} ·{" "}
                        {file.size ?? 0} B
                      </em>
                    </button>
                  );
                })}
              </div>
            </div>
            {detail.hasMore && (
              <button
                disabled={loadingMore}
                onClick={() => {
                  setCancelled(false);
                  loadMore();
                }}
              >
                {loadingMore
                  ? zh
                    ? "加载中…"
                    : "Loading…"
                  : zh
                    ? "加载更多"
                    : "Load more"}
              </button>
            )}
          </section>
          <section className="review-surface shelf-preview" aria-live="polite">
            <div className="review-toolbar">
              <button
                disabled={!selected}
                onClick={() =>
                  selected &&
                  void writeClipboardText(`${selected.depotPath}@=${changeId}`)
                }
              >
                <Copy size={13} /> {zh ? "复制 Depot spec" : "Copy depot spec"}
              </button>
              <select
                aria-label={zh ? "比较基线" : "Diff baseline"}
                value={baseline.kind}
                onChange={(event) =>
                  setBaseline({
                    kind: event.target.value as "workspace" | "have" | "head",
                  })
                }
              >
                <option value="workspace">Workspace</option>
                <option value="have">Have</option>
                <option value="head">Head</option>
              </select>
              <button
                disabled={!selected}
                onClick={() => {
                  supersedeOperations();
                  setCancelled(false);
                  compare();
                }}
              >
                {zh ? "比较" : "Diff"}
              </button>
            </div>
            {!selected ? (
              <div className="workspace-empty">
                {zh
                  ? "选择 Shelf 文件以预览"
                  : "Select a shelved file to preview"}
              </div>
            ) : contentLoading && !preview && !diff ? (
              <div className="workspace-empty" role="status">
                {zh ? "正在读取 Shelf 内容…" : "Loading shelved content…"}
              </div>
            ) : preview?.unsupported || diff?.unsupported || diff?.binary ? (
              <div className="workspace-empty">
                <strong>
                  {preview?.reason ??
                    diff?.reason ??
                    (zh ? "不支持文本预览" : "Text preview unsupported")}
                </strong>
                <div>
                  {selected.fileType ?? "unknown"} · {selected.size ?? 0} B ·{" "}
                  {selected.digest ?? "no digest"}
                </div>
              </div>
            ) : (
              <div
                ref={contentRef}
                className="diff-scroll"
                tabIndex={0}
                aria-label={diff ? "Shelf diff" : "Shelf content preview"}
              >
                <div
                  className="virtual-spacer"
                  style={{ height: contentRows.getTotalSize() }}
                >
                  {visibleContentRows.map((row) => (
                    <div
                      key={row.index}
                      className="diff-line context"
                      style={{
                        height: row.size,
                        transform: `translateY(${row.start}px)`,
                      }}
                    >
                      <span className="diff-line-number">{row.index + 1}</span>
                      <code>{contentLines[row.index] || " "}</code>
                    </div>
                  ))}
                </div>
              </div>
            )}
            <footer className="review-footer">
              {selected ? `${selected.depotPath}@=${changeId}` : "—"}
            </footer>
          </section>
        </div>
      ) : null}
    </main>
  );
}
