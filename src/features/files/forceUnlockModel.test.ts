import { describe, expect, it } from "vitest";
import type { WorkspaceNode } from "../../shared/contracts/types";
import {
  exactForceUnlockPaths,
  forceUnlockOrigin,
  forceUnlockOriginInputReason,
  isVerifiedForceUnlockSuccess,
} from "./forceUnlockModel";

const node = (path: string): WorkspaceNode => ({
  id: path,
  name: path.split("/").at(-1)!,
  kind: "file",
  absolutePath: `/workspace/${path.split("/").at(-1)}`,
  relativePath: path,
  depotPath: path,
  state: "controlled",
});

describe("force unlock model", () => {
  it("preserves first-seen order while deduplicating exact depot files", () => {
    expect(
      exactForceUnlockPaths([
        node("//depot/b.txt"),
        node("//depot/a file.txt"),
        node("//depot/b.txt"),
      ]),
    ).toEqual({
      paths: ["//depot/b.txt", "//depot/a file.txt"],
      reason: undefined,
    });
  });

  it.each([
    "//depot/...",
    "//depot/*.txt",
    "//depot/a.txt#3",
    "//depot/a.txt@7",
    "//depot/../a.txt",
  ])("rejects unsafe target %s", (path) => {
    expect(exactForceUnlockPaths([node(path)]).paths).toEqual([]);
  });

  it("keeps unsupported origins explicit for backend blockers", () => {
    expect(forceUnlockOrigin("openedChangelist", "default")).toEqual({
      mode: "openedChangelist",
      changeId: 0,
    });
    expect(forceUnlockOrigin("shelvedChangelist", "71")).toEqual({
      mode: "shelvedChangelist",
      changeId: 71,
    });
    expect(forceUnlockOrigin("orphanDistributed", "71")).toEqual({
      mode: "orphanDistributed",
    });
    expect(forceUnlockOriginInputReason("openedChangelist", "7x")).toBeTruthy();
  });

  it("calls success only complete when every file is verified unlocked", () => {
    expect(
      isVerifiedForceUnlockSuccess("succeeded", [{ outcome: "unlocked" }]),
    ).toBe(true);
    expect(
      isVerifiedForceUnlockSuccess("partial", [{ outcome: "unlocked" }]),
    ).toBe(false);
    expect(
      isVerifiedForceUnlockSuccess("succeeded", [
        { outcome: "unlocked" },
        { outcome: "unverifiable" },
      ]),
    ).toBe(false);
  });
});
