import type { FileState, WorkspaceFileStatus } from "../../shared/contracts";

export type FileBadgeId =
  | "add"
  | "edit"
  | "delete"
  | "move/add"
  | "move/delete"
  | "branch"
  | "integrate"
  | "latest"
  | "outOfDate"
  | "notSynced"
  | "missing"
  | "untracked"
  | "ignored"
  | "resolve"
  | "modified"
  | "locked"
  | "globalLock"
  | "exclusive"
  | "unmapped"
  | "depotDeleted"
  | "shelf"
  | "imported"
  | "ditto"
  | "placeholder"
  | "symlink"
  | "unknown"
  | "stale"
  | "error"
  | "loading";
export type FileBadgeOwner = "self" | "other" | "shelf";
/** UI-10 semantic tone. Backgrounds follow this map only; ownership never repaints a status. */
export type FileBadgeTone =
  "success" | "danger" | "warning" | "amber" | "neutral" | "purple" | "teal";
const badgeTones: Record<FileBadgeId, FileBadgeTone> = {
  add: "success",
  edit: "success",
  delete: "danger",
  "move/add": "success",
  "move/delete": "danger",
  branch: "success",
  integrate: "amber",
  latest: "teal",
  outOfDate: "amber",
  notSynced: "amber",
  missing: "neutral",
  untracked: "neutral",
  ignored: "neutral",
  resolve: "danger",
  modified: "amber",
  locked: "warning",
  globalLock: "warning",
  exclusive: "warning",
  unmapped: "neutral",
  depotDeleted: "danger",
  shelf: "purple",
  imported: "neutral",
  ditto: "neutral",
  placeholder: "neutral",
  symlink: "purple",
  unknown: "neutral",
  stale: "neutral",
  error: "danger",
  loading: "neutral",
};
export const fileBadgeTone = (id: FileBadgeId): FileBadgeTone => badgeTones[id];
export interface FileBadge {
  id: FileBadgeId;
  owner?: FileBadgeOwner;
  detail?: string;
}
/** Presentation facts only. Absence is unknown, never an assertion of a clean file. */
export interface FileDecorationFacts {
  state?: FileState;
  revision?: number;
  headRevision?: number;
  headAction?: string;
  action?: string;
  scope?: "workspace" | "depot" | "shelf" | "revision";
  badges?: readonly FileBadge[];
  status?: WorkspaceFileStatus;
}
const labels: Record<FileBadgeId, [string, string, string]> = {
  add: ["待添加", "Open for add", "+"],
  edit: ["已签出编辑", "Open for edit", "✓"],
  delete: ["待删除", "Open for delete", "×"],
  "move/add": ["移动目标", "Move target", "↗"],
  "move/delete": ["移动源", "Move source", "↙"],
  branch: ["待分支", "Open for branch", "⑂"],
  integrate: ["待集成", "Open for integrate", "⇄"],
  latest: ["已同步到最新修订", "Synced to head", "●"],
  outOfDate: ["版本落后", "Older revision", "↓"],
  notSynced: ["未同步到本地", "Not synced", "↓"],
  missing: ["本地文件缺失", "Local file missing", "?"],
  untracked: ["未跟踪", "Untracked", "?"],
  ignored: ["已忽略", "Ignored", "−"],
  resolve: ["需要 Resolve", "Needs resolve", "!"],
  modified: ["本地内容已修改", "Locally modified", "●"],
  locked: ["已锁定", "Locked", "L"],
  globalLock: ["全局锁定", "Globally locked", "L"],
  exclusive: ["独占签出", "Exclusive checkout", "L"],
  unmapped: ["未映射到当前工作区", "Not mapped", "∅"],
  depotDeleted: ["Depot 中已删除", "Deleted in depot", "×"],
  shelf: ["搁置副本", "Shelved copy", "S"],
  imported: ["流导入／父流共享", "Imported / shared from parent stream", "↘"],
  ditto: ["映射到多个目录", "Ditto mapped", "≡"],
  placeholder: ["占位文件，内容未下载", "Metadata-only placeholder", "⋯"],
  symlink: ["符号链接", "Symbolic link", "↗"],
  unknown: ["状态未知", "Status unknown", "?"],
  stale: ["状态缓存已过期", "Stale status", "◷"],
  error: ["状态查询失败", "Status query failed", "!"],
  loading: ["正在查询状态", "Loading status", "⋯"],
};
const actions = new Set([
  "add",
  "edit",
  "delete",
  "move/add",
  "move/delete",
  "branch",
  "integrate",
]);
const stateBadges: Partial<Record<FileState, FileBadgeId>> = {
  openedAdd: "add",
  openedEdit: "edit",
  openedDelete: "delete",
  openedMoveAdd: "move/add",
  openedMoveDelete: "move/delete",
  modified: "modified",
  outOfDate: "outOfDate",
  notSynced: "notSynced",
  conflicted: "resolve",
  missing: "missing",
  untracked: "untracked",
  ignored: "ignored",
};
export function fileBadges(facts: FileDecorationFacts): FileBadge[] {
  if (facts.state === "loading") return [{ id: "loading" }];
  const badges: FileBadge[] = [...(facts.badges ?? [])];
  const scope = facts.scope ?? "workspace";
  const status = facts.status;
  if (scope === "shelf") badges.push({ id: "shelf" });
  if (
    scope === "depot" &&
    ["delete", "move/delete"].includes(facts.headAction ?? "")
  )
    badges.push({ id: "depotDeleted" });
  if (scope === "workspace" || scope === "shelf") {
    const statusAction = status?.openedAction?.replace(
      /^move([A-Z])/,
      (_, letter: string) => `move/${letter.toLowerCase()}`,
    );
    const action = actions.has(facts.action ?? statusAction ?? "")
      ? ((facts.action ?? statusAction) as FileBadgeId)
      : undefined;
    const effectiveState = status?.primary ?? facts.state;
    const state = effectiveState && stateBadges[effectiveState];
    if (action)
      badges.push({ id: action, owner: scope === "shelf" ? "shelf" : "self" });
    if (
      state &&
      (!action || !actions.has(state)) &&
      (scope !== "shelf" || actions.has(state))
    )
      badges.push({
        id: state,
        owner: actions.has(state)
          ? scope === "shelf"
            ? "shelf"
            : "self"
          : undefined,
        detail:
          state === "ignored" && status?.ignore
            ? `${status.ignore.rule} · ${status.ignore.source}${status.ignore.line ? `:${status.ignore.line}` : ""}`
            : undefined,
      });
    if (
      scope === "workspace" &&
      facts.revision !== undefined &&
      facts.headRevision !== undefined &&
      facts.headRevision > 0 &&
      !["untracked", "ignored", "openedAdd", "missing"].includes(
        effectiveState ?? "",
      )
    ) {
      badges.push({
        id:
          facts.revision === 0
            ? "notSynced"
            : facts.revision < facts.headRevision
              ? "outOfDate"
              : facts.revision === facts.headRevision
                ? "latest"
                : "unknown",
      });
    }
    if (status?.resolve === "unresolved") badges.push({ id: "resolve" });
    if (status?.lockOwnership === "ours")
      badges.push({ id: "locked", owner: "self", detail: status.lockReason });
    if (status?.lockOwnership === "other")
      badges.push({
        id: "globalLock",
        owner: "other",
        detail: status.lockOwner ?? status.lockReason,
      });
    if (status?.exclusiveOpen)
      badges.push({
        id: "exclusive",
        owner: status.lockOwnership === "other" ? "other" : undefined,
        detail: status.otherOpen?.length
          ? status.otherOpen.join(", ")
          : status.fileType,
      });
    if (status?.local === "modified") badges.push({ id: "modified" });
    if (status?.local === "missing") badges.push({ id: "missing" });
    if (status?.local === "symlink") badges.push({ id: "symlink" });
    if (status?.sync === "outOfDate") badges.push({ id: "outOfDate" });
    if (status?.sync === "notSynced") badges.push({ id: "notSynced" });
    if (status?.completeness === "partial") badges.push({ id: "stale" });
    if (status?.completeness === "error") badges.push({ id: "error" });
    if (status?.primary === "unknown") badges.push({ id: "unknown" });
  }
  // Never let a revision comparison conceal a stronger explicit stale revision state.
  const hasOlder = badges.some(
    (b) => b.id === "outOfDate" || b.id === "notSynced",
  );
  const seen = new Set<string>();
  return badges
    .filter((b) => {
      if (hasOlder && b.id === "latest") return false;
      const key = `${b.id}:${b.owner ?? ""}:${b.detail ?? ""}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => priority(a) - priority(b));
}
function priority(b: FileBadge) {
  if (["resolve", "error", "locked", "globalLock", "exclusive"].includes(b.id))
    return 0;
  if (b.id === "shelf") return 1;
  if (b.owner) return 2;
  return 3;
}
export function fileBadgeLabel(badge: FileBadge, zh: boolean): string {
  const owner =
    badge.owner === "self"
      ? zh
        ? "我："
        : "You: "
      : badge.owner === "other"
        ? zh
          ? "其他工作区／用户："
          : "Other workspace/user: "
        : "";
  return (
    owner +
    labels[badge.id][zh ? 0 : 1] +
    (badge.detail ? ` (${badge.detail})` : "")
  );
}
export const fileBadgeGlyph = (id: FileBadgeId) => labels[id][2];
