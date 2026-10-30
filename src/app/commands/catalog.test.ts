// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
  appCommandReason,
  appCommands,
  commandForShortcut,
  commandShortcuts,
  shortcutConflicts,
  shortcutConflictsFor,
  shortcutFromEvent,
  type AppCommandId,
} from "./catalog";
import {
  resetShortcutOverrides,
  setShortcutOverride,
  subscribeShortcutOverrides,
} from "./keymap";

afterEach(() => resetShortcutOverrides());

const keys = (
  key: string,
  modifiers: Partial<
    Record<"ctrlKey" | "metaKey" | "altKey" | "shiftKey", boolean>
  > = {},
) => ({
  key,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...modifiers,
});

const editable = () => document.createElement("input");

describe("application command catalog", () => {
  it("has stable unique IDs and conflict-free shortcuts", () => {
    expect(new Set(appCommands.map(({ id }) => id)).size).toBe(
      appCommands.length,
    );
    const shortcuts = appCommands.flatMap((item) => commandShortcuts(item));
    expect(new Set(shortcuts.map((value) => value.toLowerCase())).size).toBe(
      shortcuts.length,
    );
    expect(shortcuts).not.toContain("mod+shift+t");
    expect(shortcuts).not.toContain("mod+l");
    expect(
      appCommands.every((item) => item.group && item.risk && item.confirmation),
    ).toBe(true);
    // P4V mutation keys (Ctrl+E/S/R/L/U etc.) stay unbound so the confirmation
    // state machine can only be entered from explicit UI entry points.
    expect(
      appCommands
        .filter((item) => item.risk === "mutation")
        .every(
          (item) =>
            !item.shortcut &&
            !item.aliases?.length &&
            item.confirmation === "stateMachine",
        ),
    ).toBe(true);
    expect(shortcutConflicts("windows")).toEqual([]);
    expect(shortcutConflicts("mac")).toEqual([]);
    expect(shortcutConflicts("linux")).toEqual([]);
    expect(
      new Set(
        appCommands.flatMap((item) =>
          item.execution?.kind === "shell" ? [item.execution.command] : [],
        ),
      ),
    ).toEqual(
      new Set([
        "cancel",
        "getLatest",
        "getRevision",
        "rename",
        "lock",
        "unlock",
        "resolve",
        "moveFiles",
        "shelve",
        "submit",
        "checkout",
        "add",
        "delete",
        "revert",
        "diff",
        "history",
        "revgraph",
        "preview",
        "reveal",
        "openWith",
      ]),
    );
  });

  it("uses Ctrl on Windows/Linux, Cmd on macOS, and protects editable fields", () => {
    expect(commandForShortcut(keys("r", { ctrlKey: true }), "windows")).toBe(
      "view.refresh",
    );
    expect(commandForShortcut(keys("r", { metaKey: true }), "windows")).toBe(
      undefined,
    );
    expect(commandForShortcut(keys("r", { metaKey: true }), "mac")).toBe(
      "view.refresh",
    );
    expect(
      commandForShortcut(
        { ...keys("r", { ctrlKey: true }), target: editable() },
        "linux",
      ),
    ).toBeUndefined();
    expect(
      commandForShortcut(
        { ...keys("t", { ctrlKey: true, altKey: true }), target: editable() },
        "linux",
      ),
    ).toBe("tools.openTerminal");
    // Command palette remains available from an editor.
    expect(
      commandForShortcut(
        { ...keys("P", { ctrlKey: true, shiftKey: true }), target: editable() },
        "windows",
      ),
    ).toBe("app.commandPalette");
  });

  const p4vWindows: [string, Parameters<typeof keys>[1], AppCommandId][] = [
    ["9", { ctrlKey: true }, "view.files"],
    ["1", { ctrlKey: true }, "view.pending"],
    ["2", { ctrlKey: true }, "view.submitted"],
    ["3", { ctrlKey: true }, "view.branchMappings"],
    ["5", { ctrlKey: true }, "view.workspaces"],
    ["7", { ctrlKey: true }, "view.streams"],
    ["M", { ctrlKey: true, shiftKey: true }, "view.streamgraph"],
    ["F5", {}, "view.refresh"],
    ["F", { ctrlKey: true, shiftKey: true }, "view.search"],
    ["D", { ctrlKey: true }, "file.diff"],
    ["D", { ctrlKey: true, shiftKey: true }, "file.diff"],
    ["T", { ctrlKey: true }, "file.history"],
    ["R", { ctrlKey: true, shiftKey: true }, "file.revgraph"],
    ["S", { ctrlKey: true, shiftKey: true }, "file.reveal"],
    ["I", { ctrlKey: true }, "view.diagnostics"],
    ["l", { altKey: true }, "navigation.focusAddress"],
    ["g", { ctrlKey: true }, "navigation.focusAddress"],
    // Existing seven shortcuts are unchanged (regression).
    ["R", { ctrlKey: true }, "view.refresh"],
    ["P", { ctrlKey: true, shiftKey: true }, "app.commandPalette"],
    ["t", { ctrlKey: true, altKey: true }, "tools.openTerminal"],
    ["l", { ctrlKey: true, altKey: true }, "tools.openP4Log"],
    [",", { ctrlKey: true }, "view.settings"],
    ["d", { ctrlKey: true, altKey: true }, "panel.dockBack"],
  ];

  it.each(p4vWindows)(
    "maps P4V Windows shortcut %s (+%o) to %s",
    (keyName, modifiers, expected) => {
      expect(commandForShortcut(keys(keyName, modifiers), "windows")).toBe(
        expected,
      );
    },
  );

  const p4vMac: [string, Parameters<typeof keys>[1], AppCommandId][] = [
    ["9", { metaKey: true }, "view.files"],
    ["1", { metaKey: true }, "view.pending"],
    ["2", { metaKey: true }, "view.submitted"],
    ["3", { metaKey: true }, "view.branchMappings"],
    ["5", { metaKey: true }, "view.workspaces"],
    ["7", { metaKey: true }, "view.streams"],
    ["M", { metaKey: true, shiftKey: true }, "view.streamgraph"],
    ["F5", {}, "view.refresh"],
    ["F", { metaKey: true, shiftKey: true }, "view.search"],
    ["D", { metaKey: true }, "file.diff"],
    ["D", { metaKey: true, shiftKey: true }, "file.diff"],
    ["T", { metaKey: true }, "file.history"],
    ["R", { metaKey: true, shiftKey: true }, "file.revgraph"],
    ["S", { metaKey: true, shiftKey: true }, "file.reveal"],
    ["I", { metaKey: true }, "view.diagnostics"],
    ["l", { altKey: true }, "navigation.focusAddress"],
    ["g", { metaKey: true }, "navigation.focusAddress"],
    ["R", { metaKey: true }, "view.refresh"],
  ];

  it.each(p4vMac)(
    "maps P4V macOS shortcut %s (+%o) to %s",
    (keyName, modifiers, expected) => {
      expect(commandForShortcut(keys(keyName, modifiers), "mac")).toBe(
        expected,
      );
    },
  );

  it("keeps input protection for every new navigation shortcut", () => {
    const target = editable();
    for (const [keyName, modifiers] of [
      ["1", { ctrlKey: true }],
      ["9", { ctrlKey: true }],
      ["D", { ctrlKey: true }],
      ["T", { ctrlKey: true }],
      ["F5", {}],
      ["l", { altKey: true }],
      ["g", { ctrlKey: true }],
    ] as [string, Parameters<typeof keys>[1]][]) {
      expect(
        commandForShortcut({ ...keys(keyName, modifiers), target }, "windows"),
      ).toBeUndefined();
    }
  });

  it("dispatches primary shortcuts and P4V aliases from one list", () => {
    expect(
      commandShortcuts(appCommands.find((item) => item.id === "view.refresh")!),
    ).toEqual(["Mod+R", "F5"]);
    expect(
      commandShortcuts(
        appCommands.find((item) => item.id === "navigation.focusAddress")!,
      ),
    ).toEqual(["Alt+L", "Mod+G"]);
    expect(
      commandShortcuts(appCommands.find((item) => item.id === "file.diff")!),
    ).toEqual(["Mod+D", "Mod+Shift+D"]);
    // Alias resolution uses the same parser as the primary key.
    expect(commandForShortcut(keys("F5"), "linux")).toBe("view.refresh");
    expect(
      commandForShortcut(keys("D", { ctrlKey: true, shiftKey: true }), "linux"),
    ).toBe("file.diff");
  });

  it("treats aliases as conflict sources for Settings and future keymaps", () => {
    const refresh = appCommands.find((item) => item.id === "view.refresh")!;
    const pending = {
      ...appCommands.find((item) => item.id === "view.pending")!,
      shortcut: undefined,
      aliases: ["Mod+R"],
    };
    expect(shortcutConflictsFor([refresh, pending], "windows")).toEqual([
      "view.refresh / view.pending: ctrl+r",
    ]);
    // No production collision is introduced by the P4V aliases.
    expect(shortcutConflictsFor(appCommands, "windows")).toEqual([]);
  });

  it("never binds mutation commands to the P4V write keys", () => {
    for (const [keyName, modifiers] of [
      ["E", { ctrlKey: true }],
      ["S", { ctrlKey: true }],
      ["G", { ctrlKey: true, shiftKey: true }],
      ["L", { ctrlKey: true }],
      ["L", { ctrlKey: true, shiftKey: true }],
      ["U", { ctrlKey: true }],
      ["U", { ctrlKey: true, shiftKey: true }],
    ] as [string, Parameters<typeof keys>[1]][]) {
      expect(commandForShortcut(keys(keyName, modifiers), "windows")).toBe(
        undefined,
      );
    }
    // Ctrl+R is deliberately kept for refresh (not P4V revert).
    expect(commandForShortcut(keys("R", { ctrlKey: true }), "windows")).toBe(
      "view.refresh",
    );
  });

  it("routes the new P4V page and address commands to their handlers", () => {
    const byId = (id: AppCommandId) =>
      appCommands.find((item) => item.id === id)!;
    expect(byId("view.files").execution).toEqual({
      kind: "page",
      page: "files",
    });
    expect(byId("view.branchMappings").execution).toEqual({
      kind: "page",
      page: "branchmappings",
    });
    expect(byId("view.streamgraph").execution).toEqual({
      kind: "page",
      page: "streamgraph",
    });
    expect(byId("navigation.focusAddress").execution).toBeUndefined();
    for (const id of [
      "view.files",
      "view.branchMappings",
      "view.streamgraph",
      "navigation.focusAddress",
    ] as AppCommandId[]) {
      expect(byId(id).requires).toBe("mainWindow");
      expect(byId(id).risk).toBe("read");
    }
    expect(
      appCommandReason(
        "navigation.focusAddress",
        { detached: true, runtimeReady: true },
        false,
      ),
    ).toContain("Already");
  });

  it("maps global shortcuts from one catalog", () => {
    expect(
      commandForShortcut({
        key: "T",
        ctrlKey: true,
        metaKey: false,
        shiftKey: false,
        altKey: true,
      }),
    ).toBe("tools.openTerminal");
    expect(
      commandForShortcut(
        {
          key: "l",
          ctrlKey: false,
          metaKey: true,
          shiftKey: false,
          altKey: true,
        },
        "mac",
      ),
    ).toBe("tools.openP4Log");
    expect(
      commandForShortcut({
        key: "l",
        ctrlKey: true,
        metaKey: false,
        shiftKey: true,
        altKey: false,
      }),
    ).toBeUndefined();
  });

  it("centralizes availability and disabled reasons", () => {
    expect(
      appCommandReason(
        "tools.openTerminal",
        { detached: false, runtimeReady: false },
        false,
      ),
    ).toContain("loading");
    expect(
      appCommandReason(
        "tools.popoutP4Log",
        { detached: true, runtimeReady: true },
        false,
      ),
    ).toContain("Already");
    expect(
      appCommandReason(
        "panel.dockBack",
        { detached: true, runtimeReady: true },
        false,
      ),
    ).toBeUndefined();
  });

  it("disables mutation actions for the wrong target or while busy", () => {
    expect(
      appCommandReason(
        "changelist.submit",
        {
          detached: false,
          runtimeReady: true,
          target: "pending",
          pendingCount: 0,
        },
        false,
      ),
    ).toContain("nonempty");
    expect(
      appCommandReason(
        "workspace.sync",
        { detached: false, runtimeReady: true, target: "file", busy: true },
        false,
      ),
    ).toContain("running");
  });

  it("applies user keymap overrides to dispatch, labels and conflicts", () => {
    setShortcutOverride("view.pending", "Mod+Shift+9");
    expect(
      commandForShortcut(
        keys("9", { ctrlKey: true, shiftKey: true }),
        "windows",
      ),
    ).toBe("view.pending");
    expect(commandForShortcut(keys("1", { ctrlKey: true }), "windows")).toBe(
      undefined,
    );
    expect(
      commandShortcuts(appCommands.find((item) => item.id === "view.pending")!),
    ).toEqual(["Mod+Shift+9"]);
    // Replacing the primary key keeps the documented default alias.
    setShortcutOverride("view.refresh", "Mod+Shift+9");
    expect(
      commandShortcuts(appCommands.find((item) => item.id === "view.refresh")!),
    ).toEqual(["Mod+Shift+9", "F5"]);
    // Clearing removes primary and aliases.
    setShortcutOverride("view.refresh", null);
    expect(
      commandShortcuts(appCommands.find((item) => item.id === "view.refresh")!),
    ).toEqual([]);
    expect(commandForShortcut(keys("r", { ctrlKey: true }), "windows")).toBe(
      undefined,
    );
    expect(commandForShortcut(keys("F5"), "windows")).toBe(undefined);
    expect(shortcutConflictsFor(appCommands, "windows")).toEqual([]);
  });

  it("notifies keymap subscribers and restores defaults on reset", () => {
    let notifications = 0;
    const unsubscribe = subscribeShortcutOverrides(() => {
      notifications += 1;
    });
    setShortcutOverride("view.pending", "Mod+Shift+9");
    expect(notifications).toBe(1);
    setShortcutOverride("view.pending", "Mod+Shift+8");
    expect(notifications).toBe(2);
    resetShortcutOverrides();
    expect(notifications).toBe(3);
    expect(commandForShortcut(keys("1", { ctrlKey: true }), "windows")).toBe(
      "view.pending",
    );
    unsubscribe();
    setShortcutOverride("view.pending", "Mod+Shift+7");
    expect(notifications).toBe(3);
  });

  it("canonicalizes captured key combinations and rejects unsafe keys", () => {
    expect(
      shortcutFromEvent(
        keys("p", { ctrlKey: true, shiftKey: true }),
        "windows",
      ),
    ).toBe("Mod+Shift+P");
    expect(
      shortcutFromEvent(keys("p", { metaKey: true, shiftKey: true }), "mac"),
    ).toBe("Mod+Shift+P");
    expect(shortcutFromEvent(keys("l", { altKey: true }), "windows")).toBe(
      "Alt+L",
    );
    expect(shortcutFromEvent(keys("F5"), "windows")).toBe("F5");
    expect(shortcutFromEvent(keys(",", { ctrlKey: true }), "windows")).toBe(
      "Mod+,",
    );
    // Bare printable keys, modifier-only keys, control keys and the wrong
    // platform modifier are not bindable.
    expect(shortcutFromEvent(keys("a"), "windows")).toBeUndefined();
    expect(
      shortcutFromEvent(keys("Shift", { shiftKey: true }), "windows"),
    ).toBeUndefined();
    expect(shortcutFromEvent(keys("Escape"), "windows")).toBeUndefined();
    expect(shortcutFromEvent(keys("Delete"), "windows")).toBeUndefined();
    expect(
      shortcutFromEvent(keys("p", { ctrlKey: true }), "mac"),
    ).toBeUndefined();
    expect(
      shortcutFromEvent(keys("p", { metaKey: true }), "windows"),
    ).toBeUndefined();
    // A captured combination feeds the same dispatcher.
    const captured = shortcutFromEvent(
      keys("9", { ctrlKey: true, shiftKey: true }),
      "windows",
    )!;
    setShortcutOverride("view.pending", captured);
    expect(
      commandForShortcut(
        keys("9", { ctrlKey: true, shiftKey: true }),
        "windows",
      ),
    ).toBe("view.pending");
  });
});
