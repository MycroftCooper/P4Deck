const active = new Map<string, string>();

const keyOf = (scope: string, changeId: string) => `${scope}\u0000${changeId}`;

/** One tool window per (connection, changelist); different CLs may run at the same time. */
export function claimCustomSubmitChange(
  scope: string,
  changeId: string,
  requestId: string,
): boolean {
  const key = keyOf(scope, changeId);
  if (active.has(key)) return false;
  active.set(key, requestId);
  return true;
}

/** Release only the matching request so a stale exit cannot free a newer session. */
export function releaseCustomSubmitChange(
  scope: string,
  changeId: string,
  requestId?: string,
): void {
  const key = keyOf(scope, changeId);
  if (requestId && active.get(key) !== requestId) return;
  active.delete(key);
}

/** Test isolation only: clear per-connection occupancy. */
export function resetCustomSubmitSessions(): void {
  active.clear();
}

export function isCustomSubmitChangeActive(
  scope: string,
  changeId: string,
): boolean {
  return active.has(keyOf(scope, changeId));
}
