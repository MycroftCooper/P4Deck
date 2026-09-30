import { afterEach, describe, expect, it, vi } from "vitest";
import { deferredTask } from "./deferredTask";
import { subscribeSafely } from "./subscription";
import { storage } from "./storage";
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
describe("deferred layout persistence", () => {
  it("coalesces a burst and flushes the latest pending write", () => {
    vi.useFakeTimers();
    const save = vi.fn();
    const task = deferredTask(save);
    task.schedule();
    task.schedule();
    task.schedule();
    expect(save).not.toHaveBeenCalled();
    vi.advanceTimersByTime(120);
    expect(save).toHaveBeenCalledTimes(1);
    task.schedule();
    task.flush();
    expect(save).toHaveBeenCalledTimes(2);
    vi.runAllTimers();
    expect(save).toHaveBeenCalledTimes(2);
  });
  it("can cancel without writing", () => {
    vi.useFakeTimers();
    const save = vi.fn();
    const task = deferredTask(save);
    task.schedule();
    task.cancel();
    vi.runAllTimers();
    expect(save).not.toHaveBeenCalled();
  });
});
describe("asynchronous listener lifecycle", () => {
  it("unsubscribes a registration that completes after unmount", async () => {
    let complete!: (stop: () => void) => void;
    const registration = new Promise<() => void>((resolve) => {
      complete = resolve;
    });
    const stop = vi.fn();
    const dispose = subscribeSafely(() => registration);
    dispose();
    complete(stop);
    await registration;
    await Promise.resolve();
    expect(stop).toHaveBeenCalledTimes(1);
  });
  it("handles failed registration", async () => {
    const failure = vi.fn();
    subscribeSafely(() => Promise.reject(new Error("offline")), failure);
    await Promise.resolve();
    await Promise.resolve();
    expect(failure).toHaveBeenCalledOnce();
  });
});
describe("best-effort persistence", () => {
  it("does not crash when browser storage is disabled", () => {
    const fail = () => {
      throw new Error("disabled");
    };
    vi.stubGlobal("localStorage", {
      getItem: fail,
      setItem: fail,
      removeItem: fail,
    });
    expect(storage.getItem("a")).toBeNull();
    expect(() => storage.setItem("a", "b")).not.toThrow();
    expect(() => storage.removeItem("a")).not.toThrow();
  });
});
