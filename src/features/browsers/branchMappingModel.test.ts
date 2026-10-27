import { describe, expect, it } from "vitest";
import type {
  BranchMappingDraft,
  BranchMappingPage,
} from "../../shared/contracts/types";
import {
  branchMappingError,
  isBranchMappingSnapshot,
  mergeBranchMappingPages,
  validateBranchDraft,
  validateBranchView,
} from "./branchMappingModel";

const draft = (
  values: Partial<BranchMappingDraft> = {},
): BranchMappingDraft => ({
  name: "atlas-release",
  owner: "tester",
  description: "release mapping",
  locked: false,
  view: [
    {
      modifier: "map",
      source: "//atlas/main/...",
      target: "//atlas/release/...",
    },
  ],
  ...values,
});

const page = (
  names: string[],
  overrides: Partial<BranchMappingPage> = {},
): BranchMappingPage => ({
  requestGeneration: 4,
  scope: {
    contextGeneration: 3,
    server: "fixture:1666",
    user: "tester",
    client: "workspace",
  },
  items: names.map((name) => ({ name })),
  hasMore: false,
  partial: false,
  truncated: false,
  stats: {
    scannedCount: names.length,
    matchedCount: names.length,
    returnedCount: names.length,
    invalidRecordCount: 0,
    safetyLimit: 5000,
  },
  operationIds: [],
  simulated: false,
  ...overrides,
});

describe("Branch Mapping view model", () => {
  it("rejects malformed persisted rows and metadata", () => {
    const valid = page(["mapping"]);
    expect(isBranchMappingSnapshot(valid)).toBe(true);
    for (const value of [
      null,
      {},
      { ...valid, items: [null] },
      { ...valid, items: [{ name: "mapping", owner: {} }] },
      { ...valid, operationIds: [null] },
      { ...valid, stats: {} },
      { ...valid, scope: { server: "other" } },
    ])
      expect(isBranchMappingSnapshot(value)).toBe(false);
  });

  it("accepts an ordered map/exclude/overlay View without rewriting it", () => {
    const view: BranchMappingDraft["view"] = [
      {
        modifier: "map",
        source: "//main/...",
        target: "//release/...",
      },
      {
        modifier: "exclude",
        source: "//main/private/*",
        target: "//release/private/*",
      },
      {
        modifier: "overlay",
        source: "//main/tools/...",
        target: "//release/tools/...",
      },
    ];
    expect(validateBranchView(view)).toEqual([]);
    expect(view.map((line) => line.modifier)).toEqual([
      "map",
      "exclude",
      "overlay",
    ]);
  });

  it("blocks unknown, comment, invalid wildcard, duplicate and injection-prone lines", () => {
    const issues = validateBranchView([
      { modifier: "unknown", unknown: "-//bad/... //target/..." },
      {
        modifier: "map",
        source: "//main/..",
        target: "//release/...",
      },
      {
        modifier: "map",
        source: "//main/file/*",
        target: "//release/file/...",
      },
      {
        modifier: "overlay",
        source: "//MAIN/file/*",
        target: "//other/file/*",
        comment: "# keep",
      },
    ]);
    expect(issues.map((issue) => issue.index)).toEqual([0, 1, 2, 3]);
    expect(issues[0].messages.join(" ")).toContain("cannot be edited");
    expect(issues[1].messages.join(" ")).toContain("literal depot pattern");
    expect(issues[2].messages.join(" ")).toContain("wildcard signatures");
    expect(issues[3].messages.join(" ")).toContain("conflicts with line 3");
  });

  it("matches the backend draft boundaries before preflight", () => {
    expect(validateBranchDraft(draft())).toEqual([]);
    expect(
      validateBranchDraft(
        draft({
          name: "-unsafe",
          owner: "bad owner",
          description: "bad\rline",
          view: [],
        }),
      ),
    ).toEqual([
      "Name must be a literal identifier of at most 128 characters.",
      "Owner is invalid.",
      "Description must be at most 4096 characters and use LF line endings.",
      "View must contain between 1 and 512 ordered lines.",
    ]);
    expect(
      validateBranchDraft(draft({ description: "🙂".repeat(4096) })),
    ).toEqual([]);
  });

  it("merges opaque-cursor pages stably and preserves partial evidence", () => {
    const merged = mergeBranchMappingPages(
      page(["alpha", "beta"], {
        hasMore: true,
        nextCursor: "opaque/one==",
        partial: true,
        operationIds: ["one"],
      }),
      page(["beta", "gamma"], {
        truncated: true,
        operationIds: ["one", "two"],
        simulated: true,
      }),
    );
    expect(merged.items.map((item) => item.name)).toEqual([
      "alpha",
      "beta",
      "gamma",
    ]);
    expect(merged.stats.returnedCount).toBe(3);
    expect(merged.partial).toBe(true);
    expect(merged.truncated).toBe(true);
    expect(merged.operationIds).toEqual(["one", "two"]);
    expect(merged.simulated).toBe(true);
  });

  it("normalizes structured and thrown request errors", () => {
    expect(
      branchMappingError({ code: "invalidCursor", message: "expired" }),
    ).toEqual({
      code: "invalidCursor",
      message: "expired",
    });
    expect(branchMappingError(new Error("offline")).message).toContain(
      "offline",
    );
  });
});
