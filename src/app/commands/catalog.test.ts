import { describe, expect, it } from "vitest";
import {
  appCommandReason,
  appCommands,
  commandForShortcut,
  isAppCommand,
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
    expect(isAppCommand("tools.openTerminal")).toBe(true);
    expect(isAppCommand("tools.openTerminal?<script>")).toBe(false);
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
      commandForShortcut({
        key: "l",
        ctrlKey: false,
        metaKey: true,
        shiftKey: false,
        altKey: true,
      }),
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
});
