import { expect, it } from "vitest";
import {
  bestEffortLogNote,
  bestEffortLogReceipt,
  cancelBoundaryReceipt,
  cancelIntentMessage,
  cancelIntentState,
} from "./cancelLogBoundary";
import type { CancelOperationResult } from "../../shared/contracts";

const result = (state: CancelOperationResult["state"]): CancelOperationResult =>
  ({
    operationId: "op",
    state,
    matchedOperations: state === "cancelRequested" ? 1 : 0,
    serverRollbackClaimed: false,
    message: "",
  }) as CancelOperationResult;
const forbidden = ["已取消", "已回滚", "取消成功", "已撤销", "已恢复"];
const forbiddenEn = [
  "cancelled successfully",
  "rolled back",
  "successfully cancelled",
];

it("cancel wording is intent-only: never claims rollback/not-submitted for any state", () => {
  for (const state of [
    "cancelRequested",
    "notFound",
    "unknown",
    "legacy",
  ] as const) {
    for (const zh of [true, false]) {
      const message = cancelIntentMessage(state, zh);
      forbidden.forEach((word) => expect(message).not.toContain(word));
      forbiddenEn.forEach((word) =>
        expect(message.toLowerCase()).not.toContain(word),
      );
    }
  }
  expect(cancelIntentMessage("cancelRequested", true)).toContain("不会回滚");
  expect(cancelIntentMessage("notFound", false)).toContain(
    "not evidence that the operation did not run",
  );
});
it("unknown/notFound are distinct states; legacy/absent responses stay conservative", () => {
  expect(cancelIntentState(result("cancelRequested"))).toBe("cancelRequested");
  expect(cancelIntentState(result("notFound"))).toBe("notFound");
  expect(cancelIntentState(result("unknown"))).toBe("unknown");
  expect(cancelIntentState(undefined)).toBe("legacy");
  expect(cancelBoundaryReceipt(result("notFound"))).toEqual({
    state: "notFound",
    serverRollbackClaimed: false,
    retryAllowed: false,
  });
});
it("frontend-log is best-effort: retryAllowed=false, never blocks or replays, note is small", () => {
  for (const status of [
    "recorded",
    "duplicate",
    "rejected",
    "unavailable",
  ] as const) {
    const receipt = bestEffortLogReceipt({ status });
    expect(receipt.businessActionRetryAllowed).toBe(false);
    expect(receipt.blocksBusiness).toBe(false);
    expect(receipt.retryAllowed).toBe(false);
    const note = bestEffortLogNote({ status }, true);
    expect(note).not.toMatch(/重试|回滚|已取消/);
    if (status === "recorded") expect(note).toBe("");
    else expect(note.length).toBeGreaterThan(0);
  }
});
