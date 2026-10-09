// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  appCommandReason,
  appCommands,
  commandForShortcut,
  isAppCommand,
  shortcutConflicts,
} from "./catalog";

describe("application command catalog", () => {
  it("has stable unique IDs and conflict-free shortcuts", () => {
    expect(new Set(appCommands.map(({ id }) => id)).size).toBe(
      appCommands.length,
    );
    const shortcuts = appCommands.flatMap(({ shortcut }) =>
      shortcut ? [shortcut.toLowerCase()] : [],
    );
    expect(new Set(shortcuts).size).toBe(shortcuts.length);
    expect(shortcuts).not.toContain("mod+shift+t");
    expect(shortcuts).not.toContain("mod+l");
    expect(
      appCommands.every((item) => item.group && item.risk && item.confirmation),
    ).toBe(true);
    expect(
      appCommands
        .filter((item) => item.risk === "mutation")
        .every(
          (item) => !item.shortcut && item.confirmation === "stateMachine",
        ),
    ).toBe(true);
    expect(shortcutConflicts("windows")).toEqual([]);
    expect(shortcutConflicts("mac")).toEqual([]);
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
    expect(isAppCommand("tools.openTerminal")).toBe(true);
    expect(isAppCommand("tools.openTerminal?<script>")).toBe(false);
  });

  it("uses Ctrl on Windows/Linux, Cmd on macOS, and protects editable fields", () => {
    expect(
      commandForShortcut(
        {
          key: "r",
          ctrlKey: true,
          metaKey: false,
          shiftKey: false,
          altKey: false,
        },
        "windows",
      ),
    ).toBe("view.refresh");
    expect(
      commandForShortcut(
        {
          key: "r",
          ctrlKey: false,
          metaKey: true,
          shiftKey: false,
          altKey: false,
        },
        "windows",
      ),
    ).toBeUndefined();
    expect(
      commandForShortcut(
        {
          key: "r",
          ctrlKey: false,
          metaKey: true,
          shiftKey: false,
          altKey: false,
        },
        "mac",
      ),
    ).toBe("view.refresh");
    const input = document.createElement("input");
    expect(
      commandForShortcut(
        {
          key: "r",
          ctrlKey: true,
          metaKey: false,
          shiftKey: false,
          altKey: false,
          target: input,
        },
        "linux",
      ),
    ).toBeUndefined();
    expect(
      commandForShortcut(
        {
          key: "t",
          ctrlKey: true,
          metaKey: false,
          shiftKey: false,
          altKey: true,
          target: input,
        },
        "linux",
      ),
    ).toBe("tools.openTerminal");
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
});
