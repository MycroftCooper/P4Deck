import { useRef, useState } from "react";
import type { HTMLAttributes } from "react";

export function resizeColumn(
  widths: number[],
  minimums: number[],
  index: number,
  delta: number,
) {
  return widths.map((width, i) =>
    i === index ? Math.max(minimums[i], width + delta) : width,
  );
}

/** Local widths, matching History's pointer-capture and keyboard interaction. */
export function useColumnWidths(
  defaults: number[],
  minimums: number[],
  options: { id?: string; gutter?: number; readWidths?(): number[] } = {},
) {
  const [widths, setWidths] = useState(defaults);
  const [changed, setChanged] = useState(false);
  const reset = () => {
    setWidths(defaults);
    setChanged(false);
  };
  const drag = useRef<{ pointer: number; x: number; widths: number[] } | null>(
    null,
  );
  const style = {
    gridTemplateColumns: widths.map((w) => `${w}px`).join(" "),
    minWidth:
      widths.reduce((a, b) => a + b, 0) +
      (options.gutter ?? 32 + 12 * (widths.length - 1)),
  };
  const handle = (index: number): HTMLAttributes<HTMLDivElement> => ({
    onClick: (e) => e.stopPropagation(),
    onDoubleClick: (e) => {
      e.preventDefault();
      e.stopPropagation();
      reset();
    },
    onContextMenu: (e) => {
      e.preventDefault();
      e.stopPropagation();
    },
    onPointerDown: (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      drag.current = {
        pointer: e.pointerId,
        x: e.clientX,
        widths: (options.readWidths?.() ?? widths).map((width, i) =>
          Math.max(minimums[i], width || widths[i]),
        ),
      };
      setChanged(true);
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    onPointerMove: (e) => {
      if (drag.current?.pointer === e.pointerId)
        setWidths(
          resizeColumn(
            drag.current.widths,
            minimums,
            index,
            e.clientX - drag.current.x,
          ),
        );
    },
    onPointerUp: (e) => {
      if (drag.current?.pointer !== e.pointerId) return;
      setWidths(
        resizeColumn(
          drag.current.widths,
          minimums,
          index,
          e.clientX - drag.current.x,
        ),
      );
      drag.current = null;
      e.currentTarget.releasePointerCapture(e.pointerId);
    },
    onPointerCancel: () => {
      drag.current = null;
    },
    onLostPointerCapture: () => {
      drag.current = null;
    },
    onKeyDown: (e) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
      e.preventDefault();
      e.stopPropagation();
      setChanged(true);
      setWidths((stored) => {
        const current =
          options
            .readWidths?.()
            .map((width, i) => (width > 0 ? width : stored[i])) ?? stored;
        return resizeColumn(
          current,
          minimums,
          index,
          e.key === "End"
            ? defaults[index] - current[index]
            : e.key === "Home"
              ? minimums[index] - current[index]
              : e.key === "ArrowLeft"
                ? -10
                : 10,
        );
      });
    },
  });
  return {
    id: options.id,
    changed,
    style,
    widths,
    minimums,
    handle,
    reset,
  };
}
