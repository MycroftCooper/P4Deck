import { expect, it } from "vitest";
import { buildDiffRows } from "./diffRows";
import { findDiffMatches, hunkAtRow, indexDiffRows } from "./diffNavigation";

const rows = buildDiffRows("@@ -2 +2,2 @@\n-old value\n+new value\n+extra\n", {
  left: "prefix\nold value\ntail\n",
  right: "prefix\nnew value\nextra\ntail\n",
});

it("indexes source lines independently, including unchanged lines outside hunks", () => {
  const index = indexDiffRows(rows);
  expect(index.hunks).toEqual([1]);
  expect(index.left.get(3)).toBe(4);
  expect(index.right.get(3)).toBe(3);
  expect(index.right.get(4)).toBe(4);
  expect(index.left.get(4)).toBeUndefined();
  expect(hunkAtRow(index.hunks, 0)).toBe(-1);
  expect(hunkAtRow([1, 50, 100], 90)).toBe(1);
  expect(hunkAtRow([1, 50, 100], 100)).toBe(2);
});

it("searches both sides in row order, counting shared context only once", () => {
  expect(findDiffMatches(rows, "NEW").matches).toEqual([
    { row: 2, side: "right", start: 0, length: 3 },
  ]);
  expect(findDiffMatches(rows, "value").matches).toEqual([
    { row: 2, side: "left", start: 4, length: 5 },
    { row: 2, side: "right", start: 4, length: 5 },
  ]);
  expect(findDiffMatches(rows, "tail").matches).toEqual([
    { row: 4, side: "both", start: 0, length: 4 },
  ]);
});

it("matches literal punctuation and Unicode without changing the file text", () => {
  const literals = buildDiffRows("", {
    left: "a.* a.* 世界\n",
    right: "a.* a.* 世界\n",
  });
  expect(findDiffMatches(literals, "a.*").matches).toEqual([
    { row: 0, side: "both", start: 0, length: 3 },
    { row: 0, side: "both", start: 4, length: 3 },
  ]);
  expect(findDiffMatches(literals, "世界").matches[0]).toMatchObject({
    start: 8,
    length: 2,
  });
});

it("bounds large result sets and distinguishes exactly-at-limit from truncated matches", () => {
  const lines = buildDiffRows("", { left: "a a a", right: "a a a" });
  expect(findDiffMatches(lines, "a", 2)).toEqual({
    matches: [
      { row: 0, side: "both", start: 0, length: 1 },
      { row: 0, side: "both", start: 2, length: 1 },
    ],
    limited: true,
  });
  expect(findDiffMatches(lines, "a", 3).limited).toBe(false);
  expect(findDiffMatches(lines, "")).toEqual({
    matches: [],
    limited: false,
  });
});
