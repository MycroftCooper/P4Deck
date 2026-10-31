import { describe, expect, it } from "vitest";
import { isFileActionAllowed, nodeNeedsSync } from "../fileActions";

describe("file action matrix", () => {
  it("allows add and local delete only for untracked files", () => {
    expect(isFileActionAllowed("add", "untracked")).toBe(true);
    expect(isFileActionAllowed("delete", "untracked")).toBe(true);
    expect(isFileActionAllowed("checkout", "untracked")).toBe(false);
  });

  it("allows revert and diff for opened edit files", () => {
    expect(isFileActionAllowed("revert", "openedEdit")).toBe(true);
    expect(isFileActionAllowed("diff", "openedEdit")).toBe(true);
    expect(isFileActionAllowed("checkout", "openedEdit")).toBe(false);
  });

  it("keeps conflicted files protected from overwrite", () => {
    expect(isFileActionAllowed("getLatest", "conflicted")).toBe(false);
    expect(isFileActionAllowed("delete", "conflicted")).toBe(false);
    expect(isFileActionAllowed("history", "conflicted")).toBe(true);
  });

  it("detects a syncable node from status or have/head facts", () => {
    expect(nodeNeedsSync({ revision: 79, headRevision: 80 })).toBe(true);
    expect(nodeNeedsSync({ revision: 80, headRevision: 80 })).toBe(false);
    expect(nodeNeedsSync({ revision: 0, headRevision: 3 })).toBe(true);
    expect(
      nodeNeedsSync({
        status: { sync: "outOfDate" } as never,
      }),
    ).toBe(true);
    expect(nodeNeedsSync({ status: { sync: "current" } as never })).toBe(false);
  });
});
