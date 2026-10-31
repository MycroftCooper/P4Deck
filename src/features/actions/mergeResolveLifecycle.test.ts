import { expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
import {
  beginMergeIntent,
  lifecycleOf,
  lookupMergeReceipt,
  mergeIntentActive,
  mergeIntentsSnapshot,
  mergeRemaining,
  mergeResolveSucceeded,
  mergeSaveCommitted,
  mergeStepOperationId,
  mergeUncertain,
  newMergeRootId,
  resetMergeIntentsForTests,
  settleMergeIntent,
  unwrapMergeLegacy,
  type MergeResolveActionResultLike,
} from "./mergeResolveLifecycle";
import { invoke } from "@tauri-apps/api/core";

const result = (
  kind: MergeResolveActionResultLike["kind"],
  state: MergeResolveActionResultLike["state"],
  outcome: string,
  extra: Partial<MergeResolveActionResultLike> = {},
): MergeResolveActionResultLike => ({
  kind,
  operationId: "op",
  state,
  outcome,
  files: [],
  message: "",
  optimistic: "intentOnly",
  ...extra,
});

it("intent store publishes before dispatch and settles by the same operationId", () => {
  resetMergeIntentsForTests();
  expect(beginMergeIntent({ operationId: "op-1", kind: "resolve" })).toBe(true);
  expect(beginMergeIntent({ operationId: "op-1", kind: "resolve" })).toBe(
    false,
  );
  expect(mergeIntentActive("op-1")).toBe(true);
  expect(mergeIntentsSnapshot()).toHaveLength(1);
  settleMergeIntent("op-1");
  expect(mergeIntentActive("op-1")).toBe(false);
});
it("deterministic sub-step ids: same step retries reuse one id, root is never the receipt id", () => {
  const root = newMergeRootId();
  expect(root.startsWith("manual-merge-")).toBe(true);
  expect(mergeStepOperationId(root, "save")).toBe(
    mergeStepOperationId(root, "save"),
  );
  expect(mergeStepOperationId(root, "save")).not.toBe(root);
  expect(mergeStepOperationId(root, "open")).not.toBe(
    mergeStepOperationId(root, "save"),
  );
});
it("legacy/affectedPaths/exitCode never prove resolve or save success", () => {
  const legacy = {
    outcome: "succeeded",
    affectedPaths: ["//d/a"],
    exitCode: 0,
    message: "ok",
    files: [],
    operationIds: [],
    refresh: { reason: "" },
  } as unknown;
  expect(lifecycleOf(legacy)).toBeUndefined();
  expect(unwrapMergeLegacy(legacy)).toBe(legacy);
  expect(mergeResolveSucceeded(undefined)).toBe(false);
  expect(
    mergeResolveSucceeded(
      result("resolve", "committed", "succeeded", { files: [] }),
    ),
  ).toBe(false);
  expect(
    mergeResolveSucceeded(
      result("resolve", "intent", "unknown", {
        files: [{ depotPath: "//d/a", state: "unknown", message: "" }],
      }),
    ),
  ).toBe(false);
  expect(
    mergeSaveCommitted(
      result("manualMergeSave", "committed", "succeeded", { details: {} }),
    ),
  ).toBe(false);
});
it("committed facts prove resolve success; partial/unknown keep remaining conflicts and uncertainty", () => {
  const ok = result("resolve", "committed", "succeeded", {
    files: [
      { depotPath: "//d/a", state: "succeeded", message: "" },
      { depotPath: "//d/b", state: "succeeded", message: "" },
    ],
  });
  expect(mergeResolveSucceeded(ok)).toBe(true);
  expect(mergeUncertain(ok)).toBe(false);
  const partial = result("resolve", "committed", "partial", {
    files: [
      { depotPath: "//d/a", state: "succeeded", message: "" },
      { depotPath: "//d/b", state: "unknown", message: "still unresolved" },
    ],
  });
  expect(mergeResolveSucceeded(partial)).toBe(false);
  expect(mergeUncertain(partial)).toBe(true);
  expect(mergeRemaining(partial).map((f) => f.depotPath)).toEqual(["//d/b"]);
  const digest = result("manualMergeSave", "committed", "succeeded", {
    details: { resultDigest: "abc" },
  });
  expect(mergeSaveCommitted(digest)).toBe(true);
});
it("unknown recovery looks up the SAME operationId once with the exact connection (no new id)", async () => {
  const connection = {
    profileId: "p",
    generation: "18446744073709551615",
    server: "s",
    user: "u",
    client: "c",
  };
  vi.mocked(invoke).mockResolvedValue({
    kind: "found",
    receipt: {
      state: "settled",
      result: result("resolve", "unknown", "unknown"),
    },
  });
  const looked = await lookupMergeReceipt("op-same", connection);
  expect(invoke).toHaveBeenCalledExactlyOnceWith("workflow_action_lookup", {
    request: { operationId: "op-same", connection },
  });
  expect(looked.kind).toBe("found");
});
