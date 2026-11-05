import { useEffect, useRef, useState } from "react";
import { canConfirm, confirmBlocks, tokenRemainingMs } from "./guards";
import type { ConfirmBlock, ConfirmationPlan } from "./guards";

/** What the owning dialog observes after an attempt or an expiry. */
export interface ConfirmationOutcome {
  /** Which guard stopped the attempt; empty when the token was spent. */
  blocks: ConfirmBlock[];
  /** Human-facing message from the owner (i18n copy lives in the dialog). */
  message?: string;
}

export interface ConfirmExtras {
  /** A reviewed input (form field, whole-CL scope) no longer matches. */
  drift?: boolean;
  /** A required explicit acknowledgement is missing. */
  missingAcknowledgement?: boolean;
  /**
   * Override the guard's own in-flight claim. Dialogs only pass a value when
   * they hold additional work of their own; omitting it keeps the claim.
   */
  inFlight?: boolean;
}

export interface ConfirmationGuard {
  /** Remaining lifetime of the reviewed token in ms; `undefined` when unusable. */
  remainingMs(): number | undefined;
  /** True when the reviewed token can be spent right now. */
  checked(extra?: ConfirmExtras): boolean;
  /** Same reasons the render path shows; empty means confirm is allowed. */
  blocks(extra?: ConfirmExtras): ConfirmBlock[];
  /** Records a review; `undefined` withdraws the reviewed facts. */
  hold(plan: ConfirmationPlan | undefined): void;
  /** True while an attempt is between `begin` and `settle`. */
  inFlight(): boolean;
  /** The outcome reported by the last `settle` call, until the next attempt. */
  lastOutcome(): ConfirmationOutcome | undefined;
  /** Bumped once per attempted/expired/settled event. */
  epoch(): number;
  /**
   * Claims the right to dispatch. Returns false (without dispatching) when a
   * guard blocks it or an attempt is already in flight; this is the double-click
   * and stale-token gate for every guarded write.
   */
  begin(extra?: ConfirmExtras): boolean;
  /** Releases the in-flight claim; an `expired` outcome drops the reviewed plan. */
  settle(outcome?: ConfirmationOutcome): void;
}

/**
 * Holds the reviewed preflight facts of ONE guarded write and the in-flight
 * claim for it. It never issues IPC and never chooses copy: the owning dialog
 * supplies the localized message. The reviewed plan is dropped when the token
 * can no longer be spent, so a confirm attempt after expiry cannot dispatch.
 */
export function useConfirmationGuard(
  reviewedKey?: string | null,
  currentKey?: string | null,
): ConfirmationGuard {
  const [plan, setPlan] = useState<ConfirmationPlan>();
  const [epoch, setEpoch] = useState(0);
  const [outcome, setOutcome] = useState<ConfirmationOutcome>();
  const inFlight = useRef(false);
  const held = useRef<ConfirmationPlan | undefined>(undefined);
  // `begin`/`settle` toggle the claim outside React state; this mirror forces the
  // confirm button to re-render so it cannot look enabled mid-dispatch.
  const [claim, setClaim] = useState(false);

  const guard: ConfirmationGuard = {
    remainingMs: () => tokenRemainingMs(held.current?.expiresAt ?? NaN),
    checked: (extra) =>
      canConfirm({
        plan: held.current,
        reviewed: reviewedKey,
        current: currentKey,
        now: Date.now(),
        inFlight: inFlight.current,
        ...extra,
      }),
    blocks: (extra) =>
      confirmBlocks({
        plan: held.current,
        reviewed: reviewedKey,
        current: currentKey,
        now: Date.now(),
        // The in-flight claim is part of the guard, not of the caller's
        // snapshot: a confirm button must not look enabled mid-dispatch.
        inFlight: inFlight.current,
        ...extra,
      }),
    hold: (next) => {
      held.current = next;
      setPlan(next);
      setEpoch((value) => value + 1);
    },
    inFlight: () => inFlight.current,
    lastOutcome: () => outcome,
    epoch: () => epoch,
    begin: (extra) => {
      if (inFlight.current) return false;
      if (
        !canConfirm({
          plan: held.current,
          reviewed: reviewedKey,
          current: currentKey,
          now: Date.now(),
          ...extra,
        })
      )
        return false;
      inFlight.current = true;
      setClaim(true);
      setEpoch((value) => value + 1);
      return true;
    },
    settle: (next) => {
      inFlight.current = false;
      setClaim(false);
      if (!next) {
        setOutcome(undefined);
        setEpoch((value) => value + 1);
        return;
      }
      if (next.blocks.includes("expired")) {
        held.current = undefined;
        setPlan(undefined);
      }
      setOutcome(next);
      setEpoch((value) => value + 1);
    },
  };

  // Referenced so the state subscriptions (and the re-renders they cause) are
  // not dropped by the linter: `plan`/`claim`/`outcome` drive the confirm UI.
  void plan;
  void claim;
  void outcome;
  return guard;
}

/** Re-renders the caller when the reviewed token lifetime elapses. */
export function useTokenExpiry(
  expiresAt: number | undefined,
  onExpire: () => void,
) {
  const dispose = useRef(onExpire);
  dispose.current = onExpire;
  const remaining =
    expiresAt === undefined ? undefined : tokenRemainingMs(expiresAt);
  useEffect(() => {
    if (remaining === undefined) return;
    const timer = window.setTimeout(() => dispose.current(), remaining);
    return () => window.clearTimeout(timer);
  }, [remaining]);
}

export type { ConfirmBlock, ConfirmationPlan };
