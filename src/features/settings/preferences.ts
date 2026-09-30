import { storage } from "../../shared/lib/storage";
export interface UiPreferences {
  activityBarText: boolean;
  toolbarText: boolean;
  compact: boolean;
  sidebarWidth: number;
  fontSize: number;
  reducedMotion: boolean;
}
export const defaultUi: UiPreferences = {
  activityBarText: true,
  toolbarText: true,
  compact: false,
  sidebarWidth: 240,
  fontSize: 12,
  reducedMotion: false,
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
      sidebarWidth: [200, 240, 280, 320].includes(p.sidebarWidth)
        ? p.sidebarWidth
        : 240,
      fontSize: [11, 12, 13, 14].includes(p.fontSize) ? p.fontSize : 12,
    };
  } catch {
    return defaultUi;
  }
}
