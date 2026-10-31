import { expect, it, vi } from "vitest";
import { createActionLedger } from "./ledger";
import { acceptShelfDelete, projectShelfDelete } from "./shelfDeleteAdapter";
import { acceptRevert, projectRevert } from "./revertAdapter";
import {
  applyRemovalFacts,
  captureRemovalRead,
  reconcileRemovalRead,
  unknownRemovalFacts,
  type RemovalAction,
  type RemovalEntity,
  type RemovalFact,
} from "./removalProjection";
const a = { path: "//fixture/a", changeId: 11, version: "shelf-digest-a1" },
  b = { path: "//fixture/b", changeId: 11, version: "shelf-digest-b1" },
  other = { path: "//fixture/c", changeId: 22, version: "c1" };
const scope = JSON.stringify([
  "fixture",
  "9007199254740993",
  "server.invalid",
  "user",
  "workspace",
]);
const intent = (
  operationId: string,
  items: readonly RemovalEntity[] = [a, b],
  confirmed = true,
) => ({ operationId, scope, items, confirmed });
const authority = (revision = "1", digest = "a".repeat(64)) => ({
  revision,
  payloadDigest: digest,
});
const facts = (
  items: readonly RemovalEntity[],
  outcome: RemovalFact["outcome"],
  ioComplete = true,
) => items.map((item) => ({ ...item, outcome, ioComplete }));
const ledger = () => createActionLedger<RemovalAction>();
it("shelf cancellation is zero admission and no view change", () => {
  const l = ledger(),
    base = [a, b, other];
  expect(acceptShelfDelete(l, intent("cancel", [a], false))).toBe("cancelled");
  expect(l.getSnapshot()).toHaveLength(0);
  expect(projectShelfDelete(scope, base, l).items).toBe(base);
});
it("accepted shelf hides only selected versions immediately before deferred receipt", async () => {
  const l = ledger();
  const unrelated = { ...other, description: "keep" };
  let finish!: (f: RemovalFact[]) => void;
  const pending = new Promise<RemovalFact[]>((r) => {
    finish = r;
  });
  expect(acceptShelfDelete(l, intent("deferred", [a]))).toBe("accepted");
  expect(projectShelfDelete(scope, [a, b, unrelated], l).items).toEqual([
    b,
    unrelated,
  ]);
  expect(projectShelfDelete(scope, [unrelated], l).items[0]).toBe(unrelated);
  const settle = pending.then((items) =>
    applyRemovalFacts(l, {
      scope,
      operationId: "deferred",
      authority: authority(),
      items,
    }),
  );
  finish(facts([a], "confirmed"));
  await settle;
  expect(projectShelfDelete(scope, [a, b], l).items).toEqual([b]);
});
it("missing version is unsupported and never guessed from path or local counter", () => {
  const l = ledger();
  expect(
    acceptShelfDelete(l, intent("no-version", [{ ...a, version: null }])),
  ).toBe("unsupported");
  expect(l.getSnapshot()).toHaveLength(0);
  acceptShelfDelete(l, intent("known", [a]));
  const row = { ...a, version: null };
  const p = projectShelfDelete(scope, [row], l);
  expect(p.items).toEqual([row]);
  expect(p.unsupported).toEqual([row]);
});
it("overlapping subsets conflict while other files and exact other scope remain usable", () => {
  const l = ledger();
  acceptShelfDelete(l, intent("one", [a, b]));
  expect(acceptShelfDelete(l, intent("two", [b]))).toBe("conflict");
  expect(acceptShelfDelete(l, intent("three", [other]))).toBe("accepted");
  expect(
    acceptShelfDelete(l, { ...intent("else", [a]), scope: "other-generation" }),
  ).toBe("accepted");
});
it("partial facts hide confirmed only, restore notApplied, expose unknown and retain its conflict", () => {
  const l = ledger();
  acceptShelfDelete(l, intent("partial", [a, b, other]));
  applyRemovalFacts(l, {
    scope,
    operationId: "partial",
    authority: authority(),
    items: [
      ...facts([a], "confirmed"),
      ...facts([b], "notApplied"),
      ...facts([other], "unknown"),
    ],
  });
  const p = projectShelfDelete(scope, [a, b, other], l);
  expect(p.items).toEqual([b, other]);
  expect([...p.blocked]).toEqual([other.path]);
  expect(p.needsReconciliation.map((i) => i.path)).toEqual([other.path]);
});
it("same path new shelf version remains visible after old successful receipt", () => {
  const l = ledger();
  acceptShelfDelete(l, intent("old", [a]));
  const newer = { ...a, version: "shelf-digest-a2" };
  applyRemovalFacts(l, {
    scope,
    operationId: "old",
    authority: authority(),
    items: facts([a], "confirmed"),
  });
  expect(projectShelfDelete(scope, [newer], l).items).toEqual([newer]);
});
it("old and equal revisions cannot revert a newer per-file fact", () => {
  const l = ledger();
  acceptShelfDelete(l, intent("order", [a]));
  expect(
    applyRemovalFacts(l, {
      scope,
      operationId: "order",
      authority: authority("9007199254740994"),
      items: facts([a], "confirmed"),
    }),
  ).toBe(true);
  expect(
    applyRemovalFacts(l, {
      scope,
      operationId: "order",
      authority: authority("9007199254740993"),
      items: facts([a], "notApplied"),
    }),
  ).toBe(false);
  expect(
    applyRemovalFacts(l, {
      scope,
      operationId: "order",
      authority: authority("9007199254740994"),
      items: facts([a], "unknown"),
    }),
  ).toBe(false);
  expect(projectShelfDelete(scope, [a], l).items).toHaveLength(0);
});
it("read started before new receipt or later intent cannot replace the cache or retire projections", () => {
  const l = ledger();
  acceptShelfDelete(l, intent("a", [a]));
  const old = captureRemovalRead(l.getSnapshot(), scope);
  applyRemovalFacts(l, {
    scope,
    operationId: "a",
    authority: authority(),
    items: facts([a], "confirmed"),
  });
  expect(reconcileRemovalRead(l, old, [], true)).toBe(false);
  const beforeNext = captureRemovalRead(l.getSnapshot(), scope);
  acceptShelfDelete(l, intent("b", [b]));
  expect(reconcileRemovalRead(l, beforeNext, [], true)).toBe(false);
});
it("retired latest overlay suppresses older action after reconciliation", () => {
  const l = ledger();
  acceptShelfDelete(l, intent("first", [a]));
  applyRemovalFacts(l, {
    scope,
    operationId: "first",
    authority: authority(),
    items: facts([a], "confirmed"),
  });
  acceptShelfDelete(l, intent("second", [a]));
  applyRemovalFacts(l, {
    scope,
    operationId: "second",
    authority: authority(),
    items: facts([a], "confirmed"),
  });
  expect(
    reconcileRemovalRead(
      l,
      captureRemovalRead(l.getSnapshot(), scope),
      [],
      true,
    ),
  ).toBe(true);
  expect(projectShelfDelete(scope, [a], l).items).toEqual([a]);
  expect(l.get("second")?.data.items[0].retired).toBe(true);
});
it("foreign scope, different version and duplicate facts never become matching success", () => {
  const l = ledger();
  acceptShelfDelete(l, intent("bad", [a, b]));
  expect(
    applyRemovalFacts(l, {
      scope: "other",
      operationId: "bad",
      authority: authority(),
      items: facts([a, b], "confirmed"),
    }),
  ).toBe(false);
  applyRemovalFacts(l, {
    scope,
    operationId: "bad",
    authority: authority(),
    items: [
      ...facts([a, a], "confirmed"),
      ...facts([{ ...b, version: "wrong" }], "confirmed"),
    ],
  });
  const p = projectShelfDelete(scope, [a, b], l);
  expect(p.items).toEqual([a, b]);
  expect(p.blocked.size).toBe(2);
});
it("revert does not change presentation before confirmation, then projects without claiming disk restoration", () => {
  const l = ledger();
  expect(acceptRevert(l, intent("cancel", [a], false))).toBe("cancelled");
  expect(projectRevert(scope, [a], l).items).toEqual([a]);
  acceptRevert(l, intent("accepted", [a]));
  expect(projectRevert(scope, [a, b], l).items).toEqual([b]);
  expect(projectRevert(scope, [a, b], l).blocked.has(a.path)).toBe(true);
});
it("revert confirmed membership keeps resource locked until true I/O completion", () => {
  const l = ledger();
  acceptRevert(l, intent("io", [a]));
  applyRemovalFacts(l, {
    scope,
    operationId: "io",
    authority: authority(),
    items: facts([a], "confirmed", false),
  });
  expect(projectRevert(scope, [a], l).blocked.has(a.path)).toBe(true);
  expect(acceptShelfDelete(l, intent("conflict", [a]))).toBe("conflict");
  expect(acceptRevert(l, intent("other", [b]))).toBe("accepted");
  applyRemovalFacts(l, {
    scope,
    operationId: "io",
    authority: authority("2"),
    items: facts([a], "confirmed", true),
  });
  expect(projectRevert(scope, [a], l).blocked.has(a.path)).toBe(false);
});
it("revert notApplied restores display but cannot unlock when I/O is still active", () => {
  const l = ledger();
  acceptRevert(l, intent("not-applied", [a]));
  applyRemovalFacts(l, {
    scope,
    operationId: "not-applied",
    authority: authority(),
    items: facts([a], "notApplied", false),
  });
  expect(projectRevert(scope, [a], l).items).toEqual([a]);
  expect(projectRevert(scope, [a], l).blocked.has(a.path)).toBe(true);
});
it("generic affectedPaths or missing receipt remain unknown with no retry capability", () => {
  const l = ledger();
  acceptRevert(l, intent("generic", [a, b]));
  const execute = vi.fn();
  const generic = { affectedPaths: [a.path, b.path], message: "completed" };
  void generic;
  applyRemovalFacts(l, {
    scope,
    operationId: "generic",
    authority: authority(),
    items: unknownRemovalFacts([a, b]),
  });
  const p = projectRevert(scope, [a, b], l);
  expect(p.items).toEqual([a, b]);
  expect(p.blocked.size).toBe(2);
  expect(execute).not.toHaveBeenCalled();
});
it("new opened version and a different exact generation are not hidden by old revert", () => {
  const l = ledger();
  acceptRevert(l, intent("old", [a]));
  const newer = { ...a, version: "reopened-new" };
  expect(projectRevert(scope, [newer], l).items).toEqual([newer]);
  expect(projectRevert("new-generation", [a], l).items).toEqual([a]);
});

it("partial reads and unversioned rows cannot retire a confirmed old shelf", () => {
  const l = ledger();
  acceptShelfDelete(l, intent("partial-read", [a]));
  applyRemovalFacts(l, {
    scope,
    operationId: "partial-read",
    authority: authority(),
    items: facts([a], "confirmed"),
  });
  const ticket = captureRemovalRead(l.getSnapshot(), scope);
  expect(reconcileRemovalRead(l, ticket, [], false)).toBe(false);
  expect(l.get("partial-read")?.data.items[0].retired).toBe(false);
  expect(reconcileRemovalRead(l, ticket, [{ ...a, version: null }], true)).toBe(
    true,
  );
  expect(l.get("partial-read")?.data.items[0].retired).toBe(false);
});
it("newer notApplied intent prevents an older confirmed deletion from hiding the row", () => {
  const l = ledger();
  acceptShelfDelete(l, intent("earlier", [a, b]));
  applyRemovalFacts(l, {
    scope,
    operationId: "earlier",
    authority: authority(),
    items: [...facts([a], "confirmed"), ...facts([b], "unknown")],
  });
  acceptShelfDelete(l, intent("latest", [a]));
  applyRemovalFacts(l, {
    scope,
    operationId: "latest",
    authority: authority(),
    items: facts([a], "notApplied"),
  });
  const view = projectShelfDelete(scope, [a, b], l);
  expect(view.items).toEqual([a, b]);
  expect(view.blocked.has(b.path)).toBe(true);
  expect(view.blocked.has(a.path)).toBe(false);
});
