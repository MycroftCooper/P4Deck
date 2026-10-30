import type { OpenedFileSelection, SelectedOpenedFile } from "../selectedFiles";
import { ColumnResizer } from "../../../app/context-menu/ColumnResizer";
import { useColumnWidths } from "../../../app/context-menu/useColumnWidths";
import { FileStatusIcon } from "../../files/components/FileStatusIcon";
import { useMenuEnvironment } from "../../../app/context-menu/environment";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { PendingFile, WorkspaceNode } from "../../../shared/contracts";
import { useFileMenu } from "../../../app/context-menu/useFileMenu";
import { useContextMenu } from "../../../app/context-menu/ContextMenu";
import { useRecordSelection } from "../../../app/context-menu/useRecordSelection";
import { copy, action } from "../../../app/context-menu/bindings";
import { useCommandFocus } from "../../../app/shell/CommandContext";
import { pendingFilePath } from "../pendingFilePath";

const columnMinWidths = [28, 120, 140, 92, 84];

export function PendingFileList({
  files,
  changeId,
  shelf = false,
  refresh,
  onMove,
  onShelf,
  onInspect,
  onDragFiles,
  onDragEnd,
  sharedSelection,
  onSubmitSelected,
}: {
  sharedSelection?: {
    state: OpenedFileSelection;
    nodes: WorkspaceNode[];
    change(
      rows: readonly SelectedOpenedFile[],
      path: string,
      gesture?: {
        ctrlKey?: boolean;
        metaKey?: boolean;
        shiftKey?: boolean;
        context?: boolean;
      },
    ): readonly SelectedOpenedFile[];
    clear(): void;
    reportVisible?(changeId: number, rows: readonly SelectedOpenedFile[]): void;
  };
  onSubmitSelected?(files: readonly SelectedOpenedFile[]): void;
  files: PendingFile[];
  changeId: number;
  shelf?: boolean;
  refresh(): void;
  onMove?(paths: string[]): void;
  onShelf?(
    mode: "shelve" | "delete" | "unshelve",
    paths: string[],
    source?: HTMLElement,
  ): void;
  onInspect?(path: string, fresh?: boolean): void;
  onDragFiles?(paths: string[], event: DragEvent<HTMLElement>): void;
  onDragEnd?(): void;
}) {
  const {
    runtime: { context },
    preferences: { zh },
  } = useMenuEnvironment();
  const [pathOrder, setPathOrder] = useState<"asc" | "desc">("asc");
  const [statusFilter, setStatusFilter] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const headerRef = useRef<HTMLDivElement>(null);
  const columns = useColumnWidths([28, 180, 350, 110, 90], columnMinWidths, {
    id: shelf ? "shelf-files" : "pending-files",
    gutter: 48,
    readWidths: () =>
      headerRef.current
        ? [...headerRef.current.children].map(
            (cell, index) =>
              cell.getBoundingClientRect().width ||
              [28, 180, 350, 110, 90][index],
          )
        : [28, 180, 350, 110, 90],
  });
  const columnLayout = columns.changed
    ? { widths: columns.widths, gutter: 0 }
    : null;
  const columnResizer = (index: number, label: string) => (
    <ColumnResizer resize={columns} index={index} label={label} />
  );
  const sourceRows = useMemo(
    () =>
      files.map((file) => {
        const path = pendingFilePath(file, context);
        const name = path.replace(/\\/g, "/").split("/").pop() || "";
        const dot = name.lastIndexOf(".");
        return {
          file,
          name,
          path,
          status: file.action.trim() || "unknown",
          extension:
            dot > 0 && dot < name.length - 1
              ? name.slice(dot).toLowerCase()
              : "",
        };
      }),
    [files, context.client, context.cwd],
  );
  const statuses = useMemo(
    () =>
      [
        ...new Set([
          ...sourceRows.map((row) => row.status),
          ...(statusFilter ? [statusFilter] : []),
        ]),
      ]
        .filter((status) => status !== "__resolve")
        .sort(),
    [sourceRows, statusFilter],
  );
  const types = useMemo(
    () =>
      [
        ...new Set([
          ...sourceRows.map((row) => row.extension),
          ...(typeFilter ? [typeFilter === "(none)" ? "" : typeFilter] : []),
        ]),
      ].sort(),
    [sourceRows, typeFilter],
  );
  const filteredRows = useMemo(() => {
    const collator = new Intl.Collator(zh ? "zh-CN" : "en", {
      numeric: true,
      sensitivity: "base",
    });
    const direction = pathOrder === "asc" ? 1 : -1;
    return sourceRows
      .filter(
        (row) =>
          (!statusFilter ||
            (statusFilter === "__resolve"
              ? row.file.resolve === "unresolved"
              : row.status === statusFilter)) &&
          (!typeFilter || (row.extension || "(none)") === typeFilter),
      )
      .sort(
        (left, right) =>
          direction *
          (collator.compare(left.path, right.path) ||
            collator.compare(left.file.depotPath, right.file.depotPath)),
      );
  }, [sourceRows, pathOrder, statusFilter, typeFilter, zh]);
  const nodes = useMemo(
    () =>
      filteredRows.map(({ file, path }): WorkspaceNode => ({
        id: file.depotPath,
        name: file.depotPath.split("/").pop()!,
        depotPath: file.depotPath,
        absolutePath: "",
        relativePath: path,
        kind: "file",
        state: file.state ?? "controlled",
        changelistId: changeId,
      })),
    [filteredRows, changeId],
  );
  const wholeChangelistIdFor = (targets: WorkspaceNode[]) => {
    if (shelf || !files.length) return undefined;
    const selectedPaths = new Set(
      targets.map((target) => target.depotPath).filter(Boolean),
    );
    const allPaths = new Set(files.map((file) => file.depotPath));
    return targets.length === selectedPaths.size &&
      selectedPaths.size === allPaths.size &&
      [...allPaths].every((path) => selectedPaths.has(path))
      ? changeId
      : undefined;
  };
  const localSelection = useRecordSelection(
    nodes,
    (node) => node.id,
    `${changeId}:${shelf}`,
  );
  const shared = shelf ? undefined : sharedSelection;
  useEffect(() => {
    shared?.reportVisible?.(
      changeId,
      nodes.map((node) => ({
        depotPath: node.depotPath!,
        originalChangeId: changeId,
      })),
    );
    return () => shared?.reportVisible?.(changeId, []);
  }, [shared?.reportVisible, changeId, nodes]);
  const toNodes = (files: readonly SelectedOpenedFile[]) =>
    files
      .map((file) =>
        shared?.nodes.find(
          (node) =>
            node.depotPath === file.depotPath &&
            node.changelistId === file.originalChangeId,
        ),
      )
      .filter((node): node is WorkspaceNode => !!node);
  const sharedTargets = (node: WorkspaceNode) =>
    shared!.state.files.some((file) => file.depotPath === node.depotPath)
      ? toNodes(shared!.state.files)
      : [node];
  const selectShared = (node: WorkspaceNode, gesture = {}) =>
    toNodes(
      shared!.change(
        nodes.map((row) => ({
          depotPath: row.depotPath!,
          originalChangeId: changeId,
        })),
        node.depotPath!,
        gesture,
      ),
    );
  const selection = shared
    ? {
        ...localSelection,
        isSelected: (node: WorkspaceNode) =>
          shared.state.files.some((file) => file.depotPath === node.depotPath),
        targets: sharedTargets,
        selectTargets: selectShared,
        contextTargets: (node: WorkspaceNode) =>
          selectShared(node, { context: true }),
        keyboardTargets: (
          node: WorkspaceNode,
          event: import("react").KeyboardEvent,
        ) => {
          if (
            event.target !== event.currentTarget ||
            !["Enter", " "].includes(event.key)
          )
            return false;
          event.preventDefault();
          event.stopPropagation();
          return selectShared(node, event);
        },
        clear: shared.clear,
      }
    : localSelection;
  const fileMenu = useFileMenu();
  const menu = useContextMenu();
  const focus = useCommandFocus();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const rowHeight = 30;
  const getItemKey = useCallback((index: number) => nodes[index].id, [nodes]);
  const virtualizer = useVirtualizer({
    count: nodes.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: 8,
    getItemKey,
    initialRect: { width: 480, height: 288 },
  });
  const measuredRows = virtualizer.getVirtualItems();
  const visibleRows = measuredRows.length
    ? measuredRows
    : Array.from({ length: Math.min(nodes.length, 24) }, (_, index) => ({
        index,
        key: nodes[index].id,
        start: index * rowHeight,
        size: rowHeight,
        end: (index + 1) * rowHeight,
        lane: 0,
      }));
  useEffect(() => {
    setActiveIndex(0);
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [changeId, shelf, statusFilter, typeFilter, pathOrder]);
  useEffect(() => {
    setActiveIndex((index) => Math.min(index, Math.max(0, nodes.length - 1)));
  }, [nodes.length]);
  const focusIndex = (index: number) => {
    if (!nodes.length) return;
    const next = Math.max(0, Math.min(index, nodes.length - 1));
    setActiveIndex(next);
    virtualizer.scrollToIndex(next, { align: "auto" });
    const element = scrollRef.current;
    if (element) {
      const top = next * rowHeight;
      if (
        top < element.scrollTop ||
        top + rowHeight > element.scrollTop + element.clientHeight
      ) {
        element.scrollTop = top;
        element.dispatchEvent(new Event("scroll"));
      }
    }
    requestAnimationFrame(() =>
      scrollRef.current
        ?.querySelector<HTMLElement>(`[data-pending-file-index="${next}"]`)
        ?.focus(),
    );
  };
  const clearSelection = () => {
    selection.clear();
    if (!shelf) focus({ type: "none" });
  };
  const focusSelection = (primary: WorkspaceNode, targets: WorkspaceNode[]) => {
    if (shelf) return;
    const targetNode =
      targets.find((target) => target.id === primary.id) ?? targets.at(-1);
    if (!targetNode) {
      focus({ type: "none" });
      return;
    }
    const wholeChangelistId = wholeChangelistIdFor(targets);
    focus({
      type: "file",
      node: targetNode,
      nodes: targets,
      ...(wholeChangelistId !== undefined ? { wholeChangelistId } : {}),
    });
  };
  const statusLabels: Record<string, string> = zh
    ? {
        add: "新增",
        edit: "编辑",
        delete: "删除",
        branch: "分支",
        integrate: "集成",
        "move/add": "移动 / 新增",
        "move/delete": "移动 / 删除",
        unknown: "未知",
      }
    : {};
  const statusLabel = (value: string) => statusLabels[value] || value;
  const filtered = !!statusFilter || !!typeFilter;
  return (
    <div className="pending-file-table-wrap">
      {filtered && (
        <div className="pending-file-tools">
          <span role="status">
            {nodes.length} / {files.length} {zh ? "文件" : "files"}
          </span>
          <button
            type="button"
            onClick={() => {
              setStatusFilter("");
              setTypeFilter("");
              clearSelection();
            }}
          >
            {zh ? "清除筛选" : "Clear filters"}
          </button>
        </div>
      )}
      <div
        className="pending-file-table"
        role="grid"
        aria-label={shelf ? "Shelved files" : "Opened files"}
        aria-multiselectable="true"
        aria-rowcount={nodes.length + 1}
        aria-colcount={5}
        style={
          columnLayout
            ? ({
                "--pending-file-columns": columnLayout.widths
                  .map((width) => `${width}px`)
                  .join(" "),
                "--pending-file-min-width": `${columnLayout.widths.reduce((sum, width) => sum + width, 0) + 48 + columnLayout.gutter}px`,
              } as CSSProperties)
            : undefined
        }
      >
        <div className="pending-file-header-group" role="rowgroup">
          <div
            ref={headerRef}
            className="pending-file-header"
            role="row"
            aria-rowindex={1}
          >
            <div
              role="columnheader"
              aria-label={zh ? "文件状态图标" : "File status icon"}
            >
              {columnResizer(0, "Icon")}
            </div>
            <div role="columnheader">
              {zh ? "文件名称" : "File name"}
              {columnResizer(1, zh ? "文件名称" : "File name")}
            </div>
            <div
              role="columnheader"
              aria-sort={pathOrder === "asc" ? "ascending" : "descending"}
            >
              <button
                type="button"
                aria-label={zh ? "按路径排序" : "Sort by path"}
                title={
                  zh
                    ? `切换为${pathOrder === "asc" ? "降序" : "升序"}`
                    : `Sort ${pathOrder === "asc" ? "descending" : "ascending"}`
                }
                onClick={() =>
                  setPathOrder((value) => (value === "asc" ? "desc" : "asc"))
                }
              >
                {zh ? "文件路径" : "File path"}{" "}
                {pathOrder === "asc" ? "↑" : "↓"}
              </button>
              {columnResizer(2, zh ? "文件路径" : "File path")}
            </div>
            <div role="columnheader">
              <label>
                <select
                  aria-label={zh ? "按状态筛选" : "Filter by status"}
                  value={statusFilter}
                  onChange={(event) => {
                    setStatusFilter(event.target.value);
                    clearSelection();
                  }}
                >
                  <option value="">{zh ? "所有状态" : "All statuses"}</option>
                  <option value="__resolve">
                    {zh ? "需要 Resolve" : "Needs resolve"}
                  </option>
                  {statuses.map((status) => (
                    <option key={status} value={status}>
                      {statusLabel(status)}
                    </option>
                  ))}
                </select>
              </label>
              {columnResizer(3, zh ? "状态" : "Status")}
            </div>
            <div role="columnheader">
              <label>
                <select
                  aria-label={zh ? "按类型筛选" : "Filter by type"}
                  value={typeFilter}
                  onChange={(event) => {
                    setTypeFilter(event.target.value);
                    clearSelection();
                  }}
                >
                  <option value="">{zh ? "所有类型" : "All types"}</option>
                  {types.map((extension) => (
                    <option
                      key={extension || "(none)"}
                      value={extension || "(none)"}
                    >
                      {extension || (zh ? "无后缀" : "No extension")}
                    </option>
                  ))}
                </select>
              </label>
              {columnResizer(4, zh ? "类型" : "Type")}
            </div>
          </div>
        </div>
        <div
          ref={scrollRef}
          className="pending-file-scroll"
          data-testid="pending-file-virtual-list"
          role="rowgroup"
          style={{
            height: Math.min(
              360,
              Math.max(rowHeight, nodes.length * rowHeight),
            ),
          }}
        >
          <div
            className="pending-file-spacer"
            role="presentation"
            style={{
              height: virtualizer.getTotalSize() || nodes.length * rowHeight,
            }}
          >
            {visibleRows.map((row) => {
              const node = nodes[row.index];
              const index = row.index;
              const { file, name, path, extension, status } =
                filteredRows[index];
              const menuTargets = selection.targets(node);
              const wholeChangelistId = wholeChangelistIdFor(menuTargets);
              const menuProps = shelf
                ? menu(
                    selection.targets(node).length > 1 ? "C08" : "C07",
                    () => ({
                      ...Object.fromEntries(
                        ["删除此搁置文件…", "删除所选搁置文件…"].map(
                          (label) => [
                            label,
                            action(
                              (source) =>
                                onShelf?.(
                                  "delete",
                                  selection
                                    .targets(node)
                                    .map((n) => n.depotPath!),
                                  source,
                                ),
                              onShelf
                                ? undefined
                                : "入口尚未接通 / Not connected",
                            ),
                          ],
                        ),
                      ),
                      ...Object.fromEntries(
                        ["Unshelve 此文件…", "Unshelve 所选搁置文件…"].map(
                          (label) => [
                            label,
                            action(
                              (source) =>
                                onShelf?.(
                                  "unshelve",
                                  selection
                                    .targets(node)
                                    .map((n) => n.depotPath!),
                                  source,
                                ),
                              onShelf
                                ? undefined
                                : "入口尚未接通 / Not connected",
                            ),
                          ],
                        ),
                      ),
                      "复制 Depot 路径": copy(node.depotPath),
                      查看搁置内容: action(
                        () => onInspect?.(node.depotPath!),
                        onInspect ? undefined : "入口尚未接通 / Not connected",
                      ),
                      在新页签查看搁置内容: action(
                        () => onInspect?.(node.depotPath!, true),
                        onInspect ? undefined : "入口尚未接通 / Not connected",
                      ),
                      与工作副本比较: action(
                        () => onInspect?.(node.depotPath!),
                        onInspect ? undefined : "入口尚未接通 / Not connected",
                      ),
                      与基线比较: action(
                        () => onInspect?.(node.depotPath!),
                        onInspect ? undefined : "入口尚未接通 / Not connected",
                      ),
                      复制搁置来源标识: copy(`${node.depotPath}@=${changeId}`),
                      "复制 Depot 路径列表": copy(
                        selection
                          .targets(node)
                          .map((n) => n.depotPath)
                          .join("\n"),
                      ),
                      复制搁置来源标识列表: copy(
                        selection
                          .targets(node)
                          .map((n) => `${n.depotPath}@=${changeId}`)
                          .join("\n"),
                      ),
                      刷新: action(refresh),
                    }),
                    { onOpen: () => selection.context(node) },
                  )
                : fileMenu(menuTargets, node, {
                    object: menuTargets.length > 1 ? "C05" : "C04",
                    refresh,
                    ...(wholeChangelistId !== undefined
                      ? { wholeChangelistId }
                      : {}),
                    bindings: {
                      提交选中文件: action(
                        () =>
                          onSubmitSelected?.(
                            selection.targets(node).map((row) => ({
                              depotPath: row.depotPath!,
                              originalChangeId: row.changelistId!,
                            })),
                          ),
                        onSubmitSelected
                          ? undefined
                          : "入口尚未接通 / Not connected",
                      ),
                      ...Object.fromEntries(
                        ["搁置此文件…", "搁置所选文件…"].map((label) => [
                          label,
                          action(
                            (source) =>
                              onShelf?.(
                                "shelve",
                                selection
                                  .targets(node)
                                  .map((n) => n.depotPath!),
                                source,
                              ),
                            onShelf &&
                              menuTargets.every(
                                (row) => row.changelistId === changeId,
                              )
                              ? undefined
                              : "入口尚未接通 / Not connected",
                          ),
                        ]),
                      ),
                      ...(onMove
                        ? {
                            "移到 CL…": action(() =>
                              onMove(
                                selection
                                  .targets(node)
                                  .map((n) => n.depotPath!),
                              ),
                            ),
                          }
                        : {}),
                    },
                    onOpen: () => {
                      focusSelection(node, selection.contextTargets(node));
                    },
                  });
              return (
                <div
                  key={node.id}
                  data-pending-file-index={index}
                  className={`pending-file ${shelf ? "shelf" : ""} ${selection.isSelected(node) ? "selected" : ""}`}
                  style={{
                    transform: `translateY(${row.start}px)`,
                    height: row.size,
                  }}
                  tabIndex={index === activeIndex ? 0 : -1}
                  role="row"
                  aria-selected={selection.isSelected(node)}
                  aria-rowindex={index + 2}
                  draggable={!shelf && !!onDragFiles}
                  aria-label={`${path}, ${statusLabel(status)}${!shelf && onDragFiles ? ", draggable" : ""}`}
                  {...menuProps}
                  onDragStart={(event) => {
                    if (shelf || !onDragFiles) return;
                    onDragFiles(
                      selection
                        .contextTargets(node)
                        .map((item) => item.depotPath!),
                      event,
                    );
                  }}
                  onDragEnd={onDragEnd}
                  onFocus={() => setActiveIndex(index)}
                  onKeyDown={(event) => {
                    menuProps.onKeyDown(event);
                    if (event.defaultPrevented) return;
                    if (event.key === "ArrowDown") {
                      event.preventDefault();
                      focusIndex(index + 1);
                    } else if (event.key === "ArrowUp") {
                      event.preventDefault();
                      focusIndex(index - 1);
                    } else if (event.key === "Home") {
                      event.preventDefault();
                      focusIndex(0);
                    } else if (event.key === "End") {
                      event.preventDefault();
                      focusIndex(nodes.length - 1);
                    } else {
                      const targets = selection.keyboardTargets(node, event);
                      if (targets) focusSelection(node, targets);
                    }
                  }}
                  onClick={(event) => {
                    focusSelection(node, selection.selectTargets(node, event));
                  }}
                >
                  <div role="gridcell">
                    <FileStatusIcon
                      facts={{
                        ...file,
                        scope: shelf ? "shelf" : "workspace",
                        badges: shelf
                          ? undefined
                          : [
                              file.lockOwnership === "ours"
                                ? {
                                    id: "locked" as const,
                                    owner: "self" as const,
                                  }
                                : file.lockOwnership === "other"
                                  ? {
                                      id: "globalLock" as const,
                                      owner: "other" as const,
                                      detail: file.lockOwner,
                                    }
                                  : undefined,
                              file.resolve === "unresolved"
                                ? {
                                    id: "resolve" as const,
                                  }
                                : undefined,
                              file.exclusiveOpen
                                ? {
                                    id: "exclusive" as const,
                                    detail: file.otherOpen?.join(", "),
                                  }
                                : undefined,
                            ].filter(
                              (value): value is NonNullable<typeof value> =>
                                !!value,
                            ),
                      }}
                      zh={zh}
                    />
                  </div>
                  <span
                    role="gridcell"
                    className="pending-file-name"
                    title={name}
                  >
                    {name}
                  </span>
                  <span
                    role="gridcell"
                    className="pending-file-path"
                    title={path}
                  >
                    {path}
                  </span>
                  <span
                    role="gridcell"
                    className="pending-file-status"
                    title={file.action}
                  >
                    {file.resolve === "unresolved"
                      ? `${statusLabel(status)} · ${zh ? "需要 Resolve" : "Needs resolve"}`
                      : statusLabel(status)}
                  </span>
                  <span role="gridcell" className="pending-file-type">
                    {extension || (zh ? "无后缀" : "No extension")}
                  </span>
                </div>
              );
            })}
          </div>
          {!nodes.length && (
            <p className="pending-file-empty" role="status">
              {filtered
                ? zh
                  ? "没有匹配的文件"
                  : "No matching files"
                : zh
                  ? "没有文件"
                  : "No files"}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
