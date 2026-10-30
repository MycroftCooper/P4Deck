import { storage } from "../../shared/lib/storage";

/** Persisted ids of collapsed settings sections (UI-14). */
export const SETTINGS_COLLAPSED_KEY = "p4deck.settings.collapsed";

/**
 * Read the collapsed section set. Missing, corrupted or unknown entries fall
 * back to "all expanded" so a bad value never hides settings content.
 */
export function readCollapsedSections(
  raw: string | null,
  validIds: readonly string[],
): Set<string> {
  try {
    const parsed: unknown = JSON.parse(raw ?? "null");
    if (Array.isArray(parsed))
      return new Set(
        parsed.filter(
          (value): value is string =>
            typeof value === "string" && validIds.includes(value),
        ),
      );
  } catch {
    /* Corrupted state: keep everything expanded. */
  }
  return new Set();
}
/** Persist only known ids, in section order, so unknown/stale ids cannot accumulate. */
export function writeCollapsedSections(
  collapsed: ReadonlySet<string>,
  validIds: readonly string[],
): void {
  storage.setItem(
    SETTINGS_COLLAPSED_KEY,
    JSON.stringify(validIds.filter((id) => collapsed.has(id))),
  );
}
export function toggleCollapsedSection(
  collapsed: ReadonlySet<string>,
  id: string,
): Set<string> {
  const next = new Set(collapsed);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}
export function expandSection(
  collapsed: ReadonlySet<string>,
  id: string,
): Set<string> {
  if (!collapsed.has(id)) return new Set(collapsed);
  const next = new Set(collapsed);
  next.delete(id);
  return next;
}
