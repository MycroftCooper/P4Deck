import { expect, it } from "vitest";
import { buildDiffRows } from "./diffRows";

it("pairs replacements, pads the shorter side, and keeps source line numbers", () => {
  expect(
    buildDiffRows(
      [
        "--- Have #2",
        "+++ Workspace",
        "@@ -8,5 +8,4 @@",
        " before",
        "-old one",
        "-old two",
        "-old three",
        "+new one",
        "+new two",
        " after",
        "",
      ].join("\n"),
    ),
  ).toEqual([
    { kind: "hunk", label: "@@ -8,5 +8,4 @@" },
    {
      kind: "line",
      changed: false,
      left: { number: 8, text: "before" },
      right: { number: 8, text: "before" },
    },
    {
      kind: "line",
      changed: true,
      left: { number: 9, text: "old one" },
      right: { number: 9, text: "new one" },
    },
    {
      kind: "line",
      changed: true,
      left: { number: 10, text: "old two" },
      right: { number: 10, text: "new two" },
    },
    {
      kind: "line",
      changed: true,
      left: { number: 11, text: "old three" },
      right: undefined,
    },
    {
      kind: "line",
      changed: false,
      left: { number: 12, text: "after" },
      right: { number: 11, text: "after" },
    },
  ]);
});

it("restarts numbering at each hunk and handles omitted counts", () => {
  const rows = buildDiffRows(
    "@@ -1 +1,2 @@\n-old\n+new\n+extra\n@@ -90,2 +91 @@ section\n-remove\n keep\n",
  );
  expect(rows).toHaveLength(6);
  expect(rows[2]).toMatchObject({
    left: undefined,
    right: { number: 2, text: "extra" },
  });
  expect(rows[5]).toMatchObject({
    changed: false,
    left: { number: 91, text: "keep" },
    right: { number: 91, text: "keep" },
  });
});

it("supports added and deleted files without numbering empty cells", () => {
  expect(buildDiffRows("@@ -0,0 +1,2 @@\n+first\n+second\n").slice(1)).toEqual([
    {
      kind: "line",
      changed: true,
      left: undefined,
      right: { number: 1, text: "first" },
    },
    {
      kind: "line",
      changed: true,
      left: undefined,
      right: { number: 2, text: "second" },
    },
  ]);
  expect(buildDiffRows("@@ -1 +0,0 @@\n-last\n")[1]).toEqual({
    kind: "line",
    changed: true,
    left: { number: 1, text: "last" },
    right: undefined,
  });
});

it("keeps blank source lines and treats header-looking code as source", () => {
  const rows = buildDiffRows(
    "--- left\n+++ right\n@@ -1,3 +1,3 @@\n \n--- removed code\n+++ added code\n end\n",
  );
  expect(rows).toHaveLength(4);
  expect(rows[1]).toMatchObject({
    left: { number: 1, text: "" },
    right: { number: 1, text: "" },
  });
  expect(rows[2]).toMatchObject({
    left: { number: 2, text: "-- removed code" },
    right: { number: 2, text: "++ added code" },
  });
});

it("does not count EOF annotations or patch terminators as source lines", () => {
  const rows = buildDiffRows(
    "@@ -1 +1 @@\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file\n",
  );
  expect(rows).toHaveLength(2);
  expect(rows[1]).toMatchObject({
    left: { number: 1, text: "old", noNewline: true },
    right: { number: 1, text: "new", noNewline: true },
  });
});

it("attaches a missing final newline only to the side that lacks it", () => {
  const rows = buildDiffRows(
    "@@ -1 +1 @@\n-same\n+same\n\\ No newline at end of file\n",
  );
  expect(rows[1]).toEqual({
    kind: "line",
    changed: true,
    left: { number: 1, text: "same" },
    right: { number: 1, text: "same", noNewline: true },
  });
});

it("marks both sides when unchanged EOF context has no final newline", () => {
  const rows = buildDiffRows(
    "@@ -1,2 +1,2 @@\n-old\n+new\n end\n\\ No newline at end of file\n",
  );
  expect(rows[2]).toEqual({
    kind: "line",
    changed: false,
    left: { number: 2, text: "end", noNewline: true },
    right: { number: 2, text: "end", noNewline: true },
  });
});

it("normalizes CRLF patch lines for fixed-height rendering", () => {
  expect(buildDiffRows("@@ -1 +1 @@\r\n-old\r\n+new\r\n")[1]).toMatchObject({
    left: { number: 1, text: "old" },
    right: { number: 1, text: "new" },
  });
});

it("has no code rows for an identical file or headers without a hunk", () => {
  expect(buildDiffRows("")).toEqual([]);
  expect(buildDiffRows("--- left\n+++ right\n")).toEqual([]);
});

it("fills unchanged prefix, hunk gaps and tail from complete sources without merging hunks", () => {
  const left = "prefix\nold one\nmiddle\nunchanged\nold two\ntail\n";
  const right = "prefix\nnew one\nextra\nmiddle\nunchanged\nnew two\ntail\n";
  const rows = buildDiffRows(
    "@@ -2 +2,2 @@\n-old one\n+new one\n+extra\n@@ -5 +6 @@\n-old two\n+new two\n",
    { left, right },
  );
  expect(rows.filter((row) => row.kind === "hunk")).toHaveLength(2);
  for (const side of ["left", "right"] as const) {
    const lines = rows.flatMap((row) =>
      row.kind === "line" && row[side] ? [row[side]!] : [],
    );
    expect(lines.map((line) => line.text).join("\n") + "\n").toBe(
      side === "left" ? left : right,
    );
    expect(lines.map((line) => line.number)).toEqual(
      lines.map((_, index) => index + 1),
    );
  }
});

it("expands identical text including CRLF and EOF metadata without inventing a final blank line", () => {
  const rows = buildDiffRows("", {
    left: "one\r\n\r\nend",
    right: "one\n\nend",
  });
  expect(rows).toHaveLength(3);
  expect(rows[1]).toMatchObject({
    changed: false,
    left: { number: 2, text: "" },
    right: { number: 2, text: "" },
  });
  expect(rows[2]).toMatchObject({
    left: { number: 3, text: "end", noNewline: true },
    right: { number: 3, text: "end", noNewline: true },
  });
  expect(buildDiffRows("", { left: "", right: "" })).toEqual([]);
  expect(buildDiffRows("", { left: "\n", right: "\n" })).toHaveLength(1);
  expect(buildDiffRows("", { left: "end\n", right: "end" })).toEqual([]);
});

it("handles empty ranges for insertion and deletion after unchanged context", () => {
  const added = buildDiffRows("@@ -2,0 +3 @@\n+extra\n", {
    left: "one\ntwo\nend\n",
    right: "one\ntwo\nextra\nend\n",
  });
  expect(added[3]).toMatchObject({
    changed: true,
    left: undefined,
    right: { number: 3, text: "extra" },
  });
  expect(added[4]).toMatchObject({
    left: { number: 3, text: "end" },
    right: { number: 4, text: "end" },
  });
  const deleted = buildDiffRows("@@ -3 +2,0 @@\n-extra\n", {
    left: "one\ntwo\nextra\nend\n",
    right: "one\ntwo\nend\n",
  });
  expect(deleted[3]).toMatchObject({
    changed: true,
    left: { number: 3, text: "extra" },
    right: undefined,
  });
});

it("falls back to patch rows when supplied sources disagree with a hunk or an omitted gap", () => {
  const patch = "@@ -2 +2 @@\n-old\n+new\n";
  const fallback = buildDiffRows(patch);
  expect(
    buildDiffRows(patch, {
      left: "prefix\nold\ntail\n",
      right: "different prefix\nnew\ntail\n",
    }),
  ).toEqual(fallback);
  expect(
    buildDiffRows(patch, {
      left: "prefix\nwrong\ntail\n",
      right: "prefix\nnew\ntail\n",
    }),
  ).toEqual(fallback);
});
