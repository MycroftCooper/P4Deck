import { useCommandFocus } from "../../../app/shell/CommandContext";
import { useEffect, useState, useContext, useRef } from "react";
import {
  ChevronDown,
  FolderArchive,
  MoreHorizontal,
  Plus,
  Trash2,
} from "lucide-react";
import type { PendingChange } from "../../../shared/contracts/types";
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
type T = (typeof messages)[keyof typeof messages];

export function PendingPage({
  t,
  clientName,
  ready,
}: {
  t: T;
  clientName: string;
  ready: boolean;
}) {
  const focus = useCommandFocus();
  const surface = useRef<HTMLElement>(null);
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
  const [shelfRequest, setShelfRequest] = useState<{
    request: ShelfRequest;
    unshelve: boolean;
  }>();
  const openShelf = (
    change: PendingChange,
    mode: "shelve" | "delete" | "unshelve",
    paths: string[],
  ) =>
    setShelfRequest({
      request: {
        changeId: change.id,
        paths: [...paths],
        hasShelf: !!change.shelvedFiles.length,
        mode: mode === "delete" ? "delete" : "shelve",
        source: surface.current?.ownerDocument
          .activeElement as HTMLElement | null,
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
  useEffect(() => {
    const reload = () => setRefresh((n) => n + 1);
    window.addEventListener("p4deck:pending-refresh", reload);
    return () => window.removeEventListener("p4deck:pending-refresh", reload);
  }, []);
  const [changes, setChanges] = useState<PendingChange[]>([]);
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState<Set<number>>(new Set([0, 31821]));
  const [collapsedShelves, setCollapsedShelves] = useState<Set<number>>(
    new Set(),
  );
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
        if (live) setChanges(value);
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
        "编辑 CL…": action(() => openForm(change)),
        "搁置…": action(
          () =>
            openShelf(
              change,
              "shelve",
              change.files.map((file) => file.depotPath),
            ),
          change.files.length ? undefined : "没有已打开文件 / No opened files",
        ),
        "创建编号 CL 并搁置…": action(
          () =>
            openShelf(
              change,
              "shelve",
              change.files.map((file) => file.depotPath),
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
            zh={t.files === "文件"}
            onDismiss={() => setShelfRequest(undefined)}
          />
        ) : (
          <ShelfDialog
            request={shelfRequest.request}
            zh={t.files === "文件"}
            onDismiss={() => setShelfRequest(undefined)}
          />
        ))}
      {move && (
        <MoveFilesDialog
          request={move}
          changes={changes}
          client={clientName}
          zh={t.files === "文件"}
          onDismiss={() => setMove(undefined)}
        />
      )}
      {form && (
        <ChangelistFormDialog
          mode={form.change ? "edit" : "create"}
          changeId={form.change?.id}
          initial={
            form.change
              ? { description: form.change.description, jobs: [] }
              : undefined
          }
          client={clientName}
          zh={t.files === "文件"}
          source={form.source}
          onDismiss={() => setForm(undefined)}
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
            className={`pending-card ${selection.isSelected(change) ? "command-selected" : ""}`}
          >
            <header
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
                  disabled
                  title={
                    t.files === "文件"
                      ? "CL 删除流程尚未接通"
                      : "CL deletion workflow is not connected"
                  }
                  aria-label={t.delete}
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
                  onShelf={(mode, paths) => openShelf(change, mode, paths)}
                />
                {change.shelvedFiles.length ? (
                  <>
                    <h4
                      tabIndex={0}
                      {...menu("C06", () => ({
                        "Unshelve 到 CL…": action(() =>
                          openShelf(
                            change,
                            "unshelve",
                            change.shelvedFiles.map((file) => file.depotPath),
                          ),
                        ),
                        "删除搁置内容…": action(() =>
                          openShelf(
                            change,
                            "delete",
                            change.shelvedFiles.map((file) => file.depotPath),
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
                        onShelf={(mode, paths) =>
                          openShelf(change, mode, paths)
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
