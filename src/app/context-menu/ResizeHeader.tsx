import { ColumnResizer } from "./ColumnResizer";
import type { useColumnWidths } from "./useColumnWidths";

export function ResizeHeader({
  columns,
  resize,
}: {
  columns: string[];
  resize: ReturnType<typeof useColumnWidths>;
}) {
  return (
    <div
      className="shared-resize-header"
      data-table-id={resize.id}
      style={resize.style}
    >
      {columns.map((label, index) => (
        <div key={index} style={{ position: "relative", minWidth: 0 }}>
          {label}
          <ColumnResizer
            resize={resize}
            index={index}
            label={label || String(index + 1)}
          />
        </div>
      ))}
    </div>
  );
}
