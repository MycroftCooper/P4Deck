import { panelKind } from "../panels";

export interface PanelRuntimeBinding {
  profileId?: string;
  contextGeneration: number;
  connectionKey: string;
}

export interface FloatingPanelRecord {
  id: string;
  binding?: PanelRuntimeBinding;
}

export interface FloatingPanelState {
  version: 1;
  panels: FloatingPanelRecord[];
}

export function readFloatingPanels(raw: string | null): FloatingPanelState {
  try {
    const value: unknown = JSON.parse(raw ?? "null");
    const records = Array.isArray(value)
      ? value.map((id) => ({ id }))
      : value &&
          typeof value === "object" &&
          (value as { version?: unknown }).version === 1 &&
          Array.isArray((value as { panels?: unknown }).panels)
        ? (value as { panels: unknown[] }).panels
        : [];
    const panels: FloatingPanelRecord[] = [];
    for (const record of records) {
      const candidate =
        typeof record === "string"
          ? { id: record }
          : (record as FloatingPanelRecord);
      if (
        !candidate ||
        typeof candidate.id !== "string" ||
        !panelKind(candidate.id)
      )
        continue;
      if (panels.some(({ id }) => id === candidate.id)) continue;
      const binding = candidate.binding;
      panels.push({
        id: candidate.id,
        binding:
          binding &&
          typeof binding.contextGeneration === "number" &&
          Number.isSafeInteger(binding.contextGeneration) &&
          binding.contextGeneration >= 0 &&
          typeof binding.connectionKey === "string"
            ? {
                profileId:
                  typeof binding.profileId === "string"
                    ? binding.profileId
                    : undefined,
                contextGeneration: binding.contextGeneration,
                connectionKey: binding.connectionKey,
              }
            : undefined,
      });
    }
    return { version: 1, panels };
  } catch {
    return { version: 1, panels: [] };
  }
}
