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

it("tags vxdx build markers for display while leaving submittedTags/filtering untouched", () => {
  const source = "fix v2d0 and V1D7, keep [CODE]";
  const parts = submittedDescriptionParts(source);
  expect(parts.map((part) => part.text).join("")).toBe(source);
  expect(parts.filter((part) => part.tag).map((part) => part.tag)).toEqual([
    "v2d0",
    "V1D7",
    "CODE",
  ]);
  // Display-only: version markers are not filtered/tagged in the query logic.
  expect(submittedTags(source)).toEqual(["CODE"]);
  expect(matchesSubmittedTags(source, ["v2d0"])).toBe(false);
  // Workspace-style strings split into text + tag without changing case.
  const workspace = submittedDescriptionParts("xxx_v2d0_project");
  expect(workspace.map((part) => part.text).join("")).toBe("xxx_v2d0_project");
  expect(workspace.filter((part) => part.tag).map((part) => part.tag)).toEqual([
    "v2d0",
  ]);
});
