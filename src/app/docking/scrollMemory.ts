/**
 * Per-tab scroll memory for docked pages.
 *
 * Dockview detaches a page's DOM element while another tab is active. Re-attaching
 * that element — or remounting the page — puts every scroll container back to the
 * top, so switching tabs loses the reading position even though the data and the
 * React state are still cached. This module remembers the offset of every scrolled
 * element per panel id and restores it when the panel becomes visible again.
 *
 * Elements are identified by their child-index path from the page root: the
 * structural scroll containers (`.virtual-scroll`, `.pending-file-scroll`, page
 * shells) keep the same position across re-attach, while their virtualized rows do
 * not need to be tracked individually.
 */
interface ScrollPosition {
  /** Child-index path from the page root to the scrolled element. */
  path: number[];
  top: number;
  left: number;
}

const panels = new Map<string, Map<string, ScrollPosition>>();
const MAX_PANELS = 200;
const MAX_ENTRIES = 64;

function pathOf(root: HTMLElement, node: HTMLElement): number[] | undefined {
  const path: number[] = [];
  let current: HTMLElement | null = node;
  while (current && current !== root) {
    const parent: HTMLElement | null = current.parentElement;
    if (!parent) return undefined;
    const index = Array.prototype.indexOf.call(parent.children, current);
    if (index < 0) return undefined;
    path.unshift(index);
    current = parent;
  }
  return current === root ? path : undefined;
}

function elementAt(
  root: HTMLElement,
  path: readonly number[],
): HTMLElement | undefined {
  let current: Element = root;
  for (const index of path) {
    const child = current.children[index];
    if (!child) return undefined;
    current = child;
  }
  return current instanceof HTMLElement ? current : undefined;
}

function entriesFor(panelId: string): Map<string, ScrollPosition> {
  let entries = panels.get(panelId);
  if (!entries) {
    entries = new Map();
    panels.set(panelId, entries);
    while (panels.size > MAX_PANELS) {
      const oldest = panels.keys().next().value;
      if (!oldest) break;
      panels.delete(oldest);
    }
  }
  return entries;
}

/**
 * Record one element's current offset. Called from a capture-phase `scroll`
 * listener: only elements the user actually scrolled get an entry, and scrolling
 * back to the top removes it again so no stale position is restored later.
 */
export function rememberScrollElement(
  panelId: string,
  root: HTMLElement,
  node: HTMLElement,
): void {
  const path = pathOf(root, node);
  if (!path) return;
  const entries = entriesFor(panelId);
  const key = path.join("/");
  if (node.scrollTop === 0 && node.scrollLeft === 0) {
    entries.delete(key);
    return;
  }
  if (!entries.has(key) && entries.size >= MAX_ENTRIES) return;
  entries.set(key, { path, top: node.scrollTop, left: node.scrollLeft });
}

/** Remember every currently scrolled descendant (used when the page unmounts). */
export function rememberPanelScroll(panelId: string, root: HTMLElement): void {
  for (const node of root.querySelectorAll<HTMLElement>("*")) {
    if (node.scrollTop === 0 && node.scrollLeft === 0) continue;
    rememberScrollElement(panelId, root, node);
  }
}

/**
 * Restore the remembered offsets. Returns true when every tracked element is
 * back at its offset (or no longer exists); virtualized lists can clamp the first
 * assignment while their spacer is still being measured, so callers retry.
 */
export function restorePanelScroll(
  panelId: string,
  root: HTMLElement,
): boolean {
  const entries = panels.get(panelId);
  if (!entries || entries.size === 0) return true;
  let restored = 0;
  const ordered = [...entries.values()].sort(
    (left, right) => left.path.length - right.path.length,
  );
  for (const entry of ordered) {
    const node = elementAt(root, entry.path);
    if (!node) {
      // The page content is not mounted yet (lazy dock pages mount one frame
      // after the panel turns visible). Keep the entry and report "not done" so
      // the caller retries instead of forgetting the offset.
      continue;
    }
    if (node.scrollTop === entry.top && node.scrollLeft === entry.left) {
      restored += 1;
      continue;
    }
    node.scrollTop = entry.top;
    node.scrollLeft = entry.left;
    // Programmatic assignment does not notify React handlers (virtualizers read
    // the element on scroll), so replay the event the browser would have fired.
    node.dispatchEvent(new Event("scroll", { bubbles: true }));
    if (node.scrollTop === entry.top && node.scrollLeft === entry.left) {
      restored += 1;
    }
  }
  return restored === ordered.length;
}

/** Forget a panel's offsets, e.g. after the user closes that tab. */
export function clearPanelScroll(panelId: string): void {
  panels.delete(panelId);
}

/** Test/QA surface: inspect the remembered offsets for one panel. */
export function rememberedScroll(panelId: string): Array<{
  top: number;
  left: number;
}> {
  return [...(panels.get(panelId)?.values() ?? [])].map(({ top, left }) => ({
    top,
    left,
  }));
}
