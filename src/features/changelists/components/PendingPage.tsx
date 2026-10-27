import { useChangeDetails } from "./ChangeDetailsDialog";
import { useCommandFocus } from "../../../app/shell/CommandContext";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useState,
  useContext,
  useRef,
  useMemo,
  type DragEvent,
  type KeyboardEvent,
} from "react";
import {
  defaultRangeExtractor,
  useVirtualizer,
  type VirtualItem,
} from "@tanstack/react-virtual";
import { createPortal } from "react-dom";
import {
  ChevronDown,
  FolderArchive,
  MoreHorizontal,
  Plus,
  RotateCcw,
  Send,
  Trash2,
  ListChecks,
  LoaderCircle,
  Check,
} from "lucide-react";
import type {
  PendingChange,
  PendingChangeSort,
  PendingChangeMutationResult,
  WorkspaceNode,
} from "../../../shared/contracts/types";
import type { messages } from "../../../shared/i18n";
import { backend } from "../../../infrastructure/backend";
import { PendingFileList } from "./PendingFileList";
import { useContextMenu } from "../../../app/context-menu/ContextMenu";
import { action, copy } from "../../../app/context-menu/bindings";
import { useRecordSelection } from "../../../app/context-menu/useRecordSelection";
import { CommandExecutionContext } from "../../../app/shell/CommandContext";
import { ChangelistFormDialog } from "./ChangelistFormDialog";
import { ShelfDialog, type ShelfRequest } from "./ShelfDialog";
import { UnshelveDialog } from "./UnshelveDialog";
import { MoveFilesDialog, type MoveFilesRequest } from "./MoveFilesDialog";
import { invalidateData } from "../../../shared/cache/dataEffects";
import { mergePendingMutation } from "../pendingQueries";
export { mergePendingMutation } from "../pendingQueries";
import { usePendingCache } from "../pendingCache";
import {
  readPendingFilterState,
  writePendingFilterState,
} from "../pendingFilterState";
import { useMenuEnvironment } from "../../../app/context-menu/environment";
import type { WorkflowRefreshDetail } from "../workflowRefresh";
import { swarmMenuAction } from "../../swarm/SwarmAction";
import { pendingFilePath } from "../pendingFilePath";
import { filterPendingChanges } from "../pendingQueries";
import { connectionPresentation } from "../../settings/connectionWizard";
import { PageHeaderActionsContext } from "../../../app/docking/chrome";
type T = (typeof messages)[keyof typeof messages];
const openedStates: Record<string, WorkspaceNode["state"]> = {
  add: "openedAdd",
  branch: "openedAdd",
  edit: "openedEdit",
  integrate: "openedEdit",
  delete: "openedDelete",
  "move/add": "openedMoveAdd",
  "move/delete": "openedMoveDelete",
};

export function PendingPage({
  t,
  clientName,
  connectionKey,
  demo,
  ready: cliReady,
  checkingConnection = false,
  navigation,
}: {
  t: T;
  clientName: string;
  connectionKey: string;
  demo: boolean;
  ready: boolean;
  checkingConnection?: boolean;
  navigation?: { changeId: number; nonce: number };
}) {
  const menuEnvironment = useMenuEnvironment();
  const connection = menuEnvironment.runtime.connection;
  const ready = cliReady && connection.state === "connected";
  const checking = checkingConnection || connection.state === "notTested";
  const connectionProblem = !checking && connection.state !== "connected";
  const connectionReason = ready
    ? undefined
    : t.files === "文件"
      ? "连接尚未就绪"
      : "Connection is not ready";
  const retryConnection = () =>
    window.dispatchEvent(new Event("p4deck:auto-refresh"));
  const focus = useCommandFocus();
  const headerTarget = useContext(PageHeaderActionsContext);
  const surface = useRef<HTMLElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const handledNavigation = useRef<number | undefined>(undefined);
  const [form, setForm] = useState<{
    change?: PendingChange;
    source: HTMLElement | null;
  }>();
  const openForm = (change?: PendingChange) => {
    if (!ready) return;
    setForm({
      change,
      source: surface.current?.ownerDocument
        .activeElement as HTMLElement | null,
    });
  };
  const pending = usePendingCache(menuEnvironment.runtime, ready);
  const cachedChanges = pending.changes;
  const setChanges = pending.updateChanges;
  const loading = pending.initialLoading || pending.refreshing;
  const loaded = !!pending.data;
  const partial = pending.data?.partial ?? false;
  const truncated = pending.data?.stats.truncatedBySafetyLimit ?? false;
  const stats = pending.data?.stats ?? { scannedCount: 0, matchedCount: 0 };
  const reload = useCallback(() => {
    setError("");
    if (!ready) {
      window.dispatchEvent(new Event("p4deck:auto-refresh"));
      return Promise.resolve();
    }
    return pending.refresh();
  }, [pending.refresh, ready]);
  const [move, setMove] = useState<MoveFilesRequest>();
  const [drag, setDrag] = useState<{
    connectionKey: string;
    from: number;
    paths: string[];
    origins: Record<string, number>;
  }>();
  const [dropTarget, setDropTarget] = useState<number>();
  const [deleting, setDeleting] = useState<number>();
  const deletingRef = useRef(false);
  const currentBinding = useRef(connectionKey);
  currentBinding.current = connectionKey;
  const [shelfRequest, setShelfRequest] = useState<{
    request: ShelfRequest;
    unshelve: boolean;
  }>();
  const openShelf = (
    change: PendingChange,
    mode: "shelve" | "delete" | "unshelve",
    paths: string[],
    source?: HTMLElement,
  ) => {
    if (!ready) return;
    setShelfRequest({
      request: {
        changeId: change.id,
        paths: [...paths],
        hasShelf: !!change.shelvedFiles.length,
        mode: mode === "delete" ? "delete" : "shelve",
        source:
          source ??
          (surface.current?.ownerDocument.activeElement as HTMLElement | null),
      },
      unshelve: mode === "unshelve",
    });
  };
  const openMove = (from: number, paths: string[]) => {
    if (!ready) return;
    setMove({
      from,
      paths: [...paths],
      source: surface.current?.ownerDocument
        .activeElement as HTMLElement | null,
    });
  };
  const beginDrag = (
    from: number,
    paths: string[],
    event: DragEvent<HTMLElement>,
  ) => {
    if (!ready || move || menuEnvironment.commandBusy) {
      event.preventDefault();
      return;
    }
    const snapshot = {
      connectionKey,
      from,
      paths: [...new Set(paths)],
      origins: Object.fromEntries(paths.map((path) => [path, from])),
    };
    setDrag(snapshot);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData(
      "application/x-p4deck-opened-files",
      JSON.stringify({ from, count: snapshot.paths.length, connectionKey }),
    );
    event.dataTransfer.setData("text/plain", snapshot.paths.join("\n"));
  };
  const dropFiles = (targetChangeId: number, event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setDropTarget(undefined);
    if (!ready || move || menuEnvironment.commandBusy) return;
    if (!drag || drag.connectionKey !== connectionKey) {
      setDrag(undefined);
      return;
    }
    setMove({
      from: drag.from,
      origins: drag.origins,
      paths: [...drag.paths],
      target: targetChangeId,
      source: event.currentTarget,
    });
    setDrag(undefined);
  };
  const openShelfDetail = (changeId: number, path?: string, fresh = false) =>
    menuEnvironment.openFilePage(
      "shelf",
      {
        id: `shelf:${changeId}:${path ?? ""}`,
        name: `Shelf ${changeId}`,
        kind: "file",
        absolutePath: "",
        relativePath: "",
        depotPath: `${changeId}${path ? `::${encodeURIComponent(path)}` : ""}`,
        state: "controlled",
      },
      fresh,
    );
  useEffect(() => {
    const mergeWorkflow = (event: Event) => {
      const detail = (event as CustomEvent<WorkflowRefreshDetail>).detail;
      if (!detail || detail.connectionKey !== connectionKey) return;
      const operation = detail.result.operationIds.join(", ");
      setNotice(
        `${detail.result.message}${operation ? ` · ${t.files === "文件" ? "操作记录" : "Operations"} ${operation}` : ""}${detail.result.logReference ? ` · ${t.files === "文件" ? "日志" : "Log"} ${detail.result.logReference}` : ""}`,
      );
    };
    window.addEventListener("p4deck:workflow-result", mergeWorkflow);
    return () => {
      window.removeEventListener("p4deck:workflow-result", mergeWorkflow);
    };
  }, [connectionKey, t.files]);
  const initialFilter = useRef(readPendingFilterState()).current;
  const [keyword, setKeyword] = useState(initialFilter.keyword);
  const [sort, setSort] = useState<PendingChangeSort>(initialFilter.sort);
  const [optimisticDeleted, setOptimisticDeleted] = useState<Set<number>>(
    new Set(),
  );
  const visibleChanges = useMemo(
    () => cachedChanges.filter((change) => !optimisticDeleted.has(change.id)),
    [cachedChanges, optimisticDeleted],
  );
  const changes = useMemo(
    () =>
      filterPendingChanges(visibleChanges, keyword).sort((left, right) =>
        left.id === 0
          ? -1
          : right.id === 0
            ? 1
            : sort === "newest"
              ? right.id - left.id
              : left.id - right.id,
      ),
    [visibleChanges, keyword, sort],
  );
  const mounted = useRef(true);
  const activeChangeId = useRef<number | undefined>(undefined);
  const restoreVirtualFocus = useRef(false);
  const [operationError, setError] = useState("");
  const error = operationError || pending.error;
  const authenticationRequired =
    ["authRequired", "ticketExpired"].includes(
      menuEnvironment.runtime.connection.state,
    ) ||
    /session has expired|ticket (?:has )?expired|password (?:invalid|unset)|not logged in|authenticationRequired/i.test(
      error,
    );
  const [notice, setNotice] = useState("");
  const [expanded, setExpanded] = useState<Set<number>>(new Set([31821]));
  const [collapsedShelves, setCollapsedShelves] = useState<Set<number>>(
    new Set(),
  );
  useEffect(() => writePendingFilterState({ keyword, sort }), [keyword, sort]);
  useEffect(() => {
    setExpanded(new Set());
    setCollapsedShelves(new Set());
    setOptimisticDeleted(new Set());
    setDrag(undefined);
    setDropTarget(undefined);
  }, [connectionKey]);
  useEffect(() => {
    if (!navigation || handledNavigation.current === navigation.nonce) return;
    if (!cachedChanges.some((change) => change.id === navigation.changeId))
      return;
    if (!changes.some((change) => change.id === navigation.changeId)) {
      setKeyword(String(navigation.changeId));
      return;
    }
    handledNavigation.current = navigation.nonce;
    setExpanded((value) => new Set([...value, navigation.changeId]));
    surface.current
      ?.querySelector<HTMLElement>(
        `[data-pending-change="${navigation.changeId}"]`,
      )
      ?.focus();
  }, [cachedChanges, changes, navigation]);
  const toggleShelf = (id: number) =>
    setCollapsedShelves((previous) => {
      const next = new Set(previous);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const menu = useContextMenu();
  const openChangeDetails = useChangeDetails();
  const run = useContext(CommandExecutionContext);
  const selection = useRecordSelection(
    changes,
    (change) => String(change.id),
    connectionKey,
  );
  const rowVirtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: changes.length,
    getScrollElement: () => list.current,
    estimateSize: (index) => (expanded.has(changes[index]?.id) ? 380 : 54),
    // Expansion needs the committed height, even before ResizeObserver delivers.
    measureElement: (element) => (element as HTMLDivElement).offsetHeight,
    overscan: 6,
    getItemKey: (index) => changes[index]?.id ?? index,
    initialRect: { width: 800, height: 600 },
    rangeExtractor: (range) =>
      [...new Set([0, ...defaultRangeExtractor(range)])].filter(
        (index) => index < changes.length,
      ),
  });
  useLayoutEffect(() => {
    list.current
      ?.querySelectorAll<HTMLDivElement>(".pending-change-virtual-row")
      .forEach((element) => rowVirtualizer.measureElement(element));
  }, [rowVirtualizer, changes, expanded, collapsedShelves]);
  const measuredRows = rowVirtualizer.getVirtualItems();
  const virtualRows: VirtualItem[] = measuredRows.length
    ? measuredRows
    : Array.from({ length: Math.min(changes.length, 20) }, (_, index) => ({
        index,
        key: changes[index].id,
        start: index * 66,
        size: 66,
        end: (index + 1) * 66,
        lane: 0,
      }));
  useEffect(() => {
    const changeId = activeChangeId.current;
    if (!restoreVirtualFocus.current || changeId === undefined) return;
    const document = surface.current?.ownerDocument;
    if (
      document &&
      document.activeElement !== document.body &&
      document.activeElement !== list.current
    )
      return;
    const target = surface.current?.querySelector<HTMLElement>(
      `[data-pending-change="${changeId}"]`,
    );
    if (target) {
      restoreVirtualFocus.current = false;
      target.focus();
    }
  }, [virtualRows]);
  const applyMutation = (
    result: PendingChangeMutationResult,
    incompleteMessage: string,
    successMessage: string,
  ) => {
    if (!result.refreshError)
      setChanges((value) => mergePendingMutation(value, result));
    setError(
      result.refreshError ? `${incompleteMessage}: ${result.refreshError}` : "",
    );
    setNotice(
      result.refreshError
        ? ""
        : `${successMessage} · ${t.files === "文件" ? "操作记录" : "Operation"} ${result.operation.operationId}${demo ? (t.files === "文件" ? " · 浏览器 Mock，未访问真实 P4 Server" : " · Browser Mock; no real P4 server was accessed") : ""}`,
    );
    if (result.refreshError)
      window.dispatchEvent(new Event("p4deck:pending-refresh"));
    else
      window.dispatchEvent(
        new CustomEvent("p4deck:pending-mutation", { detail: result }),
      );
  };
  const refreshFileStatus = (affectedPaths?: readonly string[]) =>
    invalidateData(["workspaceStatus", "depot"], {
      connectionKey,
      affectedPaths,
    }).catch(() => undefined);
  const deleteEmptyChange = async (change: PendingChange) => {
    if (
      !ready ||
      menuEnvironment.commandBusy ||
      deletingRef.current ||
      change.id <= 0 ||
      change.files.length ||
      change.shelvedFiles.length ||
      change.jobs.length
    )
      return;
    const binding = connectionKey;
    deletingRef.current = true;
    setDeleting(change.id);
    setError("");
    setOptimisticDeleted((current) => new Set(current).add(change.id));
    setChanges((current) => current.filter((item) => item.id !== change.id), {
      revalidate: false,
    });
    try {
      const result = await backend.mutatePendingChange({
        type: "delete",
        changeId: change.id,
        operationId: crypto.randomUUID(),
      });
      if (!mounted.current || currentBinding.current !== binding) return;
      applyMutation(
        result,
        t.files === "文件" ? "删除后的刷新不完整" : "Delete refresh incomplete",
        t.files === "文件" ? "CL 已删除" : "Changelist deleted",
      );
    } catch (cause) {
      if (!mounted.current || currentBinding.current !== binding) return;
      setOptimisticDeleted((current) => {
        const next = new Set(current);
        next.delete(change.id);
        return next;
      });
      setChanges(
        (current) =>
          current.some((item) => item.id === change.id)
            ? current
            : [...current, change].sort((left, right) =>
                left.id === 0 ? -1 : right.id === 0 ? 1 : right.id - left.id,
              ),
        { revalidate: false },
      );
      void reload().catch(() => undefined);
      if (mounted.current && currentBinding.current === binding)
        setError(String(cause));
    } finally {
      deletingRef.current = false;
      if (mounted.current) setDeleting(undefined);
    }
  };
  const deleteReason = (change: PendingChange) =>
    !ready || menuEnvironment.commandBusy || deleting !== undefined
      ? "请等待当前操作完成 / Wait for the current operation"
      : change.id <= 0
        ? "Default CL 不可删除 / Default cannot be deleted"
        : change.files.length ||
            change.shelvedFiles.length ||
            change.jobs.length
          ? "CL 包含文件、Shelf 或 Jobs / Changelist contains files, shelves or Jobs"
          : undefined;
  const toggle = (id: number) =>
    setExpanded((value) => {
      const next = new Set(value);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  const moveFocus = (
    change: PendingChange,
    event: KeyboardEvent<HTMLElement>,
  ) => {
    if (event.target !== event.currentTarget) return;
    if (selection.keyboard(change, event)) return;
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const index = changes.findIndex((item) => item.id === change.id);
    const target = Math.max(
      0,
      Math.min(
        changes.length - 1,
        index + (event.key === "ArrowDown" ? 1 : -1),
      ),
    );
    if (target === index) return;
    event.preventDefault();
    rowVirtualizer.scrollToIndex(target, { align: "auto" });
    requestAnimationFrame(() =>
      surface.current
        ?.querySelector<HTMLElement>(
          `[data-pending-change="${changes[target].id}"]`,
        )
        ?.focus(),
    );
  };
  const changeMenu = (change: PendingChange) =>
    menu(
      selection.targets(change).length > 1
        ? "C12"
        : change.id === 0
          ? "C01"
          : "C02",
      () => ({
        "展开/折叠": action(() => toggle(change.id)),
        查看详情: action((source) =>
          openChangeDetails?.(
            { kind: "pending", changeId: change.id, snapshot: change },
            source,
          ),
        ),
        "复制标识 default": copy("default"),
        "复制 CL 编号": copy(change.id),
        复制描述: copy(change.description),
        刷新: action(reload),
        "在 Swarm 中打开": swarmMenuAction(
          menuEnvironment.runtime,
          menuEnvironment.preferences.zh,
          {
            kind: change.shelvedFiles.length ? "shelf" : "pendingChange",
            changeId: change.id,
          },
        ),
        "编辑 CL…": action(
          () => openForm(change),
          connectionReason ??
            (change.id > 0
              ? undefined
              : "Default CL 没有可编辑的编号 spec / Default has no numbered spec"),
        ),
        "删除空 CL": action(
          () => deleteEmptyChange(change),
          deleteReason(change),
        ),
        "搁置…": action(
          (source) =>
            openShelf(
              change,
              "shelve",
              change.files.map((file) => file.depotPath),
              source,
            ),
          connectionReason ??
            (change.files.length
              ? undefined
              : "没有已打开文件 / No opened files"),
        ),
        "创建编号 CL 并搁置…": action(
          (source) =>
            openShelf(
              change,
              "shelve",
              change.files.map((file) => file.depotPath),
              source,
            ),
          connectionReason ??
            (change.files.length
              ? undefined
              : "没有已打开文件 / No opened files"),
        ),
        "移动文件到编号 CL…": action(
          () =>
            openMove(
              change.id,
              change.files.map((file) => file.depotPath),
            ),
          connectionReason ??
            (change.files.length
              ? undefined
              : "没有可移动的文件 / No files to move"),
        ),
        "移动文件到其他 CL…": action(
          () =>
            openMove(
              change.id,
              change.files.map((file) => file.depotPath),
            ),
          connectionReason ??
            (change.files.length
              ? undefined
              : "没有可移动的文件 / No files to move"),
        ),
        "复制 CL 编号列表": copy(
          selection
            .targets(change)
            .map((v) => v.id || "default")
            .join("\n"),
        ),
        复制摘要列表: copy(
          selection
            .targets(change)
            .map((v) => `${v.id || "default"} ${v.description}`)
            .join("\n"),
        ),
        "提交整个 CL…": action(
          (source) =>
            run(
              "submit",
              {
                type: "pending",
                id: change.id,
                count: change.files.length,
              },
              source,
            ),
          connectionReason ??
            (change.files.length ? undefined : "空 CL 不可提交"),
        ),
      }),
      {
        title: change.id ? `CL ${change.id}` : "Default",
        onOpen: () => selection.context(change),
      },
    );
  const headerActions =
    headerTarget &&
    createPortal(
      <>
        <span
          className="pending-operation-state"
          title={
            checking
              ? t.files === "文件"
                ? "正在检查连接与登录状态"
                : "Checking connection and login"
              : notice || undefined
          }
          role="status"
        >
          {checking || move || deleting !== undefined ? (
            <LoaderCircle size={16} className="spin" />
          ) : notice ? (
            <Check size={16} />
          ) : null}
          <span className="sr-only">
            {checking
              ? t.files === "文件"
                ? "正在检查连接与登录状态"
                : "Checking connection and login"
              : move || deleting !== undefined
                ? t.files === "文件"
                  ? "正在操作"
                  : "Operation in progress"
                : notice}
          </span>
        </span>
        <button
          disabled={!ready}
          title={connectionReason}
          aria-label={t.newCl}
          onClick={() => openForm()}
        >
          <Plus size={15} aria-hidden="true" />
          <span>{t.newCl}</span>
        </button>
      </>,
      headerTarget,
    );
  return (
    <section className="pending-page" ref={surface}>
      {headerActions}
      {shelfRequest &&
        (shelfRequest.unshelve ? (
          <UnshelveDialog
            request={shelfRequest.request}
            changes={changes}
            currentWorkspace={clientName}
            connectionKey={connectionKey}
            demo={demo}
            zh={t.files === "文件"}
            onDismiss={() => setShelfRequest(undefined)}
          />
        ) : (
          <ShelfDialog
            request={shelfRequest.request}
            connectionKey={connectionKey}
            demo={demo}
            zh={t.files === "文件"}
            onDismiss={() => setShelfRequest(undefined)}
          />
        ))}
      {move && (
        <MoveFilesDialog
          request={move}
          changes={cachedChanges}
          client={clientName}
          connectionKey={connectionKey}
          zh={t.files === "文件"}
          onDismiss={() => setMove(undefined)}
          onResult={async (result) => {
            if (!result.refreshError) {
              setChanges((current) =>
                mergePendingMutation(current, {
                  operation: {
                    operationId: result.operationIds[0] ?? "move",
                    exitCode: result.outcome === "succeeded" ? 0 : 1,
                    events: [],
                    durationMs: 0,
                  },
                  affectedChanges: result.affectedChanges,
                  affectedPaths: result.refresh.depotPaths,
                  refreshedChanges: result.refreshedChanges,
                }),
              );
            } else {
              setError(result.refreshError);
              window.dispatchEvent(new Event("p4deck:pending-refresh"));
            }
            setNotice(
              result.outcome === "succeeded"
                ? t.files === "文件"
                  ? "移动完成"
                  : "Move completed"
                : "",
            );
            if (result.refreshError) void reload().catch(() => undefined);
            void refreshFileStatus(result.refresh.depotPaths);
          }}
        />
      )}
      {form && (
        <ChangelistFormDialog
          mode={form.change ? "edit" : "create"}
          changeId={form.change?.id}
          initial={
            form.change
              ? {
                  description: form.change.description,
                  jobs: [...form.change.jobs],
                }
              : undefined
          }
          client={clientName}
          zh={t.files === "文件"}
          source={form.source}
          onDismiss={() => setForm(undefined)}
          onSubmit={async (draft) => {
            try {
              const result = await backend.mutatePendingChange(
                form.change
                  ? {
                      type: "edit",
                      changeId: form.change.id,
                      description: draft.description,
                      jobs: draft.jobs,
                      operationId: crypto.randomUUID(),
                    }
                  : {
                      type: "create",
                      description: draft.description,
                      jobs: draft.jobs,
                      operationId: crypto.randomUUID(),
                    },
              );
              applyMutation(
                result,
                t.files === "文件"
                  ? "保存后的刷新不完整"
                  : "Save refresh incomplete",
                t.files === "文件" ? "CL 已保存" : "Changelist saved",
              );
            } catch (cause) {
              window.dispatchEvent(new Event("p4deck:pending-refresh"));
              throw cause;
            }
          }}
        />
      )}
      <div
        className="pending-query-bar"
        aria-label="Pending changelist filters"
      >
        <input
          value={keyword}
          onChange={(event) => setKeyword(event.target.value)}
          placeholder={
            t.files === "文件"
              ? "筛选已缓存的 CL、描述或文件路径"
              : "Filter cached CL, description, or file path"
          }
          aria-label={
            t.files === "文件"
              ? "筛选 Pending CL"
              : "Filter pending changelists"
          }
        />
        <select
          value={sort}
          onChange={(event) => setSort(event.target.value as PendingChangeSort)}
          aria-label={t.files === "文件" ? "Pending 排序" : "Pending sort"}
        >
          <option value="newest">
            {t.files === "文件" ? "最新优先" : "Newest first"}
          </option>
          <option value="oldest">
            {t.files === "文件" ? "最早优先" : "Oldest first"}
          </option>
        </select>
      </div>
      {(error || authenticationRequired || connectionProblem) && (
        <div
          role="alert"
          className={`workspace-load-error${connectionProblem || authenticationRequired ? " pending-connection-status" : ""}`}
        >
          {authenticationRequired ? (
            <>
              <p>
                {t.files === "文件"
                  ? "登录已过期或尚未登录，无法读取 Pending 列表。请在连接设置中重新登录后刷新。"
                  : "Your login has expired or is required. Sign in again in connection settings, then refresh Pending."}
              </p>
              <button
                className="secondary"
                onClick={() => menuEnvironment.openPage("settings")}
              >
                {t.files === "文件" ? "前往连接设置" : "Connection settings"}
              </button>
            </>
          ) : connectionProblem ? (
            <>
              <p>
                {connectionPresentation(connection, t.files === "文件").title}
                {" · "}
                {t.files === "文件"
                  ? loaded
                    ? "当前显示本地缓存。"
                    : "还没有本地缓存。"
                  : loaded
                    ? "Showing the local cache."
                    : "No local cache is available yet."}
              </p>
              {connection.recovery === "retry" && (
                <button className="secondary" onClick={retryConnection}>
                  {t.files === "文件" ? "重试连接" : "Retry connection"}
                </button>
              )}
              <button
                className="secondary"
                onClick={() => menuEnvironment.openPage("settings")}
              >
                {t.files === "文件" ? "连接设置" : "Connection settings"}
              </button>
            </>
          ) : (
            error
          )}
        </div>
      )}
      {(partial || truncated) && (
        <div role="status" className="workspace-notice">
          {t.files === "文件"
            ? `结果为部分数据：扫描 ${stats.scannedCount}，匹配 ${stats.matchedCount}。`
            : `Partial results: scanned ${stats.scannedCount}, matched ${stats.matchedCount}.`}
        </div>
      )}
      <div
        className="pending-list"
        ref={list}
        tabIndex={0}
        data-testid="pending-change-virtual-list"
        {...menu("C13", () => ({
          "新建 CL…": action(() => openForm(), connectionReason),
          刷新: action(reload),
          全选当前筛选结果: action(selection.all),
          清除选择: action(selection.clear),
        }))}
      >
        <div
          className="pending-change-spacer"
          style={{ height: `${rowVirtualizer.getTotalSize()}px` }}
        >
          {virtualRows.map((virtualRow: VirtualItem) => {
            const change = changes[virtualRow.index];
            const zh = t.files === "文件";
            const label = change.id ? `CL ${change.id}` : "Default";
            const unavailable = !ready
              ? zh
                ? "连接尚未就绪"
                : "Connection is not ready"
              : menuEnvironment.commandBusy || deleting !== undefined
                ? zh
                  ? "请等待当前操作完成"
                  : "Wait for the current operation"
                : !change.files.length
                  ? zh
                    ? "没有已打开文件"
                    : "No opened files"
                  : undefined;
            const numberedReason =
              unavailable ??
              (change.id === 0
                ? zh
                  ? "请先将文件移到编号 CL"
                  : "Move files to a numbered CL first"
                : undefined);
            const revertTarget = () => {
              const revertNodes: WorkspaceNode[] = change.files.map((file) => ({
                id: file.depotPath,
                name: file.depotPath.split("/").pop()!,
                kind: "file",
                depotPath: file.depotPath,
                absolutePath: "",
                relativePath: pendingFilePath(
                  file,
                  menuEnvironment.runtime.context,
                ),
                state: file.state ?? openedStates[file.action] ?? "unknown",
                changelistId: change.id,
              }));
              return revertNodes.length
                ? {
                    type: "file" as const,
                    node: revertNodes[0],
                    nodes: revertNodes,
                    scopeLabel: `${label} · ${zh ? "全部已打开文件" : "All opened files"}`,
                    wholeChangelistId: change.id,
                  }
                : undefined;
            };
            return (
              <div
                key={change.id}
                ref={rowVirtualizer.measureElement}
                data-index={virtualRow.index}
                className={`pending-change-virtual-row ${change.id === 0 && !expanded.has(0) ? "pending-default-row" : ""}`}
                style={{ transform: `translateY(${virtualRow.start}px)` }}
              >
                <section
                  className={`pending-card ${selection.isSelected(change) ? "command-selected" : ""} ${dropTarget === change.id ? "drop-target" : ""}`}
                  aria-label={`${change.id === 0 ? "Default" : `CL ${change.id}`} drop target`}
                  onDragOver={(event) => {
                    if (
                      drag?.connectionKey === connectionKey &&
                      drag.paths.some(
                        (path) => drag.origins[path] !== change.id,
                      )
                    ) {
                      event.preventDefault();
                      event.dataTransfer.dropEffect = "move";
                      setDropTarget(change.id);
                    }
                  }}
                  onDragLeave={(event) => {
                    if (
                      !event.relatedTarget ||
                      !event.currentTarget.contains(event.relatedTarget as Node)
                    )
                      setDropTarget(undefined);
                  }}
                  onDrop={(event) => dropFiles(change.id, event)}
                >
                  <header
                    data-pending-change={change.id}
                    tabIndex={0}
                    {...changeMenu(change)}
                    onKeyDown={(event) => moveFocus(change, event)}
                    onFocus={() => {
                      activeChangeId.current = change.id;
                      focus({
                        type: "pending",
                        id: change.id,
                        count: change.files.length,
                      });
                    }}
                    onBlur={(event) => {
                      if (!event.relatedTarget)
                        restoreVirtualFocus.current = true;
                    }}
                    onClick={(event) => {
                      selection.select(change, event);

                      toggle(change.id);
                      focus({
                        type: "pending",
                        id: change.id,
                        count: change.files.length,
                      });
                    }}
                  >
                    <ChevronDown
                      size={15}
                      className={
                        expanded.has(change.id)
                          ? ""
                          : "pending-chevron-collapsed"
                      }
                    />
                    <strong>
                      {change.id === 0 ? "Default" : `CL ${change.id}`}
                    </strong>
                    <span
                      className="pending-description"
                      title={change.description}
                    >
                      {change.description}
                    </span>
                    <b>
                      {change.files.length} {t.files}
                    </b>
                    <div
                      className="pending-cl-actions"
                      role="group"
                      aria-label={`${label} ${zh ? "操作" : "actions"}`}
                    >
                      <button
                        type="button"
                        disabled={!!numberedReason}
                        title={
                          numberedReason ??
                          (zh ? `提交整个 ${label}` : `Submit entire ${label}`)
                        }
                        aria-label={zh ? `提交 ${label}` : `Submit ${label}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          run(
                            "submit",
                            {
                              type: "pending",
                              id: change.id,
                              count: change.files.length,
                            },
                            event.currentTarget,
                          );
                        }}
                        onKeyDown={(event) => event.stopPropagation()}
                      >
                        <Send size={14} />
                        <span>{zh ? "提交" : "Submit"}</span>
                      </button>
                      <button
                        type="button"
                        disabled={!!unavailable}
                        title={
                          unavailable ??
                          (zh
                            ? `还原 ${label} 的全部已打开文件`
                            : `Revert all opened files in ${label}`)
                        }
                        aria-label={
                          zh ? `还原全部 ${label}` : `Revert all ${label}`
                        }
                        onClick={(event) => {
                          event.stopPropagation();
                          const target = revertTarget();
                          if (target)
                            run("revert", target, event.currentTarget);
                        }}
                        onKeyDown={(event) => event.stopPropagation()}
                      >
                        <RotateCcw size={14} />
                        <span>{zh ? "还原全部" : "Revert all"}</span>
                      </button>
                      <button
                        type="button"
                        disabled={!!unavailable}
                        title={
                          unavailable ??
                          (zh
                            ? `仅还原 ${label} 中内容和类型未更改的文件`
                            : `Revert only unchanged files in ${label}`)
                        }
                        aria-label={
                          zh
                            ? `还原未更改 ${label}`
                            : `Revert unchanged ${label}`
                        }
                        onClick={(event) => {
                          event.stopPropagation();
                          const target = revertTarget();
                          if (target)
                            run("revertUnchanged", target, event.currentTarget);
                        }}
                        onKeyDown={(event) => event.stopPropagation()}
                      >
                        <ListChecks size={14} />
                        <span>{zh ? "还原未更改" : "Revert unchanged"}</span>
                      </button>
                      <button
                        type="button"
                        disabled={!!numberedReason}
                        title={
                          numberedReason ??
                          (zh
                            ? `搁置 ${label} 的全部已打开文件`
                            : `Shelve all opened files in ${label}`)
                        }
                        aria-label={
                          zh ? `全部 Shelve ${label}` : `Shelve all ${label}`
                        }
                        onClick={(event) => {
                          event.stopPropagation();
                          openShelf(
                            change,
                            "shelve",
                            change.files.map((file) => file.depotPath),
                            event.currentTarget,
                          );
                        }}
                        onKeyDown={(event) => event.stopPropagation()}
                      >
                        <FolderArchive size={14} />
                        <span>{zh ? "全部 Shelve" : "Shelve all"}</span>
                      </button>
                    </div>
                    {change.id ? (
                      <button
                        title={
                          t.files === "文件"
                            ? "删除空的编号 CL"
                            : "Delete an empty numbered CL"
                        }
                        aria-label={t.delete}
                        disabled={!!deleteReason(change)}
                        aria-busy={deleting === change.id}
                        onClick={(event) => {
                          event.stopPropagation();
                          void deleteEmptyChange(change);
                        }}
                      >
                        {deleting === change.id ? (
                          <LoaderCircle size={14} className="spin" />
                        ) : (
                          <Trash2 size={14} />
                        )}
                      </button>
                    ) : null}
                    <button
                      aria-label={`${t.files === "文件" ? "打开 CL 菜单" : "Open CL menu"} ${change.id || "Default"}`}
                      onClick={(event) =>
                        changeMenu(change).onContextMenu(event)
                      }
                    >
                      <MoreHorizontal size={16} />
                    </button>
                  </header>
                  {expanded.has(change.id) ? (
                    <div className="pending-body">
                      <PendingFileList
                        files={change.files}
                        changeId={change.id}
                        refresh={reload}
                        onMove={(paths) => openMove(change.id, paths)}
                        onDragFiles={(paths, event) =>
                          beginDrag(change.id, paths, event)
                        }
                        onDragEnd={() => {
                          setDrag(undefined);
                          setDropTarget(undefined);
                        }}
                        onShelf={(mode, paths, source) =>
                          openShelf(change, mode, paths, source)
                        }
                      />
                      {change.shelvedFiles.length ? (
                        <>
                          <h4
                            tabIndex={0}
                            {...menu("C06", () => ({
                              "Unshelve 到 CL…": action((source) =>
                                openShelf(
                                  change,
                                  "unshelve",
                                  change.shelvedFiles.map(
                                    (file) => file.depotPath,
                                  ),
                                  source,
                                ),
                              ),
                              查看搁置详情: action(() =>
                                openShelfDetail(change.id),
                              ),
                              "删除搁置内容…": action((source) =>
                                openShelf(
                                  change,
                                  "delete",
                                  change.shelvedFiles.map(
                                    (file) => file.depotPath,
                                  ),
                                  source,
                                ),
                              ),
                              "展开/折叠": action(() => toggleShelf(change.id)),
                              "复制来源 CL 编号": copy(change.id),
                              刷新: action(reload),
                              "在 Swarm 中打开": swarmMenuAction(
                                menuEnvironment.runtime,
                                menuEnvironment.preferences.zh,
                                { kind: "shelf", changeId: change.id },
                              ),
                            }))}
                          >
                            <FolderArchive size={13} />
                            {t.shelves}
                            <button
                              aria-label="展开/折叠搁置文件 / Toggle shelved files"
                              aria-expanded={!collapsedShelves.has(change.id)}
                              onClick={() => toggleShelf(change.id)}
                            >
                              {collapsedShelves.has(change.id) ? "+" : "−"}
                            </button>
                          </h4>
                          {!collapsedShelves.has(change.id) && (
                            <PendingFileList
                              files={change.shelvedFiles}
                              changeId={change.id}
                              shelf
                              onInspect={(path, fresh) =>
                                openShelfDetail(change.id, path, fresh)
                              }
                              onShelf={(mode, paths, source) =>
                                openShelf(change, mode, paths, source)
                              }
                              refresh={reload}
                            />
                          )}
                        </>
                      ) : null}
                    </div>
                  ) : null}
                </section>
              </div>
            );
          })}
        </div>
        {loading && !loaded && !changes.length ? (
          <div role="status">{t.files === "文件" ? "加载中…" : "Loading…"}</div>
        ) : null}
        {(loaded || !loading) &&
        !changes.length &&
        !error &&
        !authenticationRequired &&
        !checking &&
        !connectionProblem ? (
          <div className="empty-state">{t.empty}</div>
        ) : null}
      </div>
    </section>
  );
}
