import { describe, expect, it } from "vitest";
import {
  confirmationRejectionKind,
  hasRejection,
  rejectionCodeOf,
  rejectionInvalidatesToken,
  rejectionIsUncertain,
  rejectionRequiresReview,
} from "./codes";
import type { ConfirmationRejectionKind } from "./codes";

/** Every raw code any guarded write may return, with its shared meaning. */
const EXPECTED: [string, ConfirmationRejectionKind | undefined][] = [
  ["tokenUnknown", "tokenUnknown"],
  ["tokenExpired", "tokenExpired"],
  ["targetMismatch", "targetMismatch"],
  ["contextChanged", "contextChanged"],
  ["preflightChanged", "stale"],
  ["previewChanged", "stale"],
  ["changeChanged", "stale"],
  ["contentChanged", "stale"],
  ["sourceChanged", "stale"],
  ["targetChanged", "stale"],
  ["stateChanged", "stale"],
  ["preflightBlocked", "preflightBlocked"],
  ["forceAcknowledgementRequired", "acknowledgementRequired"],
  ["warningAcknowledgementRequired", "acknowledgementRequired"],
  ["dangerousConfirmationRequired", "acknowledgementRequired"],
  ["commandFailure", "commandFailure"],
  ["cancelled", "cancelled"],
  ["uncertainOutcome", "uncertainOutcome"],
  // Operation-specific codes keep their own (visible) meaning: no remapping.
  ["permissionDenied", undefined],
  ["diskSpace", undefined],
  ["offline", undefined],
  ["serverUnreachable", undefined],
  ["authExpired", undefined],
  ["switchFailed", undefined],
  ["verificationFailed", undefined],
  ["syncFailed", undefined],
  ["invalidInput", undefined],
];

describe("confirmation rejection codes", () => {
  it.each(EXPECTED)("maps %s to its shared kind", (raw, kind) => {
    expect(confirmationRejectionKind(raw)).toBe(kind);
  });

  it("never invents a meaning for absent or non-string codes", () => {
    expect(confirmationRejectionKind(undefined)).toBeUndefined();
    expect(confirmationRejectionKind(null)).toBeUndefined();
    expect(confirmationRejectionKind("")).toBeUndefined();
    expect(confirmationRejectionKind("TokenExpired")).toBeUndefined();
    expect(confirmationRejectionKind(42)).toBeUndefined();
    expect(confirmationRejectionKind({ code: "tokenExpired" })).toBeUndefined();
  });

  it("does not resolve inherited object properties as codes", () => {
    expect(confirmationRejectionKind("constructor")).toBeUndefined();
    expect(confirmationRejectionKind("toString")).toBeUndefined();
  });

  it("classifies token invalidation, re-review and uncertainty", () => {
    const token = { outcome: "rejected", failure: "tokenExpired" };
    expect(rejectionInvalidatesToken(token)).toBe(true);
    expect(rejectionRequiresReview(token)).toBe(true);
    expect(rejectionIsUncertain(token)).toBe(false);

    expect(
      rejectionInvalidatesToken({
        outcome: "rejected",
        failure: "tokenUnknown",
      }),
    ).toBe(true);
    expect(
      rejectionInvalidatesToken({
        outcome: "rejected",
        failure: "contextChanged",
      }),
    ).toBe(false);
    expect(
      rejectionRequiresReview({
        outcome: "rejected",
        failure: "targetChanged",
      }),
    ).toBe(true);
    expect(
      rejectionRequiresReview({ outcome: "failed", failure: "commandFailure" }),
    ).toBe(false);
    expect(
      rejectionIsUncertain({ outcome: "unknown", failure: "uncertainOutcome" }),
    ).toBe(true);
    expect(
      rejectionIsUncertain({
        outcome: "rejected",
        failure: "preflightBlocked",
      }),
    ).toBe(false);
  });

  it("never treats a missing, null or unknown code as success or certainty", () => {
    for (const result of [
      undefined,
      null,
      {},
      { outcome: "succeeded" },
      { outcome: "failed", failure: null },
      { outcome: "failed", failure: "permissionDenied" },
    ]) {
      expect(rejectionCodeOf(result)).not.toBe("tokenExpired");
      expect(rejectionInvalidatesToken(result)).toBe(false);
      expect(rejectionRequiresReview(result)).toBe(false);
      expect(rejectionIsUncertain(result)).toBe(false);
    }
  });

  it("reads the code from every guarded-write result envelope", () => {
    for (const result of [
      { outcome: "rejected", failure: "tokenExpired" },
      { outcome: "rejected", failure: "tokenUnknown" },
      { outcome: "rejected", failure: "preflightBlocked" },
      { outcome: "unknown", failure: "uncertainOutcome" },
    ] as const) {
      expect(
        hasRejection(result, confirmationRejectionKind(result.failure)!),
      ).toBe(true);
    }
  });

  it("hasRejection only answers for the requested kind", () => {
    const result = { outcome: "rejected", failure: "targetMismatch" };
    expect(hasRejection(result, "targetMismatch")).toBe(true);
    expect(hasRejection(result, "tokenExpired")).toBe(false);
    expect(hasRejection(result, "preflightBlocked")).toBe(false);
  });
});
