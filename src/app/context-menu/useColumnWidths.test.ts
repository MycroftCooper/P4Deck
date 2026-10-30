import { expect, it } from "vitest";
import { resizeColumn } from "./useColumnWidths";
it("resizes only the requested column without mutating rows or neighbouring widths", () => {
  const original = [260, 110, 140, 300, 190];
  expect(resizeColumn(original, [140, 80, 90, 140, 150], 3, 80)).toEqual([
    260, 110, 140, 380, 190,
  ]);
  expect(original).toEqual([260, 110, 140, 300, 190]);
});
it("clamps every workspace and stream column to its minimum", () => {
  for (const [widths, mins] of [
    [
      [260, 110, 140, 300, 190],
      [140, 80, 90, 140, 150],
    ],
    [
      [300, 260, 420],
      [160, 150, 180],
    ],
  ]) {
    widths.forEach((_, i) =>
      expect(resizeColumn(widths, mins, i, -10000)[i]).toBe(mins[i]),
    );
  }
});
