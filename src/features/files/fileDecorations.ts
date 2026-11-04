import { t, tFor, type MsgKey } from "../../shared/i18n";
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
  | "resolved"
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
  | "success"
  | "danger"
  | "warning"
  | "amber"
  | "yellow"
  | "neutral"
  | "purple"
  | "teal";
const badgeTones: Record<FileBadgeId, FileBadgeTone> = {
  add: "success",
  edit: "success",
  delete: "danger",
  "move/add": "success",
  "move/delete": "danger",
  branch: "success",
  integrate: "amber",
  latest: "teal",
  outOfDate: "yellow",
  notSynced: "yellow",
  missing: "neutral",
  untracked: "neutral",
  ignored: "neutral",
  resolve: "danger",
  resolved: "teal",
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
  add: ["files.add.2", "files.add.2", "+"],
  edit: ["files.edit", "files.edit", "✓"],
  delete: ["files.delete.2", "files.delete.2", "×"],
  "move/add": ["files.move.add", "files.move.add", "↗"],
  "move/delete": ["files.move.delete", "files.move.delete", "↙"],
  branch: ["files.branch", "files.branch", "⑂"],
  integrate: ["files.integrate", "files.integrate", "⇄"],
  latest: ["files.latest", "files.latest", "●"],
  outOfDate: ["files.outOfDate", "files.outOfDate", "↓"],
  notSynced: ["files.notSynced", "files.notSynced", "↓"],
  missing: ["files.missing", "files.missing", "?"],
  untracked: ["files.untracked.2", "files.untracked.2", "?"],
  ignored: ["files.ignored.2", "files.ignored.2", "−"],
  resolve: ["files.resolve", "files.resolve", "!"],
  resolved: ["files.resolved", "files.resolved", "✓"],
  modified: ["files.modified", "files.modified", "●"],
  locked: ["files.locked", "files.locked", "L"],
  globalLock: ["files.globalLock", "files.globalLock", "L"],
  exclusive: ["files.exclusive", "files.exclusive", "L"],
  unmapped: ["files.unmapped", "files.unmapped", "∅"],
  depotDeleted: ["files.depotDeleted", "files.depotDeleted", "×"],
  shelf: ["files.shelf", "files.shelf", "S"],
  imported: ["files.imported", "files.imported", "↘"],
  ditto: ["files.ditto", "files.ditto", "≡"],
  placeholder: ["files.placeholder", "files.placeholder", "⋯"],
  symlink: ["files.symlink", "files.symlink", "↗"],
  unknown: ["files.unknown.2", "files.unknown.2", "?"],
  stale: ["files.stale", "files.stale", "◷"],
  error: ["files.error", "files.error", "!"],
  loading: ["files.loading.2", "files.loading.2", "⋯"],
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
    else if (status?.resolve === "resolved") badges.push({ id: "resolved" });
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
      ? t("files.you")
      : badge.owner === "other"
        ? t("files.other.workspace.user")
        : "";
  return (
    owner +
    tFor(zh ? "zh-CN" : "en-US", labels[badge.id][0] as MsgKey) +
    (badge.detail ? ` (${badge.detail})` : "")
  );
}
export const fileBadgeGlyph = (id: FileBadgeId) => labels[id][2];
