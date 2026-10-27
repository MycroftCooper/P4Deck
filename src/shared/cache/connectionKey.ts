/**
 * Runtime connection keys include view/context generations so stale in-flight
 * UI work can be isolated. Persisted resource snapshots must survive those
 * generations across app restarts and therefore use the stable suffix.
 */
export function stableConnectionKey(connectionKey: string) {
  return connectionKey.replace(/^\d+:\d+:/, "") || connectionKey;
}
