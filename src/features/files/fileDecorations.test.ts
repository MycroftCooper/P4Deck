import { expect, it } from "vitest";
import { fileBadges, fileBadgeLabel } from "./fileDecorations";

it("does not infer modified or latest from checkout or controlled alone", () => {
  expect(fileBadges({ state: "openedEdit" })).toEqual([
    { id: "edit", owner: "self" },
  ]);
  expect(fileBadges({ state: "controlled" })).toEqual([]);
});
it("combines ownership, conflicts, locks and revision independently", () => {
  const result = fileBadges({
    state: "conflicted",
    action: "edit",
    revision: 1,
    headRevision: 2,
    badges: [
      { id: "edit", owner: "other", detail: "alice@ws" },
      { id: "locked", owner: "other" },
    ],
  });
  expect(result.map((b) => b.id)).toEqual([
    "locked",
    "resolve",
    "edit",
    "edit",
    "outOfDate",
  ]);
  expect(fileBadgeLabel(result[2], true)).toContain("alice@ws");
});
it("does not mistake the depot selection fallback for a missing local file", () => {
  expect(
    fileBadges({ scope: "depot", state: "missing", headAction: "delete" }),
  ).toEqual([{ id: "depotDeleted" }]);
});
it("treats shelf and historical copies separately from workspace state", () => {
  expect(
    fileBadges({ scope: "shelf", state: "conflicted", action: "move/add" }),
  ).toEqual([{ id: "shelf" }, { id: "move/add", owner: "shelf" }]);
  expect(
    fileBadges({ scope: "revision", revision: 1, headRevision: 2 }),
  ).toEqual([]);
});
it("distinguishes unsynced, latest, older and missing without duplicate badges", () => {
  expect(fileBadges({ revision: 0, headRevision: 3 })).toEqual([
    { id: "notSynced" },
  ]);
  expect(fileBadges({ revision: 3, headRevision: 3 })).toEqual([
    { id: "latest" },
  ]);
  expect(
    fileBadges({ state: "outOfDate", revision: 1, headRevision: 3 }),
  ).toEqual([{ id: "outOfDate" }]);
  expect(
    fileBadges({ state: "missing", revision: 3, headRevision: 3 }),
  ).toEqual([{ id: "missing" }]);
});

it("renders orthogonal aggregate evidence and explains ignore provenance", () => {
  const partial = fileBadges({
    state: "openedEdit",
    status: {
      primary: "openedEdit",
      openedAction: "edit",
      sync: "outOfDate",
      resolve: "unresolved",
      local: "missing",
      mapped: true,
      completeness: "partial",
      evidence: [],
      errors: [{ source: "reconcilePreview", message: "preview unavailable" }],
    },
  });
  expect(partial.map((badge) => badge.id)).toEqual([
    "resolve",
    "edit",
    "missing",
    "outOfDate",
    "stale",
  ]);
  const ignored = fileBadges({
    state: "ignored",
    status: {
      primary: "ignored",
      sync: "unknown",
      resolve: "none",
      local: "ignored",
      completeness: "complete",
      ignore: {
        rule: "target/",
        source: "C:/ws/.p4ignore",
        line: 4,
        explanation: "matched",
      },
      evidence: [],
      errors: [],
    },
  });
  expect(ignored).toEqual([
    { id: "ignored", detail: "target/ · C:/ws/.p4ignore:4" },
  ]);
});

it("renders authoritative lock ownership and +l independently", () => {
  expect(
    fileBadges({
      status: {
        primary: "openedEdit",
        openedAction: "edit",
        sync: "unknown",
        resolve: "none",
        local: "present",
        completeness: "complete",
        fileType: "binary+l",
        exclusiveOpen: true,
        lockOwnership: "other",
        lockOwner: "bob@render",
        otherOpen: ["bob@render"],
        canLock: false,
        canUnlock: false,
        evidence: [],
        errors: [],
      },
    }).map((badge) => [badge.id, badge.owner, badge.detail]),
  ).toEqual([
    ["globalLock", "other", "bob@render"],
    ["exclusive", "other", "bob@render"],
    ["edit", "self", undefined],
  ]);
});
