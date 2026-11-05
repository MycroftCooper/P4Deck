import { tFor } from "../../shared/i18n";
import { notifyFailure } from "../../shared/notice";
import { storage } from "../../shared/lib/storage";
import { appCommands, isValidShortcut } from "./catalog";
import {
  getShortcutOverrides,
  setShortcutOverrides,
  subscribeShortcutOverrides,
  type ShortcutOverrides,
} from "./keymap";

/**
 * Versioned, profile-scoped persistence for the shortcut keymap.
 *
 * The keymap lives in the existing local preference storage (WebView
 * localStorage / app data) under `p4deck.keymap:<profileId>`; it is never part
 * of the repository. A corrupt or unsupported document degrades to the P4V
 * defaults and is rewritten cleanly instead of failing startup.
 */
export const KEYMAP_SCHEMA_VERSION = 1;
export const DEFAULT_KEYMAP_PROFILE = "environment";
const STORAGE_PREFIX = "p4deck.keymap:";

export function keymapStorageKey(profileId: string): string {
  return `${STORAGE_PREFIX}${profileId.trim() || DEFAULT_KEYMAP_PROFILE}`;
}

export type KeymapLoadStatus =
  | "defaults"
  | "loaded"
  | "migrated"
  | "corrupted"
  | "unsupportedVersion"
  | "profileMismatch";

export interface KeymapLoadResult {
  status: KeymapLoadStatus;
  overrides: ShortcutOverrides;
  storedVersion?: number;
}

export interface KeymapStoragePort {
  getItem(key: string): string | null;
  setItemChecked(key: string, value: string): boolean;
}

export interface KeymapPersistenceOptions {
  storage?: KeymapStoragePort;
  notify?: typeof notifyFailure;
}

const commandIds = new Set<string>(appCommands.map((command) => command.id));

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validBindings(value: unknown): ShortcutOverrides | undefined {
  if (!isRecord(value)) return undefined;
  const bindings: ShortcutOverrides = {};
  for (const [commandId, shortcut] of Object.entries(value)) {
    if (!commandIds.has(commandId)) continue;
    const id = commandId as keyof ShortcutOverrides;
    if (shortcut === null) bindings[id] = null;
    else if (typeof shortcut === "string" && isValidShortcut(shortcut))
      bindings[id] = shortcut;
    // Unknown command IDs and invalid key strings are dropped so one damaged
    // entry cannot discard the rest of the keymap.
  }
  return bindings;
}

export function parseKeymapDocument(
  raw: string | null,
  profileId: string,
): KeymapLoadResult {
  const profile = profileId.trim() || DEFAULT_KEYMAP_PROFILE;
  if (raw === null || raw.trim() === "")
    return { status: "defaults", overrides: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: "corrupted", overrides: {} };
  }
  if (!isRecord(parsed)) return { status: "corrupted", overrides: {} };
  if (
    typeof parsed.profileId === "string" &&
    parsed.profileId &&
    parsed.profileId !== profile
  )
    return { status: "profileMismatch", overrides: {} };
  const version = parsed.schemaVersion;
  if (version === undefined || version === 0) {
    // Legacy/development documents were written without a schema version.
    const migrated = validBindings(parsed.bindings ?? parsed.overrides);
    if (!migrated) return { status: "corrupted", overrides: {} };
    return { status: "migrated", overrides: migrated, storedVersion: 0 };
  }
  if (
    typeof version !== "number" ||
    !Number.isSafeInteger(version) ||
    version < 1
  )
    return { status: "corrupted", overrides: {} };
  if (version > KEYMAP_SCHEMA_VERSION)
    return {
      status: "unsupportedVersion",
      overrides: {},
      storedVersion: version,
    };
  const bindings = validBindings(parsed.bindings);
  if (!bindings) return { status: "corrupted", overrides: {} };
  return { status: "loaded", overrides: bindings, storedVersion: version };
}

export function serializeKeymapDocument(
  profileId: string,
  overrides: ShortcutOverrides,
): string {
  return JSON.stringify({
    schemaVersion: KEYMAP_SCHEMA_VERSION,
    profileId: profileId.trim() || DEFAULT_KEYMAP_PROFILE,
    bindings: overrides,
  });
}

/** Persists the current overrides; returns false and notifies when storage fails. */
export function saveKeymap(
  profileId: string,
  overrides: ShortcutOverrides,
  options: KeymapPersistenceOptions = {},
): boolean {
  const io = options.storage ?? storage;
  const notify = options.notify ?? notifyFailure;
  let ok = false;
  try {
    ok = io.setItemChecked(
      keymapStorageKey(profileId),
      serializeKeymapDocument(profileId, overrides),
    );
  } catch {
    ok = false;
  }
  if (!ok)
    notify(null, {
      zh: tFor("zh-CN", "shell.saving.local.storage"),
      en: tFor("en-US", "shell.saving.local.storage"),
    });
  return ok;
}

let stopSaving: (() => void) | undefined;
let activeProfile: string | undefined;

/**
 * Loads the profile keymap into the shared store and keeps it persisted on
 * every change. Called once per window when the active profile changes.
 * Returns an unsubscribe/cleanup function.
 */
export function startKeymapPersistence(
  profileId: string | undefined,
  options: KeymapPersistenceOptions = {},
): () => void {
  const profile = profileId?.trim() || DEFAULT_KEYMAP_PROFILE;
  const io = options.storage ?? storage;
  const notify = options.notify ?? notifyFailure;
  stopSaving?.();
  activeProfile = profile;
  let raw: string | null = null;
  try {
    raw = io.getItem(keymapStorageKey(profile));
  } catch {
    raw = null;
  }
  const result = parseKeymapDocument(raw, profile);
  setShortcutOverrides(result.overrides);
  if (
    result.status === "corrupted" ||
    result.status === "unsupportedVersion" ||
    result.status === "profileMismatch"
  ) {
    notify(null, {
      zh:
        result.status === "unsupportedVersion"
          ? "快捷键配置来自更高版本，已恢复默认；本版本不会覆盖原配置。"
          : "快捷键配置已损坏或不属于当前 Profile，已恢复默认。",
      en:
        result.status === "unsupportedVersion"
          ? "Shortcut configuration comes from a newer version; defaults restored."
          : "Shortcut configuration is corrupt or belongs to another profile; defaults restored.",
    });
    if (result.status !== "unsupportedVersion")
      saveKeymap(profile, {}, { storage: io, notify });
  } else if (result.status === "migrated") {
    saveKeymap(profile, result.overrides, { storage: io, notify });
  }
  const unsubscribe = subscribeShortcutOverrides(() => {
    saveKeymap(profile, getShortcutOverrides(), { storage: io, notify });
  });
  stopSaving = unsubscribe;
  return () => {
    unsubscribe();
    if (stopSaving === unsubscribe) stopSaving = undefined;
    if (activeProfile === profile) activeProfile = undefined;
  };
}
