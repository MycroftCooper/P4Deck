import type { ConfigBackupLocalStorageEntry } from "../../shared/contracts";

export const BACKUP_LOCAL_STORAGE_KEYS = [
  "p4deck.ui",
  "p4deck.locale",
  "p4deck.theme",
  "p4deck.leftOpen",
  "p4deck.toolOpen",
  "p4deck.toolTab",
  "p4deck.toolHeight",
  "p4deck.dockLayout",
  "p4deck.nativePanels",
  "p4deck.pages",
  "p4deck.submitted.filters",
  "p4deck.pending-filter.v1",
  "p4deck.p4Log.view.v1",
] as const;

const BACKUP_LOCAL_STORAGE_PREFIXES = [
  "p4deck.panel.",
  "p4deck.toolPanel.",
] as const;

export function isBackupLocalStorageKey(key: string) {
  return (
    (BACKUP_LOCAL_STORAGE_KEYS as readonly string[]).includes(key) ||
    BACKUP_LOCAL_STORAGE_PREFIXES.some((prefix) => key.startsWith(prefix))
  );
}

export function collectBackupLocalStorage(
  target: Storage = window.localStorage,
): ConfigBackupLocalStorageEntry[] {
  const entries: ConfigBackupLocalStorageEntry[] = [];
  try {
    for (let index = 0; index < target.length; index += 1) {
      const key = target.key(index);
      if (!key || !isBackupLocalStorageKey(key)) continue;
      const value = target.getItem(key);
      if (value !== null) entries.push({ key, value });
    }
  } catch {
    return [];
  }
  return entries.sort((left, right) => left.key.localeCompare(right.key));
}

export function applyBackupLocalStorage(
  entries: ConfigBackupLocalStorageEntry[],
  target: Storage = window.localStorage,
): boolean {
  try {
    const current = collectBackupLocalStorage(target);
    for (const entry of current) target.removeItem(entry.key);
    for (const entry of entries) {
      if (isBackupLocalStorageKey(entry.key))
        target.setItem(entry.key, entry.value);
    }
    return true;
  } catch {
    // Storage can be unavailable in locked-down webviews. The backend still
    // retains the complete verified backup for a later manual recovery.
    return false;
  }
}
