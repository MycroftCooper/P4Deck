import { useEffect, useRef, type ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { DiffResult, RuntimeInfo } from "../../shared/contracts/types";
import { useContextMenu } from "../../app/context-menu/ContextMenu";
import { action, copy } from "../../app/context-menu/bindings";
import { useFullTextSelection } from "../../app/context-menu/FullTextSelection";
import { swarmMenuAction } from "../swarm/SwarmAction";
import type { DiffRow } from "./diffRows";
import type { DiffMatch, DiffNavigation, DiffSideName } from "./diffNavigation";

export function SplitDiff({
  diff,
  rows,
  runtime,
  zh,
  navigation,
  matches,
  activeMatch,
  onSideFocus,
  onViewportRow,
}: {
  diff: DiffResult;
  rows: DiffRow[];
  runtime: RuntimeInfo;
  zh: boolean;
  navigation?: DiffNavigation;
  matches: Map<number, DiffMatch[]>;
  activeMatch?: DiffMatch;
  onSideFocus(side: DiffSideName): void;
  onViewportRow(row: number): void;
}) {
  const leftScroll = useRef<HTMLDivElement>(null);
  const rightScroll = useRef<HTMLDivElement>(null);
  const menu = useContextMenu();
  const textSelection = useFullTextSelection();
  const navigatedTop = useRef<number | undefined>(undefined);
  const virtual = useVirtualizer({
    count: rows.length,
    getScrollElement: () => leftScroll.current,
    estimateSize: () => 24,
    overscan: 15,
  });
  const items = virtual.getVirtualItems();
  useEffect(() => {
    if (!navigation) return;
    virtual.scrollToIndex(navigation.row, { align: navigation.align });
    navigatedTop.current = leftScroll.current?.scrollTop;
  }, [navigation, virtual]);
  useEffect(() => {
    if (!navigation) return;
    const scroll =
      navigation.side === "left" ? leftScroll.current : rightScroll.current;
    const match = scroll?.querySelector<HTMLElement>(
      `[data-row="${navigation.row}"] mark[data-active="true"]`,
    );
    if (!scroll || !match) return;
    const pane = scroll.getBoundingClientRect();
    const bounds = match.getBoundingClientRect();
    if (bounds.left < pane.left + 70 || bounds.right > pane.right - 12)
      scroll.scrollLeft += bounds.left - pane.left - 80;
  }, [navigation, items[0]?.index, items.at(-1)?.index]);
  useEffect(() => {
    for (const pane of [leftScroll.current, rightScroll.current]) {
      if (pane) {
        pane.scrollTop = 0;
        pane.scrollLeft = 0;
      }
    }
  }, [diff.path, diff.left.label, diff.right.label]);

  return (
    <div className="diff-split" ref={textSelection.surfaceRef}>
      {(["left", "right"] as const).map((side) => {
        const reference = diff[side];
        const sideLabel =
          side === "left" ? (zh ? "左侧" : "Left") : zh ? "右侧" : "Right";
        const text = () =>
          rows
            .flatMap((row) =>
              row.kind === "line" && row[side] ? [row[side]!.text] : [],
            )
            .join("\n");
        return (
          <section className="diff-pane" key={side} data-side={side}>
            <div
              className="diff-side-scroll"
              ref={side === "left" ? leftScroll : rightScroll}
              tabIndex={0}
              role="region"
              aria-label={`${sideLabel} · ${reference.label}`}
              onPointerDown={() => onSideFocus(side)}
              onFocus={() => onSideFocus(side)}
              onScroll={(event) => {
                const other =
                  side === "left" ? rightScroll.current : leftScroll.current;
                if (other && other.scrollTop !== event.currentTarget.scrollTop)
                  other.scrollTop = event.currentTarget.scrollTop;
                if (
                  side === "left" &&
                  event.currentTarget.scrollTop !== navigatedTop.current
                )
                  onViewportRow(Math.floor(event.currentTarget.scrollTop / 24));
              }}
              {...menu(
                "V04",
                () => ({
                  复制所选文本: copy(textSelection.selectedText()),
                  全选当前侧: {
                    ...action(() => textSelection.selectAll(text())),
                    label: zh
                      ? "全选当前侧差异文本"
                      : "Select all diff text on this side",
                  },
                  "复制当前侧文件/修订标识": copy(
                    `${reference.depotPath} · ${reference.label}`,
                  ),
                  "在 Swarm 中打开": swarmMenuAction(runtime, zh, {
                    kind: "file",
                    depotPath: reference.depotPath,
                  }),
                }),
                { title: `${sideLabel} · ${reference.label}` },
              )}
            >
              <div
                className="virtual-spacer"
                style={{ height: virtual.getTotalSize() }}
              >
                {items.map((item) => {
                  const row = rows[item.index];
                  const line = row.kind === "line" ? row[side] : undefined;
                  const style =
                    row.kind === "hunk"
                      ? "meta"
                      : !line
                        ? "empty"
                        : row.changed
                          ? side === "left"
                            ? "removed"
                            : "added"
                          : "context";
                  return (
                    <div
                      className={`diff-side-line ${style}${navigation?.row === item.index ? " diff-target-row" : ""}`}
                      key={item.key}
                      data-row={item.index}
                      data-line={line?.number}
                      style={{
                        height: item.size,
                        transform: `translateY(${item.start}px)`,
                      }}
                    >
                      <span className="diff-line-number">{line?.number}</span>
                      <code>
                        {row.kind === "hunk"
                          ? row.label
                          : highlight(
                              line?.text ?? "",
                              matches.get(item.index),
                              side,
                              activeMatch,
                            )}
                      </code>
                      {line?.noNewline && (
                        <span className="diff-eof-marker">
                          {zh ? "末尾无换行" : "No newline at end of file"}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </section>
        );
      })}
      {textSelection.dialog}
    </div>
  );
}

function highlight(
  text: string,
  matches: DiffMatch[] | undefined,
  side: DiffSideName,
  active?: DiffMatch,
) {
  if (!matches?.length) return text;
  const nodes: ReactNode[] = [];
  let offset = 0;
  for (const match of matches) {
    if (match.side !== "both" && match.side !== side) continue;
    nodes.push(text.slice(offset, match.start));
    nodes.push(
      <mark
        key={match.start}
        data-active={match === active ? "true" : undefined}
      >
        {text.slice(match.start, match.start + match.length)}
      </mark>,
    );
    offset = match.start + match.length;
  }
  nodes.push(text.slice(offset));
  return nodes;
}
