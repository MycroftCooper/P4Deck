import { describe, expect, it } from "vitest";
import {
  canConfirm,
  confirmBlocks,
  isLiveToken,
  tokenRemainingMs,
} from "./guards";
import { acknowledgementRequired, GUARD_PRESETS, guardPreset } from "./presets";

const NOW = 1_000_000;
const live = { ready: true, token: "one-use", expiresAt: NOW + 60_000 };

describe("confirmation guards", () => {
  it("allows confirm only for a ready plan with a live one-use token", () => {
    expect(canConfirm({ plan: live, now: NOW })).toBe(true);
    expect(confirmBlocks({ plan: live, now: NOW })).toEqual([]);
  });

  it("never confirms without a reviewed plan or a token", () => {
    expect(confirmBlocks({ plan: undefined, now: NOW })).toEqual([
      "notReady",
      "missingToken",
    ]);
    expect(canConfirm({ plan: undefined, now: NOW })).toBe(false);
    expect(confirmBlocks({ plan: { ...live, token: "" }, now: NOW })).toEqual([
      "missingToken",
    ]);
    expect(
      confirmBlocks({ plan: { ...live, token: undefined }, now: NOW }),
    ).toEqual(["missingToken"]);
    expect(
      confirmBlocks({ plan: { ...live, ready: false }, now: NOW }),
    ).toEqual(["notReady"]);
  });

  it("blocks a token that is not yet reviewed as ready even with a token", () => {
    const blocked = { ready: false, token: "token", expiresAt: NOW + 1 };
    expect(canConfirm({ plan: blocked, now: NOW })).toBe(false);
  });

  it("treats a non-finite expiry as unusable instead of never expiring", () => {
    expect(
      confirmBlocks({ plan: { ...live, expiresAt: Number.NaN }, now: NOW }),
    ).toEqual(["missingExpiry"]);
    expect(
      confirmBlocks({ plan: { ...live, expiresAt: Infinity }, now: NOW }),
    ).toEqual(["missingExpiry"]);
    expect(isLiveToken({ ...live, expiresAt: Number.NaN }, NOW)).toBe(false);
    expect(tokenRemainingMs(Number.NaN)).toBeUndefined();
  });

  it("blocks an expired token and confirms exactly up to the expiry instant", () => {
    const expiring = { ...live, expiresAt: NOW + 10 };
    expect(canConfirm({ plan: expiring, now: NOW })).toBe(true);
    expect(canConfirm({ plan: expiring, now: NOW + 9 })).toBe(true);
    expect(confirmBlocks({ plan: expiring, now: NOW + 10 })).toEqual([
      "expired",
    ]);
    expect(canConfirm({ plan: expiring, now: NOW + 11 })).toBe(false);
  });

  it("blocks a missing explicit acknowledgement", () => {
    expect(
      confirmBlocks({ plan: live, now: NOW, missingAcknowledgement: true }),
    ).toEqual(["acknowledgementRequired"]);
    expect(
      canConfirm({ plan: live, now: NOW, missingAcknowledgement: false }),
    ).toBe(true);
  });

  it("blocks target drift between the reviewed key and the current key", () => {
    expect(
      confirmBlocks({ plan: live, now: NOW, reviewed: "a:1", current: "b:2" }),
    ).toEqual(["stale"]);
    expect(
      canConfirm({ plan: live, now: NOW, reviewed: "a:1", current: "a:1" }),
    ).toBe(true);
    expect(confirmBlocks({ plan: live, now: NOW, drift: true })).toEqual([
      "stale",
    ]);
  });

  it("reports every simultaneous reason instead of the first one", () => {
    expect(
      confirmBlocks({
        plan: { ...live, expiresAt: NOW - 1 },
        reviewed: "a",
        current: "b",
        missingAcknowledgement: true,
        inFlight: true,
        now: NOW,
      }),
    ).toEqual(["expired", "acknowledgementRequired", "stale", "inFlight"]);
  });

  it("never reports confirm as possible while a request is in flight", () => {
    expect(canConfirm({ plan: live, now: NOW, inFlight: true })).toBe(false);
  });

  it("clamps the remaining lifetime to the timer range", () => {
    expect(tokenRemainingMs(NOW + 5_000, NOW)).toBe(5_000);
    expect(tokenRemainingMs(NOW - 1, NOW)).toBe(0);
    expect(tokenRemainingMs(Number.MAX_SAFE_INTEGER, NOW)).toBe(2147483647);
  });
});

describe("guarded-write presets", () => {
  it("declares a preset for every guarded write", () => {
    const operations = [
      "sync",
      "submit",
      "shelf",
      "unshelve",
      "resolve",
      "renameMove",
      "streamSwitch",
      "fileLock",
      "branchMapping",
      "workspaceMutation",
      "profileCreate",
    ] as const;
    for (const operation of operations) {
      const preset = guardPreset(operation);
      expect(preset.operation).toBe(operation);
      expect(preset.expiredMessageKey.length).toBeGreaterThan(0);
      // The mapping is total: a missing entry would silently fall back to copy
      // from another operation.
      expect(GUARD_PRESETS[operation]).toBe(preset);
    }
  });

  it("derives the acknowledgement requirement from reviewed facts only", () => {
    expect(acknowledgementRequired(guardPreset("sync"), { force: true })).toBe(
      true,
    );
    expect(acknowledgementRequired(guardPreset("sync"), { force: false })).toBe(
      false,
    );
    expect(
      acknowledgementRequired(guardPreset("streamSwitch"), { warnings: 1 }),
    ).toBe(true);
    expect(
      acknowledgementRequired(guardPreset("streamSwitch"), { warnings: 0 }),
    ).toBe(false);
    expect(
      acknowledgementRequired(guardPreset("branchMapping"), {
        destructive: true,
      }),
    ).toBe(true);
    expect(acknowledgementRequired(guardPreset("submit"), {})).toBe(true);
    expect(acknowledgementRequired(guardPreset("fileLock"), {})).toBe(false);
  });
});
