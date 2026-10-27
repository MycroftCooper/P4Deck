import { describe, expect, it, vi } from "vitest";
import {
  AutoRefreshCoordinator,
  type AutoRefreshEnvironment,
} from "./autoRefresh";

const foreground: AutoRefreshEnvironment = {
  visible: true,
  focused: true,
  online: true,
  detached: false,
};

describe("automatic refresh coordinator", () => {
  it("uses the configured interval for foreground and detached windows", async () => {
    let now = 20_000;
    let environment = foreground;
    const refresh = vi.fn(async () => undefined);
    const coordinator = new AutoRefreshCoordinator({
      binding: () => "a:1",
      environment: () => environment,
      paused: () => false,
      refresh,
      update: vi.fn(),
      now: () => now,
      intervalMs: () => 10_000,
    });
    expect(await coordinator.trigger("visible")).toBe(false);
    now += 10_000;
    expect(await coordinator.trigger("visible")).toBe(true);
    now += 5_000;
    expect(await coordinator.trigger("focus")).toBe(false);
    environment = { ...foreground, detached: true };
    now += 4_000;
    expect(await coordinator.trigger("interval")).toBe(false);
    now += 1_000;
    expect(await coordinator.trigger("interval")).toBe(true);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("waits five minutes and coalesces triggers without aborting an active read", async () => {
    let now = 0;
    let finish!: () => void;
    let signal!: AbortSignal;
    const refresh = vi.fn((activeSignal: AbortSignal) => {
      signal = activeSignal;
      return new Promise<void>((resolve) => (finish = resolve));
    });
    const coordinator = new AutoRefreshCoordinator({
      binding: () => "a:1",
      environment: () => foreground,
      paused: () => false,
      refresh,
      update: vi.fn(),
      now: () => now,
    });
    now = 299_999;
    expect(await coordinator.trigger("focus")).toBe(false);
    now = 300_000;
    const pending = coordinator.trigger("interval");
    now += 300_000;
    expect(await coordinator.trigger("visible")).toBe(false);
    expect(await coordinator.trigger("manual")).toBe(false);
    expect(signal.aborted).toBe(false);
    expect(refresh).toHaveBeenCalledTimes(1);
    finish();
    expect(await pending).toBe(true);
    now += 299_999;
    expect(await coordinator.trigger("online")).toBe(false);
    now += 1;
    const next = coordinator.trigger("focus");
    finish();
    expect(await next).toBe(true);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("skips paused, hidden, and offline refreshes", async () => {
    let paused = true;
    let environment = foreground;
    const refresh = vi.fn(async () => undefined);
    const coordinator = new AutoRefreshCoordinator({
      binding: () => "a:1",
      environment: () => environment,
      paused: () => paused,
      refresh,
      update: vi.fn(),
    });
    expect(await coordinator.trigger("focus")).toBe(false);
    expect(await coordinator.trigger("manual")).toBe(true);
    paused = false;
    environment = { ...foreground, visible: false };
    expect(await coordinator.trigger("interval")).toBe(false);
    environment = { ...foreground, online: false };
    expect(await coordinator.trigger("online")).toBe(false);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("cancels an old request and isolates its late response after binding drift", async () => {
    let binding = "a:1";
    let finish!: () => void;
    const updates = vi.fn();
    const coordinator = new AutoRefreshCoordinator({
      binding: () => binding,
      environment: () => foreground,
      paused: () => false,
      refresh: () => new Promise<void>((resolve) => (finish = resolve)),
      update: updates,
      intervalMs: () => 0,
    });
    const pending = coordinator.trigger("manual");
    binding = "b:2";
    finish();
    expect(await pending).toBe(false);
    expect(updates).not.toHaveBeenCalledWith(
      expect.objectContaining({ lastUpdated: expect.any(Number) }),
    );
  });
});
