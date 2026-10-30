import { expect, it } from "vitest";
import { createActionLedger, compareRevision } from "./ledger";
const digest = "a".repeat(64);
it("admission is synchronous and rejects duplicate IDs without changing the stored intent", () => {
  const l = createActionLedger<{ path: string }>();
  let count = 0;
  l.subscribe(() => count++);
  expect(l.admit("scope", "one", { path: "a" })).toBe(true);
  expect(l.get("one")?.phase).toBe("localAccepted");
  expect(l.admit("other", "one", { path: "b" })).toBe(false);
  expect(count).toBe(1);
  expect(l.get("one")?.data.path).toBe("a");
});
it("orders exact decimal revisions beyond Number range and rejects old/equal receipts", () => {
  const l = createActionLedger<string>();
  l.admit("s", "id", "initial");
  expect(
    l.update("id", "new", "settled", {
      revision: "9007199254740994",
      payloadDigest: digest,
    }),
  ).toBe(true);
  expect(
    l.update("id", "old", "running", {
      revision: "9007199254740993",
      payloadDigest: digest,
    }),
  ).toBe(false);
  expect(
    l.update("id", "duplicate", "settled", {
      revision: "9007199254740994",
      payloadDigest: digest,
    }),
  ).toBe(false);
  expect(l.get("id")?.data).toBe("new");
  expect(compareRevision("10", "9")).toBeGreaterThan(0);
});
it("digest conflict and malformed sequence cannot replace committed facts", () => {
  const l = createActionLedger<string>();
  l.admit("s", "id", "first");
  l.update("id", "confirmed", "settled", {
    revision: "1",
    payloadDigest: digest,
  });
  expect(
    l.update("id", "other", "unknown", {
      revision: "2",
      payloadDigest: "b".repeat(64),
    }),
  ).toBe(false);
  expect(
    l.update("id", "bad", "unknown", { revision: "02", payloadDigest: digest }),
  ).toBe(false);
  expect(l.get("id")?.data).toBe("confirmed");
});
it("retired latest intent remains ordered after local reconciliation and other scopes coexist", () => {
  const l = createActionLedger<{ path: string; retired: boolean }>();
  l.admit("s", "a", { path: "x", retired: false });
  l.admit("s", "b", { path: "x", retired: false });
  l.update("b", { path: "x", retired: true }, "settled");
  l.admit("other", "c", { path: "x", retired: false });
  expect(
    l
      .getSnapshot()
      .filter((r) => r.scope === "s")
      .at(-1)?.operationId,
  ).toBe("b");
});
