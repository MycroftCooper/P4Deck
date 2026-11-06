import { describe, expect, it } from "vitest";
import { CursorLedger, PagedSession } from "./pagedSession";

function harness() {
  let next = 0;
  const cancelled: string[] = [];
  const session = new PagedSession({
    cancelOperation: async (operationId) => {
      cancelled.push(operationId);
    },
    mintOperationId: () => `op-${++next}`,
  });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  return { session, cancelled, settle };
}

describe("paged session chains", () => {
  it("keeps sibling pages of one chain alive and retires them for a new chain", async () => {
    const { session, cancelled, settle } = harness();
    const chain = session.open("graph");
    const first = session.request(chain);
    const more = session.request(chain);
    // Siblings do not supersede each other: that is the whole point.
    expect(session.isCurrent(chain, first)).toBe(true);
    expect(session.isCurrent(chain, more)).toBe(true);
    expect(session.liveOperationIds()).toEqual(["op-1", "op-2"]);

    const next = session.open("graph");
    // A new chain retires the old one's requests, exactly once each.
    expect(session.isCurrent(chain, first)).toBe(false);
    expect(session.isCurrent(chain, more)).toBe(false);
    expect(first.signal.aborted).toBe(true);
    expect(cancelled).toEqual(["op-1", "op-2"]);
    expect(next.generation).toBe(chain.generation + 1);
    await settle();
  });

  it("never lets a retired or cancelled request look current", () => {
    const { session } = harness();
    const chain = session.open("graph");
    const request = session.request(chain);
    session.settle(request);
    expect(session.isCurrent(chain, request)).toBe(false);

    const live = session.request(chain);
    session.cancel(chain);
    expect(live.signal.aborted).toBe(true);
    expect(session.isCurrent(chain, live)).toBe(false);
    // Cancelling does not end the chain: paging can continue.
    expect(session.request(chain).signal.aborted).toBe(false);
  });

  it("abandons one request without touching its siblings", async () => {
    const { session, cancelled } = harness();
    const chain = session.open("graph");
    const page = session.request(chain);
    const sibling = session.request(chain);
    session.abandon(page);
    expect(cancelled).toEqual(["op-1"]);
    expect(session.isCurrent(chain, page)).toBe(false);
    expect(session.isCurrent(chain, sibling)).toBe(true);
  });

  it("keeps a side read current when the page that started it is settled or abandoned", () => {
    // The invariant a page relies on: a side read that rides on the chain is
    // not silenced by superseding the page that happened to start it. Only the
    // chain's own retirement may do that.
    const { session } = harness();
    const chain = session.open("graph");
    const page = session.request(chain);
    const sideRead = session.request(chain);
    session.settle(page);
    expect(session.isCurrent(chain, sideRead)).toBe(true);
    expect(session.isCurrent(chain, page)).toBe(false);

    const superseded = session.request(chain);
    session.abandon(superseded);
    expect(session.isCurrent(chain, sideRead)).toBe(true);
    session.open("graph");
    expect(session.isCurrent(chain, sideRead)).toBe(false);
  });

  it("hands out an already-aborted request for a dead chain and never reaches the host", async () => {
    const { session, cancelled } = harness();
    const chain = session.open("graph");
    session.open("graph");
    const request = session.request(chain);
    expect(request.signal.aborted).toBe(true);
    expect(session.isCurrent(chain, request)).toBe(false);
    expect(cancelled).toEqual([]);
  });

  it("keeps channels independent and cancelAll covers every chain", async () => {
    const { session, cancelled } = harness();
    const list = session.open("list");
    const detail = session.open("detail");
    session.request(list);
    session.request(detail);
    session.open("detail");
    // The detail chain retired alone; the list chain is untouched.
    expect(session.isCurrent(list, session.request(list))).toBe(true);
    expect(cancelled).toEqual(["op-2"]);
    session.cancelAll();
    expect(session.liveOperationIds()).toEqual([]);
  });
});

describe("cursor ledger", () => {
  it("allows a retry after a failed page and stops on a repeated cursor", () => {
    const ledger = new CursorLedger();
    expect(ledger.claim("c1")).toBe(true);
    // A second request for an in-flight cursor is refused.
    expect(ledger.claim("c1")).toBe(false);
    ledger.release("c1");
    expect(ledger.claim("c1")).toBe(true);
    ledger.consume("c1");
    expect(ledger.claim("c1")).toBe(false);
    expect(ledger.isStalled(undefined)).toBe(true);
    expect(ledger.isStalled("c1", "c2")).toBe(true);
    expect(ledger.isStalled("c2", "c1")).toBe(false);
    ledger.reset();
    expect(ledger.claim("c1")).toBe(true);
  });
});
