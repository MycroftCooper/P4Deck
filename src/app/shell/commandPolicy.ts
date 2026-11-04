import type {
  LocalPathCapabilities,
  WorkspaceNode,
} from "../../shared/contracts";
import { tFor } from "../../shared/i18n";
import { compactTargets } from "../../features/files/selectionCommands";
import { nodeNeedsSync } from "../../features/files/fileActions";
import { nodeKey } from "../../features/files/selection";
export type CommandId =
  | "refresh"
  | "getLatest"
  | "getRevision"
  | "rename"
  | "lock"
  | "unlock"
  | "resolve"
  | "moveFiles"
  | "shelve"
  | "submit"
  | "checkout"
  | "add"
  | "delete"
  | "revert"
  | "revertUnchanged"
  | "diff"
  | "history"
  | "revgraph"
  | "preview"
  | "reveal"
  | "openWith"
  | "cancel";
export type CommandTarget =
  | {
      type: "file";
      node: WorkspaceNode;
      nodes?: WorkspaceNode[];
      scopeLabel?: string;
      /** Set only when the snapshot is the complete file set of this CL. */
      wholeChangelistId?: number;
    }
  | {
      type: "pending";
      id: number;
      count: number;
      selectedSubmitExpectation?: import("../../features/changelists/selectedSubmit").SelectedSubmitExpectation;
    }
  | { type: "submitted"; id: number }
  | { type: "history"; path: string; revisions: number[] }
  | { type: "none" };
/** Explicit revision operands for the toolbar; never reinterpret them as workspace files. */
export function historyDiffTarget(target: CommandTarget) {
  if (
    target.type !== "history" ||
    !target.path ||
    target.revisions.length !== 2 ||
    new Set(target.revisions).size !== 2 ||
    !target.revisions.every(
      (revision) => Number.isSafeInteger(revision) && revision > 0,
    )
  )
    return undefined;
  const [left, right] = [...target.revisions].sort((a, b) => a - b);
  return { path: target.path, left, right };
}
/** Identity for stale-response guards; derived from the explicit execution snapshot. */
export function commandTargetKey(target: CommandTarget): string {
  if (target.type === "history")
    return `history:${target.path}:${target.revisions.join(",")}`;
  return target.type === "file"
    ? `file:${(target.nodes ?? [target.node]).map(nodeKey).join("\n")}${
        target.wholeChangelistId === undefined
          ? ""
          : `\nwhole-changelist:${target.wholeChangelistId}`
      }`
    : target.type === "none"
      ? "none"
      : `${target.type}:${target.id}`;
}
export function commandReason(
  id: CommandId,
  target: CommandTarget,
  busy: boolean,
  native: boolean,
  zh: boolean,
  localCapabilities?: LocalPathCapabilities | null,
): string | undefined {
  if (id === "cancel")
    return busy
      ? undefined
      : tFor(zh ? "zh-CN" : "en-US", "shell.no.toolbar.operation.running");
  // Refresh is read-only bookkeeping; keep it usable during a mutation so a
  // long-running or stuck operation never locks the user out of refreshing.
  if (id === "refresh") return undefined;
  if (busy)
    return tFor(zh ? "zh-CN" : "en-US", "shell.wait.for.or.cancel.the.current");
  if (target.type === "history") {
    if (id === "diff")
      return historyDiffTarget(target)
        ? undefined
        : tFor(
            zh ? "zh-CN" : "en-US",
            "shell.select.two.historical.revisions.maximum.two",
          );
    return tFor(
      zh ? "zh-CN" : "en-US",
      "shell.this.action.is.unavailable.for.historical",
    );
  }
  if (id === "submit")
    return target.type === "pending" && target.id > 0 && target.count > 0
      ? undefined
      : tFor(
          zh ? "zh-CN" : "en-US",
          "shell.select.a.nonempty.numbered.pending.cl",
        );
  if (target.type !== "file")
    return tFor(zh ? "zh-CN" : "en-US", "shell.select.a.file.or.folder.first");
  const { node } = target;
  const nodes = target.nodes ?? [node];
  if (nodes.length > 1) {
    if (
      [
        "preview",
        "diff",
        "history",
        "revgraph",
        "reveal",
        "openWith",
        "rename",
      ].includes(id)
    )
      return tFor(
        zh ? "zh-CN" : "en-US",
        "shell.select.a.single.target.for.this",
      );
    for (const item of compactTargets(nodes)) {
      const reason = commandReason(
        id,
        { type: "file", node: item },
        false,
        native,
        zh,
      );
      if (reason) return `${item.name}: ${reason}`;
    }
    return undefined;
  }
  const local =
    !!node.absolutePath && !["missing", "openedDelete"].includes(node.state);
  if (id === "rename")
    return node.absolutePath || node.depotPath
      ? undefined
      : tFor(zh ? "zh-CN" : "en-US", "shell.target.path.is.unknown");
  if (id === "lock" || id === "unlock") {
    if (node.kind !== "file")
      return tFor(
        zh ? "zh-CN" : "en-US",
        "shell.lock.operations.require.explicit.files.and",
      );
    if (!node.absolutePath && !node.depotPath)
      return tFor(zh ? "zh-CN" : "en-US", "shell.target.path.is.unknown");
    const capability =
      id === "lock" ? node.status?.canLock : node.status?.canUnlock;
    if (capability === false)
      return (
        node.status?.lockReason ??
        tFor(zh ? "zh-CN" : "en-US", "shell.current.lock.state.does.not.allow")
      );
    return [
      "openedEdit",
      "openedAdd",
      "openedDelete",
      "openedMoveAdd",
      "openedMoveDelete",
      "conflicted",
    ].includes(node.state)
      ? undefined
      : tFor(zh ? "zh-CN" : "en-US", "shell.the.file.must.be.opened.in");
  }
  if (id === "reveal" || id === "openWith") {
    if (!native)
      return tFor(
        zh ? "zh-CN" : "en-US",
        "shell.system.actions.require.the.desktop.app",
      );
    if (id === "openWith" && node.kind === "directory")
      return tFor(
        zh ? "zh-CN" : "en-US",
        "shell.open.with.requires.a.file.use",
      );
    if (localCapabilities === null)
      return tFor(zh ? "zh-CN" : "en-US", "shell.checking.local.path");
    const available = localCapabilities ? localCapabilities[id] : local;
    return available
      ? undefined
      : tFor(
          zh ? "zh-CN" : "en-US",
          "shell.target.is.outside.the.workspace.or",
        );
  }
  if (node.kind === "directory") {
    if (!node.absolutePath && !node.depotPath)
      return tFor(zh ? "zh-CN" : "en-US", "shell.folder.path.is.not.known.yet");
    if (
      ["getLatest", "getRevision", "checkout", "delete", "revert"].includes(id)
    )
      return undefined;
    if (id === "add")
      return local
        ? undefined
        : tFor(
            zh ? "zh-CN" : "en-US",
            "shell.adding.a.folder.requires.a.local",
          );
    return tFor(
      zh ? "zh-CN" : "en-US",
      "shell.this.viewer.requires.a.file.folder",
    );
  }
  if (id === "preview")
    return local
      ? undefined
      : tFor(zh ? "zh-CN" : "en-US", "shell.preview.needs.a.local.file.get");
  const allowed: Record<string, string[]> = {
    moveFiles: ["openedEdit", "openedAdd", "openedDelete", "conflicted"],
    shelve: ["openedEdit", "openedAdd", "openedDelete", "conflicted"],
    resolve: [
      "controlled",
      "outOfDate",
      "openedEdit",
      "openedAdd",
      "conflicted",
      "missing",
    ],
    getLatest: ["controlled", "outOfDate", "missing", "openedEdit"],
    getRevision: ["controlled", "outOfDate", "missing", "openedEdit"],
    // Local edits without checkout can still be checked out, compared, browsed.
    checkout: ["controlled", "outOfDate", "modified"],
    add: ["untracked"],
    delete: ["controlled", "outOfDate", "openedEdit", "untracked", "ignored"],
    revert: [
      "openedEdit",
      "openedAdd",
      "openedDelete",
      "openedMoveAdd",
      "openedMoveDelete",
      "conflicted",
    ],
    revertUnchanged: [
      "openedEdit",
      "openedAdd",
      "openedDelete",
      "openedMoveAdd",
      "openedMoveDelete",
      "conflicted",
    ],
    diff: ["controlled", "outOfDate", "openedEdit", "conflicted", "modified"],
    history: [
      "controlled",
      "outOfDate",
      "openedEdit",
      "openedDelete",
      "conflicted",
      "missing",
      "modified",
      "notSynced",
    ],
    revgraph: [
      "controlled",
      "outOfDate",
      "openedEdit",
      "openedDelete",
      "conflicted",
      "missing",
      "modified",
      "notSynced",
    ],
  };
  if ((id === "getLatest" || id === "getRevision") && node.state === "modified")
    return tFor(
      zh ? "zh-CN" : "en-US",
      "shell.local.un.checked.out.edits.exist",
    );
  if (
    (id === "getLatest" || id === "getRevision") &&
    (node.absolutePath || node.depotPath) &&
    nodeNeedsSync(node)
  )
    return undefined;
  if (
    allowed[id]?.includes(node.state) &&
    (node.absolutePath || node.depotPath)
  )
    return undefined;
  if (node.state === "unknown" || node.state === "loading")
    return tFor(
      zh ? "zh-CN" : "en-US",
      "shell.file.status.unknown.refresh.to.re",
    );
  return tFor(
    zh ? "zh-CN" : "en-US",
    "shell.unavailable.for.the.current.file.state",
  );
}
