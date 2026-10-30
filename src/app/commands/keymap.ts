import { useSyncExternalStore } from "react";
import type { AppCommandId } from "./catalog";

/**
 * User key overrides for the application command catalog.
 *
 * - A string replaces the command's primary shortcut.
 * - `null` removes every binding, including the P4V default aliases.
 * - Absent means "use the catalog default".
 *
 * The store is the single keymap source shared by the global dispatcher
 * (`commandForShortcut`), the command palette labels and the Settings editor.
 */
export type ShortcutOverrides = Partial<Record<AppCommandId, string | null>>;

let overrides: ShortcutOverrides = {};
const listeners = new Set<() => void>();

export function getShortcutOverrides(): ShortcutOverrides {
  return overrides;
}

export function setShortcutOverrides(next: ShortcutOverrides): void {
  overrides = next;
  for (const listener of listeners) listener();
}

export function setShortcutOverride(
  commandId: AppCommandId,
  shortcut: string | null,
): void {
  setShortcutOverrides({ ...overrides, [commandId]: shortcut });
}

export function clearShortcutOverride(commandId: AppCommandId): void {
  const next = { ...overrides };
  delete next[commandId];
  setShortcutOverrides(next);
}

export function resetShortcutOverrides(): void {
  setShortcutOverrides({});
}

export function subscribeShortcutOverrides(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useShortcutOverrides(): ShortcutOverrides {
  return useSyncExternalStore(
    subscribeShortcutOverrides,
    getShortcutOverrides,
    getShortcutOverrides,
  );
}
