import {
  Children,
  cloneElement,
  isValidElement,
  useRef,
  type ReactElement,
  type ReactNode,
  type HTMLAttributes,
  type TableHTMLAttributes,
} from "react";
import { ColumnResizer } from "./ColumnResizer";
import { useColumnWidths } from "./useColumnWidths";

function textOf(node: ReactNode): string {
  return Children.toArray(node)
    .map((value) =>
      typeof value === "string" || typeof value === "number"
        ? String(value)
        : isValidElement<{ children?: ReactNode }>(value)
          ? textOf(value.props.children)
          : "",
    )
    .join("");
}

/** Keeps native table semantics, cells and virtual spacer rows intact. */
export function ResizableTable({
  tableId,
  defaults,
  minimums,
  children,
  style,
  ...props
}: TableHTMLAttributes<HTMLTableElement> & {
  tableId: string;
  defaults: number[];
  minimums: number[];
}) {
  const table = useRef<HTMLTableElement>(null);
  const resize = useColumnWidths(defaults, minimums, {
    id: tableId,
    gutter: 0,
    readWidths: () =>
      table.current
        ? [...table.current.querySelectorAll("thead tr:first-child > th")].map(
            (cell) =>
              cell.getBoundingClientRect().width /
              (table.current!.getBoundingClientRect().width /
                table.current!.offsetWidth || 1),
          )
        : defaults,
  });
  const headings = (nodes: ReactNode): ReactNode =>
    Children.map(nodes, (node) => {
      if (!isValidElement<HTMLAttributes<HTMLElement>>(node)) return node;
      if (node.type !== "thead") return node;
      return cloneElement(
        node,
        {},
        Children.map(node.props.children, (row) => {
          if (
            !isValidElement<HTMLAttributes<HTMLElement>>(row) ||
            row.type !== "tr"
          )
            return row;
          return cloneElement(
            row,
            {},
            Children.map(row.props.children, (cell, index) => {
              if (
                !isValidElement<HTMLAttributes<HTMLElement>>(cell) ||
                cell.type !== "th"
              )
                return cell;
              return cloneElement(
                cell as ReactElement<HTMLAttributes<HTMLElement>>,
                { style: { ...cell.props.style, position: "relative" } },
                cell.props.children,
                <ColumnResizer
                  resize={resize}
                  index={index}
                  label={textOf(cell.props.children)}
                />,
              );
            }),
          );
        }),
      );
    });
  return (
    <table
      ref={table}
      {...props}
      data-table-id={tableId}
      style={{
        ...style,
        tableLayout: "fixed",
        width: resize.style.minWidth,
        minWidth: resize.changed ? undefined : "100%",
      }}
    >
      <colgroup>
        {resize.widths.map((width, index) => (
          <col key={index} style={{ width }} />
        ))}
      </colgroup>
      {headings(children)}
    </table>
  );
}
