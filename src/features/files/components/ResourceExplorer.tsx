import {
  useContext,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ChevronRight,
  Folder,
  FolderOpen,
  Search,
  PanelLeftClose,
  PanelLeftOpen,
} from "lucide-react";
import type { WorkspaceNode } from "../../../shared/contracts/types";
import type { messages } from "../../../shared/i18n";
import { useFileMenu } from "../../../app/context-menu/useFileMenu";
import { useContextMenu } from "../../../app/context-menu/ContextMenu";
import { SelectionContext, useObjectSelection } from "../SelectionContext";
import { useDirectoryMenu } from "../../../app/context-menu/useDirectoryMenu";
import { action } from "../../../app/context-menu/bindings";
import { useMenuEnvironment } from "../../../app/context-menu/environment";
import { FileStatusIcon } from "./FileStatusIcon";
import { useResourceTree } from "../useResourceTree";
import type { ResourceTreeRow } from "../resourceTree";
import { connectionPresentation } from "../../settings/connectionWizard";
import { canListWorkspace } from "../workspaceQueries";

type T = (typeof messages)[keyof typeof messages];

export function ResourceExplorer({
  collapsed,
  onToggle,
  zh,
  t,
  mode,
  onModeChange,
  clientName,
  connectionKey,
  ready,
  workspaceReady,
  checkingConnection = false,
  onNavigate,
  resizeHandle,
}: {
  resizeHandle?: ReactNode;
  collapsed: boolean;
  onToggle(): void;
  zh: boolean;
  t: T;
  clientName: string;
  connectionKey: string;
  ready: boolean;
  workspaceReady: boolean;
  checkingConnection?: boolean;
  onNavigate(node: WorkspaceNode): void;
  mode: "workspace" | "depot";
  onModeChange(mode: "workspace" | "depot"): void;
}) {
  const [filter, setFilter] = useState("");
  const [rootOpen, setRootOpen] = useState({ workspace: true, depot: true });
  const [activePath, setActivePath] = useState("");
  const env = useMenuEnvironment();
  const blocked =
    mode === "workspace"
      ? !canListWorkspace(env.runtime)
      : env.runtime.connection.state !== "connected";
  const tree = useResourceTree(
    connectionKey,
    mode,
    !collapsed && rootOpen[mode] && ready && !blocked,
    filter,
    mode === "workspace" ? workspaceReady : !blocked,
  );
  useEffect(() => {
    if (!tree.root.loaded || !tree.rows.length) return;
    const frame = requestAnimationFrame(() => {
      if (!performance.getEntriesByName("p4deck:tree-visible").length)
        performance.mark("p4deck:tree-visible");
    });
    return () => cancelAnimationFrame(frame);
  }, [tree.root.loaded, tree.rows.length]);
  const nodeRows = tree.rows.filter((row) => row.kind === "node");
  const items = nodeRows.map((row) => row.node);
  const selection = useObjectSelection(items);
  const { select } = useContext(SelectionContext);
  const fileMenu = useFileMenu();
  const menu = useContextMenu();
  const root: WorkspaceNode = {
    id: mode === "workspace" ? env.runtime.context.cwd || "" : "//",
    name: mode === "workspace" ? clientName : "//",
    absolutePath: mode === "workspace" ? env.runtime.context.cwd || "" : "",
    depotPath: mode === "depot" ? "//" : undefined,
    relativePath: "",
    state: "controlled",
    kind: "directory",
  };
  const refresh = () => tree.refresh();
  const blankMenu = useDirectoryMenu(
    mode === "workspace" ? undefined : "",
    refresh,
    () => select(items),
    () => select([]),
  );
  const connectionNotice = checkingConnection
    ? zh
      ? "正在自动检查连接与登录状态…"
      : "Checking connection and login automatically…"
    : !ready
      ? env.runtime.p4Version === "loading"
        ? zh
          ? "正在初始化连接…"
          : "Initializing connection…"
        : zh
          ? "未连接，请在设置中添加或选择连接。"
          : "Not connected. Add or select a connection in Settings."
      : blocked || (ready && env.runtime.connection.state !== "connected")
        ? mode === "workspace" && !env.runtime.context.cwd?.trim()
          ? zh
            ? "未配置工作区根目录，请先选择工作区。"
            : "No workspace root configured. Select a workspace."
          : connectionPresentation(env.runtime.connection, zh).detail
        : "";
  const notice =
    connectionNotice ||
    (!tree.root.loaded
      ? tree.root.loading
        ? zh
          ? "正在加载文件…"
          : "Loading files…"
        : ""
      : rootOpen[mode] && !tree.rows.length
        ? filter
          ? zh
            ? "已展开目录中没有匹配项"
            : "No matches in expanded folders"
          : zh
            ? "此目录为空"
            : "This folder is empty"
        : "");
  const scrollRef = useRef<HTMLDivElement>(null);
  const rows = rootOpen[mode] ? tree.rows : [];
  const virtual = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 33,
    overscan: 8,
    getItemKey: (index) => rows[index].key,
  });
  const focusedPath = nodeRows.some((row) => row.key === activePath)
    ? activePath
    : nodeRows[0]?.key;
  const focusRow = (row: ResourceTreeRow | undefined) => {
    if (!row || row.kind !== "node") return;
    setActivePath(row.key);
    virtual.scrollToIndex(rows.indexOf(row), { align: "auto" });
    requestAnimationFrame(() => {
      const targets = scrollRef.current?.querySelectorAll<HTMLElement>(
        "[data-resource-path]",
      );
      [...(targets || [])]
        .find((target) => target.dataset.resourcePath === row.key)
        ?.focus();
    });
  };
  const onTreeKey = (
    event: KeyboardEvent,
    row: ResourceTreeRow & { kind: "node" },
  ) => {
    if (event.defaultPrevented) return;
    const index = nodeRows.findIndex((item) => item.key === row.key);
    if (event.key === "ArrowDown") focusRow(nodeRows[index + 1]);
    else if (event.key === "ArrowUp") focusRow(nodeRows[index - 1]);
    else if (event.key === "Home") focusRow(nodeRows[0]);
    else if (event.key === "End") focusRow(nodeRows.at(-1));
    else if (event.key === "ArrowRight" && row.node.kind === "directory") {
      if (!tree.expanded.has(row.key)) tree.toggle(row.key, true);
      else if (nodeRows[index + 1]?.parent === row.key)
        focusRow(nodeRows[index + 1]);
    } else if (event.key === "ArrowLeft") {
      if (row.node.kind === "directory" && tree.expanded.has(row.key))
        tree.toggle(row.key, false);
      else focusRow(nodeRows.find((item) => item.key === row.parent));
    } else if (event.key === "Enter") {
      if (row.node.kind === "directory") tree.toggle(row.key);
      else onNavigate(row.node);
    } else if (event.key === " ") selection.choose(row.node, event);
    else return;
    event.preventDefault();
    event.stopPropagation();
  };
  const title = zh
    ? collapsed
      ? "展开资源侧栏"
      : "折叠资源侧栏"
    : collapsed
      ? "Expand resource sidebar"
      : "Collapse resource sidebar";
  return (
    <aside
      id="resource-explorer"
      className={`resource-explorer ${collapsed ? "is-collapsed" : ""}`}
    >
      {resizeHandle}
      <button
        className="resource-collapse"
        onClick={onToggle}
        aria-expanded={!collapsed}
        aria-label={title}
        title={title}
      >
        {collapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
      </button>
      <div
        className="resource-tabs"
        tabIndex={0}
        {...menu("T05", () => ({
          "折叠/展开资源栏": action(onToggle),
          刷新当前资源视图: action(refresh),
        }))}
      >
        {(["workspace", "depot"] as const).map((tab) => (
          <div className="resource-tab" key={tab}>
            <button
              className={mode === tab ? "active" : ""}
              onClick={() => onModeChange(tab)}
            >
              {tab === "workspace" ? t.workspaceTree : t.depotTree}
            </button>
          </div>
        ))}
      </div>
      <label className="tree-search">
        <Search size={13} />
        <input
          aria-label={zh ? "筛选资源文件" : "Filter resource files"}
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder={
            zh
              ? "筛选已展开的文件和目录…"
              : "Filter expanded files and folders…"
          }
        />
      </label>
      <div
        className="tree-root"
        tabIndex={0}
        {...(mode === "workspace"
          ? fileMenu([root], root, { object: "F05", refresh })
          : menu("F10", () => ({
              "刷新 Depot 列表": action(refresh),
              全选当前可见结果: action(() => select(items)),
              清除选择: action(() => select([])),
            })))}
      >
        <button
          className="tree-toggle"
          aria-label={`${rootOpen[mode] ? (zh ? "折叠" : "Collapse") : zh ? "展开" : "Expand"} ${root.name}`}
          aria-expanded={rootOpen[mode]}
          onClick={() => setRootOpen((old) => ({ ...old, [mode]: !old[mode] }))}
        >
          <ChevronRight
            size={12}
            className={rootOpen[mode] ? "tree-chevron-open" : ""}
          />
        </button>
        {rootOpen[mode] ? <FolderOpen size={15} /> : <Folder size={15} />}
        <strong title={root.name}>{root.name}</strong>
      </div>
      <div className="tree-content">
        {(notice || tree.root.error || tree.root.warning) && (
          <div className="tree-notice">
            {tree.root.error ? (
              <p role="alert">{tree.root.error}</p>
            ) : (
              notice && <p role="status">{notice}</p>
            )}
            {tree.root.warning && (
              <p className="workspace-warning" role="status">
                {tree.root.warning}
              </p>
            )}
            {(blocked || env.runtime.connection.state !== "connected") &&
              ready &&
              !checkingConnection && (
                <button onClick={() => env.openPage("settings")}>
                  {zh ? "连接设置" : "Connection settings"}
                </button>
              )}
            {tree.root.error && (
              <button onClick={() => void refresh().catch(() => undefined)}>
                {zh ? "重试" : "Retry"}
              </button>
            )}
          </div>
        )}
        <div
          className="tree-list"
          ref={scrollRef}
          role="tree"
          aria-label={mode === "depot" ? "Depot" : t.workspaceTree}
          aria-multiselectable="true"
          aria-busy={tree.root.loading}
          {...blankMenu}
          onKeyDown={(event) => {
            blankMenu.onKeyDown(event);
            if (!event.defaultPrevented) selection.onKeyDown(event);
          }}
        >
          <div
            className="virtual-spacer"
            style={{ height: virtual.getTotalSize() }}
          >
            {virtual.getVirtualItems().map((virtualRow) => {
              const row = rows[virtualRow.index];
              const style = {
                position: "absolute" as const,
                top: 0,
                transform: `translateY(${virtualRow.start}px)`,
                height: virtualRow.size,
                paddingLeft: 8 + row.depth * 16,
                minWidth: 160 + row.depth * 16,
              };
              if (row.kind === "notice")
                return (
                  <div
                    key={row.key}
                    role="treeitem"
                    aria-level={row.depth + 1}
                    aria-label={row.state === "error" ? row.message : row.state}
                    className={`resource-tree-notice ${row.state}`}
                    style={style}
                    title={row.message}
                  >
                    <span>
                      {row.state === "loading"
                        ? zh
                          ? "正在加载…"
                          : "Loading…"
                        : row.state === "empty"
                          ? zh
                            ? "空目录"
                            : "Empty folder"
                          : row.message}
                    </span>
                    {row.state === "error" && (
                      <button
                        onClick={() =>
                          void tree.refresh(row.parent).catch(() => undefined)
                        }
                      >
                        {zh ? "重试" : "Retry"}
                      </button>
                    )}
                  </div>
                );
              const node = row.node;
              const expanded = tree.expanded.has(row.key);
              const menuProps = fileMenu(
                selection.isSelected(node) ? selection.nodes : [node],
                node,
                {
                  depot: mode === "depot",
                  onOpen: () => selection.context(node),
                  refresh: () =>
                    tree.refresh(
                      node.kind === "directory" ? row.key : row.parent,
                    ),
                },
              );
              return (
                <div
                  key={row.key}
                  style={style}
                  className={`resource-tree-row ${selection.isSelected(node) ? "selected" : ""}`}
                  data-resource-path={row.key}
                  role="treeitem"
                  aria-label={node.name}
                  aria-level={row.depth + 1}
                  aria-posinset={row.position}
                  aria-setsize={row.siblings}
                  aria-selected={selection.isSelected(node)}
                  aria-expanded={
                    node.kind === "directory" ? expanded : undefined
                  }
                  tabIndex={row.key === focusedPath ? 0 : -1}
                  {...menuProps}
                  onFocus={() => setActivePath(row.key)}
                  onKeyDown={(event) => {
                    menuProps.onKeyDown(event);
                    onTreeKey(event, row);
                  }}
                  onDoubleClick={() => {
                    if (node.kind === "file") onNavigate(node);
                  }}
                  onClick={(event) => selection.choose(node, event)}
                >
                  {node.kind === "directory" ? (
                    <button
                      className="tree-toggle"
                      tabIndex={-1}
                      aria-label={`${expanded ? (zh ? "折叠" : "Collapse") : zh ? "展开" : "Expand"} ${node.name}`}
                      aria-expanded={expanded}
                      onClick={(event) => {
                        event.stopPropagation();
                        tree.toggle(row.key);
                        event.currentTarget.parentElement?.focus();
                      }}
                    >
                      <ChevronRight
                        size={12}
                        className={expanded ? "tree-chevron-open" : ""}
                      />
                    </button>
                  ) : (
                    <i className="tree-toggle-spacer" />
                  )}
                  {node.kind === "directory" ? (
                    expanded ? (
                      <FolderOpen size={14} />
                    ) : (
                      <Folder size={14} />
                    )
                  ) : (
                    <FileStatusIcon facts={{ ...node, scope: mode }} zh={zh} />
                  )}
                  <span
                    className="resource-tree-name"
                    title={node.absolutePath || node.depotPath}
                  >
                    {node.name}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </aside>
  );
}
