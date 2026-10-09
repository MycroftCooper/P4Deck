import { describe, expect, it, vi } from "vitest";
import { NotificationCenter, sanitizeNotificationText } from "./notifications";

describe("desktop notification policy", () => {
  it("redacts secrets and local/depot paths", () => {
    const clean = sanitizeNotificationText(
      "password=hunter2 C:\\Users\\me\\ticket //depot/secret/file token=abc",
    );
    expect(clean).not.toMatch(/hunter2|Users|secret\/file|abc/);
    expect(clean).toContain("[redacted]");
  });

  it("deduplicates, cools down, honors preferences, and suppresses foreground noise", async () => {
    let now = 1_000;
    let foreground = false;
    let enabled = true;
    const adapter = { send: vi.fn() };
    const center = new NotificationCenter(
      adapter,
      () => ({ enabled, failuresOnly: false }),
      () => foreground,
      () => now,
      500,
    );
    const notice = {
      key: "same",
      title: "Done",
      body: "ok",
      kind: "success" as const,
    };
    expect(await center.notify(notice)).toBe(true);
    expect(await center.notify(notice)).toBe(false);
    now += 501;
    foreground = true;
    expect(await center.notify(notice)).toBe(false);
    foreground = false;
    enabled = false;
    expect(await center.notify({ ...notice, key: "new" })).toBe(false);
    expect(adapter.send).toHaveBeenCalledTimes(1);
  });

  it("supports a failures-only preference", async () => {
    const adapter = { send: vi.fn() };
    const center = new NotificationCenter(
      adapter,
      () => ({ enabled: true, failuresOnly: true }),
      () => false,
    );
    await center.notify({
      key: "ok",
      title: "Done",
      body: "ok",
      kind: "success",
    });
    await center.notify({
      key: "bad",
      title: "Failed",
      body: "bad",
      kind: "failure",
    });
    expect(adapter.send).toHaveBeenCalledTimes(1);
  });

  it("keeps notification adapter failures non-fatal", async () => {
    const center = new NotificationCenter(
      { send: vi.fn(() => Promise.reject(new Error("permission revoked"))) },
      () => ({ enabled: true, failuresOnly: false }),
      () => false,
    );
    await expect(
      center.notify({
        key: "failure",
        title: "Done",
        body: "ok",
        kind: "success",
      }),
    ).resolves.toBe(false);
  });
});
