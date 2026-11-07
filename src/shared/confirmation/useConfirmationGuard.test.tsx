// @vitest-environment jsdom
import { act, useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { useConfirmationGuard, useTokenExpiry } from "./useConfirmationGuard";
import type { ConfirmationGuard } from "./useConfirmationGuard";

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

function renderGuard(props: {
  reviewed?: string | null;
  current?: string | null;
  onValue(guard: ConfirmationGuard): void;
}) {
  function Probe() {
    const guard = useConfirmationGuard(props.reviewed, props.current);
    props.onValue(guard);
    return null;
  }
  return act(async () => root.render(<Probe />));
}

function unmount() {
  return act(async () => root.unmount());
}

describe("useConfirmationGuard", () => {
  it("holds one reviewed plan and refuses confirm without it", async () => {
    let guard!: ConfirmationGuard;
    await renderGuard({ onValue: (value) => (guard = value) });
    expect(guard.checked()).toBe(false);
    expect(guard.blocks()).toEqual(["notReady", "missingToken"]);
    expect(guard.begin()).toBe(false);
    await act(async () =>
      guard.hold({
        ready: true,
        token: "one-use",
        expiresAt: Date.now() + 5_000,
      }),
    );
    expect(guard.checked()).toBe(true);
    expect(guard.blocks()).toEqual([]);
    expect(guard.remainingMs()).toBeGreaterThan(0);
    await unmount();
  });

  it("blocks the token after it expires and drops it on the expired outcome", async () => {
    let guard!: ConfirmationGuard;
    await renderGuard({ onValue: (value) => (guard = value) });
    await act(async () =>
      guard.hold({ ready: true, token: "one-use", expiresAt: Date.now() - 1 }),
    );
    // A plan reviewed before dispatch but already elapsed cannot be spent.
    expect(guard.begin()).toBe(false);
    expect(guard.blocks()).toEqual(["expired"]);
    await act(async () => guard.settle({ blocks: ["expired"] }));
    expect(guard.blocks()).toEqual(["notReady", "missingToken"]);
    expect(guard.lastOutcome()).toEqual({ blocks: ["expired"] });
    await unmount();
  });

  it("refuses a second dispatch while one is in flight (double click)", async () => {
    let guard!: ConfirmationGuard;
    await renderGuard({ onValue: (value) => (guard = value) });
    await act(async () =>
      guard.hold({
        ready: true,
        token: "one-use",
        expiresAt: Date.now() + 5_000,
      }),
    );
    let took = false;
    await act(async () => {
      took = guard.begin();
    });
    expect(took).toBe(true);
    expect(guard.inFlight()).toBe(true);
    let again = true;
    await act(async () => {
      again = guard.begin();
    });
    expect(again).toBe(false);
    // The token is still valid, but the in-flight claim keeps confirm disabled.
    expect(guard.checked({ inFlight: false })).toBe(true);
    expect(guard.checked()).toBe(false);
    expect(guard.blocks()).toEqual(["inFlight"]);
    await act(async () => guard.settle());
    expect(guard.inFlight()).toBe(false);
    expect(guard.checked()).toBe(true);
    await unmount();
  });

  it("blocks confirm when the connection key changes under the dialog", async () => {
    let guard!: ConfirmationGuard;
    const value = {
      hold: (next: Parameters<ConfirmationGuard["hold"]>[0]) =>
        guard?.hold(next),
    };
    const onValue = (next: ConfirmationGuard) => {
      guard = next;
      value.hold = (plan) => next.hold(plan);
    };
    await renderGuard({
      reviewed: "profile-a:7",
      current: "profile-a:7",
      onValue,
    });
    await act(async () =>
      value.hold({
        ready: true,
        token: "one-use",
        expiresAt: Date.now() + 5_000,
      }),
    );
    expect(guard.checked()).toBe(true);
    await renderGuard({
      reviewed: "profile-a:7",
      current: "profile-b:8",
      onValue,
    });
    expect(guard.blocks()).toContain("stale");
    expect(guard.begin()).toBe(false);
    await unmount();
  });

  it("requires the explicit acknowledgement before the token can be spent", async () => {
    let guard!: ConfirmationGuard;
    await renderGuard({ onValue: (value) => (guard = value) });
    await act(async () =>
      guard.hold({
        ready: true,
        token: "one-use",
        expiresAt: Date.now() + 5_000,
      }),
    );
    expect(guard.begin({ missingAcknowledgement: true })).toBe(false);
    let took = false;
    await act(async () => {
      took = guard.begin({ missingAcknowledgement: false });
    });
    expect(took).toBe(true);
    await act(async () => guard.settle());
    await unmount();
  });

  it("re-renders the owner when the claim is taken and released", async () => {
    let renders = 0;
    let guard!: ConfirmationGuard;
    await renderGuard({
      onValue: (value) => {
        guard = value;
        renders++;
      },
    });
    await act(async () =>
      guard.hold({
        ready: true,
        token: "one-use",
        expiresAt: Date.now() + 5_000,
      }),
    );
    const settled = renders;
    // `begin` runs from an async confirm handler; the confirm button must be
    // re-rendered as disabled before the awaited dispatch resumes.
    await act(async () => {
      await Promise.resolve().then(() => guard.begin());
    });
    expect(renders).toBeGreaterThan(settled);
    expect(guard.blocks()).toEqual(["inFlight"]);
    await act(async () => guard.settle());
    expect(guard.blocks()).toEqual([]);
    await unmount();
  });
});

describe("useTokenExpiry", () => {
  it("fires exactly once when the reviewed token elapses", async () => {
    vi.useFakeTimers();
    try {
      const onExpire = vi.fn();
      function Probe() {
        const [expiry] = useState(() => Date.now() + 1_000);
        useTokenExpiry(expiry, onExpire);
        return null;
      }
      await act(async () => root.render(<Probe />));
      expect(onExpire).not.toHaveBeenCalled();
      await act(async () => {
        vi.advanceTimersByTime(999);
      });
      expect(onExpire).not.toHaveBeenCalled();
      await act(async () => {
        vi.advanceTimersByTime(1);
      });
      expect(onExpire).toHaveBeenCalledTimes(1);
      await unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does nothing for a plan without a finite expiry", async () => {
    vi.useFakeTimers();
    try {
      const onExpire = vi.fn();
      function Probe() {
        useTokenExpiry(Number.NaN, onExpire);
        return null;
      }
      await act(async () => root.render(<Probe />));
      await act(async () => {
        vi.advanceTimersByTime(60_000);
      });
      expect(onExpire).not.toHaveBeenCalled();
      await unmount();
    } finally {
      vi.useRealTimers();
    }
  });
});
