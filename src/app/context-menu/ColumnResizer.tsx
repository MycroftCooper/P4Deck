import type { useColumnWidths } from "./useColumnWidths";

/** Shared grid/native-table grip; independent of business header menus. */
export function ColumnResizer({
  resize,
  index,
  label,
}: {
  resize: ReturnType<typeof useColumnWidths>;
  index: number;
  label: string;
}) {
  return (
    <div
      className="history-column-resizer"
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      aria-label={`调整列宽 / Resize ${label}`}
      title={`调整列宽 / Resize ${label} · Home: minimum · End: reset`}
      aria-valuemin={resize.minimums[index]}
      aria-valuenow={resize.widths[index]}
      {...resize.handle(index)}
    />
  );
}
