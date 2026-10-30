import { describe, expect, it } from "vitest";
import {
  emptyOpenedSelection,
  selectOpenedFile,
  snapshotOpenedSelection,
} from "./selectedFiles";
const rows = [0, 12, 25].map((originalChangeId, i) => ({
  depotPath: `//test/file${i}`,
  originalChangeId,
}));
const pick = (
  s: ReturnType<typeof emptyOpenedSelection>,
  i: number,
  gesture = {},
) =>
  selectOpenedFile(s, "identity:workspace:1", rows, rows[i].depotPath, gesture);
describe("selected opened files", () => {
  it("accumulates Default and two numbered sources, toggles without duplicates", () => {
    let s = pick(emptyOpenedSelection("identity:workspace:1"), 0);
    s = pick(pick(s, 1, { ctrlKey: true }), 2, { metaKey: true });
    expect(s.files).toEqual(rows);
    expect(pick(s, 1, { ctrlKey: true }).files).toEqual([rows[0], rows[2]]);
  });
  it("uses visible order for Shift and does not include hidden rows", () => {
    const s = pick(emptyOpenedSelection("identity:workspace:1"), 0);
    expect(
      selectOpenedFile(s, s.scope, [rows[2], rows[0]], rows[2].depotPath, {
        shiftKey: true,
      }).files,
    ).toEqual([rows[2], rows[0]]);
  });
  it("preserves the full set when right clicking a selected file", () => {
    const s = pick(pick(emptyOpenedSelection("identity:workspace:1"), 0), 2, {
      ctrlKey: true,
    });
    expect(pick(s, 0, { context: true })).toBe(s);
    expect(pick(s, 1, { context: true }).files).toEqual([rows[1]]);
  });
  it("clears old identity/workspace selection before applying a gesture", () => {
    const s = pick(emptyOpenedSelection("identity:workspace:1"), 0);
    expect(
      selectOpenedFile(s, "new-workspace:2", rows, rows[1].depotPath, {
        ctrlKey: true,
      }).files,
    ).toEqual([rows[1]]);
  });
  it("does not select unloaded or filtered targets", () => {
    const s = emptyOpenedSelection("identity:workspace:1");
    expect(selectOpenedFile(s, s.scope, rows, "//missing").files).toEqual([]);
  });
  it("freezes file origins and deduplicates the preview", () => {
    const input = { scope: "scope", files: [{ ...rows[0] }, { ...rows[0] }] };
    const snapshot = snapshotOpenedSelection(input);
    input.files[0].originalChangeId = 999;
    expect(snapshot.files).toEqual([rows[0]]);
  });
});
