import { describe, expect, it, vi } from "vitest";
import {
  CloseStateRegistry,
  connectCloseGuard,
  type CloseGuardWire,
} from "./state";
const tick = async () => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
};
function wire(generation = "9007199254740993") {
  const report = vi
    .fn<CloseGuardWire["report"]>()
    .mockResolvedValue({ accepted: true });
  return {
    register: vi.fn().mockResolvedValue({ generation }),
    report,
  };
}
describe("window state aggregation", () => {
  it("starts unknown; dirty dominates unknown and another editor cannot clear it", () => {
    const registry = new CloseStateRegistry(),
      a = Symbol(),
      b = Symbol();
    expect(registry.snapshot()).toBe("unknown");
    registry.setReady(true);
    registry.attach(a, "dirty");
    registry.attach(b, "unknown");
    registry.update(b, "clean");
    expect(registry.snapshot()).toBe("dirty");
    registry.update(a, "clean");
    expect(registry.snapshot()).toBe("clean");
  });
  it("explicit save/discard allows clean detach; unexpected dirty detach remains dirty", async () => {
    const registry = new CloseStateRegistry();
    registry.setReady(true);
    const a = Symbol(),
      release = registry.attach(a, "dirty");
    registry.update(a, "clean");
    release();
    await tick();
    expect(registry.snapshot()).toBe("clean");
    const releaseDirty = registry.attach(Symbol(), "dirty");
    releaseDirty();
    await tick();
    expect(registry.snapshot()).toBe("dirty");
  });
  it("StrictMode reattach and late cleanup cannot remove the newer lease", async () => {
    const registry = new CloseStateRegistry(),
      token = Symbol();
    registry.setReady(true);
    const old = registry.attach(token, "dirty");
    old();
    registry.attach(token, "clean");
    old();
    await tick();
    expect(registry.snapshot()).toBe("clean");
  });
  it("does not share dirty state between windows", () => {
    const first = new CloseStateRegistry(),
      second = new CloseStateRegistry();
    first.setReady(true);
    second.setReady(true);
    first.attach(Symbol(), "dirty");
    expect(first.snapshot()).toBe("dirty");
    expect(second.snapshot()).toBe("clean");
  });
  it("crash/coverage loss cannot be cleared by one editor", () => {
    const registry = new CloseStateRegistry(),
      token = Symbol();
    registry.setReady(true);
    registry.attach(token, "clean");
    registry.markUnknown();
    registry.update(token, "clean");
    expect(registry.snapshot()).toBe("unknown");
  });
});
describe("frozen close wire", () => {
  it("reports only state metadata on every registry change", async () => {
    const registry = new CloseStateRegistry(),
      transport = wire(),
      token = Symbol();
    const stop = connectCloseGuard(registry, transport);
    await tick();
    registry.setReady(true);
    registry.attach(token, "dirty");
    // register, ready, attach — every registry change is pushed exactly once.
    expect(transport.report).toHaveBeenCalledTimes(3);
    expect(transport.report.mock.calls.map(([value]) => value.state)).toEqual([
      "unknown",
      "clean",
      "dirty",
    ]);
    expect(transport.report.mock.lastCall![0]).toEqual({
      generation: "9007199254740993",
      sequence: 3,
      state: "dirty",
      dirtyCategories: ["otherDraft"],
      probeId: null,
    });
    const count = transport.report.mock.calls.length;
    stop();
    registry.update(token, "clean");
    expect(transport.report).toHaveBeenCalledTimes(count);
  });
  it("keeps increasing sequence through same-generation reconnects", async () => {
    const registry = new CloseStateRegistry(),
      first = wire();
    const stop = connectCloseGuard(registry, first);
    await tick();
    stop();
    const second = wire();
    connectCloseGuard(registry, second);
    await tick();
    expect(second.report.mock.calls[0][0].sequence).toBeGreaterThan(
      first.report.mock.calls[0][0].sequence,
    );
  });
  it("never publishes a state before the host acknowledges the window", async () => {
    const registry = new CloseStateRegistry(),
      transport = wire();
    registry.setReady(true);
    transport.register.mockRejectedValueOnce(new Error("unavailable"));
    connectCloseGuard(registry, transport);
    await tick();
    expect(registry.snapshot()).toBe("unknown");
    expect(transport.report).not.toHaveBeenCalled();
  });
  it("registration failure stays unknown after unmount", async () => {
    const registry = new CloseStateRegistry(),
      transport = wire();
    registry.setReady(true);
    transport.register.mockRejectedValueOnce(new Error("unavailable"));
    const stop = connectCloseGuard(registry, transport);
    await tick();
    stop();
    expect(registry.snapshot()).toBe("unknown");
    expect(transport.report).not.toHaveBeenCalled();
  });
  it("a rejected report fails closed without unbounded retries", async () => {
    const registry = new CloseStateRegistry(),
      transport = wire();
    registry.setReady(true);
    // The host refuses the first pushed report (clean).
    transport.report.mockResolvedValueOnce({ accepted: false });
    const stop = connectCloseGuard(registry, transport);
    await tick();
    // A refused report must never leave the window looking closeable.
    expect(registry.snapshot()).toBe("unknown");
    expect(transport.report).toHaveBeenCalledTimes(1);
    // The transport is dead: later registry changes are not retried.
    registry.attach(Symbol(), "dirty");
    await tick();
    expect(transport.report).toHaveBeenCalledTimes(1);
    stop();
  });
  it("late registration after teardown never reports", async () => {
    const registry = new CloseStateRegistry(),
      transport = wire();
    let finish!: (value: { generation: string }) => void;
    transport.register.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const stop = connectCloseGuard(registry, transport);
    await tick();
    stop();
    finish({ generation: "1" });
    await tick();
    expect(transport.report).not.toHaveBeenCalled();
  });
});
it("clearing a detached editor never clears a second dirty editor", async () => {
  const registry = new CloseStateRegistry();
  registry.setReady(true);
  const a = Symbol(),
    b = Symbol();
  const release = registry.attach(a, "dirty");
  registry.attach(b, "dirty");
  release();
  await tick();
  registry.clear(a);
  expect(registry.snapshot()).toBe("dirty");
  registry.clear(b);
  expect(registry.snapshot()).toBe("clean");
});
it("unknown does not erase retained dirty and explicit discard releases only that fact", async () => {
  const registry = new CloseStateRegistry();
  registry.setReady(true);
  const a = Symbol();
  const release = registry.attach(a, "dirty");
  release();
  await tick();
  registry.markUnknown();
  expect(registry.snapshot()).toBe("dirty");
  registry.clear(a);
  expect(registry.snapshot()).toBe("unknown");
});

it("reports bounded deduplicated categories and clears only the saved editor", async () => {
  const registry = new CloseStateRegistry(),
    transport = wire();
  registry.setReady(true);
  const a = Symbol(),
    b = Symbol(),
    c = Symbol();
  registry.attach(a, "dirty", "changelistDescription");
  const detach = registry.attach(b, "dirty", "changelistDescription");
  registry.attach(c, "dirty", "manualMerge");
  const stop = connectCloseGuard(registry, transport);
  await tick();
  expect(registry.dirtyCategories()).toEqual([
    "changelistDescription",
    "manualMerge",
  ]);
  detach();
  await tick();
  registry.clear(a);
  expect(registry.dirtyCategories()).toEqual([
    "changelistDescription",
    "manualMerge",
  ]);
  registry.clear(b);
  expect(registry.dirtyCategories()).toEqual(["manualMerge"]);
  registry.clear(c);
  expect(transport.report.mock.lastCall![0]).toMatchObject({
    state: "clean",
    dirtyCategories: [],
  });
  stop();
});

it("dirty then diagnostic unknown then explicit discard reports covered resolution without faking clean", async () => {
  const r = new CloseStateRegistry(),
    t = wire(),
    token = Symbol();
  r.setReady(true);
  const stop = connectCloseGuard(r, t);
  await tick();
  r.attach(token, "dirty", "changelistDescription");
  await tick();
  r.markUnknown();
  await tick();
  const dirty = t.report.mock.lastCall![0].sequence;
  r.clear(token);
  await tick();
  expect(t.report.mock.lastCall![0]).toMatchObject({
    state: "unknown",
    dirtyCategories: [],
    resolvedDirtyThroughSequence: dirty,
  });
  stop();
});
it("one saved editor or unexpected unmount cannot resolve another dirty editor", async () => {
  const r = new CloseStateRegistry(),
    t = wire(),
    a = Symbol(),
    b = Symbol();
  r.setReady(true);
  const stop = connectCloseGuard(r, t);
  await tick();
  r.attach(a, "dirty");
  const detach = r.attach(b, "dirty");
  await tick();
  r.markUnknown();
  r.clear(a);
  detach();
  await tick();
  expect(t.report.mock.lastCall![0].state).toBe("dirty");
  expect(
    t.report.mock.lastCall![0].resolvedDirtyThroughSequence,
  ).toBeUndefined();
  r.update(b, "clean");
  expect(r.snapshot()).toBe("dirty");
  r.clear(b);
  await tick();
  expect(
    t.report.mock.lastCall![0].resolvedDirtyThroughSequence,
  ).toBeGreaterThan(0);
  stop();
});
it("late dirty acknowledgement emits resolution only for explicitly resolved epochs and stays generation scoped", async () => {
  const r = new CloseStateRegistry(),
    t = wire("7"),
    a = Symbol();
  let ack!: () => void;
  t.report.mockImplementation((value) =>
    value.state === "dirty"
      ? new Promise((resolve) => (ack = () => resolve({ accepted: true })))
      : Promise.resolve({ accepted: true }),
  );
  r.setReady(true);
  const stop = connectCloseGuard(r, t);
  await tick();
  r.attach(a, "dirty");
  r.markUnknown();
  r.clear(a);
  expect(
    t.report.mock.lastCall![0].resolvedDirtyThroughSequence,
  ).toBeUndefined();
  ack();
  await tick();
  expect(
    t.report.mock.lastCall![0].resolvedDirtyThroughSequence,
  ).toBeGreaterThan(0);
  expect(r.resolutionFor("8")).toBeUndefined();
  r.attach(Symbol(), "dirty");
  expect(
    t.report.mock.lastCall![0].resolvedDirtyThroughSequence,
  ).toBeUndefined();
  stop();
});
it("an editor becoming unknown never erases its known dirty fact", () => {
  const r = new CloseStateRegistry(),
    a = Symbol();
  r.setReady(true);
  r.attach(a, "dirty");
  r.update(a, "unknown");
  expect(r.snapshot()).toBe("dirty");
  r.clear(a);
  expect(r.dirtyCategories()).toEqual([]);
});
