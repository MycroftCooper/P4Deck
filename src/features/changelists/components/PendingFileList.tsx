import { FileStatusIcon } from "../../files/components/FileStatusIcon";
import { useMenuEnvironment } from "../../../app/context-menu/environment";
import { useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type {
  PendingFile,
  WorkspaceNode,
} from "../../../shared/contracts/types";
import { useFileMenu } from "../../../app/context-menu/useFileMenu";
import { useContextMenu } from "../../../app/context-menu/ContextMenu";
import { useRecordSelection } from "../../../app/context-menu/useRecordSelection";
import { copy, action } from "../../../app/context-menu/bindings";
import { useCommandFocus } from "../../../app/shell/CommandContext";

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
}: {
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
  const nodes = useMemo(
    () =>
      files.map((file): WorkspaceNode => ({
        id: file.depotPath,
        name: file.depotPath.split("/").pop()!,
        depotPath: file.depotPath,
        absolutePath: "",
        relativePath: file.depotPath,
        kind: "file",
        state: file.state ?? "controlled",
        changelistId: changeId,
      })),
    [files, changeId],
  );
  const selection = useRecordSelection(
    nodes,
    (node) => node.id,
    `${changeId}:${shelf}`,
  );
  const fileMenu = useFileMenu();
  const menu = useContextMenu();
  const focus = useCommandFocus();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const rowHeight = 36;
  const virtualizer = useVirtualizer({
    count: nodes.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: 8,
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
  useEffect(() => setActiveIndex(0), [changeId, shelf, files]);
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
  const {
    preferences: { zh },
  } = useMenuEnvironment();
  return (
    <div
      ref={scrollRef}
      className="pending-file-scroll"
      data-testid="pending-file-virtual-list"
      role="listbox"
      aria-label={shelf ? "Shelved files" : "Opened files"}
      aria-multiselectable="true"
      style={{
        height: Math.min(360, Math.max(rowHeight, nodes.length * rowHeight)),
      }}
    >
      <div
        className="pending-file-spacer"
        style={{
          height: virtualizer.getTotalSize() || nodes.length * rowHeight,
        }}
      >
        {visibleRows.map((row) => {
          const node = nodes[row.index];
          const index = row.index;
          const menuProps = shelf
            ? menu(
                selection.targets(node).length > 1 ? "C08" : "C07",
                () => ({
                  ...Object.fromEntries(
                    ["删除此搁置文件…", "删除所选搁置文件…"].map((label) => [
                      label,
                      action(
                        (source) =>
                          onShelf?.(
                            "delete",
                            selection.targets(node).map((n) => n.depotPath!),
                            source,
                          ),
                        onShelf ? undefined : "入口尚未接通 / Not connected",
                      ),
                    ]),
                  ),
                  ...Object.fromEntries(
                    ["Unshelve 此文件…", "Unshelve 所选搁置文件…"].map(
                      (label) => [
                        label,
                        action(
                          (source) =>
                            onShelf?.(
                              "unshelve",
                              selection.targets(node).map((n) => n.depotPath!),
                              source,
                            ),
                          onShelf ? undefined : "入口尚未接通 / Not connected",
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
            : fileMenu(selection.targets(node), node, {
                object: selection.targets(node).length > 1 ? "C05" : "C04",
                refresh,
                bindings: {
                  ...Object.fromEntries(
                    ["搁置此文件…", "搁置所选文件…"].map((label) => [
                      label,
                      action(
                        (source) =>
                          onShelf?.(
                            "shelve",
                            selection.targets(node).map((n) => n.depotPath!),
                            source,
                          ),
                        onShelf ? undefined : "入口尚未接通 / Not connected",
                      ),
                    ]),
                  ),
                  ...(onMove
                    ? {
                        "移到 CL…": action(() =>
                          onMove(
                            selection.targets(node).map((n) => n.depotPath!),
                          ),
                        ),
                      }
                    : {}),
                },
                onOpen: () => {
                  selection.context(node);
                  focus({ type: "file", node, nodes: selection.targets(node) });
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
              role="option"
              aria-selected={selection.isSelected(node)}
              aria-setsize={nodes.length}
              aria-posinset={index + 1}
              draggable={!shelf && !!onDragFiles}
              aria-label={`${node.depotPath}, ${files[index].action}${!shelf && onDragFiles ? ", draggable" : ""}`}
              {...menuProps}
              onDragStart={(event) => {
                if (shelf || !onDragFiles) return;
                selection.context(node);
                onDragFiles(
                  selection.targets(node).map((item) => item.depotPath!),
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
                } else if (selection.keyboard(node, event) && !shelf) {
                  focus({ type: "file", node });
                }
              }}
              onClick={(event) => {
                selection.select(node, event);
                if (!shelf) focus({ type: "file", node });
              }}
            >
              <FileStatusIcon
                facts={{
                  ...files[index],
                  scope: shelf ? "shelf" : "workspace",
                  badges: shelf
                    ? undefined
                    : [
                        files[index].lockOwnership === "ours"
                          ? { id: "locked" as const, owner: "self" as const }
                          : files[index].lockOwnership === "other"
                            ? {
                                id: "globalLock" as const,
                                owner: "other" as const,
                                detail: files[index].lockOwner,
                              }
                            : undefined,
                        files[index].exclusiveOpen
                          ? {
                              id: "exclusive" as const,
                              detail: files[index].otherOpen?.join(", "),
                            }
                          : undefined,
                      ].filter(
                        (value): value is NonNullable<typeof value> => !!value,
                      ),
                }}
                zh={zh}
              />
              <span>{node.depotPath}</span>
              <em>{files[index].action}</em>
            </div>
          );
        })}
      </div>
    </div>
  );
}
