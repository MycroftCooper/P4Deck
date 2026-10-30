import { expect, it } from "vitest";
import {
  submittedTags,
  matchesSubmittedTags,
  submittedDescriptionParts,
} from "./submittedTags";
import {
  createDefaultSubmittedFilter,
  validateSubmittedFilter,
} from "./submittedFilters";
it("extracts trimmed unique ASCII tags across the complete description without HTML interpretation", () => {
  const description = "[ CODE ][CODE][][  ] title\n[DOC] [<b>x</b>] [unclosed";
  expect(submittedTags(description)).toEqual(["CODE", "DOC", "<b>x</b>"]);
  expect(description).toContain("[ CODE ]");
  expect(submittedTags("plain ［wide］")).toEqual([]);
});
it("ORs selected tags, leaves empty selection unrestricted and never adds query parameters", () => {
  expect(matchesSubmittedTags("[CODE] change", ["DOC", "CODE"])).toBe(true);
  expect(matchesSubmittedTags("[CODE] change", ["DOC"])).toBe(false);
  expect(matchesSubmittedTags("plain", [])).toBe(true);
  const base = createDefaultSubmittedFilter(
    new Date("2026-10-27T12:00:00Z"),
    "alice",
  );
  expect(validateSubmittedFilter({ ...base, tags: ["CODE"] }).query).toEqual(
    validateSubmittedFilter(base).query,
  );
});
it("creates a fresh seven day default per invocation and connection user", () => {
  const now = new Date("2026-10-27T12:00:00Z");
  const first = createDefaultSubmittedFilter(now, "alice");
  const next = createDefaultSubmittedFilter(
    new Date(now.getTime() + 86400000),
    "bob",
  );
  expect(first).toMatchObject({
    users: "alice",
    submissionKind: "ordinary",
    streams: [],
    currentStreamOnly: false,
    tags: [],
    keyword: "",
    depotPath: "",
  });
  expect(Date.parse(first.to) - Date.parse(first.from)).toBe(7 * 86400000);
  expect(next.users).toBe("bob");
  expect(Date.parse(next.to) - Date.parse(first.to)).toBe(86400000);
});

it("renders repeated tags at their original positions without changing the source", () => {
  const source = "before [CODE] middle [CODE] [] [unclosed <script>";
  const parts = submittedDescriptionParts(source);
  expect(parts.map((part) => part.text).join("")).toBe(source);
  expect(parts.filter((part) => part.tag).map((part) => part.tag)).toEqual([
    "CODE",
    "CODE",
  ]);
});
