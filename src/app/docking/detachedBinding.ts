import type { PanelRuntimeBinding } from "./floatingPanels";

export function opaqueConnectionBinding(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `v1-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export function readDetachedBinding(
  search: string,
): PanelRuntimeBinding | undefined {
  const params = new URLSearchParams(search);
  const connectionKey = params.get("connectionKey");
  const generation = Number(params.get("contextGeneration"));
  if (
    !connectionKey ||
    !params.has("contextGeneration") ||
    !Number.isSafeInteger(generation) ||
    generation < 0
  )
    return undefined;
  return {
    profileId: params.get("profileId") ?? undefined,
    contextGeneration: generation,
    connectionKey,
  };
}

export function detachedBindingMatches(
  expected: PanelRuntimeBinding | undefined,
  current: PanelRuntimeBinding,
) {
  return (
    !expected ||
    (expected.profileId === current.profileId &&
      expected.contextGeneration === current.contextGeneration &&
      expected.connectionKey === current.connectionKey)
  );
}
