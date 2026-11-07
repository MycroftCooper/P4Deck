import type {
  BranchMutationFailureCode,
  FileLockFailureCode,
  RenameMoveFailureCode,
  StreamSwitchFailureCode,
  SubmitFailureCode,
  SyncFailureCode,
  WorkflowFailureCode,
} from "../contracts";

/**
 * The ONE typed mapping for guarded-write rejections ("B2/B3").
 *
 * Every guarded UI write (sync, submit, shelf/unshelve, resolve, rename/move,
 * stream switch, file lock, branch mapping, workspace/profile mutation) gets a
 * structured failure code back from the host. The wire unions differ per
 * operation, but the *client-side meaning* is the same on all of them:
 *
 *  - identity/authority of the one-use confirmation: tokenUnknown, tokenExpired,
 *    targetMismatch;
 *  - the reviewed facts went stale: preflightChanged / changeChanged /
 *    contentChanged / sourceChanged / targetChanged / stateChanged / previewChanged;
 *  - the runtime context moved: contextChanged;
 *  - the server refused at execute time: preflightBlocked;
 *  - an explicit acknowledgement was not supplied: *AcknowledgementRequired.
 *
 * Dialogs must branch on {@link ConfirmationRejectionKind} (or on this module's
 * predicates) instead of re-testing raw strings; raw code strings stay display
 * data only. Never treat an unknown code as success or as "nothing happened".
 */
export type ConfirmationRejectionKind =
  | "tokenUnknown"
  | "tokenExpired"
  | "targetMismatch"
  | "contextChanged"
  | "stale"
  | "preflightBlocked"
  | "acknowledgementRequired"
  | "commandFailure"
  | "cancelled"
  | "uncertainOutcome";

/** Raw failure code strings emitted by any guarded-write host result. */
export type GuardedWriteFailureCode =
  | BranchMutationFailureCode
  | FileLockFailureCode
  | RenameMoveFailureCode
  | StreamSwitchFailureCode
  | SubmitFailureCode
  | SyncFailureCode
  | WorkflowFailureCode;

const RAW_CODES: Readonly<Record<string, ConfirmationRejectionKind>> = {
  tokenUnknown: "tokenUnknown",
  tokenExpired: "tokenExpired",
  targetMismatch: "targetMismatch",
  contextChanged: "contextChanged",
  // Reviewed facts changed between preflight and confirm.
  preflightChanged: "stale",
  previewChanged: "stale",
  changeChanged: "stale",
  contentChanged: "stale",
  sourceChanged: "stale",
  targetChanged: "stale",
  stateChanged: "stale",
  preflightBlocked: "preflightBlocked",
  acknowledgementRequired: "acknowledgementRequired",
  forceAcknowledgementRequired: "acknowledgementRequired",
  warningAcknowledgementRequired: "acknowledgementRequired",
  dangerousConfirmationRequired: "acknowledgementRequired",
  commandFailure: "commandFailure",
  cancelled: "cancelled",
  uncertainOutcome: "uncertainOutcome",
};

/** Codes whose meaning is always "the one-use token can no longer be used". */
const TOKEN_KINDS: ReadonlySet<ConfirmationRejectionKind> = new Set([
  "tokenUnknown",
  "tokenExpired",
]);

/** Codes that mean "the client must preflight again before any retry". */
const REPREVIEW_KINDS: ReadonlySet<ConfirmationRejectionKind> = new Set([
  "tokenUnknown",
  "tokenExpired",
  "targetMismatch",
  "contextChanged",
  "stale",
  "preflightBlocked",
  "acknowledgementRequired",
]);

/** Codes that may have applied a write; never offered as a silent retry. */
const UNCERTAIN_KINDS: ReadonlySet<ConfirmationRejectionKind> = new Set([
  "uncertainOutcome",
]);

const hasOwn = (value: Record<string, unknown>, key: string) =>
  Object.prototype.hasOwnProperty.call(value, key);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Maps one raw failure code to its shared kind. Unknown/absent codes map to
 * `undefined`: callers keep their own copy for it instead of inventing either
 * success or certainty.
 */
export function confirmationRejectionKind(
  failure: unknown,
): ConfirmationRejectionKind | undefined {
  if (typeof failure !== "string") return undefined;
  if (!hasOwn(RAW_CODES, failure)) return undefined;
  return RAW_CODES[failure];
}

/** Exact decoded failure code of any guarded-write result envelope. */
export function rejectionCodeOf(result: unknown): unknown {
  if (!isRecord(result)) return undefined;
  return result.failure;
}

/**
 * True when the result carries a failure code whose shared meaning is `kind`.
 * Never infers success: a missing/unknown code is simply "not this kind".
 */
export function hasRejection(result: unknown, kind: ConfirmationRejectionKind) {
  return confirmationRejectionKind(rejectionCodeOf(result)) === kind;
}

/** The token itself is unknown/consumed/expired: nothing was written. */
export function rejectionInvalidatesToken(result: unknown) {
  const kind = confirmationRejectionKind(rejectionCodeOf(result));
  return kind !== undefined && TOKEN_KINDS.has(kind);
}

/** Confirm again only after a fresh preflight (token, target or context moved). */
export function rejectionRequiresReview(result: unknown) {
  const kind = confirmationRejectionKind(rejectionCodeOf(result));
  return kind !== undefined && REPREVIEW_KINDS.has(kind);
}

/** The write may have reached the host; never present it as failed-and-unchanged. */
export function rejectionIsUncertain(result: unknown) {
  const kind = confirmationRejectionKind(rejectionCodeOf(result));
  return kind !== undefined && UNCERTAIN_KINDS.has(kind);
}
