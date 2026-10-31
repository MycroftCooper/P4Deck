// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { storage } from "../../shared/lib/storage";
import {
  readPendingFilterState,
  sortPendingChanges,
  writePendingFilterState,
} from "./pendingFilterState";

afterEach(() => storage.removeItem("p4deck.pending-filter.v1"));

it("keeps empty, singleton and equal-number rows stable in both orders", () => {
  for (const order of ["oldest", "newest"] as const) {
    expect(sortPendingChanges([], order)).toEqual([]);
    const singleton = { id: 10 };
    expect(sortPendingChanges([singleton], order)).toEqual([singleton]);
    const equal = [
      { id: 2, label: "first" },
      { id: 2, label: "second" },
    ];
    expect(sortPendingChanges(equal, order)).toEqual(equal);
    expect(
      sortPendingChanges([{ id: 10 }, { id: 2 }, { id: 0 }], order).map(
        (r) => r.id,
      ),
    ).toEqual(order === "oldest" ? [0, 2, 10] : [0, 10, 2]);
  }
});

it("sorts numerically in both directions, pins Default and preserves equal IDs", () => {
  const rows = [
    { id: 100 },
    { id: 2, label: "first" },
    { id: 0 },
    { id: 11 },
    { id: 2, label: "second" },
  ];
  expect(sortPendingChanges(rows, "oldest").map((row) => row.id)).toEqual([
    0, 2, 2, 11, 100,
  ]);
  expect(sortPendingChanges(rows, "newest").map((row) => row.id)).toEqual([
    0, 100, 11, 2, 2,
  ]);
  expect(
    sortPendingChanges(rows, "oldest")
      .filter((row) => row.id === 2)
      .map((row) => row.label),
  ).toEqual(["first", "second"]);
  expect(rows[0].id).toBe(100);
});

it("round-trips a versioned safe Pending filter and rejects malformed storage", () => {
  writePendingFilterState({ keyword: "JOB-42", sort: "oldest" });
  expect(readPendingFilterState()).toEqual({
    keyword: "JOB-42",
    sort: "oldest",
  });
  storage.setItem("p4deck.pending-filter.v1", '{"keyword":7,"sort":"newest"}');
  expect(readPendingFilterState()).toEqual({ keyword: "", sort: "newest" });
});
