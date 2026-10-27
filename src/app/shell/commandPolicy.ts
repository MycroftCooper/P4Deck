import type {
  LocalPathCapabilities,
  WorkspaceNode,
} from "../../shared/contracts/types";
import { compactTargets } from "../../features/files/selectionCommands";
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
  | { type: "pending"; id: number; count: number }
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
  const msg = (a: string, b: string) => (zh ? a : b);
  if (id === "cancel")
    return busy
      ? undefined
      : msg("没有正在执行的工具栏任务", "No toolbar operation running");
  if (busy)
    return msg(
      "请等待当前任务完成，或取消任务",
      "Wait for or cancel the current operation",
    );
  if (id === "refresh") return undefined;
  if (target.type === "history") {
    if (id === "diff")
      return historyDiffTarget(target)
        ? undefined
        : msg(
            "请选择两个历史版本（最多两条）",
            "Select two historical revisions (maximum two)",
          );
    return msg(
      "此操作不适用于历史版本",
      "This action is unavailable for historical revisions",
    );
  }
  if (id === "submit")
    return target.type === "pending" && target.id > 0 && target.count > 0
      ? undefined
      : msg(
          "请选择非空、已编号的待提交 CL（提交整个 CL）",
          "Select a nonempty numbered pending CL (submits the whole CL)",
        );
  if (target.type !== "file")
    return msg("请先选择文件或目录", "Select a file or folder first");
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
      return msg(
        "此操作需要仅选择一个目标",
        "Select a single target for this operation",
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
      : msg("目标路径尚未确定", "Target path is unknown");
  if (id === "lock" || id === "unlock") {
    if (node.kind !== "file")
      return msg(
        "锁操作仅支持显式文件，不递归目录",
        "Lock operations require explicit files and never recurse folders",
      );
    if (!node.absolutePath && !node.depotPath)
      return msg("目标路径尚未确定", "Target path is unknown");
    const capability =
      id === "lock" ? node.status?.canLock : node.status?.canUnlock;
    if (capability === false)
      return (
        node.status?.lockReason ??
        msg(
          "当前锁状态不支持此操作",
          "Current lock state does not allow this operation",
        )
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
      : msg(
          "文件必须先在当前工作区打开",
          "The file must be opened in the current workspace first",
        );
  }
  if (id === "reveal" || id === "openWith") {
    if (!native)
      return msg(
        "浏览器演示不支持系统操作，请在桌面应用中使用",
        "System actions require the desktop app, not the browser demo",
      );
    if (id === "openWith" && node.kind === "directory")
      return msg(
        "其他软件打开仅支持文件；目录请使用系统中定位",
        "Open with requires a file; use Reveal for folders",
      );
    if (localCapabilities === null)
      return msg("正在检查本地路径", "Checking local path");
    const available = localCapabilities ? localCapabilities[id] : local;
    return available
      ? undefined
      : msg(
          "目标不在当前工作区内或本地不存在，请先获取文件",
          "Target is outside the workspace or missing locally; get the file first",
        );
  }
  if (node.kind === "directory") {
    if (!node.absolutePath && !node.depotPath)
      return msg("目录路径尚未确定", "Folder path is not known yet");
    if (
      ["getLatest", "getRevision", "checkout", "delete", "revert"].includes(id)
    )
      return undefined;
    if (id === "add")
      return local
        ? undefined
        : msg(
            "添加目录需要本地目录",
            "Adding a folder requires a local directory",
          );
    return msg(
      "此查看工具仅支持单文件；目录操作作用于子文件",
      "This viewer requires a file; folder operations affect descendants",
    );
  }
  if (id === "preview")
    return local
      ? undefined
      : msg(
          "预览需要本地文件，请先获取最新版本",
          "Preview needs a local file; get latest first",
        );
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
    getLatest: ["controlled", "outOfDate", "missing"],
    getRevision: ["controlled", "outOfDate", "missing"],
    checkout: ["controlled", "outOfDate"],
    add: ["untracked"],
    delete: ["controlled", "outOfDate", "openedEdit"],
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
    diff: ["controlled", "outOfDate", "openedEdit", "conflicted"],
    history: [
      "controlled",
      "outOfDate",
      "openedEdit",
      "openedDelete",
      "conflicted",
      "missing",
    ],
    revgraph: [
      "controlled",
      "outOfDate",
      "openedEdit",
      "openedDelete",
      "conflicted",
      "missing",
    ],
  };
  if (
    allowed[id]?.includes(node.state) &&
    (node.absolutePath || node.depotPath)
  )
    return undefined;
  return msg(
    "当前文件状态不支持此操作",
    "Unavailable for the current file state",
  );
}
