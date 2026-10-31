import { parsePatchFiles } from "@pierre/diffs";
import { expect, it } from "vitest";
import {
  buildSearchLines,
  contextLineToRight,
  findDiffMatches,
  hunkAtLine,
  hunkTargetLine,
  hunksFromMetadata,
  normalizeUnifiedPatch,
  searchLinesFromMetadata,
} from "./diffNavigation";

const patch = [
  "--- Have",
  "+++ Workspace",
  "@@ -2 +2,2 @@",
  "-old value",
  "+new value",
  "+extra",
  "@@ -8,2 +9,2 @@",
  " shared before",
  "-removed",
  "+added",
].join("\n");

function metadata(patchText = patch) {
  return parsePatchFiles(patchText, "test", true)[0].files[0];
}

it("normalizes the patch without touching its hunks", () => {
  expect(normalizeUnifiedPatch("@@ -1 +1 @@\n-a\n+b")).toBe(
    "--- a/file\n+++ b/file\n@@ -1 +1 @@\n-a\n+b\n",
  );
  expect(normalizeUnifiedPatch(patch.replace(/\n/g, "\r\n"))).toBe(
    `${patch}\n`,
  );
  expect(normalizeUnifiedPatch("")).toBe("");
  expect(
    normalizeUnifiedPatch(
      "--- a\n+++ b\n@@ -1 +1 @@\n-a\n+b\n\\ No newline at end of file",
    ),
  ).toBe("--- a\n+++ b\n@@ -1 +1 @@\n-a\n+b\n\\ No newline at end of file\n");
});

it("projects library hunks into toolbar navigation bounds", () => {
  const hunks = hunksFromMetadata(metadata().hunks);
  expect(hunks).toEqual([
    {
      header: "@@ -2 +2,2 @@",
      leftStart: 2,
      leftCount: 1,
      rightStart: 2,
      rightCount: 2,
      firstLeft: 2,
      firstRight: 2,
    },
    {
      header: "@@ -8,2 +9,2 @@",
      leftStart: 8,
      leftCount: 2,
      rightStart: 9,
      rightCount: 2,
      firstLeft: 9,
      firstRight: 10,
    },
  ]);
  expect(hunkAtLine(hunks, "left", 2)).toBe(0);
  expect(hunkAtLine(hunks, "right", 3)).toBe(0);
  expect(hunkAtLine(hunks, "right", 4)).toBe(-1);
  expect(hunkTargetLine(hunks[1], "left")).toBe(9);
  expect(hunkTargetLine(hunks[1], "right")).toBe(10);
});

it("derives searchable lines from parsed hunk metadata", () => {
  expect(searchLinesFromMetadata(metadata())).toEqual([
    { left: 2, text: "old value" },
    { right: 2, text: "new value" },
    { right: 3, text: "extra" },
    { left: 8, right: 9, text: "shared before" },
    { left: 9, text: "removed" },
    { right: 10, text: "added" },
  ]);
});

it("searches both sides, counting shared context only once", () => {
  const lines = searchLinesFromMetadata(metadata());
  expect(findDiffMatches(lines, "NEW").matches).toEqual([
    { line: 2, side: "right", start: 0, length: 3 },
  ]);
  expect(findDiffMatches(lines, "value").matches).toEqual([
    { line: 2, side: "left", start: 4, length: 5 },
    { line: 2, side: "right", start: 4, length: 5 },
  ]);
  expect(findDiffMatches(lines, "before").matches).toEqual([
    { line: 9, side: "both", start: 7, length: 6 },
  ]);
});

it("matches literal punctuation and Unicode without changing the file text", () => {
  const lines = buildSearchLines("", {
    left: "a.* a.* 世界\n",
    right: "a.* a.* 世界\n",
  });
  expect(findDiffMatches(lines, "a.*").matches).toEqual([
    { line: 1, side: "left", start: 0, length: 3 },
    { line: 1, side: "left", start: 4, length: 3 },
    { line: 1, side: "right", start: 0, length: 3 },
    { line: 1, side: "right", start: 4, length: 3 },
  ]);
  expect(findDiffMatches(lines, "世界").matches[0]).toMatchObject({
    start: 8,
    length: 2,
  });
});

it("bounds large result sets and distinguishes exactly-at-limit from truncated matches", () => {
  const lines = buildSearchLines("", { left: "a a a", right: "a a a" });
  expect(findDiffMatches(lines, "a", 2)).toEqual({
    matches: [
      { line: 1, side: "left", start: 0, length: 1 },
      { line: 1, side: "left", start: 2, length: 1 },
    ],
    limited: true,
  });
  expect(findDiffMatches(lines, "a", 6).limited).toBe(false);
  expect(findDiffMatches(lines, "")).toEqual({
    matches: [],
    limited: false,
  });
});

it("maps unchanged context lines onto the additions line numbers used for expansion", () => {
  const hunks = hunksFromMetadata(metadata().hunks);
  // Before the first hunk the two sides are offset by zero.
  expect(contextLineToRight(hunks, "left", 1)).toBe(1);
  // Between the hunks the offset follows the next hunk's start delta.
  expect(contextLineToRight(hunks, "left", 3)).toBe(4);
  expect(contextLineToRight(hunks, "right", 3)).toBe(3);
});
