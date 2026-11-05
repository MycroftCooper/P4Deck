import { t as translate, useIsZh } from "../../../shared/i18n";
import { formatLocalTime } from "../../../shared/lib/localTime";
import { useColumnWidths } from "../../../app/context-menu/useColumnWidths";
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
import {
  useWorkspaceOverlays,
  visibleWorkspaceNodes,
} from "../../actions/workspaceOverlays";
import { useLocalDeleteHidden } from "../../actions/localDeleteTask";
import type { WorkspaceNode } from "../../../shared/contracts";
import type { messages } from "../../../shared/i18n";
import { depotNodeAsWorkspaceNode } from "../fileListModel";
import { nodeNeedsSync } from "../fileActions";

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
  const applyOverlays = useWorkspaceOverlays(connectionKey);
  // Fourth overlay (S3-local-FE): local-delete pending rows are hidden after filtering.
  const localDeleteHidden = useLocalDeleteHidden(connectionKey);
  const nodes: WorkspaceNode[] = useMemo(
    () =>
      applyOverlays(
        isDepot
          ? (depot.data ?? []).map(depotNodeAsWorkspaceNode)
          : (local.data?.items ?? []),
      ) as WorkspaceNode[],
    [isDepot, depot.data, local.data, applyOverlays],
  );
  const busy = listing.isFetching;
  const refreshing = listing.refreshing;
  const [compact, setCompact] = useState(density ?? false);
  useEffect(() => setCompact(density ?? false), [density]);
  const [operationError, setError] = useState("");
  const fileMenu = useFileMenu();
  const { select } = useContext(SelectionContext);
  const error = operationError || (listing.error ? String(listing.error) : "");
  const zh = useIsZh(); // subscribed: re-renders on language switch
  const labels: Record<string, string> = {
    loading: translate("files.status.pending"),
    controlled: translate("files.controlled"),
    openedEdit: translate("files.open.for.edit"),
    openedAdd: translate("files.added"),
    openedDelete: translate("files.deleted"),
    openedMoveAdd: translate("files.move.target"),
    openedMoveDelete: translate("files.move.source"),
    modified: translate("files.modified.locally"),
    untracked: translate("files.untracked"),
    outOfDate: translate("files.out.of.date"),
    notSynced: translate("files.not.synced"),
    conflicted: translate("files.conflicted"),
    missing: translate("files.missing.locally"),
    ignored: translate("files.ignored"),
    unknown: translate("files.unknown"),
  };
  const visibleNodes = useMemo(
    () => visibleWorkspaceNodes(nodes, "all", localDeleteHidden),
    [nodes, localDeleteHidden],
  );
  const selection = useObjectSelection(visibleNodes);
  const scrollRef = useRef<HTMLDivElement>(null);
  const columns = useColumnWidths(
    [300, 120, 100, 100, 160],
    [140, 80, 70, 70, 100],
    { id: "files" },
  );
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
    }
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
            translate("files.workspace.files")}
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
        <span className="filter-count">
          {visibleNodes.length} {t.files}
        </span>
        <button className="density-button" onClick={() => setCompact(!compact)}>
          {compact
            ? translate("files.compact")
            : translate("files.comfortable")}
        </button>
      </div>
      {error ? (
        <div className="workspace-error" role="alert">
          {error}
          <button onClick={() => setError("")}>×</button>
        </div>
      ) : null}
      <div className="file-content">
        <div className="file-table" style={{ overflowX: "auto" }}>
          <TableHeader
            className="file-table-head"
            resize={columns}
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
            style={{ minWidth: columns.style.minWidth }}
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
                const needsSync = nodeNeedsSync(node);
                return (
                  <button
                    key={node.id}
                    role="option"
                    aria-selected={selection.isSelected(node)}
                    className={`file-row ${selection.isSelected(node) ? "selected" : ""}`}
                    style={{
                      transform: `translateY(${row.start}px)`,
                      height: row.size,
                      ...columns.style,
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
                        ? translate("files.depot.file")
                        : labels[node.state]}
                      {!isDepot &&
                      needsSync &&
                      node.state !== "outOfDate" &&
                      node.state !== "notSynced" ? (
                        <span className="file-state-stale">
                          {" "}
                          · {translate("files.needs.sync")}
                        </span>
                      ) : null}
                    </em>
                    <span>
                      #{node.revision ?? "—"}/{node.headRevision ?? "—"}
                    </span>
                    <span>{node.changelistId ?? "—"}</span>
                    <time>
                      {node.modifiedAt
                        ? formatLocalTime(
                            node.modifiedAt,
                            zh ? "zh-CN" : "en-US",
                          )
                        : "—"}
                    </time>
                  </button>
                );
              })}
            </div>
            {!busy && !visibleNodes.length ? (
              <div className="empty-state">
                {translate("files.no.files.in.this.view")}
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
      `${translate("files.ignore.rule")}: ${status.ignore.rule} (${status.ignore.source}${status.ignore.line ? `:${status.ignore.line}` : ""})`,
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
