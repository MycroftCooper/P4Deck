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
  ShelfDetailRequestError,
  ShelfFilePreview,
} from "../../../shared/contracts/types";
import { makeReviewScope } from "../../browsers/reviewModel";
import { SwarmAction } from "../../swarm/SwarmAction";

const PAGE_SIZE = 500;

function shelfError(cause: unknown): ShelfDetailRequestError {
  if (cause && typeof cause === "object") {
    const value = cause as Partial<ShelfDetailRequestError>;
    if (typeof value.code === "string" && typeof value.message === "string")
      return value as ShelfDetailRequestError;
  }
  return { code: "queryFailed", message: String(cause) };
}

function ownsShelfResult(
  value: ShelfDetail,
  runtime: RuntimeInfo,
  changeId: number,
  generation: number,
) {
  return (
    value.requestGeneration === generation &&
    value.scope.changeId === changeId &&
    value.scope.server === runtime.context.server &&
    value.scope.user === runtime.context.user &&
    value.scope.client === runtime.context.client &&
    value.scope.workspace === (runtime.context.cwd ?? "") &&
    value.scope.activeProfileId === runtime.activeProfileId &&
    value.scope.contextGeneration === runtime.contextGeneration
  );
}

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
  const [restartRequired, setRestartRequired] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const listOperations = useRef(new Set<string>());
  const contentOperations = useRef(new Set<string>());
  const usedCursors = useRef(new Set<string>());
  const requestGeneration = useRef(0);
  const contentGeneration = useRef(0);
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
    setRestartRequired(false);
    usedCursors.current.clear();
  }, [
    changeId,
    runtime.activeProfileId,
    runtime.context.server,
    runtime.context.user,
    runtime.context.client,
    runtime.contextGeneration,
  ]);

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
    listOperations.current.add(operationId);
    setLoading(true);
    setError("");
    void backend
      .getShelfDetail({
        changeId,
        requestGeneration: generation,
        pageSize: PAGE_SIZE,
        refresh: refresh > 0,
        operationId,
      })
      .then((value) => {
        if (!active || generation !== requestGeneration.current) return;
        if (!ownsShelfResult(value, runtime, changeId, generation)) {
          setRestartRequired(true);
          setError(
            zh
              ? "Shelf 响应与当前连接或请求代次不匹配；请重新加载。"
              : "The shelf response does not match the current connection or request generation; restart the query.",
          );
          return;
        }
        setDetail(value);
        setRestartRequired(false);
        if (value.hasMore && !value.nextCursor) {
          setRestartRequired(true);
          setError(
            zh
              ? "后端未返回可继续的 Shelf 游标；请重新加载。"
              : "The backend did not return a usable shelf cursor; restart the query.",
          );
        }
      })
      .catch((cause) => {
        if (active && generation === requestGeneration.current) {
          const failure = shelfError(cause);
          setRestartRequired(
            ["invalidCursor", "cursorExpired", "snapshotChanged"].includes(
              failure.code,
            ),
          );
          setError(failure.message);
        }
      })
      .finally(() => {
        listOperations.current.delete(operationId);
        if (active && generation === requestGeneration.current)
          setLoading(false);
      });
    return () => {
      active = false;
      void backend.cancelOperation(operationId);
    };
  }, [changeId, refresh, runtime, zh]);

  useEffect(() => {
    if (!selected) return;
    let active = true;
    const generation = ++contentGeneration.current;
    const operationId = crypto.randomUUID();
    contentOperations.current.add(operationId);
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
        if (active && generation === contentGeneration.current)
          setPreview(value);
      })
      .catch((cause) => {
        if (active && generation === contentGeneration.current)
          setError(String(cause));
      })
      .finally(() => {
        contentOperations.current.delete(operationId);
        if (active && generation === contentGeneration.current)
          setContentLoading(false);
      });
    return () => {
      active = false;
      void backend.cancelOperation(operationId);
    };
  }, [selected, changeId, refresh, runtime]);

  const loadMore = useCallback(() => {
    const cursor = detail?.nextCursor;
    if (!detail?.hasMore || loadingMore || restartRequired) return;
    if (!cursor || usedCursors.current.has(cursor)) {
      setRestartRequired(true);
      setError(
        zh
          ? "Shelf 游标不可继续；请从第一页重新加载。"
          : "The shelf cursor cannot advance; restart from the first page.",
      );
      return;
    }
    usedCursors.current.add(cursor);
    const generation = requestGeneration.current;
    const operationId = crypto.randomUUID();
    listOperations.current.add(operationId);
    setLoadingMore(true);
    void backend
      .getShelfDetail({
        changeId,
        requestGeneration: generation,
        pageSize: PAGE_SIZE,
        cursor,
        operationId,
      })
      .then((page) => {
        if (generation !== requestGeneration.current) return;
        if (!ownsShelfResult(page, runtime, changeId, generation)) {
          setRestartRequired(true);
          setError(
            zh
              ? "Shelf 分页响应与当前连接或请求代次不匹配；已保留当前结果，请重新加载。"
              : "The shelf page does not match the current connection or request generation; current results were preserved. Restart the query.",
          );
          return;
        }
        setDetail((current) => {
          if (!current) return page;
          const known = new Set(current.files.map((file) => file.depotPath));
          const incoming = page.files.filter(
            (file) => !known.has(file.depotPath),
          );
          const stalled = incoming.length !== page.files.length;
          if (stalled || (page.hasMore && !page.nextCursor)) {
            setRestartRequired(true);
            setError(
              zh
                ? "Shelf 快照返回了重复项或不可继续的游标；已保留当前结果，请重新加载。"
                : "The shelf snapshot returned duplicates or a non-progressing cursor; current results were preserved. Restart the query.",
            );
          }
          return {
            ...page,
            hasMore: stalled ? false : page.hasMore,
            nextCursor: stalled ? undefined : page.nextCursor,
            files: [...current.files, ...incoming],
          };
        });
      })
      .catch((cause) => {
        if (generation === requestGeneration.current) {
          const failure = shelfError(cause);
          setRestartRequired(true);
          setError(
            `${failure.message} ${
              zh
                ? "已保留当前结果；请从第一页重新加载。"
                : "Current results were preserved; restart from the first page."
            }`,
          );
        }
      })
      .finally(() => {
        listOperations.current.delete(operationId);
        if (generation === requestGeneration.current) setLoadingMore(false);
      });
  }, [changeId, detail, loadingMore, restartRequired, runtime, zh]);

  useEffect(() => {
    if (cancelled || selected || !initialPath || !detail) return;
    const file = detail.files.find((item) => item.depotPath === initialPath);
    if (file) setSelected(file);
    else if (detail.hasMore && !loadingMore) loadMore();
  }, [cancelled, detail, initialPath, loadMore, loadingMore, selected]);

  const supersedeOperations = () => {
    requestGeneration.current += 1;
    contentGeneration.current += 1;
    for (const operationId of [
      ...listOperations.current,
      ...contentOperations.current,
    ])
      void backend.cancelOperation(operationId);
    listOperations.current.clear();
    contentOperations.current.clear();
    setLoading(false);
    setLoadingMore(false);
    setContentLoading(false);
  };

  const supersedeContent = () => {
    contentGeneration.current += 1;
    for (const operationId of contentOperations.current)
      void backend.cancelOperation(operationId);
    contentOperations.current.clear();
    setContentLoading(false);
  };

  const compare = () => {
    if (!selected) return;
    const generation = ++contentGeneration.current;
    const operationId = crypto.randomUUID();
    contentOperations.current.add(operationId);
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
        if (generation !== contentGeneration.current) return;
        setPreview(undefined);
        setDiff(value);
      })
      .catch((cause) => {
        if (generation === contentGeneration.current) setError(String(cause));
      })
      .finally(() => {
        contentOperations.current.delete(operationId);
        if (generation === contentGeneration.current) setContentLoading(false);
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
      contentGeneration.current += 1;
      for (const operationId of [
        ...listOperations.current,
        ...contentOperations.current,
      ])
        void backend.cancelOperation(operationId);
      listOperations.current.clear();
      contentOperations.current.clear();
    },
    [],
  );

  return (
    <section className="workspaces-page shelf-detail-page">
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
        <SwarmAction
          runtime={runtime}
          zh={zh}
          target={{ kind: "shelf", changeId }}
        />
      </header>
      {error && (
        <div role="alert" className="workspace-load-error">
          {error}
          {restartRequired && (
            <button
              onClick={() => {
                supersedeOperations();
                setCancelled(false);
                setRestartRequired(false);
                usedCursors.current.clear();
                setRefresh((value) => value + 1);
              }}
            >
              {zh ? "重新加载" : "Restart"}
            </button>
          )}
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
                        supersedeContent();
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
                        supersedeContent();
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
            {detail.hasMore && !restartRequired && (
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
                  supersedeContent();
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
    </section>
  );
}
