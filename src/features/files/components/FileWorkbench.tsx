import { FixedPageHeader } from "../../../app/docking/chrome";
import { useObjectSelection } from "../SelectionContext";
import {
  useWorkspaceFiles,
  useDepotFiles,
  canListWorkspace,
  refreshWorkspaceDirectory,
} from "../workspaceQueries";
import { useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Folder, RefreshCw } from "lucide-react";
import { FileStatusIcon } from "./FileStatusIcon";
import { useFileMenu } from "../../../app/context-menu/useFileMenu";
import { TableHeader } from "../../../app/context-menu/TableHeader";
import { useDirectoryMenu } from "../../../app/context-menu/useDirectoryMenu";
import { useContext } from "react";
import { SelectionContext } from "../SelectionContext";
import { useMenuEnvironment } from "../../../app/context-menu/environment";
import type { WorkspaceNode } from "../../../shared/contracts/types";
import type { messages } from "../../../shared/i18n";
import {
  depotNodeAsWorkspaceNode,
  filterWorkspaceNodes,
  type WorkspaceFileFilter,
} from "../fileListModel";

type T = (typeof messages)[keyof typeof messages];
export function FileWorkbench({
  t,
  selected,
  connectionKey,
  ready,
  workspaceReady,
  onOpenReview,
  density,
  directory,
  onNavigate,
}: {
  t: T;
  selected?: WorkspaceNode;
  connectionKey: string;
  ready: boolean;
  workspaceReady: boolean;
  density?: boolean;
  directory?: string;
  onNavigate(node: WorkspaceNode): void;
  onOpenReview(
    kind: "diff" | "revgraph" | "history" | "preview",
    node: WorkspaceNode,
  ): void;
}) {
  const isDepot = !!directory?.startsWith("//");
  const env = useMenuEnvironment();
  const local = useWorkspaceFiles(
    connectionKey,
    canListWorkspace(env.runtime) && !isDepot,
    directory,
    workspaceReady,
  );
  const depot = useDepotFiles(
    connectionKey,
    ready && isDepot && env.runtime.connection.state === "connected",
    directory,
  );
  const listing = isDepot ? depot : local;
  const nodes: WorkspaceNode[] = useMemo(
    () =>
      isDepot
        ? (depot.data ?? []).map(depotNodeAsWorkspaceNode)
        : (local.data?.items ?? []),
    [isDepot, depot.data, local.data],
  );
  const busy = listing.isFetching;
  const refreshing = listing.refreshing;
  const [filter, setFilter] = useState<WorkspaceFileFilter>("all");
  const [compact, setCompact] = useState(density ?? false);
  useEffect(() => setCompact(density ?? false), [density]);
  const [operationError, setError] = useState("");
  const fileMenu = useFileMenu();
  const { select } = useContext(SelectionContext);
  const error = operationError || (listing.error ? String(listing.error) : "");
  const zh = t.files === "文件";
  const labels: Record<string, string> = {
    loading: zh ? "状态待检查" : "Status pending",
    controlled: zh ? "受版本控制" : "Controlled",
    openedEdit: zh ? "已签出编辑" : "Open for edit",
    openedAdd: zh ? "待添加" : "Added",
    openedDelete: zh ? "待删除" : "Deleted",
    openedMoveAdd: zh ? "移动目标" : "Move target",
    openedMoveDelete: zh ? "移动来源" : "Move source",
    modified: zh ? "本地已修改" : "Modified locally",
    untracked: zh ? "未跟踪" : "Untracked",
    outOfDate: zh ? "待更新" : "Out of date",
    notSynced: zh ? "尚未同步" : "Not synced",
    conflicted: zh ? "有冲突" : "Conflicted",
    missing: zh ? "本地缺失" : "Missing locally",
    ignored: zh ? "已忽略" : "Ignored",
    unknown: zh ? "状态未知" : "Unknown",
  };
  const statusNotice =
    !isDepot &&
    local.data &&
    local.data.cacheFreshness !== "local" &&
    local.data.completeness !== "complete"
      ? local.data.errors.map((item) => item.message).join(" · ") ||
        (local.data.truncated
          ? zh
            ? `结果已限制为 ${local.data.safetyLimit} 项`
            : `Results limited to ${local.data.safetyLimit} items`
          : zh
            ? "状态证据不完整；已保留可信结果"
            : "Status evidence is partial; trusted results are preserved")
      : "";
  const visibleNodes = useMemo(
    () => filterWorkspaceNodes(nodes, filter),
    [nodes, filter],
  );
  const selection = useObjectSelection(visibleNodes);
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtual = useVirtualizer({
    count: visibleNodes.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => (compact ? 34 : 46),
    overscan: 12,
  });
  useEffect(() => {
    virtual.measure();
  }, [compact]);
  useEffect(() => {
    if (!selected) return;
    const matches = (node: WorkspaceNode) =>
      (node.absolutePath || node.depotPath) ===
      (selected.absolutePath || selected.depotPath);
    const index = visibleNodes.findIndex(matches);
    if (index >= 0) {
      // Wait for Dockview's newly activated panel to have a viewport. Rows are fixed-height.
      const reveal = () => {
        const element = scrollRef.current;
        if (!element) return;
        const top = index * (compact ? 34 : 46);
        if (
          top < element.scrollTop ||
          top + (compact ? 34 : 46) > element.scrollTop + element.clientHeight
        )
          element.scrollTop = top;
      };
      reveal();
      const frame = requestAnimationFrame(reveal);
      return () => cancelAnimationFrame(frame);
    } else if (nodes.some(matches)) setFilter("all");
  }, [
    selected?.absolutePath,
    selected?.depotPath,
    visibleNodes,
    nodes,
    compact,
  ]);
  const load = async () => {
    setError("");
    if (isDepot) await depot.refetch();
    else
      await refreshWorkspaceDirectory(connectionKey, directory, workspaceReady);
  };

  const blankMenu = useDirectoryMenu(
    directory,
    load,
    () => select(visibleNodes),
    () => select([]),
  );
  return (
    <section className="file-workbench">
      <FixedPageHeader>
        <span className="fixed-page-meta">
          {directory?.split(/[\\/]/).filter(Boolean).pop() ||
            (zh ? "工作区文件" : "Workspace files")}
          <span className="heading-count">{nodes.length}</span>
        </span>
        <button
          className="secondary"
          disabled={busy || refreshing}
          onClick={() => void load()}
        >
          <RefreshCw size={15} className={busy || refreshing ? "spin" : ""} />
          {t.refresh}
        </button>
      </FixedPageHeader>
      <div className="file-filterbar">
        <div className="segmented">
          {[
            ["all", zh ? "全部文件" : "All files"],
            ["changed", zh ? "本地修改" : "Modified"],
            ["incoming", zh ? "待更新" : "Incoming"],
          ].map(([id, label]) => (
            <button
              key={id}
              aria-pressed={filter === id}
              className={filter === id ? "active" : ""}
              onClick={() => {
                setFilter(id as WorkspaceFileFilter);
                scrollRef.current?.scrollTo(0, 0);
              }}
            >
              {label}
            </button>
          ))}
        </div>
        <span className="filter-count">
          {visibleNodes.length} {t.files}
        </span>
        <button className="density-button" onClick={() => setCompact(!compact)}>
          {compact ? (zh ? "紧凑" : "Compact") : zh ? "舒适" : "Comfortable"}
        </button>
      </div>
      {error ? (
        <div className="workspace-error" role="alert">
          {error}
          <button onClick={() => setError("")}>×</button>
        </div>
      ) : null}
      {statusNotice ? (
        <div className="workspace-warning" role="status" title={statusNotice}>
          {zh ? "状态查询不完整：" : "Partial status: "}
          {statusNotice}
        </div>
      ) : null}
      <div className="file-content">
        <div className="file-table">
          <TableHeader
            className="file-table-head"
            columns={[
              { id: "name", label: t.files },
              { id: "state", label: t.localState },
              { id: "revision", label: t.revision },
              { id: "change", label: t.changelist },
              { id: "modified", label: t.modified },
            ]}
          />
          <div
            ref={scrollRef}
            className="file-scroll"
            role="listbox"
            aria-label={t.files}
            aria-multiselectable="true"
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
              {virtual.getVirtualItems().map((row) => {
                const node = visibleNodes[row.index];
                return (
                  <button
                    key={node.id}
                    role="option"
                    aria-selected={selection.isSelected(node)}
                    className={`file-row ${selection.isSelected(node) ? "selected" : ""}`}
                    style={{
                      transform: `translateY(${row.start}px)`,
                      height: row.size,
                    }}
                    onClick={(event) => selection.choose(node, event)}
                    onDoubleClick={() => {
                      if (node.kind === "file") onOpenReview("preview", node);
                      else onNavigate(node);
                    }}
                    {...fileMenu(
                      selection.isSelected(node) ? selection.nodes : [node],
                      node,
                      {
                        depot: isDepot,
                        onOpen: () => selection.context(node),
                        refresh: load,
                      },
                    )}
                  >
                    <span>
                      {node.kind === "directory" ? (
                        <Folder size={16} className="folder-icon" />
                      ) : (
                        <FileStatusIcon
                          facts={{
                            ...node,
                            scope: isDepot ? "depot" : "workspace",
                          }}
                          zh={zh}
                        />
                      )}
                      <b>{node.name}</b>
                    </span>
                    <em
                      className={`file-state ${node.state}`}
                      title={statusExplanation(node, zh)}
                    >
                      {isDepot
                        ? zh
                          ? "Depot 文件"
                          : "Depot file"
                        : labels[node.state]}
                    </em>
                    <span>
                      #{node.revision ?? "—"}/{node.headRevision ?? "—"}
                    </span>
                    <span>{node.changelistId ?? "—"}</span>
                    <time>
                      {node.modifiedAt
                        ? new Date(node.modifiedAt).toLocaleDateString()
                        : "—"}
                    </time>
                  </button>
                );
              })}
            </div>
            {!busy && !visibleNodes.length ? (
              <div className="empty-state">
                {zh ? "当前筛选下没有文件" : "No files in this view"}
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </section>
  );
}

export function statusExplanation(node: WorkspaceNode, zh: boolean) {
  const status = node.status;
  if (!status) return "";
  const evidence = status.evidence.map((item) => item.summary);
  if (status.ignore)
    evidence.push(
      `${zh ? "忽略规则" : "Ignore rule"}: ${status.ignore.rule} (${status.ignore.source}${status.ignore.line ? `:${status.ignore.line}` : ""})`,
    );
  if (status.completeness !== "complete")
    evidence.push(
      zh
        ? `证据${status.completeness === "error" ? "失败" : "不完整"}`
        : `Evidence ${status.completeness}`,
    );
  evidence.push(...status.errors.map((item) => item.message));
  return evidence.join(" · ");
}
