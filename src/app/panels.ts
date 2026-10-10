import type { GlobalSearchTarget } from "../shared/contracts/types";

export const pageDefinitions = {
  files: { zh: "文件", en: "Files", scope: "global", target: "depot" },
  search: { zh: "搜索", en: "Search", scope: "global", target: "depot" },
  pending: { zh: "Pending", en: "Pending", scope: "global", target: "depot" },
  submitted: {
    zh: "Submitted",
    en: "Submitted",
    scope: "global",
    target: "depot",
  },
  workspaces: {
    zh: "Workspace",
    en: "Workspace",
    scope: "global",
    target: "depot",
  },
  history: { zh: "History", en: "History", scope: "file", target: "depot" },
  streams: { zh: "Streams", en: "Streams", scope: "global", target: "depot" },
  streamgraph: {
    zh: "Stream 图",
    en: "Stream Graph",
    scope: "global",
    target: "depot",
  },
  branchmappings: {
    zh: "Branch Mappings",
    en: "Branch Mappings",
    scope: "global",
    target: "depot",
  },
  terminal: {
    zh: "Terminal",
    en: "Terminal",
    scope: "global",
    target: "depot",
  },
  p4log: { zh: "P4 日志", en: "P4 Log", scope: "global", target: "depot" },
  diff: { zh: "Diff", en: "Diff", scope: "file", target: "depot" },
  shelf: {
    zh: "Shelf 详情",
    en: "Shelf Detail",
    scope: "file",
    target: "depot",
  },
  revgraph: {
    zh: "Rev Graph",
    en: "Rev Graph",
    scope: "file",
    target: "depot",
  },
  settings: { zh: "设置", en: "Settings", scope: "global", target: "depot" },
  preview: { zh: "文件预览", en: "Preview", scope: "file", target: "local" },
} as const;
export type PageId = keyof typeof pageDefinitions;
export type FilePageId = {
  [K in PageId]: (typeof pageDefinitions)[K]["scope"] extends "file"
    ? K
    : never;
}[PageId];
export const pageIds = Object.keys(pageDefinitions) as PageId[];
export function pageLabels(zh: boolean): Record<PageId, string> {
  return Object.fromEntries(
    pageIds.map((id) => [id, pageDefinitions[id][zh ? "zh" : "en"]]),
  ) as Record<PageId, string>;
}
export function targetForPage(page: PageId, depot?: string, local?: string) {
  return pageDefinitions[page].target === "local"
    ? (local ?? depot)
    : (depot ?? local);
}
export interface PanelTarget {
  target: string;
  locked: boolean;
}
export function normalizePanelTarget(value: unknown): PanelTarget {
  if (!value || typeof value !== "object") return { target: "", locked: false };
  const params = value as Partial<PanelTarget>;
  return {
    target: typeof params.target === "string" ? params.target : "",
    locked: params.locked === true,
  };
}
export const isMultiPage = (page: PageId): page is FilePageId =>
  pageDefinitions[page].scope === "file";
// The activity rail only contains global pages; Settings is anchored separately.
export const activityPageIds = pageIds.filter(
  (page): page is Exclude<PageId, FilePageId | "settings"> =>
    page !== "settings" && !isMultiPage(page),
);
export function panelKind(id: string): PageId | undefined {
  const kind = id.split("--")[0];
  return isPage(kind) ? kind : undefined;
}
export function reusablePanel<
  T extends { id: string; params?: Partial<PanelTarget> },
>(panels: T[], kind: PageId, target?: string): T | undefined {
  const matches = panels.filter((p) => panelKind(p.id) === kind);
  return isMultiPage(kind)
    ? (matches.find(
        (p) => target !== undefined && p.params?.target === target,
      ) ??
        matches.find((p) => !p.params?.locked) ??
        (target === undefined ? matches[0] : undefined))
    : matches[0];
}
export function isPage(value: string): value is PageId {
  return (pageIds as readonly string[]).includes(value);
}

export function pageForSearchTarget(
  target: GlobalSearchTarget,
): "submitted" | "pending" | "files" | undefined {
  switch (target.type) {
    case "submittedChange":
      return "submitted";
    case "pendingChange":
      return "pending";
    case "workspaceFile":
    case "depotFile":
      return "files";
    case "job":
    case "stream":
    case "shelf":
      return undefined;
  }
}
export function readPages(raw: string | null): PageId[] {
  try {
    const parsed: unknown = JSON.parse(raw ?? "null");
    if (Array.isArray(parsed))
      return [
        ...new Set(
          parsed.filter(
            (value): value is PageId =>
              typeof value === "string" && isPage(value),
          ),
        ),
      ];
  } catch {
    /* Use default layout for invalid saved state. */
  }
  return [...pageIds];
}
