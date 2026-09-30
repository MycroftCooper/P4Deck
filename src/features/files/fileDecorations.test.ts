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
