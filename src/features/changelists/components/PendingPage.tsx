import { useCommandFocus } from "../../../app/shell/CommandContext";
import { useEffect, useState, useContext, useRef, type DragEvent } from "react";
import {
  ChevronDown,
  FolderArchive,
  MoreHorizontal,
  Plus,
  Trash2,
} from "lucide-react";
import type {
  PendingChange,
  PendingChangeMutationResult,
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
import { DeleteChangelistDialog } from "./DeleteChangelistDialog";
import { workspaceCache } from "../../files/workspaceQueries";
import { useMenuEnvironment } from "../../../app/context-menu/environment";
import {
  mergeWorkflowPending,
  type WorkflowRefreshDetail,
} from "../workflowRefresh";
type T = (typeof messages)[keyof typeof messages];

export function mergePendingMutation(
  current: PendingChange[],
  result: PendingChangeMutationResult,
) {
  if (result.refreshError) return current;
  const affected = new Set(result.affectedChanges);
  const refreshed = new Map(
    result.refreshedChanges.map((change) => [change.id, change]),
  );
  const next = current
    .filter((change) => !affected.has(change.id) || refreshed.has(change.id))
    .map((change) => refreshed.get(change.id) ?? change);
  for (const change of refreshed.values())
    if (!next.some((item) => item.id === change.id)) next.push(change);
  return next.sort((left, right) =>
    left.id === 0 ? -1 : right.id === 0 ? 1 : right.id - left.id,
  );
}

export function PendingPage({
  t,
  clientName,
  connectionKey,
  demo,
  ready,
  navigation,
}: {
  t: T;
  clientName: string;
  connectionKey: string;
  demo: boolean;
  ready: boolean;
  navigation?: { changeId: number; nonce: number };
}) {
  const menuEnvironment = useMenuEnvironment();
  const focus = useCommandFocus();
  const surface = useRef<HTMLElement>(null);
  const handledNavigation = useRef<number | undefined>(undefined);
  const [form, setForm] = useState<{
    change?: PendingChange;
    source: HTMLElement | null;
  }>();
  const openForm = (change?: PendingChange) =>
    setForm({
      change,
      source: surface.current?.ownerDocument
        .activeElement as HTMLElement | null,
    });
  const [refresh, setRefresh] = useState(0);
  const [move, setMove] = useState<MoveFilesRequest>();
  const [drag, setDrag] = useState<{
    connectionKey: string;
    from: number;
    paths: string[];
    origins: Record<string, number>;
  }>();
  const [dropTarget, setDropTarget] = useState<number>();
  const [deleting, setDeleting] = useState<{
    change: PendingChange;
    source: HTMLElement | null;
  }>();
  const [shelfRequest, setShelfRequest] = useState<{
    request: ShelfRequest;
    unshelve: boolean;
  }>();
  const openShelf = (
    change: PendingChange,
    mode: "shelve" | "delete" | "unshelve",
    paths: string[],
    source?: HTMLElement,
  ) =>
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
  const openMove = (from: number, paths: string[]) =>
    setMove({
      from,
      paths: [...paths],
      source: surface.current?.ownerDocument
        .activeElement as HTMLElement | null,
    });
  const beginDrag = (
    from: number,
    paths: string[],
    event: DragEvent<HTMLElement>,
  ) => {
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
    let live = true;
    const reload = () => setRefresh((n) => n + 1);
    const merge = (event: Event) => {
      const result = (event as CustomEvent<PendingChangeMutationResult>).detail;
      if (result) setChanges((value) => mergePendingMutation(value, result));
    };
    const mergeWorkflow = (event: Event) => {
      const detail = (event as CustomEvent<WorkflowRefreshDetail>).detail;
      if (!detail || detail.connectionKey !== connectionKey) return;
      const operation = detail.result.operationIds.join(", ");
      setNotice(
        `${detail.result.message}${operation ? ` · ${t.files === "文件" ? "操作记录" : "Operations"} ${operation}` : ""}${detail.result.logReference ? ` · ${t.files === "文件" ? "日志" : "Log"} ${detail.result.logReference}` : ""}`,
      );
      void backend
        .queryPendingChanges()
        .then((latest) => {
          if (live)
            setChanges((current) =>
              mergeWorkflowPending(current, latest, detail.target),
            );
        })
        .catch((cause) => {
          if (live) {
            setError(String(cause));
            reload();
          }
        });
    };
    window.addEventListener("p4deck:pending-refresh", reload);
    window.addEventListener("p4deck:pending-mutation", merge);
    window.addEventListener("p4deck:workflow-result", mergeWorkflow);
    return () => {
      live = false;
      window.removeEventListener("p4deck:pending-refresh", reload);
      window.removeEventListener("p4deck:pending-mutation", merge);
      window.removeEventListener("p4deck:workflow-result", mergeWorkflow);
    };
  }, [connectionKey, t.files]);
  const [changes, setChanges] = useState<PendingChange[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [expanded, setExpanded] = useState<Set<number>>(new Set([0, 31821]));
  const [collapsedShelves, setCollapsedShelves] = useState<Set<number>>(
    new Set(),
  );
  useEffect(() => {
    if (
      !navigation ||
      handledNavigation.current === navigation.nonce ||
      !changes.some((change) => change.id === navigation.changeId)
    )
      return;
    handledNavigation.current = navigation.nonce;
    setExpanded((value) => new Set([...value, navigation.changeId]));
    const frame = requestAnimationFrame(() => {
      surface.current
        ?.querySelector<HTMLElement>(
          `[data-pending-change="${navigation.changeId}"]`,
        )
        ?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [changes, navigation]);
  const toggleShelf = (id: number) =>
    setCollapsedShelves((previous) => {
      const next = new Set(previous);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  useEffect(() => {
    if (!ready) return;
    let live = true;
    void backend
      .queryPendingChanges()
      .then((value) => {
        if (live) {
          setChanges(value);
          setError("");
        }
      })
      .catch((cause) => {
        if (live) setError(String(cause));
      });
    return () => {
      live = false;
    };
  }, [ready, refresh]);
  const menu = useContextMenu();
  const run = useContext(CommandExecutionContext);
  const selection = useRecordSelection(
    changes,
    (change) => String(change.id),
    clientName,
  );
  const reload = () => setRefresh((n) => n + 1);
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
  const refreshFileStatus = async () => {
    await Promise.all([
      workspaceCache.invalidateQueries({
        queryKey: ["workspace-files", connectionKey],
      }),
      workspaceCache.invalidateQueries({
        queryKey: ["depot-files", connectionKey],
      }),
    ]);
  };
  const toggle = (id: number) =>
    setExpanded((value) => {
      const next = new Set(value);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  const changeMenu = (change: PendingChange) =>
    menu(
      selection.targets(change).length > 1
        ? "C12"
        : change.id === 0
          ? "C01"
          : "C02",
      () => ({
        "展开/折叠": action(() => toggle(change.id)),
        查看详情: action(() => {
          setExpanded((v) => new Set([...v, change.id]));
        }),
        "复制标识 default": copy("default"),
        "复制 CL 编号": copy(change.id),
        复制描述: copy(change.description),
        刷新: action(reload),
        "编辑 CL…": action(
          () => openForm(change),
          change.id > 0
            ? undefined
            : "Default CL 没有可编辑的编号 spec / Default has no numbered spec",
        ),
        "删除空 CL…": action(
          (source) => setDeleting({ change, source: source ?? null }),
          change.id > 0
            ? undefined
            : "Default CL 不可删除 / Default cannot be deleted",
        ),
        "搁置…": action(
          (source) =>
            openShelf(
              change,
              "shelve",
              change.files.map((file) => file.depotPath),
              source,
            ),
          change.files.length ? undefined : "没有已打开文件 / No opened files",
        ),
        "创建编号 CL 并搁置…": action(
          (source) =>
            openShelf(
              change,
              "shelve",
              change.files.map((file) => file.depotPath),
              source,
            ),
          change.files.length ? undefined : "没有已打开文件 / No opened files",
        ),
        "移动文件到编号 CL…": action(
          () =>
            openMove(
              change.id,
              change.files.map((file) => file.depotPath),
            ),
          change.files.length
            ? undefined
            : "没有可移动的文件 / No files to move",
        ),
        "移动文件到其他 CL…": action(
          () =>
            openMove(
              change.id,
              change.files.map((file) => file.depotPath),
            ),
          change.files.length
            ? undefined
            : "没有可移动的文件 / No files to move",
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
          change.files.length ? undefined : "空 CL 不可提交",
        ),
      }),
      {
        title: change.id ? `CL ${change.id}` : "Default",
        onOpen: () => selection.context(change),
      },
    );
  return (
    <main className="pending-page" ref={surface}>
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
          changes={changes}
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
            setNotice(result.message);
            await refreshFileStatus();
          }}
        />
      )}
      {deleting && (
        <DeleteChangelistDialog
          change={deleting.change}
          source={deleting.source}
          zh={t.files === "文件"}
          onDismiss={() => setDeleting(undefined)}
          onDelete={async () => {
            try {
              const result = await backend.mutatePendingChange({
                type: "delete",
                changeId: deleting.change.id,
                operationId: crypto.randomUUID(),
              });
              applyMutation(
                result,
                t.files === "文件"
                  ? "删除后的刷新不完整"
                  : "Delete refresh incomplete",
                t.files === "文件" ? "CL 已删除" : "Changelist deleted",
              );
            } catch (cause) {
              window.dispatchEvent(new Event("p4deck:pending-refresh"));
              throw cause;
            }
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
      <header className="section-title">
        <div>
          <h1>{t.pendingPage}</h1>
          <p>
            {t.workspace} · {clientName}
          </p>
        </div>
        <div>
          <button onClick={() => openForm()}>
            <Plus size={15} />
            {t.newCl}
          </button>
        </div>
      </header>
      {error && (
        <div role="alert" className="workspace-load-error">
          {error}
        </div>
      )}
      {notice && (
        <div role="status" className="workspace-load-error">
          {notice}
        </div>
      )}
      <div
        className="pending-list"
        tabIndex={0}
        {...menu("C13", () => ({
          "新建 CL…": action(() => openForm()),
          刷新: action(reload),
          全选当前筛选结果: action(selection.all),
          清除选择: action(selection.clear),
        }))}
      >
        {changes.map((change) => (
          <section
            key={change.id}
            className={`pending-card ${selection.isSelected(change) ? "command-selected" : ""} ${dropTarget === change.id ? "drop-target" : ""}`}
            aria-label={`${change.id === 0 ? "Default" : `CL ${change.id}`} drop target`}
            onDragOver={(event) => {
              if (
                drag?.connectionKey === connectionKey &&
                drag.paths.some((path) => drag.origins[path] !== change.id)
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
              onFocus={() => {
                focus({
                  type: "pending",
                  id: change.id,
                  count: change.files.length,
                });
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
                  expanded.has(change.id) ? "" : "pending-chevron-collapsed"
                }
              />
              <strong>{change.id === 0 ? "Default" : `CL ${change.id}`}</strong>
              <span>{change.description}</span>
              <b>
                {change.files.length} {t.files}
              </b>
              <button
                aria-label={`${t.files === "文件" ? "打开 CL 菜单" : "Open CL menu"} ${change.id || "Default"}`}
                onClick={(event) => changeMenu(change).onContextMenu(event)}
              >
                <MoreHorizontal size={16} />
              </button>
              {change.id ? (
                <button
                  title={
                    t.files === "文件"
                      ? "删除空的编号 CL"
                      : "Delete an empty numbered CL"
                  }
                  aria-label={t.delete}
                  onClick={(event) => {
                    event.stopPropagation();
                    setDeleting({
                      change,
                      source: event.currentTarget,
                    });
                  }}
                >
                  <Trash2 size={14} />
                </button>
              ) : null}
            </header>
            {expanded.has(change.id) ? (
              <div className="pending-body">
                <h4>{t.openedFiles}</h4>
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
                            change.shelvedFiles.map((file) => file.depotPath),
                            source,
                          ),
                        ),
                        查看搁置详情: action(() => openShelfDetail(change.id)),
                        "删除搁置内容…": action((source) =>
                          openShelf(
                            change,
                            "delete",
                            change.shelvedFiles.map((file) => file.depotPath),
                            source,
                          ),
                        ),
                        "展开/折叠": action(() => toggleShelf(change.id)),
                        "复制来源 CL 编号": copy(change.id),
                        刷新: action(reload),
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
        ))}
      </div>
    </main>
  );
}
