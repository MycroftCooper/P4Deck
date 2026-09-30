import { expect, it } from "vitest";
import { revisionSelector } from "./revisionSelector";
it("distinguishes head, file revision and changelist selectors", () => {
  expect(revisionSelector("head", "")).toBe("#head");
  expect(revisionSelector("revision", " 12 ")).toBe("#12");
  expect(revisionSelector("change", "12")).toBe("@12");
});
it("rejects zero, negatives, prefixes, ranges and command text", () => {
  for (const value of [
    "",
    "0",
    "-1",
    "01",
    "#12",
    "@12",
    "1.2",
    "1,9",
    "1 --force",
    "9007199254740992",
  ]) {
    expect(revisionSelector("revision", value)).toBeUndefined();
    expect(revisionSelector("change", value)).toBeUndefined();
  }
});
it("validates real calendar dates without local timezone conversion", () => {
  expect(revisionSelector("date", "2024-02-29")).toBe("@2024/02/29");
  for (const value of [
    "2023-02-29",
    "2026-04-31",
    "2026-13-01",
    "2026-00-01",
    "2026-01-00",
    "2026-1-1",
    "2026-01-01T12:00",
  ])
    expect(revisionSelector("date", value)).toBeUndefined();
});
