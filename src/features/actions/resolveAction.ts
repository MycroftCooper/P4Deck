import { isCopyCommandLabel } from "../../app/context-menu/copyMenu";
import type { CommandId } from "../../app/shell/commandPolicy";
import { fileMenuCommands } from "../../app/context-menu/fileMenuCommands";
import type { FileAction, WorkspaceNode } from "../../shared/contracts";
import { selectionRequest } from "../files/selectionCommands";
import type { CanonicalAction } from "./registry";
export type ActionResolution =
  | { kind: CanonicalAction; route: "current" | "selectedMove" | "legacyOnly" }
  | { boundary: "read" | "platform" };
const current = (kind: CanonicalAction): ActionResolution => ({
  kind,
  route: "current",
});
const read: ActionResolution = { boundary: "read" },
  platform: ActionResolution = { boundary: "platform" };
/** Exhaustive against the real IPC discriminant, including host-only variants. */
export const fileActionRegistry = {
  refresh: read,
  getLatest: current("sync-revision"),
  getRevision: current("sync-revision"),
  removeFromWorkspace: current("remove-workspace"),
  deleteLocal: current("deleteLocal"),
  checkout: current("checkout"),
  checkoutAndOpen: current("checkoutAndOpen"),
  add: current("add"),
  addRecursive: current("add-recursive"),
  delete: current("delete-generic"),
  markForDelete: current("delete"),
  revert: current("revert"),
  revertUnchanged: current("revertUnchanged"),
  moveToChangelist: { kind: "legacy-unused-cl-and-move", route: "legacyOnly" },
  resolve: current("resolve"),
  reconcile: current("reconcile"),
  shelve: current("shelve"),
  changeFiletype: current("changeFiletype"),
  lock: current("file-lock-unlock"),
  unlock: current("file-lock-unlock"),
  integrate: current("integrate"),
  copy: current("copy"),
  branch: current("branch"),
  undo: current("undo-change"),
  clean: current("clean"),
  tagWithLabel: current("tagWithLabel"),
  diff: read,
  history: read,
  revisionGraph: read,
} satisfies Record<FileAction, ActionResolution>;
export const commandActions = {
  refresh: read,
  getLatest: current("sync-revision"),
  getRevision: current("sync-revision"),
  rename: current("rename-move-path"),
  lock: current("file-lock-unlock"),
  unlock: current("file-lock-unlock"),
  resolve: current("resolve"),
  moveFiles: { kind: "move-files", route: "selectedMove" },
  shelve: current("shelve"),
  submit: current("submit-native"),
  checkout: current("checkout"),
  add: current("add"),
  delete: current("delete"),
  revert: current("revert"),
  revertUnchanged: current("revertUnchanged"),
  diff: read,
  history: read,
  revgraph: read,
  preview: read,
  reveal: platform,
  openWith: platform,
  cancel: current("cancel-operation"),
} satisfies Record<CommandId, ActionResolution>;
export function resolveCommand(
  id: CommandId,
  options: { nodes?: WorkspaceNode[]; customSubmitConfigured?: boolean } = {},
): ActionResolution {
  if (id === "submit")
    return current(
      options.customSubmitConfigured ? "submit-custom" : "submit-native",
    );
  if (id === "add" && options.nodes?.length)
    return fileActionRegistry[selectionRequest("add", options.nodes).action];
  return commandActions[id];
}
/** Caller supplies the actual executable binding; labels alone never enable catalog placeholders. */
export function resolveFileMenu(
  label: string,
  executable: boolean,
  options: Parameters<typeof resolveCommand>[1] = {},
): ActionResolution | undefined {
  if (!executable) return undefined;
  if (isCopyCommandLabel(label)) return platform;
  const command = fileMenuCommands[label];
  return command ? resolveCommand(command, options) : undefined;
}
export function resolveSelectionAction(
  ...args: Parameters<typeof selectionRequest>
) {
  const request = selectionRequest(...args);
  return { request, action: fileActionRegistry[request.action] };
}
