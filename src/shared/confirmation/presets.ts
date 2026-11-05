/**
 * Per-operation recipes for the shared confirmation primitive.
 *
 * Each guarded write keeps its own review surface (what it shows, which
 * acknowledgement it needs), but the *gates* are declared once here so no
 * dialog re-invents "is this token still spendable".
 */

/** Every guarded write that uses the shared confirmation primitive. */
export type GuardedWriteOperation =
  | "sync"
  | "submit"
  | "shelf"
  | "unshelve"
  | "resolve"
  | "renameMove"
  | "streamSwitch"
  | "fileLock"
  | "branchMapping"
  | "workspaceMutation"
  | "profileCreate";

/** Why a recipe asks for an extra explicit acknowledgement before confirm. */
export type GuardAcknowledgement =
  | "none"
  /** Force re-sync / risky preview warnings. */
  | "force"
  /** Stream switch warnings that may change workspace files. */
  | "warnings"
  /** Irreversible server-side delete of a spec/mapping/workspace. */
  | "destructiveDelete"
  /** Whole-CL submit: every file in the CL is part of the scope. */
  | "wholeChangeList";

/**
 * Locale key of the copy shown when the reviewed token can no longer be spent.
 * One key per operation keeps today's exact wording; the shared guard only
 * decides *when* it is shown, never what it says.
 */
export interface GuardPreset {
  operation: GuardedWriteOperation;
  acknowledgement: GuardAcknowledgement;
  /** Copy when the token expired (or became unusable) after review. */
  expiredMessageKey: string;
  /** Copy when the connection/target changed under the dialog. */
  driftMessageKey?: string;
}

export const GUARD_PRESETS: Readonly<
  Record<GuardedWriteOperation, GuardPreset>
> = {
  sync: {
    operation: "sync",
    acknowledgement: "force",
    expiredMessageKey: "files.the.preview.expired.request.a.fresh",
  },
  submit: {
    operation: "submit",
    acknowledgement: "wholeChangeList",
    expiredMessageKey: "pending.preflight.expired.check.again",
    driftMessageKey:
      "pending.connection.identity.changed.nothing.was.submitted",
  },
  shelf: {
    operation: "shelf",
    acknowledgement: "none",
    expiredMessageKey: "files.the.preview.expired.request.a.fresh",
    driftMessageKey: "pending.connection.changed.close.and.reopen.previous",
  },
  unshelve: {
    operation: "unshelve",
    acknowledgement: "none",
    expiredMessageKey: "files.the.preview.expired.request.a.fresh",
    driftMessageKey: "pending.connection.changed.close.and.reopen.previous",
  },
  resolve: {
    operation: "resolve",
    acknowledgement: "none",
    expiredMessageKey: "files.the.preview.expired.request.a.fresh",
    driftMessageKey: "pending.connection.changed.close.and.reopen.previous",
  },
  renameMove: {
    operation: "renameMove",
    acknowledgement: "none",
    expiredMessageKey: "files.preview.target.differs.or.expired",
  },
  streamSwitch: {
    operation: "streamSwitch",
    acknowledgement: "warnings",
    expiredMessageKey: "browse.the.preflight.expired.inspect.the.current",
    driftMessageKey: "browse.connection.identity.changed.no.stream.switch",
  },
  fileLock: {
    operation: "fileLock",
    acknowledgement: "none",
    expiredMessageKey: "files.the.preview.expired.request.a.fresh",
  },
  branchMapping: {
    operation: "branchMapping",
    acknowledgement: "destructiveDelete",
    expiredMessageKey: "browse.the.preflight.expired.inspect.the.branch",
    driftMessageKey: "browse.connection.identity.changed.no.branch.mapping",
  },
  workspaceMutation: {
    operation: "workspaceMutation",
    acknowledgement: "destructiveDelete",
    expiredMessageKey: "files.the.preview.expired.request.a.fresh",
    driftMessageKey:
      "workspaces.connection.generation.changed.no.workspace.mutation",
  },
  profileCreate: {
    operation: "profileCreate",
    acknowledgement: "none",
    expiredMessageKey: "settings.the.preflight.expired.run.it.again",
    driftMessageKey:
      "settings.connection.generation.changed.nothing.was.created",
  },
};

/** Preset for one operation; total by construction. */
export function guardPreset(operation: GuardedWriteOperation): GuardPreset {
  return GUARD_PRESETS[operation];
}

/**
 * Whether this attempt needs the operation's explicit acknowledgement.
 * Never derived from translated copy: only from the reviewed plan/inputs.
 */
export function acknowledgementRequired(
  preset: GuardPreset,
  state: {
    force?: boolean;
    warnings?: number;
    destructive?: boolean;
  },
): boolean {
  switch (preset.acknowledgement) {
    case "none":
      return false;
    case "force":
      return state.force === true;
    case "warnings":
      return (state.warnings ?? 0) > 0;
    case "destructiveDelete":
      return state.destructive === true;
    case "wholeChangeList":
      return true;
  }
}
