// Persistence is best-effort: disabled storage or quota errors must not break the UI.
export const storage = {
  getItem(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  setItem(key: string, value: string): void {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* Keep in-memory state usable. */
    }
  },
  /** Like setItem but reports failure so callers can notify instead of silently losing data. */
  setItemChecked(key: string, value: string): boolean {
    try {
      localStorage.setItem(key, value);
      return true;
    } catch {
      return false;
    }
  },
  removeItem(key: string): void {
    try {
      localStorage.removeItem(key);
    } catch {
      /* Best effort. */
    }
  },
};
