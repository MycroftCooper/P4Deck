import { messages } from "../shared/i18n";
import type { GlobalSearchTarget } from "../shared/contracts";

export const pageDefinitions = {
  files: {
    zh: messages["zh-CN"].files,
    en: messages["en-US"].files,
    scope: "global",
    target: "depot",
  },
  search: { zh: "搜索", en: "Search", scope: "global", target: "depot" },
  pending: {
    zh: messages["zh-CN"].pending,
    en: messages["en-US"].pending,
    scope: "global",
    target: "depot",
  },
  submitted: {
    zh: messages["zh-CN"].submitted,
    en: messages["en-US"].submitted,
    scope: "global",
    target: "depot",
  },
  workspaces: {
    zh: messages["zh-CN"].workspace,
    en: messages["en-US"].workspace,
    scope: "global",
    target: "depot",
  },
  history: {
    zh: messages["zh-CN"].history,
    en: messages["en-US"].history,
    scope: "file",
    target: "depot",
  },
  streams: {
    zh: messages["zh-CN"].streams,
    en: messages["en-US"].streams,
    scope: "global",
    target: "depot",
  },
  streamgraph: {
    zh: "分支流图",
    en: "Stream Graph",
    scope: "global",
    target: "depot",
  },
  branchmappings: {
    zh: "分支映射",
    en: "Branch Mappings",
    scope: "global",
    target: "depot",
  },
  terminal: {
    zh: messages["zh-CN"].terminal,
    en: messages["en-US"].terminal,
    scope: "global",
    target: "depot",
  },
  p4log: { zh: "P4 日志", en: "P4 Log", scope: "global", target: "depot" },
  diff: {
    zh: messages["zh-CN"].diff,
    en: messages["en-US"].diff,
    scope: "file",
    target: "depot",
  },
  shelf: {
    zh: "搁置详情",
    en: "Shelf Detail",
    scope: "file",
    target: "depot",
  },
  revgraph: {
    zh: messages["zh-CN"].revGraph,
    en: messages["en-US"].revGraph,
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
export interface RevisionComparison {
  rightPath?: string;
  left: number;
  right: number;
}
export interface PanelTarget {
  comparison?: RevisionComparison;
  target: string;
  locked: boolean;
}
export function normalizePanelTarget(value: unknown): PanelTarget {
  if (!value || typeof value !== "object") return { target: "", locked: false };
  const params = value as Partial<PanelTarget>;
  return {
    target: typeof params.target === "string" ? params.target : "",
    locked: params.locked === true,
    ...(params.comparison &&
    Number.isSafeInteger(params.comparison.left) &&
    Number.isSafeInteger(params.comparison.right) &&
    params.comparison.left > 0 &&
    (params.comparison.rightPath
      ? params.comparison.right > 0 &&
        typeof params.comparison.rightPath === "string" &&
        params.comparison.rightPath.startsWith("//") &&
        !/[#@\r\n\0*]/.test(params.comparison.rightPath) &&
        !params.comparison.rightPath.includes("...") &&
        (params.comparison.rightPath !== params.target ||
          params.comparison.right !== params.comparison.left)
      : params.comparison.right > params.comparison.left)
      ? {
          comparison: {
            ...(params.comparison.rightPath
              ? { rightPath: params.comparison.rightPath }
              : {}),
            left: params.comparison.left,
            right: params.comparison.right,
          },
        }
      : {}),
  };
}
export const isMultiPage = (page: PageId): page is FilePageId =>
  pageDefinitions[page].scope === "file";
// The activity rail contains primary global pages. Settings is anchored
// separately, Terminal and P4 Log stay in the always-visible tool strip, and
// Stream Graph / Branch Mappings are reached from the Streams page.
export const activityPageIds = pageIds.filter(
  (
    page,
  ): page is Exclude<
    PageId,
    | FilePageId
    | "settings"
    | "terminal"
    | "p4log"
    | "streamgraph"
    | "branchmappings"
  > =>
    page !== "settings" &&
    page !== "terminal" &&
    page !== "p4log" &&
    page !== "streamgraph" &&
    page !== "branchmappings" &&
    !isMultiPage(page),
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
): "submitted" | "pending" | "files" | "streams" | "shelf" | undefined {
  switch (target.type) {
    case "submittedChange":
      return "submitted";
    case "pendingChange":
      return "pending";
    case "workspaceFile":
    case "depotFile":
      return "files";
    case "stream":
      return "streams";
    case "shelf":
      return "shelf";
    case "job":
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
