import { t } from "../../shared/i18n";
import { ColumnResizer } from "./ColumnResizer";
import type { useColumnWidths } from "./useColumnWidths";
import { useContextMenu } from "./ContextMenu";
import type { MenuBindings } from "./model";

export interface MenuColumn {
  id: string;
  label: string;
}

/** Lists actual columns even before each table's layout/sort controller exists.
 * No checked item pretends to be configurable until it has a real controller. */
export function tableMenuBindings(
  columns: MenuColumn[],
  column?: MenuColumn,
): MenuBindings {
  const sortReason = column
    ? `${column.label}：排序尚未接通 / Sorting not connected`
    : t("shell.choose.a.column.sorting.not.connected");
  return {
    按此列升序: { reason: sortReason },
    按此列降序: { reason: sortReason },
    清除排序: { reason: t("shell.sorting.not.enabled") },
    "显示列 › 各可选列": {
      children: columns.map((value) => ({
        id: `T08:column:${value.id}`,
        label: value.label,
        checked: true,
        reason: t("shell.currently.visible.column.configuration.not.connected"),
      })),
    },
    重置列宽: { reason: t("shell.fixed.column.widths") },
    重置表格布局: {
      reason: t("shell.default.layout.already.in.use"),
    },
  };
}

export function TableHeader({
  className,
  columns,
  resize,
}: {
  className: string;
  columns: MenuColumn[];
  resize?: ReturnType<typeof useColumnWidths>;
}) {
  const menu = useContextMenu();
  return (
    <div
      className={`${className}${resize ? " resizable-columns" : ""}`}
      data-table-id={resize?.id}
      style={resize?.style}
      tabIndex={0}
      {...menu("T08", () => ({
        ...tableMenuBindings(columns),
        ...(resize ? { 重置列宽: { run: resize.reset } } : {}),
      }))}
    >
      {columns.map((column, index) => (
        <span
          key={column.id}
          tabIndex={0}
          {...menu(
            "T08",
            () => ({
              ...tableMenuBindings(columns, column),
              ...(resize ? { 重置列宽: { run: resize.reset } } : {}),
            }),
            {
              title: column.label,
            },
          )}
        >
          {column.label}
          {resize && (
            <ColumnResizer resize={resize} index={index} label={column.label} />
          )}
        </span>
      ))}
    </div>
  );
}
