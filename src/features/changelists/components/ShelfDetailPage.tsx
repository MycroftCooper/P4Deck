import { t } from "../../../shared/i18n";
import { ResizeHeader } from "../../../app/context-menu/ResizeHeader";
import { useColumnWidths } from "../../../app/context-menu/useColumnWidths";
import { createPortal } from "react-dom";
import { PageRefreshSlotContext } from "../../../app/docking/chrome";
import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
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
} from "../../../shared/contracts";
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
  const refreshSlot = useContext(PageRefreshSlotContext);
  const [changeText, encodedInitialPath] = target.split("::", 2);
  const changeId = Number(changeText);
  const initialPath = encodedInitialPath
    ? decodeURIComponent(encodedInitialPath)
    : undefined;
  const tableColumns = useColumnWidths([320, 230], [140, 140], {
    id: "shelf-detail",
    gutter: 48,
  });
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
      setError(t("pending.invalid.shelf.changelist.id"));
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
          setError(t("pending.the.shelf.response.does.not"));
          return;
        }
        setDetail(value);
        setRestartRequired(false);
        if (value.hasMore && !value.nextCursor) {
          setRestartRequired(true);
          setError(t("pending.the.backend.did.not.return"));
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
      setError(t("pending.the.shelf.cursor.cannot.advance"));
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
          setError(t("pending.the.shelf.page.does.not"));
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
            setError(t("pending.the.shelf.snapshot.returned.duplicates"));
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
            `${failure.message} ${t(
              "pending.current.results.were.preserved.restart",
            )}`,
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
    setError(t("pending.operation.cancelled"));
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

  const refreshButton = (
    <button
      type="button"
      title={t("pending.refresh")}
      aria-label={t("pending.refresh")}
      aria-busy={loading}
      disabled={loading}
      onClick={() => {
        supersedeOperations();
        setCancelled(false);
        setRefresh((value) => value + 1);
      }}
    >
      <RefreshCw
        size={15}
        className={loading ? "spin" : ""}
        aria-hidden="true"
      />
      {!refreshSlot && <span>{t("pending.refresh")}</span>}
    </button>
  );
  return (
    <section className="workspaces-page shelf-detail-page">
      {refreshSlot && createPortal(refreshButton, refreshSlot)}
      <header className="section-title">
        <div>
          <span className="workspace-eyebrow">PERFORCE / SHELF</span>
          <h1>
            {t("pending.shelf.cl")}{" "}
            {Number.isFinite(changeId) ? changeId : target}
          </h1>
          <p>
            {detail?.description ||
              t("pending.shelf.detail.and.content.preview")}
          </p>
        </div>
        {!refreshSlot && refreshButton}
        <button
          disabled={!loading && !loadingMore && !contentLoading}
          onClick={cancel}
        >
          {t("pending.cancel")}
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
              {t("pending.restart")}
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
            {detail.totalFiles} {t("pending.files")}
          </span>
          <span>
            {detail.cacheFreshness === "cached"
              ? t("pending.cached")
              : t("pending.fresh")}
          </span>
          {(detail.inspectionStatus === "partial" || detail.truncated) && (
            <strong>{detail.message ?? t("pending.partial.result")}</strong>
          )}
        </div>
      )}
      {loading && !detail ? (
        <div className="workspace-empty" role="status">
          {t("pending.loading.shelf")}
        </div>
      ) : detail && !detail.totalFiles ? (
        <div className="workspace-empty">{t("pending.shelf.is.empty")}</div>
      ) : detail ? (
        <div className="shelf-detail-layout">
          <section className="review-surface">
            <div
              ref={listRef}
              className="shelf-file-scroll"
              role="listbox"
              aria-label="Shelved files"
            >
              <ResizeHeader
                columns={[t("pending.path"), t("pending.action.type.size")]}
                resize={tableColumns}
              />
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
                        ...tableColumns.style,
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
                {loadingMore ? t("pending.loading") : t("pending.load.more")}
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
                <Copy size={13} /> {t("pending.copy.depot.spec")}
              </button>
              <select
                aria-label={t("pending.diff.baseline")}
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
                {t("pending.diff")}
              </button>
            </div>
            {!selected ? (
              <div className="workspace-empty">
                {t("pending.select.a.shelved.file.to")}
              </div>
            ) : contentLoading && !preview && !diff ? (
              <div className="workspace-empty" role="status">
                {t("pending.loading.shelved.content")}
              </div>
            ) : preview?.unsupported || diff?.unsupported || diff?.binary ? (
              <div className="workspace-empty">
                <strong>
                  {preview?.reason ??
                    diff?.reason ??
                    t("pending.text.preview.unsupported")}
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
