import { useEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useContextMenu } from "../../../app/context-menu/ContextMenu";
import { copy } from "../../../app/context-menu/bindings";
import { useRecordSelection } from "../../../app/context-menu/useRecordSelection";
import { FileStatusIcon } from "../../files/components/FileStatusIcon";
import { useMenuEnvironment } from "../../../app/context-menu/environment";
import { swarmMenuAction } from "../../swarm/SwarmAction";

export interface RevisionFileTarget {
  depotPath: string;
  revision?: number;
  changeId: number;
  action?: string;
  fileType?: string;
}
/** Explicit revision targets. Never convert them into current-working-copy mutation targets. */
export function RevisionFileList({
  files,
  scope,
  demo,
}: {
  files: RevisionFileTarget[];
  scope: string;
  demo: boolean;
}) {
  const menu = useContextMenu();
  const env = useMenuEnvironment();
  const {
    preferences: { zh },
  } = env;
  const selection = useRecordSelection(
    files,
    (file) => `${file.depotPath}#${file.revision}`,
    scope,
  );
  const scrollRef = useRef<HTMLDivElement>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const virtualizer = useVirtualizer({
    count: files.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 40,
    overscan: 8,
    initialRect: { width: 320, height: 240 },
  });
  const measuredRows = virtualizer.getVirtualItems();
  const visibleRows = measuredRows.length
    ? measuredRows
    : Array.from({ length: Math.min(files.length, 14) }, (_, index) => ({
        index,
        key: `${files[index].depotPath}#${files[index].revision ?? "unknown"}`,
        start: index * 40,
        size: 40,
        end: (index + 1) * 40,
        lane: 0,
      }));
  useEffect(() => {
    setActiveIndex(0);
  }, [scope]);
  const focusIndex = (index: number) => {
    if (!files.length) return;
    const next = Math.max(0, Math.min(index, files.length - 1));
    setActiveIndex(next);
    virtualizer.scrollToIndex(next, { align: "auto" });
    requestAnimationFrame(() =>
      scrollRef.current
        ?.querySelector<HTMLButtonElement>(`[data-file-index="${next}"]`)
        ?.focus(),
    );
  };
  return (
    <section
      className="revision-file-list"
      aria-label="已提交文件 / Submitted files"
    >
      {demo && (
        <p className="preview-note">
          {zh
            ? "这是浏览器 Mock 的模拟提交文件，未访问真实 P4 Server。"
            : "These are simulated Browser Mock files; no real P4 Server was accessed."}
        </p>
      )}
      <div
        ref={scrollRef}
        className="revision-file-scroll"
        data-testid="revision-file-virtual-list"
        role="listbox"
        aria-label={zh ? "提交文件" : "Submitted files"}
        tabIndex={files.length ? -1 : 0}
      >
        <div
          className="revision-file-spacer"
          style={{
            height: `${virtualizer.getTotalSize() || files.length * 40}px`,
          }}
        >
          {visibleRows.map((row) => {
            const file = files[row.index];
            const exactRevision =
              file.revision === undefined
                ? undefined
                : `${file.depotPath}#${file.revision}`;
            const menuProps = menu(
              selection.targets(file).length > 1 ? "C11" : "C10",
              () => ({
                "复制 Depot 路径": copy(file.depotPath),
                复制精确修订标识: copy(exactRevision),
                "复制所属 CL 编号": copy(file.changeId),
                "在 Swarm 中打开": swarmMenuAction(env.runtime, zh, {
                  kind: "file",
                  depotPath: file.depotPath,
                  revision: file.revision,
                }),
                "复制 Depot 路径列表": copy(
                  selection
                    .targets(file)
                    .map((f) => f.depotPath)
                    .join("\n"),
                ),
                复制精确修订标识列表: copy(
                  selection
                    .targets(file)
                    .map((f) =>
                      f.revision === undefined
                        ? f.depotPath
                        : `${f.depotPath}#${f.revision}`,
                    )
                    .join("\n"),
                ),
              }),
              {
                title: `${demo ? "模拟 · " : ""}${exactRevision ?? file.depotPath}`,
                onOpen: () => selection.context(file),
              },
            );
            return (
              <button
                key={`${file.depotPath}#${file.revision ?? "unknown"}`}
                data-file-index={row.index}
                role="option"
                tabIndex={row.index === activeIndex ? 0 : -1}
                className={selection.isSelected(file) ? "selected" : ""}
                style={{
                  transform: `translateY(${row.start}px)`,
                  height: `${row.size}px`,
                }}
                aria-selected={selection.isSelected(file)}
                {...menuProps}
                onFocus={() => setActiveIndex(row.index)}
                onClick={(event) => selection.select(file, event)}
                onKeyDown={(event) => {
                  menuProps.onKeyDown(event);
                  if (event.defaultPrevented) return;
                  if (event.key === "ArrowDown") {
                    event.preventDefault();
                    focusIndex(row.index + 1);
                  } else if (event.key === "ArrowUp") {
                    event.preventDefault();
                    focusIndex(row.index - 1);
                  } else if (event.key === "Home") {
                    event.preventDefault();
                    focusIndex(0);
                  } else if (event.key === "End") {
                    event.preventDefault();
                    focusIndex(files.length - 1);
                  } else {
                    selection.keyboard(file, event);
                  }
                }}
              >
                <FileStatusIcon facts={{ scope: "revision" }} zh={zh} />
                <span title={file.depotPath}>{file.depotPath}</span>
                {file.action ? <small>{file.action}</small> : null}
                <small>
                  {file.revision === undefined ? "#?" : `#${file.revision}`}
                </small>
              </button>
            );
          })}
        </div>
        {!files.length && (
          <p>{zh ? "此提交没有文件" : "This change contains no files"}</p>
        )}
      </div>
    </section>
  );
}
