import { useObjectSelection } from "../SelectionContext";
import { useWorkspaceFiles, useDepotFiles } from "../workspaceQueries";
import { useMemo, useRef, useState, useContext } from "react";
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
import { SelectionContext } from "../SelectionContext";
import { useDirectoryMenu } from "../../../app/context-menu/useDirectoryMenu";
import { action } from "../../../app/context-menu/bindings";
import { useMenuEnvironment } from "../../../app/context-menu/environment";
import { resourceScope } from "../resourceScope";
import { FileStatusIcon } from "./FileStatusIcon";
import {
  depotNodeAsWorkspaceNode,
  searchWorkspaceNodes,
} from "../fileListModel";
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
  directory,
  onNavigate,
}: {
  collapsed: boolean;
  onToggle(): void;
  zh: boolean;
  t: T;
  clientName: string;
  connectionKey: string;
  ready: boolean;
  directory?: string;
  onNavigate(node: WorkspaceNode): void;
  mode: "workspace" | "depot";
  onModeChange(mode: "workspace" | "depot"): void;
}) {
  const workspace = useWorkspaceFiles(
    connectionKey,
    ready && !collapsed && mode === "workspace",
    directory?.startsWith("//") ? undefined : directory,
  );
  const depot = useDepotFiles(
    connectionKey,
    ready && !collapsed && mode === "depot",
    directory?.startsWith("//") ? directory : undefined,
  );
  const [filter, setFilter] = useState("");
  const query = mode === "workspace" ? workspace : depot;
  const error = query.error ? String(query.error) : "";
  const items = useMemo(() => {
    const nodes = (query.data ?? []).map((node): WorkspaceNode =>
      "absolutePath" in node ? node : depotNodeAsWorkspaceNode(node),
    );
    return searchWorkspaceNodes(nodes, filter);
  }, [query.data, filter]);
  const selection = useObjectSelection(items);
  const { select } = useContext(SelectionContext);
  const fileMenu = useFileMenu();
  const menu = useContextMenu();
  const env = useMenuEnvironment();
  const refresh = () => query.refetch();
  const scope = resourceScope(mode, directory, env.runtime.context.cwd);
  const blankMenu = useDirectoryMenu(
    scope.current,
    refresh,
    () => select(items),
    () => select([]),
  );
  // The tree root is stable while browsing subfolders; never make a Depot
  // address or the currently viewed child the local workspace root.
  const rootPath = scope.root;
  const root: WorkspaceNode = {
    id: rootPath,
    name: mode === "workspace" ? clientName : scope.depot || "//",
    absolutePath: mode === "workspace" ? rootPath : "",
    depotPath: scope.depot || undefined,
    relativePath: "",
    state: "controlled",
    kind: "directory",
  };
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtual = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 33,
    overscan: 8,
  });
  return (
    <aside className={`resource-explorer ${collapsed ? "is-collapsed" : ""}`}>
      <button
        className="resource-collapse"
        onClick={onToggle}
        aria-expanded={!collapsed}
        aria-label={
          zh
            ? collapsed
              ? "展开资源侧栏"
              : "折叠资源侧栏"
            : collapsed
              ? "Expand resource sidebar"
              : "Collapse resource sidebar"
        }
        title={
          zh
            ? collapsed
              ? "展开资源侧栏"
              : "折叠资源侧栏"
            : collapsed
              ? "Expand resource sidebar"
              : "Collapse resource sidebar"
        }
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
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder={t.search}
        />
      </label>
      <div
        className="tree-root"
        tabIndex={0}
        {...(mode === "workspace"
          ? fileMenu([root], root, { object: "F05", refresh })
          : scope.depot
            ? fileMenu([root], root, { depot: true, refresh })
            : menu("F10", () => ({
                "刷新 Depot 列表": action(refresh),
                全选当前可见结果: action(() => select(items)),
                清除选择: action(() => select([])),
              })))}
      >
        <FolderOpen size={15} />
        <strong>{root.name}</strong>
      </div>
      <div
        className="tree-list"
        ref={scrollRef}
        role="listbox"
        aria-label={mode === "depot" ? "Depot" : t.workspaceTree}
        aria-multiselectable="true"
        {...blankMenu}
        onKeyDown={(event) => {
          blankMenu.onKeyDown(event);
          if (!event.defaultPrevented) selection.onKeyDown(event);
        }}
      >
        {error && <p role="alert">{error}</p>}
        <div
          className="virtual-spacer"
          style={{ height: virtual.getTotalSize() }}
        >
          {virtual.getVirtualItems().map((row) => {
            const node = items[row.index];
            return (
              <button
                key={node.id}
                style={{
                  position: "absolute",
                  top: 0,
                  transform: `translateY(${row.start}px)`,
                  height: row.size,
                }}
                role="option"
                aria-selected={selection.isSelected(node)}
                className={selection.isSelected(node) ? "selected" : ""}
                onDoubleClick={() => {
                  if (node.kind === "directory")
                    onNavigate(node as WorkspaceNode);
                }}
                onClick={(event) => selection.choose(node, event)}
                {...fileMenu(
                  selection.isSelected(node) ? selection.nodes : [node],
                  node,
                  {
                    depot: mode === "depot",
                    onOpen: () => selection.context(node),
                    refresh,
                  },
                )}
              >
                <ChevronRight
                  size={12}
                  className={node.kind === "file" ? "hidden" : ""}
                />
                {node.kind === "directory" ? (
                  <Folder size={14} />
                ) : (
                  <FileStatusIcon facts={{ ...node, scope: mode }} zh={zh} />
                )}
                <span>{node.name}</span>
              </button>
            );
          })}
        </div>
      </div>
    </aside>
  );
}
