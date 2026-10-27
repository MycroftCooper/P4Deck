import type { RuntimeInfo } from "../contracts/types";

/**
 * Freshness classes. See ForAIDoc/Coder/数据缓存与操作架构.md.
 * - snapshot: server lists that other people can change (Pending, Submitted...)
 * - target: data about one selected file or changelist
 * - immutable: content addressed by a fixed revision
 * - local: local disk reads; cheap, so they are re-read on every open
 */
export const CACHE_POLICY = {
  snapshot: { staleTime: 5 * 60_000, gcTime: 30 * 60_000 },
  target: { staleTime: 60_000, gcTime: 10 * 60_000 },
  immutable: { staleTime: Number.POSITIVE_INFINITY, gcTime: 30 * 60_000 },
  local: { staleTime: 0, gcTime: 60_000 },
} as const;

/** Domains whose cached server snapshots can be invalidated as a group. */
export type SnapshotDomain =
  | "pending"
  | "submitted"
  | "workspaces"
  | "streams"
  | "streamGraph"
  | "branchMappings";

export const SNAPSHOT_DOMAINS: readonly SnapshotDomain[] = [
  "pending",
  "submitted",
  "workspaces",
  "streams",
  "streamGraph",
  "branchMappings",
];

type ScopeRuntime = Pick<RuntimeInfo, "mode" | "activeProfileId" | "context">;

/** Data visible to one user on one server (Workspaces, Streams, Submitted). */
export function serverScope(runtime: ScopeRuntime) {
  return JSON.stringify([
    runtime.mode,
    runtime.activeProfileId ?? "",
    runtime.context.server,
    runtime.context.user,
  ]);
}

/** Data owned by one workspace (Pending, workspace-relative views). */
export function workspaceScope(runtime: ScopeRuntime) {
  return JSON.stringify([
    runtime.mode,
    runtime.activeProfileId ?? "",
    runtime.context.server,
    runtime.context.user,
    runtime.context.client,
    runtime.context.cwd ?? "",
  ]);
}

/** Keys never contain a connection generation, so restarts can reuse them. */
export function snapshotKey(
  domain: SnapshotDomain,
  scope: string,
  ...parameters: string[]
) {
  return ["snapshot", domain, scope, ...parameters] as const;
}
