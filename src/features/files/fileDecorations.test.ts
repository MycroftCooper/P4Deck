import { expect, it } from "vitest";
import {
  fileBadgeTone,
  fileBadges,
  fileBadgeLabel,
  type FileBadgeId,
} from "./fileDecorations";

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

it("UI-10 semantic palette: checkout/add/move-target green; delete/conflict/error red; locks orange; sync/modified amber", () => {
  const tones: Partial<Record<FileBadgeId, string>> = {
    add: "success",
    edit: "success",
    "move/add": "success",
    branch: "success",
    delete: "danger",
    "move/delete": "danger",
    resolve: "danger",
    error: "danger",
    depotDeleted: "danger",
    locked: "warning",
    globalLock: "warning",
    exclusive: "warning",
    outOfDate: "amber",
    notSynced: "amber",
    modified: "amber",
    integrate: "amber",
    latest: "teal",
    shelf: "purple",
    symlink: "purple",
    untracked: "neutral",
    missing: "neutral",
    unknown: "neutral",
    stale: "neutral",
    loading: "neutral",
  };
  for (const [id, tone] of Object.entries(tones))
    expect(fileBadgeTone(id as FileBadgeId)).toBe(tone);
  // The normal checkout must never share the destructive/conflict colour.
  expect(fileBadgeTone("edit")).not.toBe(fileBadgeTone("delete"));
  expect(fileBadgeTone("edit")).not.toBe(fileBadgeTone("resolve"));
  // Ownership is not part of the colour decision.
  const mine = fileBadges({ state: "openedEdit" })[0];
  expect(mine.owner).toBe("self");
  expect(fileBadgeTone(mine.id)).toBe("success");
});
