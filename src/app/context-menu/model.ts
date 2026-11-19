import { t } from "../../shared/i18n";
import { menuCatalog, type MenuObjectId } from "./catalog";

export interface MenuAction {
  /** Optional presentation override, retaining the inventory's stable item ID. */
  label?: string;
  run?: (source?: HTMLElement) => void | Promise<unknown>;
  reason?: string;
  checked?: boolean;
  /** Accent an actionable command (e.g. Resolve while a conflict is unresolved). */
  emphasis?: "primary";
  children?: MenuItem[];
  hidden?: boolean;
}
export interface MenuItem extends MenuAction {
  id: string;
  label: string;
  children?: MenuItem[];
  danger?: boolean;
}
export type MenuBindings = Record<string, MenuAction | undefined>;
export interface MenuSpec {
  title: string;
  items: MenuItem[];
  /** Only local/cached capabilities; opening a menu must not fan out into P4 queries. */
  resolve?: () => Promise<MenuItem[]>;
}

export function buildMenu(
  object: MenuObjectId,
  bindings: MenuBindings = {},
): MenuItem[] {
  const result: MenuItem[] = [];
  for (const entry of menuCatalog[object].items) {
    const binding = bindings[entry.id] ?? bindings[entry.label];
    if (binding?.hidden) continue;
    // A menu lists what the user can do right now, not what the product might do
    // one day. Inventory items that no page binds are not rendered at all: they
    // used to sit in a "more actions (not connected)" submenu that looked like
    // ninety features and did nothing. The backlog lives in
    // ForAIDoc/Designer/右键菜单待实现清单.md and stays reviewable there.
    if (entry.phase === "later" && !binding?.run && !binding?.children)
      continue;
    const item: MenuItem = {
      ...binding,
      id: entry.id,
      label: binding?.label ?? entry.label,
      reason:
        binding?.reason ??
        (binding?.run || binding?.children
          ? undefined
          : entry.phase === "later"
            ? t("contextMenu.workflowNotConnected")
            : t("contextMenu.unavailableForTarget")),
      // i18n-exempt: classifies labels across both locales.
      danger: /删除|还原|撤销|移除/.test(entry.label), // i18n-exempt: label classifier
    };
    if (binding?.children) {
      // The inventory names the dynamic leaf (e.g. target group), but the
      // visible parent should only say "Move to group".
      result.push({ ...item, label: entry.label.split(" › ")[0] });
      continue;
    }
    const parts = entry.label.split(" › ");
    if (parts.length === 2) {
      let parent = result.find(
        (value) => value.label === parts[0] && value.children,
      );
      if (!parent) {
        parent = {
          id: `${object}:group:${parts[0]}`,
          label: parts[0],
          children: [],
        };
        result.push(parent);
      }
      parent.children!.push({ ...item, label: parts[1] });
    } else result.push(item);
  }
  return result;
}

export function clampMenu(
  x: number,
  y: number,
  width: number,
  height: number,
  viewportWidth: number,
  viewportHeight: number,
) {
  return {
    left: Math.max(4, Math.min(x, viewportWidth - width - 4)),
    top: Math.max(4, Math.min(y, viewportHeight - height - 4)),
  };
}

export function isTextInput(element: EventTarget | null) {
  return (
    element !== null &&
    "closest" in element &&
    !!(element as Element).closest('input, textarea, [contenteditable="true"]')
  );
}
