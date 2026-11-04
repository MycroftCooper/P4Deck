import { t as translate } from "../../../shared/i18n";
import { recordFrontendOperationLog } from "../../../infrastructure/backend/frontendOperationLog";
import { pathKey } from "../address";
import { nextRevealStep, type ResourceReveal } from "../resourceReveal";
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
import type { WorkspaceNode } from "../../../shared/contracts";
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
  reveal,
  onRevealConsumed,
}: {
  reveal?: ResourceReveal;
  onRevealConsumed?(id: number): void;
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
  // Selecting the configured root makes toolbar actions (e.g. Get Latest) target
  // the whole workspace; the empty-cwd guard keeps "no usable path" unreadable.
  const [rootSelectNotice, setRootSelectNotice] = useState("");
  const refresh = () => tree.refresh();
  const blankMenu = useDirectoryMenu(
    mode === "workspace" ? undefined : "",
    refresh,
    () => select(items),
    () => select([]),
  );
  const connectionNotice = checkingConnection
    ? translate("files.checking.connection.and.login.automatically")
    : !ready
      ? env.runtime.p4Version === "loading"
        ? translate("files.initializing.connection")
        : translate("files.not.connected.add.or.select")
      : blocked || (ready && env.runtime.connection.state !== "connected")
        ? mode === "workspace" && !env.runtime.context.cwd?.trim()
          ? translate("files.no.workspace.root.configured.select")
          : connectionPresentation(env.runtime.connection, zh).detail
        : "";
  const notice =
    rootSelectNotice ||
    connectionNotice ||
    (!tree.root.loaded
      ? tree.root.loading
        ? translate("files.loading.files")
        : ""
      : rootOpen[mode] && !tree.rows.length
        ? filter
          ? translate("files.no.matches.in.expanded.folders")
          : translate("files.this.folder.is.empty")
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
  const revealSeen = useRef("");
  const revealDone = useRef("");

  const revealKey = reveal ? `${reveal.connectionKey}\0${reveal.id}` : "";
  const cancelReveal = () => {
    if (!reveal || reveal.connectionKey !== connectionKey) return;
    revealDone.current = revealKey;
    onRevealConsumed?.(reveal.id);
  };
  const rootSelected = selection.isSelected(root);
  const selectRoot = () => {
    if (mode === "workspace" && !root.absolutePath) {
      setRootSelectNotice(
        translate("files.no.workspace.root.configured.select.2"),
      );
      return;
    }
    setRootSelectNotice("");
    cancelReveal();
    select([root], root);
  };
  // The root keeps its F05 (workspace) / F10 (depot) menu, but opening it first
  // selects the root so the following menu/toolbar command targets the workspace.
  const rootMenu =
    mode === "workspace"
      ? fileMenu([root], root, {
          object: "F05",
          refresh,
          onOpen: selectRoot,
        })
      : menu("F10", () => ({
          "刷新 Depot 列表": action(refresh),
          全选当前可见结果: action(() => select(items)),
          清除选择: action(() => select([])),
        }));
  useEffect(() => {
    if (
      !reveal ||
      reveal.connectionKey !== connectionKey ||
      revealDone.current === revealKey
    )
      return;
    if (revealSeen.current !== revealKey) {
      revealSeen.current = revealKey;

      setFilter("");
      setRootOpen((old) => ({ ...old, workspace: true }));
      return;
    }
    if (
      collapsed ||
      mode !== "workspace" ||
      !rootOpen.workspace ||
      filter ||
      !ready
    )
      return;
    const finish = (message?: string) => {
      revealDone.current = revealKey;
      if (message) {
        const operationId = crypto.randomUUID();
        void recordFrontendOperationLog({
          eventId: `${operationId}-navigation`,
          operationId,
          action: "addressNavigation",
          phase: "navigation",
          outcome: "failed",
          code: "operationFailed",
          targetCount: 1,
        });
      }
      onRevealConsumed?.(reveal.id);
    };
    if (blocked) {
      finish(
        translate("files.workspace.unavailable.cannot.locate.target"),
      );
      return;
    }
    if (pathKey(reveal.path) === pathKey(root.absolutePath)) {
      setActivePath("");
      select([root], root);
      finish();
      return;
    }
    const step = nextRevealStep(reveal.path, tree.folders, tree.expanded);
    if (step.kind === "wait") return;
    if (step.kind === "error") {
      finish(step.message);
      return;
    }
    if (step.kind === "expand") {
      tree.toggle(step.path, true);
      return;
    }
    const index = rows.findIndex(
      (row) => row.kind === "node" && row.key === step.path,
    );
    const row = rows[index];
    if (!row || row.kind !== "node" || !scrollRef.current?.clientHeight) return;
    // Consume before selection/render updates. Programmatic scroll events do not cancel.
    revealDone.current = revealKey;
    virtual.scrollToIndex(index, { align: "auto" });
    setActivePath(row.key);
    select([row.node], row.node);
    onRevealConsumed?.(reveal.id);
  }, [
    revealKey,
    connectionKey,
    collapsed,
    mode,
    rootOpen.workspace,
    filter,
    ready,
    blocked,
    tree.folders,
    tree.expanded,
    rows,
    virtual,
    select,
    zh,
  ]);
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
        onClick={() => {
          cancelReveal();
          onToggle();
        }}
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
          "折叠/展开资源栏": action(() => {
            cancelReveal();
            onToggle();
          }),
          刷新当前资源视图: action(refresh),
        }))}
      >
        {(["workspace", "depot"] as const).map((tab) => (
          <div className="resource-tab" key={tab}>
            <button
              className={mode === tab ? "active" : ""}
              onClick={() => {
                cancelReveal();
                onModeChange(tab);
              }}
            >
              {tab === "workspace" ? t.workspaceTree : t.depotTree}
            </button>
          </div>
        ))}
      </div>
      <label className="tree-search">
        <Search size={13} />
        <input
          aria-label={translate("files.filter.resource.files")}
          value={filter}
          onChange={(event) => {
            cancelReveal();
            setFilter(event.target.value);
          }}
          placeholder={
            translate("files.filter.expanded.files.and.folders")
          }
        />
      </label>
      <div
        className={`tree-root${rootSelected ? " selected" : ""}`}
        tabIndex={0}
        role="treeitem"
        aria-level={1}
        aria-selected={rootSelected}
        aria-expanded={mode === "workspace" ? rootOpen[mode] : undefined}
        {...rootMenu}
        onClick={(event) => {
          if ((event.target as Element).closest(".tree-toggle")) return;
          selectRoot();
        }}
        onKeyDown={(event) => {
          rootMenu.onKeyDown(event);
          if (event.defaultPrevented) return;
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            selectRoot();
          } else if (event.key === "ArrowRight") {
            event.preventDefault();
            cancelReveal();
            setRootOpen((old) => ({ ...old, [mode]: true }));
          } else if (event.key === "ArrowLeft") {
            event.preventDefault();
            cancelReveal();
            setRootOpen((old) => ({ ...old, [mode]: false }));
          } else if (event.key === "Escape") {
            cancelReveal();
          }
        }}
      >
        <button
          className="tree-toggle"
          aria-label={`${rootOpen[mode] ? (translate("files.collapse")) : translate("files.expand")} ${root.name}`}
          aria-expanded={rootOpen[mode]}
          onClick={(event) => {
            event.stopPropagation();
            cancelReveal();
            setRootOpen((old) => ({ ...old, [mode]: !old[mode] }));
          }}
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
                  {translate("files.connection.settings")}
                </button>
              )}
            {tree.root.error && (
              <button onClick={() => void refresh().catch(() => undefined)}>
                {translate("files.retry")}
              </button>
            )}
          </div>
        )}
        <div
          className="tree-list"
          onWheelCapture={cancelReveal}
          onTouchStartCapture={cancelReveal}
          onPointerDownCapture={cancelReveal}
          ref={scrollRef}
          role="tree"
          aria-label={mode === "depot" ? "Depot" : t.workspaceTree}
          aria-multiselectable="true"
          aria-busy={tree.root.loading}
          {...blankMenu}
          onKeyDown={(event) => {
            if (
              [
                "ArrowDown",
                "ArrowUp",
                "PageDown",
                "PageUp",
                "Home",
                "End",
                "Escape",
              ].includes(event.key)
            )
              cancelReveal();
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
                        ? translate("files.loading")
                        : row.state === "empty"
                          ? translate("files.empty.folder")
                          : row.message}
                    </span>
                    {row.state === "error" && (
                      <button
                        onClick={() =>
                          void tree.refresh(row.parent).catch(() => undefined)
                        }
                      >
                        {translate("files.retry")}
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
                      aria-label={`${expanded ? (translate("files.collapse")) : translate("files.expand")} ${node.name}`}
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
