import { describe, expect, it } from "vitest";
import { isFileActionAllowed } from "../fileActions";

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
});
