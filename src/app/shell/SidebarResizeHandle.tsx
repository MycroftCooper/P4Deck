import { t } from "../../shared/i18n";
import { useEffect, useRef, useState } from "react";
import {
  sidebarMaxWidth,
  sidebarMinWidth,
} from "../../features/settings/preferences";

const collapseThreshold = 96;

export function SidebarResizeHandle({
  width,
  collapsed,
  zh: _zh,
  onPreview,
  onCommit,
  onCollapsedChange,
}: {
  width: number;
  collapsed: boolean;
  zh: boolean;
  onPreview(width: number | undefined): void;
  onCommit(width: number): void;
  onCollapsedChange(collapsed: boolean): void;
}) {
  const drag = useRef<{
    pointerId: number;
    left: number;
    offset: number;
    max: number;
    width: number;
    collapsed: boolean;
    initiallyCollapsed: boolean;
  } | null>(null);
  const [resizing, setResizing] = useState(false);
  useEffect(() => () => onPreview(undefined), [onPreview]);
  const clamp = (value: number, max = sidebarMaxWidth) =>
    Math.round(Math.max(sidebarMinWidth, Math.min(max, value)));
  const update = (clientX: number) => {
    const session = drag.current;
    if (!session) return;
    const next = clientX - session.left + session.offset;
    session.collapsed = next <= collapseThreshold;
    session.width = clamp(next, session.max);
    onCollapsedChange(session.collapsed);
    onPreview(session.width);
  };
  const cancel = () => {
    if (!drag.current) return;
    const initiallyCollapsed = drag.current.initiallyCollapsed;
    drag.current = null;
    setResizing(false);
    onPreview(undefined);
    onCollapsedChange(initiallyCollapsed);
  };
  return (
    <div
      role="separator"
      tabIndex={collapsed ? -1 : 0}
      aria-label={t("shell.resize.resource.sidebar")}
      aria-controls="resource-explorer"
      aria-orientation="vertical"
      aria-valuemin={0}
      aria-valuemax={sidebarMaxWidth}
      aria-valuenow={collapsed ? 0 : width}
      className={`resource-resize-handle ${resizing ? "is-resizing" : ""}`}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        const sidebar = event.currentTarget.parentElement!;
        const rect = sidebar.getBoundingClientRect();
        const workbench = sidebar.parentElement!.getBoundingClientRect();
        const narrow = window.matchMedia("(max-width: 520px)").matches;
        drag.current = {
          pointerId: event.pointerId,
          left: rect.left,
          offset: rect.right - event.clientX,
          max: Math.min(
            sidebarMaxWidth,
            Math.max(
              sidebarMinWidth,
              workbench.right - rect.left - (narrow ? 0 : 280),
            ),
          ),
          width,
          collapsed,
          initiallyCollapsed: collapsed,
        };
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        setResizing(true);
      }}
      onPointerMove={(event) => {
        if (drag.current?.pointerId === event.pointerId) update(event.clientX);
      }}
      onPointerUp={(event) => {
        if (drag.current?.pointerId !== event.pointerId) return;
        update(event.clientX);
        const session = drag.current;
        drag.current = null;
        setResizing(false);
        if (!session.collapsed) onCommit(session.width);
        onPreview(undefined);
        event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onPointerCancel={cancel}
      onLostPointerCapture={cancel}
      onKeyDown={(event) => {
        let next = width;
        if (event.key === "ArrowLeft") next -= 20;
        else if (event.key === "ArrowRight") next += 20;
        else if (event.key === "Home") {
          event.currentTarget.parentElement
            ?.querySelector<HTMLButtonElement>(".resource-collapse")
            ?.focus();
          onCollapsedChange(true);
        } else if (event.key === "End") next = sidebarMaxWidth;
        else return;
        event.preventDefault();
        if (event.key !== "Home") onCommit(clamp(next));
      }}
    />
  );
}
