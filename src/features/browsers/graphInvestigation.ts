import { t } from "../../shared/i18n";
import type {
  BranchViewLine,
  RevisionGraph,
  RevisionGraphNode,
  SubmittedChangeFile,
} from "../../shared/contracts";
import {
  edgeIncludesSource,
  focusEvidence,
  GRAPH_BUDGET,
  validGraphPath,
} from "./graphFocus";
import { mergeRevisionGraphs } from "./reviewModel";

export type FileMapping = { target?: string; reason?: string };
export function mapBranchFile(
  path: string,
  view: BranchViewLine[],
  reverse = false,
): FileMapping {
  const candidates = new Set<string>();
  // Deliberately support only literal paths / one trailing ...; never guess overlays/remaps.
  for (const line of view) {
    const from = reverse ? line.target : line.source,
      to = reverse ? line.source : line.target;
    if (
      line.unknown ||
      !from ||
      !to ||
      !["map", "exclude"].includes(line.modifier)
    )
      return { reason: t("browse.unsupported.mapping.rule") };
    const prefix = from.endsWith("/...") && to.endsWith("/...");
    if (
      (!prefix && (from.includes("...") || to.includes("..."))) ||
      /[*%@#]/.test(from + to)
    )
      return { reason: t("browse.unsupported.wildcard.mapping") };
    const suffix =
      prefix && path.startsWith(from.slice(0, -3))
        ? path.slice(from.length - 3)
        : !prefix && path === from
          ? ""
          : undefined;
    if (suffix === undefined) continue;
    if (line.modifier === "exclude")
      return { reason: t("browse.file.excluded.by.mapping") };
    const target = prefix ? to.slice(0, -3) + suffix : to;
    if (!validGraphPath(target))
      return { reason: t("browse.mapping.is.not.a.single.file") };
    candidates.add(target);
  }
  return candidates.size === 1
    ? { target: [...candidates][0] }
    : {
        reason: candidates.size
          ? t("browse.ambiguous.target")
          : t("browse.no.matching.mapping"),
      };
}
export function mapBranchRoots(
  path: string,
  sourceRoot: string,
  targetRoot: string,
): FileMapping {
  const source = sourceRoot.replace(/\/+$/, ""),
    target = targetRoot.replace(/\/+$/, "");
  if (
    !validGraphPath(source + "/file") ||
    !validGraphPath(target + "/file") ||
    source === target ||
    !path.startsWith(source + "/")
  )
    return {
      reason: t("browse.invalid.roots.or.file.outside.source"),
    };
  const mapped = target + path.slice(source.length);
  return validGraphPath(mapped)
    ? { target: mapped }
    : { reason: t("browse.not.a.single.file.path") };
}
export interface InvestigationRow {
  file: SubmittedChangeFile;
  target?: string;
  status: "records" | "review" | "unknown";
  reason: string;
  graph?: RevisionGraph;
  sourceId?: string;
  evidence?: ReturnType<typeof focusEvidence>;
  updatedAt?: number;
}
export interface InvestigationReport {
  rows: InvestigationRow[];
  reads: number;
  total: number;
  fileListComplete: boolean;
  interrupted: boolean;
  limited: boolean;
}
export interface InvestigationBudget {
  used: number;
  limit: number;
}
export const newInvestigationBudget = (): InvestigationBudget => ({
  used: 0,
  limit: GRAPH_BUDGET,
});
export function takeInvestigationRead(
  budget: InvestigationBudget,
  signal: AbortSignal,
) {
  if (signal.aborted) throw new Error(t("browse.cancelled"));
  if (budget.used >= budget.limit)
    throw new Error(t("browse.query.budget.reached"));
  budget.used++;
}
const blank = (): RevisionGraph => ({
  nodes: [],
  edges: [],
  hasMore: false,
  partial: false,
  truncated: false,
  operationIds: [],
});

/** Sequential file investigation, bounded pages and shared read adapter; no backend import. */
export async function investigateFiles(
  files: SubmittedChangeFile[],
  changeId: number,
  map: (path: string) => FileMapping,
  read: (
    path: string,
    cursor?: string,
  ) => Promise<{ graph: RevisionGraph; updatedAt: number }>,
  options: {
    signal: AbortSignal;
    budget: InvestigationBudget;
    fileListComplete: boolean;
    intermediates: boolean;
    progress?: (report: InvestigationReport) => void;
  },
): Promise<InvestigationReport> {
  const report: InvestigationReport = {
    rows: [],
    reads: options.budget.used,
    total: files.length,
    fileListComplete: options.fileListComplete,
    interrupted: false,
    limited: false,
  };
  const seenFiles = new Set<string>();
  for (const file of files) {
    const key = file.depotPath + "#" + file.revision;
    if (seenFiles.has(key)) {
      report.total--;
      continue;
    }
    seenFiles.add(key);
    const row: InvestigationRow = {
      file,
      status: "unknown",
      reason: t("browse.insufficient.evidence"),
    };
    report.rows.push(row);
    if (
      options.signal.aborted ||
      options.budget.used >= options.budget.limit ||
      report.rows.length > 100
    ) {
      row.reason = options.signal.aborted
        ? t("browse.cancelled")
        : t("browse.not.queried.budget.or.100.file");
      report.interrupted ||= options.signal.aborted;
      report.limited ||= !options.signal.aborted;
      continue;
    }
    const mapping = map(file.depotPath);
    row.target = mapping.target;
    if (
      !mapping.target ||
      !Number.isSafeInteger(file.revision) ||
      file.revision! < 1 ||
      !validGraphPath(file.depotPath)
    ) {
      row.reason = mapping.reason ?? t("browse.missing.exact.revision");
      continue;
    }
    if (mapping.target === file.depotPath) {
      row.reason = t("browse.source.equals.target");
      continue;
    }
    // Seed is actual describe/filelog metadata, not an inferred server revision.
    const seed: RevisionGraphNode = {
      id: file.depotPath + "#" + file.revision,
      depotPath: file.depotPath,
      revision: file.revision!,
      changelistId: changeId,
      action: file.action,
      fileType: file.fileType ?? "",
      label: "#" + file.revision,
      x: 0,
      y: 0,
      missing: false,
    };
    let graph = { ...blank(), nodes: [seed] };
    const loaded = new Map<string, RevisionGraph>();
    let incomplete = false;
    const evidence = () =>
      focusEvidence(graph, seed.id, mapping.target!, "target");
    const load = async (path: string, maxPages: number) => {
      let cursor: string | undefined;
      const cursors = new Set<string>();
      for (let page = 0; page < maxPages; page++) {
        takeInvestigationRead(options.budget, options.signal);
        const result = await read(path, cursor);
        if (options.signal.aborted) throw new Error(t("browse.cancelled"));
        row.updatedAt =
          row.updatedAt === undefined
            ? result.updatedAt
            : Math.min(row.updatedAt, result.updatedAt);
        graph = mergeRevisionGraphs(graph, result.graph);
        loaded.set(path, result.graph);
        incomplete ||= result.graph.partial || result.graph.truncated;
        if (!result.graph.hasMore || evidence().edges.length) break;
        const next = result.graph.nextCursor;
        if (!next || cursors.has(next)) {
          incomplete = true;
          break;
        }
        cursors.add(next);
        cursor = next;
      }
      incomplete ||= !!loaded.get(path)?.hasMore;
    };
    try {
      await load(mapping.target, 2);
      if (!evidence().edges.length && options.intermediates) {
        await load(file.depotPath, 2);
        const index = new Map(graph.nodes.map((n) => [n.id, n]));
        const outgoing = new Set(
          graph.edges
            .filter(
              (e) =>
                edgeIncludesSource(e, seed, index) &&
                !/ignor|undo|undid|delete/i.test(e.relationship),
            )
            .map((e) => index.get(e.target)?.depotPath),
        );
        const incoming = new Set(
          graph.edges
            .filter(
              (e) =>
                e.kind !== "revision" &&
                index.get(e.target)?.depotPath === mapping.target,
            )
            .map((e) => index.get(e.source)?.depotPath),
        );
        const candidates = [...outgoing]
          .filter(
            (p): p is string =>
              !!p &&
              incoming.has(p) &&
              p !== file.depotPath &&
              p !== mapping.target &&
              validGraphPath(p),
          )
          .sort();
        if (candidates.length > 2) incomplete = true;
        for (const path of candidates.slice(0, 2)) {
          if (evidence().edges.length) break;
          await load(path, 2);
        }
      }
      graph = { ...graph, partial: graph.partial || incomplete };
      const result = evidence();
      row.status = result.edges.length
        ? result.caution
          ? "review"
          : "records"
        : "unknown";
      row.reason = result.edges.length
        ? t("browse.integration.records.content.inclusion.remains.unknown")
        : t("browse.no.path.in.inspected.range.absence");
      row.evidence = result;
      row.graph = graph;
      row.sourceId = seed.id;
    } catch (cause) {
      row.reason = String(cause);
      row.graph = { ...graph, partial: true };
      row.sourceId = seed.id;
      row.evidence = focusEvidence(
        row.graph,
        seed.id,
        mapping.target,
        "target",
      );
      report.interrupted ||= options.signal.aborted;
      report.limited ||= options.budget.used >= options.budget.limit;
    }
    report.reads = options.budget.used;
    options.progress?.({ ...report, rows: [...report.rows] });
  }
  report.reads = options.budget.used;
  return report;
}
