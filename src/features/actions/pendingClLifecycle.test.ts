import { expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
import {
  authoritativeChangeId,
  beginPendingClIntent,
  lifecycleOf,
  lookupPendingClReceipt,
  recoverPendingClUnknown,
  pendingClCommitted,
  pendingClDeleteConfirmed,
  pendingClFacts,
  pendingClIntentActive,
  pendingClIntentsSnapshot,
  resetPendingClIntentsForTests,
  settlePendingClIntent,
  unwrapPendingClLegacy,
  type PendingClActionResultLike,
} from "./pendingClLifecycle";
import { invoke } from "@tauri-apps/api/core";

const result = (
  kind: PendingClActionResultLike["kind"],
  state: PendingClActionResultLike["state"],
  extra: Partial<PendingClActionResultLike> = {},
): PendingClActionResultLike => ({
  kind,
  operationId: "op",
  state,
  outcome: "succeeded",
  changes: [],
  optimistic: "intentOnly",
  message: "",
  mapping: { placeholder: "op", source: "host-post-create-readback" },
  ...extra,
});

it("intent store publishes before dispatch and settles by the same operationId", () => {
  resetPendingClIntentsForTests();
  expect(
    beginPendingClIntent({ operationId: "op-1", kind: "pendingClCreate" }),
  ).toBe(true);
  expect(
    beginPendingClIntent({ operationId: "op-1", kind: "pendingClCreate" }),
  ).toBe(false);
  expect(pendingClIntentActive("op-1")).toBe(true);
  expect(pendingClIntentsSnapshot()).toHaveLength(1);
  settlePendingClIntent("op-1");
  expect(pendingClIntentActive("op-1")).toBe(false);
});
it("legacy payloads never count as committed; no client-fabricated CL id", () => {
  const legacy = {
    operation: { operationId: "legacy-op", exitCode: 0, events: [] },
    createdChangeId: 77,
    affectedChanges: [77],
    affectedPaths: [],
    refreshedChanges: [],
  } as unknown;
  expect(lifecycleOf(legacy)).toBeUndefined();
  expect(unwrapPendingClLegacy(legacy)).toBe(legacy);
  expect(authoritativeChangeId(undefined)).toBeUndefined();
  // even a committed result without host mapping/created id yields no fabricated number.
  expect(
    authoritativeChangeId(result("pendingClCreate", "committed")),
  ).toBeUndefined();
  expect(
    authoritativeChangeId(
      result("pendingClCreate", "intent", { createdChangeId: 41 }),
    ),
  ).toBeUndefined();
});
it("committed mapping/created id is the only authoritative source; facts come from readback", () => {
  const committed = result("pendingClCreate", "committed", {
    changes: [
      { changeId: 41, description: "d", fileCount: 0, jobs: [], present: true },
    ],
    createdChangeId: 42,
    mapping: {
      placeholder: "op",
      authoritativeChangeId: 41,
      source: "host-post-create-readback",
    },
  });
  expect(pendingClCommitted(committed)).toBe(true);
  expect(authoritativeChangeId(committed)).toBe(41);
  expect(pendingClFacts(committed).map((f) => f.changeId)).toEqual([41]);
  const unmapped = result("pendingClCreate", "committed", {
    createdChangeId: 42,
  });
  expect(authoritativeChangeId(unmapped)).toBe(42);
  const unknown = result("pendingClCreate", "unknown", { createdChangeId: 42 });
  expect(authoritativeChangeId(unknown)).toBeUndefined();
  expect(pendingClFacts(unknown)).toEqual([]);
});
it("delete is confirmed only by committed absence; an unknown result keeps the row", () => {
  const committedGone = result("pendingClDelete", "committed", { changes: [] });
  expect(pendingClDeleteConfirmed(committedGone, 10)).toBe(true);
  const committedStillThere = result("pendingClDelete", "committed", {
    changes: [{ changeId: 10, description: "x", present: true }],
  });
  expect(pendingClDeleteConfirmed(committedStillThere, 10)).toBe(false);
  expect(
    pendingClDeleteConfirmed(result("pendingClDelete", "unknown"), 10),
  ).toBe(false);
});
it("unknown recovery looks up the SAME operationId once with the exact connection", async () => {
  const connection = {
    profileId: "p",
    generation: "18446744073709551615",
    server: "s",
    user: "u",
    client: "c",
  };
  vi.mocked(invoke).mockResolvedValue({
    kind: "found",
    receipt: { state: "settled", result: result("pendingClEdit", "unknown") },
  });
  const looked = await lookupPendingClReceipt("op-same", connection);
  expect(invoke).toHaveBeenCalledExactlyOnceWith("workflow_action_lookup", {
    request: { operationId: "op-same", connection },
  });
  expect(looked.kind).toBe("found");
});
it("recoverPendingClUnknown: settled result corrects; notFound/exception stay conservative; one lookup only", async () => {
  const connection = {
    profileId: "p",
    generation: "1",
    server: "s",
    user: "u",
    client: "c",
  };
  const committed = result("pendingClCreate", "committed", {
    changes: [{ changeId: 41, description: "d", present: true }],
    createdChangeId: 41,
    mapping: {
      placeholder: "op",
      authoritativeChangeId: 41,
      source: "host-readback",
    },
  });
  const lookup = vi.fn().mockResolvedValue({
    kind: "found",
    receipt: { state: "settled", result: committed },
  });
  const recovered = await recoverPendingClUnknown("op-1", {
    connection: async () => connection,
    lookup,
  });
  expect(lookup).toHaveBeenCalledExactlyOnceWith("op-1", connection);
  expect(recovered.result).toBe(committed);
  expect(authoritativeChangeId(recovered.result)).toBe(41);
  // notFound: conservative, still exactly one lookup with the same id.
  lookup.mockClear();
  lookup.mockResolvedValue({ kind: "notFound" });
  expect(
    await recoverPendingClUnknown("op-1", {
      connection: async () => connection,
      lookup,
    }),
  ).toEqual({ found: false });
  expect(lookup).toHaveBeenCalledExactlyOnceWith("op-1", connection);
  // interrupted receipt is NOT readable as a settled result.
  lookup.mockClear();
  lookup.mockResolvedValue({
    kind: "found",
    receipt: { state: "interrupted" },
  });
  expect(
    await recoverPendingClUnknown("op-1", {
      connection: async () => connection,
      lookup,
    }),
  ).toEqual({ found: true });
  // lookup failure never retries or mints a new id.
  lookup.mockClear();
  lookup.mockRejectedValue(Error("lookup failed"));
  expect(
    await recoverPendingClUnknown("op-1", {
      connection: async () => connection,
      lookup,
    }),
  ).toEqual({ found: false });
  expect(lookup).toHaveBeenCalledTimes(1);
});
