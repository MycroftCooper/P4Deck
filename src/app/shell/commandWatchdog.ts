import type { CommandId } from "./commandPolicy";
import type { OperationKind } from "./useOperationWatchdog";

/**
 * Toolbar commands cover several host families. Before R9 every mutating
 * command was watched as "sync" (660 s) while the host actually bounded it at
 * 300 s, so a hung call could hold the toolbar for twice its server-side limit.
 * This table is the single place where a command names its family, and the
 * widths come from `src/shared/operationBounds.generated.ts`, which is generated
 * from the runner's own table.
 *
 * A command may still pick a shorter family (Get Latest uses the raw `sync`
 * bound); the backend command it dispatches must never be allowed a longer
 * limit than the watchdog waits for, and the watchdog must never give up on a
 * command the host is still allowed to finish.
 */
type CommandFamily = OperationKind | "revert";

const COMMAND_FAMILY: Partial<Record<CommandId, CommandFamily>> = {
  getLatest: "getLatest",
  getRevision: "getRevision",
  refresh: "refresh",
  // Single mutating workspace commands: the host runs them under the widest
  // interactive family, so the watchdog has to wait at least that long.
  checkout: "other",
  add: "other",
  delete: "other",
  revert: "revert",
  revertUnchanged: "revert",
  lock: "other",
  unlock: "other",
};

/** The mutating workspace family, which outlives the generic "other" one. */
const MUTATING_FAMILY: OperationKind = "other";

export function commandFamily(id: CommandId): OperationKind {
  const family = COMMAND_FAMILY[id];
  // Revert runs through the durable revert task, which executes one P4
  // `sync`/`revert` file action per batch under the generic file action lane.
  return family === undefined || family === "revert" ? MUTATING_FAMILY : family;
}
