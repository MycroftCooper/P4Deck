import { tFor } from "../shared/i18n";
import type { MsgKey } from "../shared/i18n";
import type { GlobalSearchTarget } from "../shared/contracts";

/**
 * Every page title is a catalog key, never a translated string: the authoring
 * side only names the key, and `pageLabels` resolves it for the requested
 * locale. Anything that renders a label goes through there, so a raw key can
 * never reach the activity bar or a page header.
 */
export const pageDefinitions = {
  files: { key: "changes.columns.files", scope: "global", target: "depot" },
  search: { key: "shell.search", scope: "global", target: "depot" },
  pending: { key: "changes.pending", scope: "global", target: "depot" },
  submitted: { key: "changes.submitted", scope: "global", target: "depot" },
  workspaces: {
    key: "changes.columns.workspace",
    scope: "global",
    target: "depot",
  },
  history: { key: "nav.history", scope: "file", target: "depot" },
  streams: { key: "nav.streams", scope: "global", target: "depot" },
  streamgraph: { key: "shell.stream.graph", scope: "global", target: "depot" },
  branchmappings: {
    key: "shell.branch.mappings",
    scope: "global",
    target: "depot",
  },
  terminal: { key: "nav.terminal", scope: "global", target: "depot" },
  p4log: { key: "shell.p4.log", scope: "global", target: "depot" },
  diff: { key: "common.diff", scope: "file", target: "depot" },
  shelf: { key: "shell.shelf.detail", scope: "file", target: "depot" },
  revgraph: { key: "files.revGraph", scope: "file", target: "depot" },
  settings: { key: "shell.settings", scope: "global", target: "depot" },
  preview: { key: "shell.preview", scope: "file", target: "local" },
} as const satisfies Record<
  string,
  { key: MsgKey; scope: "global" | "file"; target: "depot" | "local" }
>;
export type PageId = keyof typeof pageDefinitions;
export type FilePageId = {
  [K in PageId]: (typeof pageDefinitions)[K]["scope"] extends "file"
    ? K
    : never;
}[PageId];
export const pageIds = Object.keys(pageDefinitions) as PageId[];
/**
 * Resolves every page title through the catalog for the requested locale.
 *
 * The locale is passed explicitly (`tFor`) rather than read from the module
 * global (`t`): preferences activate the global in an effect, so during the
 * render that follows a locale switch the global can still be one locale
 * behind. The caller's `zh` is the authority.
 */
export function pageLabels(zh: boolean): Record<PageId, string> {
  const locale = zh ? "zh-CN" : "en-US";
  return Object.fromEntries(
    pageIds.map((id) => [id, tFor(locale, pageDefinitions[id].key)]),
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
