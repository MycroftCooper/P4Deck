import type { CommandId } from "../shell/commandPolicy";
import {
  ALL_DATA_DOMAINS,
  type DataDomain,
} from "../../shared/cache/dataEffects";

/**
 * How an action interacts with the UI. See
 * ForAIDoc/Coder/数据缓存与操作架构.md for the rules behind each mode.
 * - background: starts at once, reports in Operations, refreshes on completion
 * - confirm: a dialog checks fresh server state, then the write runs
 * - barrier: replaces the connection/workspace every view is bound to
 * - view: opens a page or the OS; no P4 write
 */
export type ActionMode = "background" | "confirm" | "barrier" | "view";

export interface ActionSpec {
  mode: ActionMode;
  /** Cached data made out of date when the action finishes or fails. */
  effects: readonly DataDomain[];
}

const fileState: readonly DataDomain[] = [
  "pending",
  "workspaceStatus",
  "depot",
];

/** Toolbar, context-menu and command-palette actions. */
export const commandActions = {
  refresh: { mode: "background", effects: ALL_DATA_DOMAINS },
  getLatest: { mode: "confirm", effects: fileState },
  getRevision: { mode: "confirm", effects: fileState },
  rename: { mode: "confirm", effects: fileState },
  lock: { mode: "confirm", effects: fileState },
  unlock: { mode: "confirm", effects: fileState },
  resolve: { mode: "confirm", effects: fileState },
  moveFiles: { mode: "background", effects: ["pending"] },
  shelve: { mode: "confirm", effects: ["pending"] },
  submit: {
    mode: "confirm",
    effects: [...fileState, "submitted"],
  },
  checkout: { mode: "background", effects: fileState },
  add: { mode: "background", effects: fileState },
  delete: { mode: "background", effects: fileState },
  revert: { mode: "background", effects: fileState },
  revertUnchanged: { mode: "background", effects: fileState },
  diff: { mode: "view", effects: [] },
  history: { mode: "view", effects: [] },
  revgraph: { mode: "view", effects: [] },
  preview: { mode: "view", effects: [] },
  reveal: { mode: "view", effects: ["localCapabilities"] },
  openWith: { mode: "view", effects: ["localCapabilities"] },
  cancel: { mode: "background", effects: [] },
} as const satisfies Record<CommandId, ActionSpec>;

/** Actions started from Pending, Submitted, Streams and Branch Mappings. */
export const pageActions = {
  createChange: { mode: "background", effects: ["pending"] },
  editChange: { mode: "background", effects: ["pending"] },
  deleteChange: { mode: "background", effects: ["pending"] },
  unshelve: { mode: "confirm", effects: fileState },
  deleteShelf: { mode: "confirm", effects: ["pending"] },
  editSubmitted: { mode: "background", effects: ["submitted"] },
  branchMapping: { mode: "confirm", effects: ["branchMappings"] },
  switchStream: { mode: "barrier", effects: ALL_DATA_DOMAINS },
  switchWorkspace: { mode: "barrier", effects: ALL_DATA_DOMAINS },
  connection: { mode: "barrier", effects: ALL_DATA_DOMAINS },
} as const satisfies Record<string, ActionSpec>;
