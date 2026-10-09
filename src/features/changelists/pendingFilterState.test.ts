// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { storage } from "../../shared/lib/storage";
import {
  readPendingFilterState,
  writePendingFilterState,
} from "./pendingFilterState";

afterEach(() => storage.removeItem("p4deck.pending-filter.v1"));

it("round-trips a versioned safe Pending filter and rejects malformed storage", () => {
  writePendingFilterState({ keyword: "JOB-42", sort: "oldest" });
  expect(readPendingFilterState()).toEqual({
    keyword: "JOB-42",
    sort: "oldest",
  });
  storage.setItem("p4deck.pending-filter.v1", '{"keyword":7,"sort":"newest"}');
  expect(readPendingFilterState()).toEqual({ keyword: "", sort: "newest" });
});
