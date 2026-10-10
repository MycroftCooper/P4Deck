import { describe, expect, it } from "vitest";
import type { GlobalSearchItem } from "../../shared/contracts/types";
import {
  GLOBAL_SEARCH_KINDS,
  highlightedSegments,
  mergeSearchItems,
  validateSearchText,
} from "./searchModel";

const item = (identity: string): GlobalSearchItem => ({
  identity,
  kind: "job",
  title: identity,
  summary: identity,
  target: { type: "job", jobId: identity },
  matchedFields: ["title"],
  highlights: [],
  rank: 1,
});

describe("global search model", () => {
  it("keeps the canonical seven-kind order used by filters and empty-kind backend defaults", () => {
    expect(GLOBAL_SEARCH_KINDS).toEqual([
      "submittedChange",
      "pendingChange",
      "workspaceFile",
      "depotFile",
      "job",
      "stream",
      "shelf",
    ]);
  });
  it("normalizes Unicode whitespace and rejects empty, control, and overlong input", () => {
    expect(validateSearchText("  你好\u3000[asset]  ")).toEqual({
      valid: true,
      text: "你好 [asset]",
    });
    expect(validateSearchText(" \t ")).toEqual({
      valid: false,
      reason: "control",
    });
    expect(validateSearchText("\u0085unsafe")).toEqual({
      valid: false,
      reason: "control",
    });
    expect(validateSearchText("😀".repeat(128))).toMatchObject({ valid: true });
    expect(validateSearchText("😀".repeat(129))).toEqual({
      valid: false,
      reason: "tooLong",
    });
  });

  it("applies UTF-16 ranges without interpreting HTML", () => {
    const value = "A😀<img src=x>尾";
    expect(
      highlightedSegments(value, "title", [
        { field: "title", start: 1, end: 3 },
      ]),
    ).toEqual([
      { text: "A", highlighted: false },
      { text: "😀", highlighted: true },
      { text: "<img src=x>尾", highlighted: false },
    ]);
  });

  it("deduplicates appended pages by stable identity", () => {
    expect(
      mergeSearchItems([item("a"), item("b")], [item("b"), item("c")]).map(
        (value) => value.identity,
      ),
    ).toEqual(["a", "b", "c"]);
  });
});
