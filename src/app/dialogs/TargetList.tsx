import { useEffect, useId, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";

/** Read-only frozen operation scope. Rendering cost does not grow with file count. */
export function TargetList({
  paths,
  label,
  selectedIndex,
  onSelect,
}: {
  paths: readonly string[];
  label: string;
  selectedIndex?: number;
  onSelect?(index: number): void;
}) {
  const id = useId();
  const scroll = useRef<HTMLDivElement>(null);
  const virtual = useVirtualizer({
    count: paths.length,
    getScrollElement: () => scroll.current,
    estimateSize: () => 30,
    overscan: 6,
  });
  const rows = virtual.getVirtualItems();
  useEffect(() => {
    if (onSelect && selectedIndex !== undefined)
      virtual.scrollToIndex(selectedIndex, { align: "auto" });
  }, [selectedIndex, onSelect, virtual]);
  return (
    <div
      className="workflow-target-list"
      style={{ height: Math.min(160, Math.max(30, paths.length * 30)) }}
      ref={scroll}
      role={onSelect ? "listbox" : "list"}
      aria-label={label}
      tabIndex={0}
      aria-activedescendant={
        onSelect && rows.some((row) => row.index === selectedIndex)
          ? `${id}-${selectedIndex}`
          : undefined
      }
      onKeyDown={(event) => {
        if (!onSelect || !paths.length) return;
        const current = selectedIndex ?? 0;
        const next =
          event.key === "ArrowDown"
            ? Math.min(paths.length - 1, current + 1)
            : event.key === "ArrowUp"
              ? Math.max(0, current - 1)
              : event.key === "Home"
                ? 0
                : event.key === "End"
                  ? paths.length - 1
                  : undefined;
        if (next !== undefined) {
          event.preventDefault();
          onSelect(next);
        }
      }}
    >
      <div style={{ height: virtual.getTotalSize(), position: "relative" }}>
        {rows.map((row) => (
          <div
            key={row.key}
            id={`${id}-${row.index}`}
            role={onSelect ? "option" : "listitem"}
            aria-selected={onSelect ? selectedIndex === row.index : undefined}
            onClick={
              onSelect
                ? () => {
                    onSelect(row.index);
                    scroll.current?.focus();
                  }
                : undefined
            }
            aria-setsize={paths.length}
            aria-posinset={row.index + 1}
            className="workflow-target-row"
            title={paths[row.index]}
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              height: row.size,
              transform: `translateY(${row.start}px)`,
            }}
          >
            {paths[row.index]}
          </div>
        ))}
      </div>
    </div>
  );
}
