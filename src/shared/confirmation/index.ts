/**
 * One client-side confirmation primitive for every guarded write.
 *
 * - `codes.ts`     the single typed mapping of host failure codes to meaning
 * - `guards.ts`    the pure state machine: ready + live token + no drift + no double click
 * - `useConfirmationGuard.ts`  the React binding that holds one reviewed plan
 * - `presets.ts`   the per-operation guard recipes (which acknowledgement, which copy)
 */
export {
  confirmationRejectionKind,
  hasRejection,
  rejectionCodeOf,
  rejectionInvalidatesToken,
  rejectionIsUncertain,
  rejectionRequiresReview,
} from "./codes";
export type {
  ConfirmationRejectionKind,
  GuardedWriteFailureCode,
} from "./codes";
export {
  canConfirm,
  confirmBlocks,
  isLiveToken,
  tokenRemainingMs,
} from "./guards";
export type { ConfirmBlock, ConfirmationPlan } from "./guards";
export { acknowledgementRequired, guardPreset } from "./presets";
export type {
  GuardAcknowledgement,
  GuardedWriteOperation,
  GuardPreset,
} from "./presets";
export { useConfirmationGuard, useTokenExpiry } from "./useConfirmationGuard";
export type {
  ConfirmExtras,
  ConfirmationGuard,
  ConfirmationOutcome,
} from "./useConfirmationGuard";
