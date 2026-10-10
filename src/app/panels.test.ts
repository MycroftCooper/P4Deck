import { describe, expect, it } from "vitest";
import {
  pageIds,
  activityPageIds,
  pageLabels,
  targetForPage,
  pageForSearchTarget,
  normalizePanelTarget,
  readPages,
  isPage,
  isMultiPage,
  panelKind,
  reusablePanel,
} from "./panels";
describe("workspace panels", () => {
  it("keeps target-specific tools and the anchored settings out of the activity list", () => {
    expect(activityPageIds).toEqual([
      "files",
      "search",
      "pending",
      "submitted",
      "workspaces",
      "streams",
      "streamgraph",
      "branchmappings",
      "terminal",
      "p4log",
    ]);
  });
  it("classifies global and file-target tabs", () => {
    expect(isPage("settings")).toBe(true);
    for (const page of [
      "search",
      "files",
      "pending",
      "submitted",
      "workspaces",
      "streams",
      "streamgraph",
      "branchmappings",
      "terminal",
      "p4log",
      "settings",
    ] as const)
      expect(isMultiPage(page)).toBe(false);
    for (const page of [
      "history",
      "diff",
      "shelf",
      "revgraph",
      "preview",
    ] as const)
      expect(isMultiPage(page)).toBe(true);
  });
  it("preview instances retain locked targets", () => {
    const panel = {
      id: "preview--1",
      params: { target: "/workspace/a.txt", locked: true },
    };
    expect(panelKind(panel.id)).toBe("preview");
    expect(
      reusablePanel([panel], "preview", "/workspace/b.png"),
    ).toBeUndefined();
    expect(readPages('["preview","preview"]')).toEqual(["preview"]);
  });
  it("restores both legacy and instance IDs", () => {
    expect(panelKind("diff")).toBe("diff");
    expect(panelKind("diff--some-instance")).toBe("diff");
    expect(panelKind("unknown--123")).toBeUndefined();
  });
  it("reuses global pages regardless of target", () => {
    const search = { id: "search" };
    expect(reusablePanel([search], "search", "12345")).toBe(search);
    const panel = { id: "settings" };
    expect(reusablePanel([panel], "settings", "fileA")).toBe(panel);
  });
  it("does not create a blank duplicate when restoring a locked-only page", () => {
    const panel = { id: "diff--saved", params: { target: "A", locked: true } };
    expect(reusablePanel([panel], "diff")).toBe(panel);
  });
  it("reuses an unlocked file tab without overwriting a locked target", () => {
    const pinned = { id: "diff--1", params: { target: "A", locked: true } },
      follow = { id: "diff--2", params: { target: "B", locked: false } };
    expect(reusablePanel([pinned, follow], "diff", "C")).toBe(follow);
    expect(reusablePanel([pinned], "diff", "C")).toBeUndefined();
    expect(reusablePanel([pinned, follow], "diff", "A")).toBe(pinned);
    expect(reusablePanel([follow], "history", "B")).toBeUndefined();
  });
  it("restores file review tabs and accepts their routes", () => {
    expect(isPage("diff")).toBe(true);
    expect(isPage("revgraph")).toBe(true);
    expect(isPage("shelf")).toBe(true);
    expect(panelKind("shelf--saved-instance")).toBe("shelf");
    expect(readPages('["diff","shelf","revgraph"]')).toEqual([
      "diff",
      "shelf",
      "revgraph",
    ]);
  });
  it("restores a closed-all layout and rejects invalid IDs", () => {
    expect(readPages("[]")).toEqual([]);
    expect(readPages('["history","history","unknown"]')).toEqual(["history"]);
    expect(readPages("broken")).toContain("streams");
  });
  it("derives labels and target routing from one registry", () => {
    expect(Object.keys(pageLabels(true))).toEqual(pageIds);
    expect(targetForPage("preview", "//depot/a", "/local/a")).toBe("/local/a");
    expect(targetForPage("history", "//depot/a", "/local/a")).toBe("//depot/a");
    expect(targetForPage("diff", undefined, "/local/a")).toBe("/local/a");
  });
  it("sanitizes corrupted persisted target data", () => {
    expect(normalizePanelTarget(null)).toEqual({ target: "", locked: false });
    expect(normalizePanelTarget({ target: 32, locked: "false" })).toEqual({
      target: "",
      locked: false,
    });
    expect(normalizePanelTarget({ target: "a", locked: true })).toEqual({
      target: "a",
      locked: true,
    });
  });
});

it("maps every global search target only to an existing destination page", () => {
  expect(pageForSearchTarget({ type: "submittedChange", changeId: 42 })).toBe(
    "submitted",
  );
  expect(pageForSearchTarget({ type: "pendingChange", changeId: 43 })).toBe(
    "pending",
  );
  expect(
    pageForSearchTarget({
      type: "workspaceFile",
      absolutePath: "C:\\work\\a.txt",
    }),
  ).toBe("files");
  expect(
    pageForSearchTarget({ type: "depotFile", depotPath: "//depot/a.txt" }),
  ).toBe("files");
  expect(pageForSearchTarget({ type: "job", jobId: "JOB-1" })).toBeUndefined();
  expect(
    pageForSearchTarget({ type: "stream", streamPath: "//atlas/main" }),
  ).toBeUndefined();
  expect(pageForSearchTarget({ type: "shelf", changeId: 44 })).toBeUndefined();
});
