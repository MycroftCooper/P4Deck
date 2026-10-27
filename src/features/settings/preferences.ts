import { storage } from "../../shared/lib/storage";
export const sidebarMinWidth = 200;
export const sidebarMaxWidth = 600;
export interface UiPreferences {
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
