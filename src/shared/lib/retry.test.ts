import { describe, expect, it, vi } from "vitest";
import { classifyRetryFailure, retryDelay, runWithRetry } from "./retry";

describe("safe retry policy", () => {
  it("classifies only transient failures as retryable and bounds jitter", () => {
    expect(classifyRetryFailure(new Error("server unreachable"))).toBe(
      "serverUnreachable",
    );
    expect(classifyRetryFailure(new Error("ticket expired"))).toBe("auth");
    expect(retryDelay(3, 100, 1_000, 0.2, () => 0)).toBe(320);
    expect(retryDelay(9, 100, 1_000, 0.2, () => 1)).toBe(1_000);
  });

  it("retries an idempotent read with backoff", async () => {
    const task = vi
      .fn()
      .mockRejectedValueOnce(new Error("network unavailable"))
      .mockResolvedValue("ok");
    const sleep = vi.fn(async () => undefined);
    await expect(
      runWithRetry(task, {
        kind: "read",
        idempotent: true,
        binding: { profileId: "a", generation: 2 },
        currentBinding: () => ({ profileId: "a", generation: 2 }),
        random: () => 0.5,
        sleep,
      }),
    ).resolves.toBe("ok");
    expect(task).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(400, undefined);
  });

  it("never implicitly replays mutations", async () => {
    const task = vi.fn(async () => {
      throw new Error("network unavailable");
    });
    await expect(
      runWithRetry(task, {
        kind: "mutation",
        idempotent: false,
        binding: { generation: 1 },
        currentBinding: () => ({ generation: 1 }),
      }),
    ).rejects.toThrow("network");
    expect(task).toHaveBeenCalledTimes(1);
  });

  it("cancels retries when the profile generation drifts", async () => {
    let generation = 1;
    const task = vi.fn(async () => {
      generation = 2;
      throw new Error("timeout");
    });
    await expect(
      runWithRetry(task, {
        kind: "refresh",
        idempotent: true,
        binding: { profileId: "a", generation: 1 },
        currentBinding: () => ({ profileId: "a", generation }),
        sleep: async () => undefined,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(task).toHaveBeenCalledTimes(1);
  });
});
