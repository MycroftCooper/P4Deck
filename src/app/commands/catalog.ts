export type AppCommandId =
  | "app.commandPalette"
  | "tools.openTerminal"
  | "tools.openP4Log"
  | "tools.popoutTerminal"
  | "tools.popoutP4Log"
  | "panel.dockBack";

export interface AppCommandDefinition {
  id: AppCommandId;
  zh: string;
  en: string;
  shortcut?: string;
  hiddenFromPalette?: boolean;
}

export const appCommands: readonly AppCommandDefinition[] = [
  {
    id: "app.commandPalette",
    zh: "打开命令面板",
    en: "Open Command Palette",
    shortcut: "Mod+Shift+P",
  },
  {
    id: "tools.openTerminal",
    zh: "打开 Terminal",
    en: "Open Terminal",
    shortcut: "Mod+Alt+T",
  },
  {
    id: "tools.openP4Log",
    zh: "打开 P4 Log",
    en: "Open P4 Log",
    shortcut: "Mod+Alt+L",
  },
  {
    id: "tools.popoutTerminal",
    zh: "在独立窗口打开 Terminal",
    en: "Open Terminal in New Window",
  },
  {
    id: "tools.popoutP4Log",
    zh: "在独立窗口打开 P4 Log",
    en: "Open P4 Log in New Window",
  },
  {
    id: "panel.dockBack",
    zh: "停靠回主窗口",
    en: "Dock Back to Main Window",
    shortcut: "Mod+Alt+D",
  },
] as const;

export function isAppCommand(value: unknown): value is AppCommandId {
  return (
    typeof value === "string" && appCommands.some(({ id }) => id === value)
  );
}

export interface AppCommandEnvironment {
  detached: boolean;
  runtimeReady: boolean;
}

export function appCommandReason(
  id: AppCommandId,
  environment: AppCommandEnvironment,
  zh: boolean,
): string | undefined {
  const message = (cn: string, en: string) => (zh ? cn : en);
  if (id === "panel.dockBack")
    return environment.detached
      ? undefined
      : message("当前内容已在主窗口", "Content is already docked");
  if (
    !environment.runtimeReady &&
    (id === "tools.openTerminal" || id === "tools.popoutTerminal")
  )
    return message("正在加载连接运行时", "Connection runtime is loading");
  if (
    environment.detached &&
    (id === "tools.popoutTerminal" || id === "tools.popoutP4Log")
  )
    return message("当前已在独立窗口", "Already in a separate window");
  return undefined;
}

export function commandForShortcut(
  event: Pick<
    KeyboardEvent,
    "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey"
  >,
): AppCommandId | undefined {
  if (!(event.ctrlKey || event.metaKey)) return undefined;
  const key = event.key.toLowerCase();
  return appCommands.find((command) => {
    if (!command.shortcut) return false;
    const parts = command.shortcut.toLowerCase().split("+");
    return (
      parts.at(-1) === key &&
      parts.includes("shift") === event.shiftKey &&
      parts.includes("alt") === event.altKey
    );
  })?.id;
}

export function shortcutLabel(shortcut: string, mac = false) {
  return shortcut
    .replace("Mod", mac ? "⌘" : "Ctrl")
    .replace("Shift", mac ? "⇧" : "Shift")
    .replace("Alt", mac ? "⌥" : "Alt")
    .replaceAll("+", mac ? "" : "+");
}
