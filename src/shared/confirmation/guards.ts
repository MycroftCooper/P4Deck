/**
 * Client-side confirmation state machine shared by every guarded write.
 *
 * The reviewed server facts are described by {@link ConfirmationPlan}; this
 * module owns the rules that decide whether the one-use token may still be
 * spent. It is pure: no React, no IPC and no hidden clock — every entry point
 * takes `now` explicitly (defaulting only for convenience).
 *
 * Guarantees (never weakened by callers):
 *  - confirm is only allowed for a `ready` plan that carries a non-empty token;
 *  - an unexpired token is required: `expiresAt` must be a finite timestamp;
 *    a non-finite expiry makes the plan unusable rather than "never expires";
 *  - an outstanding acknowledgement requirement blocks confirm;
 *  - target drift and context drift block confirm.
 */
export interface ConfirmationPlan {
  ready: boolean;
  token?: string | null;
  expiresAt: number;
}

/** A guard reason. Presentation decides how (or whether) to show it. */
export type ConfirmBlock =
  | "notReady"
  | "missingToken"
  | "missingExpiry"
  | "expired"
  | "acknowledgementRequired"
  | "stale"
  | "inFlight";

/** Guard input; `undefined` means "not reviewed yet". */
export interface ConfirmGuardInput {
  plan: ConfirmationPlan | undefined;
  /** The owned connection key the plan was preflighted for. */
  reviewed?: string | null;
  /** The current connection key. */
  current?: string | null;
  /** Additional target drift (e.g. a form field bound to the plan). */
  drift?: boolean;
  /** A required explicit acknowledgement is missing. */
  missingAcknowledgement?: boolean;
  /** A request for this dialog is already in flight. */
  inFlight?: boolean;
  now?: number;
}

/**
 * Every reason the reviewed token cannot be spent, in evaluation order.
 * An empty result means confirm may dispatch. Never returns success for an
 * absent plan: without a reviewed plan there is no token to spend.
 */
export function confirmBlocks(input: ConfirmGuardInput): ConfirmBlock[] {
  const blocks: ConfirmBlock[] = [];
  const { plan } = input;
  if (!plan?.ready) blocks.push("notReady");
  if (!plan?.token) blocks.push("missingToken");
  if (plan && !Number.isFinite(plan.expiresAt)) blocks.push("missingExpiry");
  else if (plan && plan.expiresAt <= (input.now ?? Date.now()))
    blocks.push("expired");
  if (input.missingAcknowledgement) blocks.push("acknowledgementRequired");
  if (
    input.reviewed != null &&
    input.current != null &&
    input.reviewed !== input.current
  )
    blocks.push("stale");
  if (input.drift) blocks.push("stale");
  if (input.inFlight) blocks.push("inFlight");
  return blocks;
}

/** True only when nothing blocks the token from being spent. */
export function canConfirm(input: ConfirmGuardInput) {
  return confirmBlocks(input).length === 0;
}

/** Remaining lifetime of a reviewed token, clamped to the setTimeout range. */
export function tokenRemainingMs(
  expiresAt: number,
  now = Date.now(),
): number | undefined {
  if (!Number.isFinite(expiresAt)) return undefined;
  return Math.min(2147483647, Math.max(0, expiresAt - now));
}

/** True for a real, still-live, one-use token. */
export function isLiveToken(
  plan: ConfirmationPlan | undefined,
  now = Date.now(),
) {
  return (
    !!plan?.token && Number.isFinite(plan.expiresAt) && plan.expiresAt > now
  );
}
