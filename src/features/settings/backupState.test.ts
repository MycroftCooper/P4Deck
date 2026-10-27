// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
  applyBackupLocalStorage,
  collectBackupLocalStorage,
  isBackupLocalStorageKey,
} from "./backupState";

afterEach(() => localStorage.clear());

describe("configuration backup local storage allowlist", () => {
  it("collects preferences and dock state while excluding terminal and path history", () => {
    localStorage.setItem("p4deck.ui", '{"compact":true}');
    localStorage.setItem("p4deck.panel.diff--1", '{"target":"//depot/a"}');
    localStorage.setItem("p4deck.toolPanel.p4log.tab", "operations");
    localStorage.setItem(
      "p4deck.terminalHistory",
      '["p4 print //depot/secret"]',
    );
    localStorage.setItem("p4deck.fileSelection", '{"path":"//depot/private"}');
    localStorage.setItem("p4deck.mockConnection", '{"server":"secret"}');

    expect(collectBackupLocalStorage()).toEqual([
      { key: "p4deck.panel.diff--1", value: '{"target":"//depot/a"}' },
      { key: "p4deck.toolPanel.p4log.tab", value: "operations" },
      { key: "p4deck.ui", value: '{"compact":true}' },
    ]);
    expect(isBackupLocalStorageKey("p4deck.terminalHistory")).toBe(false);
    expect(isBackupLocalStorageKey("p4deck.fileSelection")).toBe(false);
  });

  it("replaces the complete allowlisted layout snapshot without touching excluded keys", () => {
    localStorage.setItem("p4deck.ui", '{"compact":false}');
    localStorage.setItem("p4deck.panel.old", "old");
    localStorage.setItem("p4deck.terminalHistory", "keep");
    expect(
      applyBackupLocalStorage([
        { key: "p4deck.ui", value: '{"compact":true}' },
        { key: "p4deck.panel.new", value: "new" },
        { key: "p4deck.terminalHistory", value: "must-not-replace" },
      ]),
    ).toBe(true);

    expect(localStorage.getItem("p4deck.ui")).toBe('{"compact":true}');
    expect(localStorage.getItem("p4deck.panel.old")).toBeNull();
    expect(localStorage.getItem("p4deck.panel.new")).toBe("new");
    expect(localStorage.getItem("p4deck.terminalHistory")).toBe("keep");
  });

  it("reports a layout write failure instead of claiming the restore succeeded", () => {
    const unavailable = {
      get length(): number {
        throw new Error("storage unavailable");
      },
    } as Storage;

    expect(
      applyBackupLocalStorage(
        [{ key: "p4deck.ui", value: '{"compact":true}' }],
        unavailable,
      ),
    ).toBe(false);
  });
});
