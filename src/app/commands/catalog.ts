import { tFor, type MsgKey } from "../../shared/i18n";
import type { PageId } from "../panels";
import type { CommandId } from "../shell/commandPolicy";
import { getShortcutOverrides, type ShortcutOverrides } from "./keymap";

export type AppCommandId =
  | "app.commandPalette"
  | "connection.manageProfiles"
  | "view.refresh"
  | "workspace.sync"
  | "workspace.syncRevision"
  | "changelist.submit"
  | "changelist.shelf"
  | "changelist.moveFiles"
  | "view.files"
  | "view.pending"
  | "view.submitted"
  | "view.search"
  | "view.workspaces"
  | "view.streams"
  | "view.streamgraph"
  | "view.branchMappings"
  | "view.diagnostics"
  | "file.diff"
  | "file.history"
  | "file.revgraph"
  | "file.preview"
  | "file.rename"
  | "file.lock"
  | "file.unlock"
  | "file.resolve"
  | "file.checkout"
  | "file.add"
  | "file.delete"
  | "file.revert"
  | "file.reveal"
  | "file.openWith"
  | "swarm.open"
  | "operation.cancel"
  | "tools.openTerminal"
  | "tools.openP4Log"
  | "tools.popoutTerminal"
  | "tools.popoutP4Log"
  | "view.settings"
  | "refresh.toggleAuto"
  | "panel.dockBack"
  | "navigation.focusAddress";

export type AppCommandGroup =
  "app" | "connection" | "changes" | "navigation" | "file" | "tools";
export type AppCommandRisk = "read" | "mutation" | "sensitive";
export type AppCommandConfirmation = "none" | "stateMachine";

export interface AppCommandDefinition {
  id: AppCommandId;
  group: AppCommandGroup;
  /** Catalog key; resolve with tFor. Shared by both locales. */
  zh: string;
  en: string;
  /** Primary, user-editable key binding. */
  shortcut?: string;
  /** Default P4V-compatible alternate keys; dispatched but not user-editable. */
  aliases?: readonly string[];
  allowInEditable?: boolean;
  risk: AppCommandRisk;
  confirmation: AppCommandConfirmation;
  requires?:
    "runtime" | "connected" | "file" | "pending" | "swarm" | "mainWindow";
  execution?:
    | { kind: "shell"; command: CommandId }
    | { kind: "page"; page: PageId }
    | { kind: "tool"; tool: "diagnostics" };
  hiddenFromPalette?: boolean;
}

function command(
  id: AppCommandId,
  group: AppCommandGroup,
  zh: string,
  en: string,
  options: Partial<
    Omit<AppCommandDefinition, "id" | "group" | "zh" | "en">
  > = {},
): AppCommandDefinition {
  return { id, group, zh, en, risk: "read", confirmation: "none", ...options };
}

export const appCommands: readonly AppCommandDefinition[] = [
  command(
    "app.commandPalette",
    "app",
    "commands.app.commandPalette",
    "commands.app.commandPalette",
    {
      shortcut: "Mod+Shift+P",
      allowInEditable: true,
    },
  ),
  command(
    "connection.manageProfiles",
    "connection",
    "commands.connection.manageProfiles",
    "commands.connection.manageProfiles",
    {
      requires: "mainWindow",
      execution: { kind: "page", page: "settings" },
    },
  ),
  command(
    "view.refresh",
    "navigation",
    "commands.view.refresh",
    "commands.view.refresh",
    {
      shortcut: "Mod+R",
      aliases: ["F5"],
      requires: "runtime",
    },
  ),
  command(
    "workspace.sync",
    "changes",
    "commands.workspace.sync",
    "commands.workspace.sync",
    {
      risk: "mutation",
      confirmation: "stateMachine",
      requires: "file",
      execution: { kind: "shell", command: "getLatest" },
    },
  ),
  command(
    "workspace.syncRevision",
    "changes",
    "commands.workspace.syncRevision",
    "commands.workspace.syncRevision",
    {
      risk: "mutation",
      confirmation: "stateMachine",
      requires: "file",
      execution: { kind: "shell", command: "getRevision" },
    },
  ),
  command(
    "changelist.submit",
    "changes",
    "commands.changelist.submit",
    "commands.changelist.submit",
    {
      risk: "mutation",
      confirmation: "stateMachine",
      requires: "pending",
      execution: { kind: "shell", command: "submit" },
    },
  ),
  command(
    "changelist.shelf",
    "changes",
    "commands.changelist.shelf",
    "commands.changelist.shelf",
    {
      risk: "mutation",
      confirmation: "stateMachine",
      requires: "file",
      execution: { kind: "shell", command: "shelve" },
    },
  ),
  command(
    "changelist.moveFiles",
    "changes",
    "commands.changelist.moveFiles",
    "commands.changelist.moveFiles",
    {
      risk: "mutation",
      confirmation: "stateMachine",
      requires: "file",
      execution: { kind: "shell", command: "moveFiles" },
    },
  ),
  command(
    "view.files",
    "navigation",
    "commands.view.files",
    "commands.view.files",
    {
      shortcut: "Mod+9",
      requires: "mainWindow",
      execution: { kind: "page", page: "files" },
    },
  ),
  command(
    "view.pending",
    "navigation",
    "commands.view.pending",
    "commands.view.pending",
    {
      shortcut: "Mod+1",
      requires: "mainWindow",
      execution: { kind: "page", page: "pending" },
    },
  ),
  command(
    "view.submitted",
    "navigation",
    "commands.view.submitted",
    "commands.view.submitted",
    {
      shortcut: "Mod+2",
      requires: "mainWindow",
      execution: { kind: "page", page: "submitted" },
    },
  ),
  command(
    "view.search",
    "navigation",
    "commands.view.search",
    "commands.view.search",
    {
      shortcut: "Mod+Shift+F",
      requires: "mainWindow",
      execution: { kind: "page", page: "search" },
    },
  ),
  command(
    "view.workspaces",
    "navigation",
    "commands.view.workspaces",
    "commands.view.workspaces",
    {
      shortcut: "Mod+5",
      requires: "mainWindow",
      execution: { kind: "page", page: "workspaces" },
    },
  ),
  command(
    "view.streams",
    "navigation",
    "commands.view.streams",
    "commands.view.streams",
    {
      shortcut: "Mod+7",
      requires: "mainWindow",
      execution: { kind: "page", page: "streams" },
    },
  ),
  command(
    "view.streamgraph",
    "navigation",
    "commands.view.streamgraph",
    "commands.view.streamgraph",
    {
      shortcut: "Mod+Shift+M",
      requires: "mainWindow",
      execution: { kind: "page", page: "streamgraph" },
    },
  ),
  command(
    "view.branchMappings",
    "navigation",
    "commands.view.branchMappings",
    "commands.view.branchMappings",
    {
      shortcut: "Mod+3",
      requires: "mainWindow",
      execution: { kind: "page", page: "branchmappings" },
    },
  ),
  command(
    "view.diagnostics",
    "tools",
    "commands.view.diagnostics",
    "commands.view.diagnostics",
    {
      shortcut: "Mod+I",
      execution: { kind: "tool", tool: "diagnostics" },
    },
  ),
  command("file.diff", "file", "commands.file.diff", "commands.file.diff", {
    shortcut: "Mod+D",
    aliases: ["Mod+Shift+D"],
    requires: "file",
    execution: { kind: "shell", command: "diff" },
  }),
  command(
    "file.history",
    "file",
    "commands.file.history",
    "commands.file.history",
    {
      shortcut: "Mod+T",
      requires: "file",
      execution: { kind: "shell", command: "history" },
    },
  ),
  command(
    "file.revgraph",
    "file",
    "commands.file.revgraph",
    "commands.file.revgraph",
    {
      shortcut: "Mod+Shift+R",
      requires: "file",
      execution: { kind: "shell", command: "revgraph" },
    },
  ),
  command(
    "file.preview",
    "file",
    "commands.file.preview",
    "commands.file.preview",
    {
      requires: "file",
      execution: { kind: "shell", command: "preview" },
    },
  ),
  ...(
    [
      ["file.rename", "commands.file.rename", "commands.file.rename", "rename"],
      ["file.lock", "commands.file.lock", "commands.file.lock", "lock"],
      ["file.unlock", "commands.file.unlock", "commands.file.unlock", "unlock"],
      // Keep each mutating file command on one line: the contract validator
      // matches this table by `["id", "zh", "en", "shell"]` on a single line,
      // so a wrapped entry silently drops out of the production catalog.
      // prettier-ignore
      ["file.resolve", "commands.file.resolve", "commands.file.resolve", "resolve"],
      // prettier-ignore
      ["file.checkout", "commands.file.checkout", "commands.file.checkout", "checkout"],
      ["file.add", "commands.file.add", "commands.file.add", "add"],
      ["file.delete", "commands.file.delete", "commands.file.delete", "delete"],
      ["file.revert", "commands.file.revert", "commands.file.revert", "revert"],
    ] as const
  ).map(([id, zh, en, shellCommand]) =>
    command(id, "changes", zh, en, {
      risk: "mutation",
      confirmation: "stateMachine",
      requires: "file",
      execution: { kind: "shell", command: shellCommand },
    }),
  ),
  command(
    "file.reveal",
    "file",
    "commands.file.reveal",
    "commands.file.reveal",
    {
      shortcut: "Mod+Shift+S",
      requires: "file",
      execution: { kind: "shell", command: "reveal" },
    },
  ),
  command(
    "file.openWith",
    "file",
    "commands.file.openWith",
    "commands.file.openWith",
    {
      requires: "file",
      execution: { kind: "shell", command: "openWith" },
    },
  ),
  command(
    "swarm.open",
    "navigation",
    "commands.swarm.open",
    "commands.swarm.open",
    {
      requires: "swarm",
    },
  ),
  command(
    "operation.cancel",
    "app",
    "commands.operation.cancel",
    "commands.operation.cancel",
    {
      execution: { kind: "shell", command: "cancel" },
    },
  ),
  command(
    "tools.openTerminal",
    "tools",
    "commands.tools.openTerminal",
    "commands.tools.openTerminal",
    {
      shortcut: "Mod+Alt+T",
      allowInEditable: true,
      requires: "runtime",
      risk: "sensitive",
    },
  ),
  command(
    "tools.openP4Log",
    "tools",
    "commands.tools.openP4Log",
    "commands.tools.openP4Log",
    {
      shortcut: "Mod+Alt+L",
      allowInEditable: true,
    },
  ),
  command(
    "tools.popoutTerminal",
    "tools",
    "commands.tools.popoutTerminal",
    "commands.tools.popoutTerminal",
    {
      requires: "mainWindow",
      risk: "sensitive",
    },
  ),
  command(
    "tools.popoutP4Log",
    "tools",
    "commands.tools.popoutP4Log",
    "commands.tools.popoutP4Log",
    {
      requires: "mainWindow",
    },
  ),
  command(
    "view.settings",
    "app",
    "commands.view.settings",
    "commands.view.settings",
    {
      shortcut: "Mod+,",
      requires: "mainWindow",
      execution: { kind: "page", page: "settings" },
    },
  ),
  command(
    "navigation.focusAddress",
    "navigation",
    "commands.navigation.focusAddress",
    "commands.navigation.focusAddress",
    {
      shortcut: "Alt+L",
      aliases: ["Mod+G"],
      requires: "mainWindow",
    },
  ),
  command(
    "refresh.toggleAuto",
    "app",
    "commands.refresh.toggleAuto",
    "commands.refresh.toggleAuto",
  ),
  command(
    "panel.dockBack",
    "tools",
    "commands.panel.dockBack",
    "commands.panel.dockBack",
    {
      shortcut: "Mod+Alt+D",
    },
  ),
] as const;

export interface AppCommandEnvironment {
  detached: boolean;
  runtimeReady: boolean;
  connected?: boolean;
  busy?: boolean;
  target?: "none" | "file" | "pending" | "submitted" | "history";
  pendingCount?: number;
  pendingId?: number;
  shellReasons?: Partial<Record<CommandId, string | undefined>>;
  swarmReason?: string;
}

export function appCommandReason(
  id: AppCommandId,
  environment: AppCommandEnvironment,
  zh: boolean,
): string | undefined {
  const message = (key: string) => tFor(zh ? "zh-CN" : "en-US", key as MsgKey);
  const definition = appCommands.find((item) => item.id === id)!;
  if (id === "panel.dockBack")
    return environment.detached
      ? undefined
      : message("commands.content.is.already.docked");
  if (environment.detached && definition.requires === "mainWindow")
    return message("commands.already.in.a.separate.window");
  if (!environment.runtimeReady && definition.requires === "runtime")
    return message("commands.connection.runtime.is.loading");
  if (!environment.runtimeReady && definition.risk === "mutation")
    return message("commands.connection.runtime.is.loading");
  if (definition.requires === "connected" && !environment.connected)
    return message("commands.the.current.connection.is.unavailable");
  if (environment.busy && definition.risk === "mutation")
    return message("commands.another.operation.is.running");
  if (definition.requires === "file" && environment.target !== "file")
    return message("commands.select.a.file.or.folder.first");
  if (definition.requires === "swarm" && environment.swarmReason)
    return environment.swarmReason;
  if (
    definition.requires === "pending" &&
    (environment.target !== "pending" ||
      !(environment.pendingId && environment.pendingId > 0) ||
      !(environment.pendingCount && environment.pendingCount > 0))
  )
    return message("commands.select.a.nonempty.numbered.pending.cl");
  if (definition.risk === "mutation" && environment.connected === false)
    return message("commands.connection.or.authentication.is.unavailable");
  if (definition.execution?.kind === "shell")
    return environment.shellReasons?.[definition.execution.command];
  return undefined;
}

export type ShortcutPlatform = "mac" | "windows" | "linux";

function isEditable(target: EventTarget | null | undefined): boolean {
  if (typeof Element === "undefined" || !(target instanceof Element))
    return false;
  return !!target.closest(
    "input, textarea, select, [contenteditable='true'], [role='textbox']",
  );
}

export function normalizedShortcut(
  shortcut: string,
  platform: ShortcutPlatform,
): string {
  return shortcut
    .toLowerCase()
    .split("+")
    .map((part) =>
      part === "mod" ? (platform === "mac" ? "meta" : "ctrl") : part,
    )
    .sort()
    .join("+");
}

/** Primary shortcut plus P4V-compatible default aliases, in display order. */
export function commandShortcuts(
  command: AppCommandDefinition,
  overrides: ShortcutOverrides = getShortcutOverrides(),
): readonly string[] {
  const overridden = Object.prototype.hasOwnProperty.call(
    overrides,
    command.id,
  );
  const primary = overridden
    ? (overrides[command.id] ?? undefined)
    : command.shortcut;
  // Clearing a binding removes its default aliases too; replacing the primary
  // keeps the read-only P4V aliases (documented default compatibility keys).
  const aliases =
    overridden && overrides[command.id] === null ? [] : (command.aliases ?? []);
  return primary ? [primary, ...aliases] : aliases;
}

export function shortcutConflictsFor(
  definitions: readonly AppCommandDefinition[],
  platform: ShortcutPlatform,
  overrides: ShortcutOverrides = getShortcutOverrides(),
): string[] {
  const seen = new Map<string, AppCommandId>();
  const conflicts: string[] = [];
  for (const item of definitions) {
    for (const shortcut of commandShortcuts(item, overrides)) {
      const normalized = normalizedShortcut(shortcut, platform);
      const previous = seen.get(normalized);
      if (previous) conflicts.push(`${previous} / ${item.id}: ${normalized}`);
      else seen.set(normalized, item.id);
    }
  }
  return conflicts;
}

export function shortcutConflicts(
  platform: ShortcutPlatform,
  overrides: ShortcutOverrides = getShortcutOverrides(),
): string[] {
  return shortcutConflictsFor(appCommands, platform, overrides);
}

export function commandForShortcut(
  event: Pick<
    KeyboardEvent,
    "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey"
  > & {
    target?: EventTarget | null;
  },
  platform: ShortcutPlatform = navigator.platform.toLowerCase().includes("mac")
    ? "mac"
    : navigator.platform.toLowerCase().includes("linux")
      ? "linux"
      : "windows",
  overrides: ShortcutOverrides = getShortcutOverrides(),
): AppCommandId | undefined {
  if (
    (platform === "mac" && event.ctrlKey) ||
    (platform !== "mac" && event.metaKey)
  )
    return undefined;
  const modifiers = [
    platform === "mac" ? event.metaKey && "meta" : event.ctrlKey && "ctrl",
    event.shiftKey && "shift",
    event.altKey && "alt",
    event.key.toLowerCase(),
  ]
    .filter(Boolean)
    .sort()
    .join("+");
  const found = appCommands.find((item) =>
    commandShortcuts(item, overrides).some(
      (shortcut) => normalizedShortcut(shortcut, platform) === modifiers,
    ),
  );
  if (!found || (isEditable(event.target) && !found.allowInEditable))
    return undefined;
  return found.id;
}

const modifierOnlyKeys = new Set([
  "Shift",
  "Control",
  "Alt",
  "Meta",
  "CapsLock",
  "Fn",
  "FnLock",
  "Hyper",
  "Super",
  "Symbol",
  "OS",
]);

/** Printable/function keys that may be stored in the keymap. */
function normalizedShortcutKey(key: string): string | undefined {
  if (/^[a-z]$/i.test(key)) return key.toUpperCase();
  if (/^[0-9]$/.test(key)) return key;
  if (/^F([1-9]|1[0-9]|2[0-4])$/i.test(key)) return key.toUpperCase();
  if ([",", ".", "/", ";", "'", "[", "]", "-", "=", "`", "\\"].includes(key))
    return key;
  return undefined;
}

/**
 * Canonical catalog key string for a captured keydown, or `undefined` when the
 * combination cannot be bound. Mirrors commandForShortcut platform handling:
 * Windows/Linux use Ctrl for Mod, macOS uses Cmd; other Ctrl/Meta combinations
 * are rejected instead of silently producing a different binding.
 */
export function shortcutFromEvent(
  event: Pick<
    KeyboardEvent,
    "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey"
  >,
  platform: ShortcutPlatform,
): string | undefined {
  if (!event.key || modifierOnlyKeys.has(event.key)) return undefined;
  if (platform === "mac" && event.ctrlKey) return undefined;
  if (platform !== "mac" && event.metaKey) return undefined;
  const mod = platform === "mac" ? event.metaKey : event.ctrlKey;
  const key = normalizedShortcutKey(event.key);
  if (!key) return undefined;
  // Require Ctrl/Cmd, Alt or a function key so printable text cannot become a
  // global shortcut outside inputs.
  if (!mod && !event.altKey && !/^F\d{1,2}$/.test(key)) return undefined;
  return [
    ...(mod ? ["Mod"] : []),
    ...(event.altKey ? ["Alt"] : []),
    ...(event.shiftKey ? ["Shift"] : []),
    key,
  ].join("+");
}

/**
 * Validates a canonical keymap string (as stored by shortcutFromEvent) without
 * a platform, used when loading persisted keymaps and migration data.
 */
export function isValidShortcut(shortcut: string): boolean {
  if (typeof shortcut !== "string" || !shortcut.trim()) return false;
  const parts = shortcut.split("+");
  if (parts.length > 4) return false;
  const key = normalizedShortcutKey(parts[parts.length - 1]);
  if (!key) return false;
  const modifiers = parts.slice(0, -1);
  if (
    !modifiers.every((modifier) => ["Mod", "Alt", "Shift"].includes(modifier))
  )
    return false;
  if (new Set(modifiers).size !== modifiers.length) return false;
  return (
    modifiers.includes("Mod") ||
    modifiers.includes("Alt") ||
    /^F\d{1,2}$/.test(key)
  );
}

export function shortcutLabel(shortcut: string, mac = false) {
  return shortcut
    .replace("Mod", mac ? "⌘" : "Ctrl")
    .replace("Shift", mac ? "⇧" : "Shift")
    .replace("Alt", mac ? "⌥" : "Alt")
    .replaceAll("+", mac ? "" : "+");
}
