import { storage } from "../../shared/lib/storage";
import { defaultAccent, normalizeAccent } from "./accent";
import { defaultBackgroundTone, normalizeBackgroundTone } from "./background";
export const sidebarMinWidth = 200;
export const sidebarMaxWidth = 600;
export interface UiPreferences {
  accentColor: string;
  /** Empty string follows the theme; otherwise a validated `#rrggbb` tone. */
  backgroundTone: string;
  activityBarText: boolean;
  toolbarText: boolean;
  compact: boolean;
  sidebarWidth: number;
  fontSize: number;
  reducedMotion: boolean;
  autoRefresh: boolean;
  autoRefreshMinutes: number;
  desktopNotifications: boolean;
  notifyOnlyFailures: boolean;
  checkoutUseDefault: boolean;
}
export const defaultUi: UiPreferences = {
  accentColor: defaultAccent,
  backgroundTone: defaultBackgroundTone,
  activityBarText: true,
  toolbarText: true,
  compact: false,
  sidebarWidth: 240,
  fontSize: 12,
  reducedMotion: false,
  autoRefresh: true,
  autoRefreshMinutes: 5,
  desktopNotifications: false,
  notifyOnlyFailures: false,
  checkoutUseDefault: false,
};
export function readUiPreferences(): UiPreferences {
  try {
    const p = JSON.parse(storage.getItem("p4deck.ui") ?? "{}");
    return {
      accentColor: normalizeAccent(p.accentColor) ?? defaultAccent,
      backgroundTone:
        normalizeBackgroundTone(p.backgroundTone) ?? defaultBackgroundTone,
      activityBarText:
        typeof p.activityBarText === "boolean" ? p.activityBarText : true,
      toolbarText: typeof p.toolbarText === "boolean" ? p.toolbarText : true,
      compact: p.compact === true,
      reducedMotion: p.reducedMotion === true,
      autoRefresh: p.autoRefresh !== false,
      autoRefreshMinutes:
        Number.isSafeInteger(p.autoRefreshMinutes) && p.autoRefreshMinutes >= 0
          ? p.autoRefreshMinutes
          : defaultUi.autoRefreshMinutes,
      desktopNotifications: p.desktopNotifications === true,
      notifyOnlyFailures: p.notifyOnlyFailures === true,
      checkoutUseDefault: p.checkoutUseDefault === true,
      sidebarWidth:
        Number.isFinite(p.sidebarWidth) &&
        p.sidebarWidth >= sidebarMinWidth &&
        p.sidebarWidth <= sidebarMaxWidth
          ? p.sidebarWidth
          : 240,
      fontSize: [11, 12, 13, 14].includes(p.fontSize) ? p.fontSize : 12,
    };
  } catch {
    return defaultUi;
  }
}

/** The status-bar pause remembers the configured interval for resuming. */
export function toggleAutoRefresh(ui: UiPreferences): UiPreferences {
  return {
    ...ui,
    autoRefresh: !ui.autoRefresh || ui.autoRefreshMinutes === 0,
    autoRefreshMinutes: ui.autoRefreshMinutes || defaultUi.autoRefreshMinutes,
  };
}

/**
 * Persist UI preferences and verify the round-trip. `storage` is best-effort
 * (disabled storage/quota silently no-op), so callers use the result to tell
 * the user that the appearance change may not survive a restart.
 */
export function saveUiPreferences(ui: UiPreferences): boolean {
  const value = JSON.stringify(ui);
  storage.setItem("p4deck.ui", value);
  return storage.getItem("p4deck.ui") === value;
}
