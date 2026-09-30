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
    : "请在具体列标题上打开；排序尚未接通 / Choose a column; sorting not connected";
  return {
    按此列升序: { reason: sortReason },
    按此列降序: { reason: sortReason },
    清除排序: { reason: "当前表格尚未启用排序 / Sorting not enabled" },
    "显示列 › 各可选列": {
      children: columns.map((value) => ({
        id: `T08:column:${value.id}`,
        label: value.label,
        checked: true,
        reason:
          "当前固定显示；列配置尚未接通 / Currently visible; column configuration not connected",
      })),
    },
    重置列宽: { reason: "当前使用固定列宽 / Fixed column widths" },
    重置表格布局: {
      reason: "当前使用默认布局 / Default layout already in use",
    },
  };
}

export function TableHeader({
  className,
  columns,
}: {
  className: string;
  columns: MenuColumn[];
}) {
  const menu = useContextMenu();
  return (
    <div
      className={className}
      tabIndex={0}
      {...menu("T08", () => tableMenuBindings(columns))}
    >
      {columns.map((column) => (
        <span
          key={column.id}
          tabIndex={0}
          {...menu("T08", () => tableMenuBindings(columns, column), {
            title: column.label,
          })}
        >
          {column.label}
        </span>
      ))}
    </div>
  );
}
