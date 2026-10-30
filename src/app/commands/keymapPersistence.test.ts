// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { commandForShortcut } from "./catalog";
import {
  getShortcutOverrides,
  resetShortcutOverrides,
  setShortcutOverride,
} from "./keymap";
import {
  DEFAULT_KEYMAP_PROFILE,
  KEYMAP_SCHEMA_VERSION,
  keymapStorageKey,
  parseKeymapDocument,
  saveKeymap,
  serializeKeymapDocument,
  startKeymapPersistence,
  type KeymapStoragePort,
} from "./keymapPersistence";

function memoryPort(initial: Record<string, string> = {}): {
  data: Record<string, string>;
  port: KeymapStoragePort;
} {
  const data = { ...initial };
  return {
    data,
    port: {
      getItem: (key) => data[key] ?? null,
      setItemChecked: (key, value) => {
        data[key] = value;
        return true;
      },
    },
  };
}

const cleanups: (() => void)[] = [];
function start(
  profileId: string | undefined,
  options: Parameters<typeof startKeymapPersistence>[1],
) {
  const cleanup = startKeymapPersistence(profileId, options);
  cleanups.push(cleanup);
  return cleanup;
}

afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
  resetShortcutOverrides();
});

const keys = (key: string, modifiers: Record<string, boolean> = {}) => ({
  key,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...modifiers,
});

describe("keymap persistence", () => {
  it("uses a profile-scoped storage key and defaults to the environment profile", () => {
    expect(keymapStorageKey("profile-a")).toBe("p4deck.keymap:profile-a");
    expect(keymapStorageKey("")).toBe(
      `p4deck.keymap:${DEFAULT_KEYMAP_PROFILE}`,
    );
    expect(keymapStorageKey("  ")).toBe(
      `p4deck.keymap:${DEFAULT_KEYMAP_PROFILE}`,
    );
  });

  it("round-trips a versioned document", () => {
    const raw = serializeKeymapDocument("profile-a", {
      "view.pending": "Mod+Shift+9",
      "view.refresh": null,
    });
    const doc = JSON.parse(raw) as Record<string, unknown>;
    expect(doc.schemaVersion).toBe(KEYMAP_SCHEMA_VERSION);
    expect(doc.profileId).toBe("profile-a");
    const result = parseKeymapDocument(raw, "profile-a");
    expect(result.status).toBe("loaded");
    expect(result.overrides).toEqual({
      "view.pending": "Mod+Shift+9",
      "view.refresh": null,
    });
  });

  it("migrates legacy unversioned documents and drops invalid entries", () => {
    const raw = JSON.stringify({
      bindings: {
        "view.pending": "Mod+Shift+9",
        "not.aCommand": "Mod+Q",
        "view.refresh": "J",
        "view.streams": "Mod+7",
      },
    });
    const result = parseKeymapDocument(raw, "profile-a");
    expect(result.status).toBe("migrated");
    expect(result.storedVersion).toBe(0);
    expect(result.overrides).toEqual({
      "view.pending": "Mod+Shift+9",
      "view.streams": "Mod+7",
    });
  });

  it("falls back to defaults for corrupt or non-object documents without throwing", () => {
    for (const raw of ["not json", "[]", "null", '"text"', "{}"]) {
      const result = parseKeymapDocument(raw, "profile-a");
      expect(result.status).toBe("corrupted");
      expect(result.overrides).toEqual({});
    }
    expect(parseKeymapDocument(null, "profile-a")).toEqual({
      status: "defaults",
      overrides: {},
    });
  });

  it("rejects unsupported versions and mismatched profiles", () => {
    const future = parseKeymapDocument(
      JSON.stringify({
        schemaVersion: 99,
        profileId: "profile-a",
        bindings: {},
      }),
      "profile-a",
    );
    expect(future.status).toBe("unsupportedVersion");
    expect(future.storedVersion).toBe(99);
    expect(future.overrides).toEqual({});
    const mismatch = parseKeymapDocument(
      JSON.stringify({
        schemaVersion: KEYMAP_SCHEMA_VERSION,
        profileId: "other",
        bindings: { "view.pending": "Mod+Shift+9" },
      }),
      "profile-a",
    );
    expect(mismatch.status).toBe("profileMismatch");
    expect(mismatch.overrides).toEqual({});
  });

  it("reports save failures through notifyFailure without losing the in-memory keymap", () => {
    const notify = vi.fn();
    const port: KeymapStoragePort = {
      getItem: () => null,
      setItemChecked: () => false,
    };
    expect(
      saveKeymap(
        "profile-a",
        { "view.pending": "Mod+Shift+9" },
        { storage: port, notify },
      ),
    ).toBe(false);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(String(notify.mock.calls[0][1].zh)).toContain("保存失败");
    expect(getShortcutOverrides()).toEqual({});
  });

  it("loads persisted overrides at startup and applies them to dispatch", () => {
    const { port } = memoryPort({
      "p4deck.keymap:primary": serializeKeymapDocument("primary", {
        "view.pending": "Mod+Shift+9",
      }),
    });
    start("primary", { storage: port, notify: vi.fn() });
    expect(getShortcutOverrides()).toEqual({ "view.pending": "Mod+Shift+9" });
    expect(
      commandForShortcut(
        keys("9", { ctrlKey: true, shiftKey: true }),
        "windows",
      ),
    ).toBe("view.pending");
    expect(commandForShortcut(keys("1", { ctrlKey: true }), "windows")).toBe(
      undefined,
    );
  });

  it("persists edits and restores them after a simulated restart", () => {
    const { data, port } = memoryPort();
    start("primary", { storage: port, notify: vi.fn() });
    setShortcutOverride("view.pending", "Mod+Shift+9");
    const saved = JSON.parse(data["p4deck.keymap:primary"]);
    expect(saved.schemaVersion).toBe(KEYMAP_SCHEMA_VERSION);
    expect(saved.bindings).toEqual({ "view.pending": "Mod+Shift+9" });
    // Simulate an app restart: stop the old persistence, fresh store, reload.
    cleanups.pop()?.();
    resetShortcutOverrides();
    start("primary", { storage: port, notify: vi.fn() });
    expect(getShortcutOverrides()).toEqual({ "view.pending": "Mod+Shift+9" });
    expect(
      commandForShortcut(
        keys("9", { ctrlKey: true, shiftKey: true }),
        "windows",
      ),
    ).toBe("view.pending");
  });

  it("writes the default keymap back when the user restores defaults", () => {
    const { data, port } = memoryPort();
    start("primary", { storage: port, notify: vi.fn() });
    setShortcutOverride("view.pending", "Mod+Shift+9");
    resetShortcutOverrides();
    const saved = JSON.parse(data["p4deck.keymap:primary"]);
    expect(saved.bindings).toEqual({});
    expect(commandForShortcut(keys("1", { ctrlKey: true }), "windows")).toBe(
      "view.pending",
    );
  });

  it("keeps profiles isolated from each other", () => {
    const { data, port } = memoryPort();
    start("profile-a", { storage: port, notify: vi.fn() });
    setShortcutOverride("view.pending", "Mod+Shift+9");
    cleanups.pop()?.();
    resetShortcutOverrides();
    start("profile-b", { storage: port, notify: vi.fn() });
    expect(getShortcutOverrides()).toEqual({});
    setShortcutOverride("view.streams", "Mod+Shift+8");
    // Profile A document is untouched by profile B edits.
    expect(JSON.parse(data["p4deck.keymap:profile-a"]).bindings).toEqual({
      "view.pending": "Mod+Shift+9",
    });
    cleanups.pop()?.();
    resetShortcutOverrides();
    start("profile-a", { storage: port, notify: vi.fn() });
    expect(getShortcutOverrides()).toEqual({ "view.pending": "Mod+Shift+9" });
  });

  it("migrates and rewrites a legacy document on startup", () => {
    const { data, port } = memoryPort({
      "p4deck.keymap:primary": JSON.stringify({
        bindings: { "view.pending": "Mod+Shift+9" },
      }),
    });
    const notify = vi.fn();
    start("primary", { storage: port, notify });
    expect(notify).not.toHaveBeenCalled();
    expect(getShortcutOverrides()).toEqual({ "view.pending": "Mod+Shift+9" });
    const migrated = JSON.parse(data["p4deck.keymap:primary"]);
    expect(migrated.schemaVersion).toBe(KEYMAP_SCHEMA_VERSION);
  });

  it("recovers from corrupt data at startup, notifies once and rewrites defaults", () => {
    const { data, port } = memoryPort({
      "p4deck.keymap:primary": "{broken",
    });
    const notify = vi.fn();
    start("primary", { storage: port, notify });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(getShortcutOverrides()).toEqual({});
    expect(JSON.parse(data["p4deck.keymap:primary"]).bindings).toEqual({});
    expect(commandForShortcut(keys("1", { ctrlKey: true }), "windows")).toBe(
      "view.pending",
    );
  });

  it("keeps a newer-version document intact while using defaults", () => {
    const raw = JSON.stringify({
      schemaVersion: 99,
      profileId: "primary",
      bindings: { "view.pending": "Mod+Shift+9" },
    });
    const { data, port } = memoryPort({ "p4deck.keymap:primary": raw });
    const notify = vi.fn();
    start("primary", { storage: port, notify });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(getShortcutOverrides()).toEqual({});
    expect(data["p4deck.keymap:primary"]).toBe(raw);
  });

  it("notifies on a save failure after a user edit and keeps the change in memory", () => {
    const notify = vi.fn();
    const port: KeymapStoragePort = {
      getItem: () => null,
      setItemChecked: () => false,
    };
    start("primary", { storage: port, notify });
    setShortcutOverride("view.pending", "Mod+Shift+9");
    expect(notify).toHaveBeenCalled();
    expect(getShortcutOverrides()).toEqual({ "view.pending": "Mod+Shift+9" });
    expect(
      commandForShortcut(
        keys("9", { ctrlKey: true, shiftKey: true }),
        "windows",
      ),
    ).toBe("view.pending");
  });

  it("does not throw when storage reads throw", () => {
    const port: KeymapStoragePort = {
      getItem: () => {
        throw new Error("storage unavailable");
      },
      setItemChecked: () => false,
    };
    expect(() =>
      start("primary", { storage: port, notify: vi.fn() }),
    ).not.toThrow();
    expect(getShortcutOverrides()).toEqual({});
  });
});
