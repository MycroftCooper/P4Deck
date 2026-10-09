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
  it("refreshes on visibility and throttles foreground and detached windows", async () => {
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
      foregroundThrottleMs: 10_000,
      backgroundThrottleMs: 60_000,
    });
    expect(await coordinator.trigger("visible")).toBe(true);
    now += 5_000;
    expect(await coordinator.trigger("focus")).toBe(false);
    environment = { ...foreground, detached: true };
    now += 10_000;
    expect(await coordinator.trigger("interval")).toBe(false);
    now += 50_000;
    expect(await coordinator.trigger("interval")).toBe(true);
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
      foregroundThrottleMs: 0,
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
