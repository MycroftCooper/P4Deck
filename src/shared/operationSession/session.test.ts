import { describe, expect, it, vi } from "vitest";
import { OperationSessionOwner } from "./session";

function owner() {
  const cancel = vi.fn(async () => undefined);
  return {
    cancel,
    session: new OperationSessionOwner({
      cancelOperation: cancel,
      mintOperationId: () => `op-${Math.random().toString(16).slice(2)}`,
    }),
  };
}

describe("operation session owner", () => {
  it("supersedes and cancels the previous lease of a channel", async () => {
    const { cancel, session } = owner();
    const first = session.start("detail");
    const second = session.start("detail");
    await Promise.resolve();
    expect(first.signal.aborted).toBe(true);
    expect(cancel).toHaveBeenCalledWith(first.operationId);
    expect(session.isCurrent(first)).toBe(false);
    expect(session.isCurrent(second)).toBe(true);
    expect(session.finish(first)).toBe(false);
    expect(session.finish(second)).toBe(true);
  });

  it("keeps channels independent and retires a finished lease without cancelling", async () => {
    const { cancel, session } = owner();
    const detail = session.start("detail");
    const content = session.start("content");
    expect(session.isCurrent(detail)).toBe(true);
    expect(session.finish(detail)).toBe(true);
    await Promise.resolve();
    expect(cancel).not.toHaveBeenCalled();
    expect(session.isCurrent(content)).toBe(true);
    expect(session.isCurrent(detail)).toBe(false);
  });

  it("bumps the epoch and cancels without starting a replacement", async () => {
    const { cancel, session } = owner();
    const before = session.start("detail");
    session.invalidate("detail");
    await Promise.resolve();
    expect(before.signal.aborted).toBe(true);
    expect(cancel).toHaveBeenCalledExactlyOnceWith(before.operationId);
    expect(session.isCurrent(before)).toBe(false);
    expect(session.epoch("detail")).toBe(1);
    const after = session.start("detail");
    expect(after.epoch).toBe(1);
    expect(session.epoch("detail")).toBe(1);
  });

  it("abandons a live lease once and ignores an already cancelled one", async () => {
    const { cancel, session } = owner();
    const lease = session.start("detail");
    expect(session.abandon(lease)).toBe(true);
    expect(session.abandon(lease)).toBe(false);
    await Promise.resolve();
    expect(cancel).toHaveBeenCalledExactlyOnceWith(lease.operationId);
  });

  it("marks the lease of a drifted identity stale", () => {
    const { session } = owner();
    const lease = session.start("review", { identity: "a" });
    expect(session.isCurrent(lease)).toBe(true);
    session.invalidate("review");
    expect(session.isCurrent(lease)).toBe(false);
    const next = session.start("review", { identity: "b" });
    expect(session.isCurrent(next)).toBe(true);
  });

  it("honours cancelBackend: false for cache-only reads", async () => {
    const { cancel, session } = owner();
    const lease = session.start("review", { cancelBackend: false });
    session.invalidate("review");
    await Promise.resolve();
    expect(lease.signal.aborted).toBe(true);
    expect(cancel).not.toHaveBeenCalled();
  });

  it("keeps the owner usable after cancelAll and cancels each lease once", async () => {
    const { cancel, session } = owner();
    const first = session.start("detail");
    session.cancelAll();
    const second = session.start("detail");
    expect(session.isCurrent(second)).toBe(true);
    await Promise.resolve();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledWith(first.operationId);
  });

  it("never asks the backend to cancel a superseded cache-only lease", async () => {
    const { cancel, session } = owner();
    const first = session.start("review", { cancelBackend: false });
    const second = session.start("review", { cancelBackend: false });
    await Promise.resolve();
    expect(first.signal.aborted).toBe(true);
    expect(cancel).not.toHaveBeenCalled();
    expect(session.isCurrent(second)).toBe(true);
  });

  it("cancelAll cancels every live lease", async () => {
    const { cancel, session } = owner();
    const first = session.start("detail");
    const second = session.start("content");
    session.cancelAll();
    await Promise.resolve();
    expect(cancel).toHaveBeenCalledWith(first.operationId);
    expect(cancel).toHaveBeenCalledWith(second.operationId);
    expect(session.isCurrent(first)).toBe(false);
    expect(session.isCurrent(second)).toBe(false);
  });
});
