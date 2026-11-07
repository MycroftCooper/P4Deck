import type { ChangelistSummary } from "../../shared/contracts";
import { classifySubmission } from "./submittedReport";

/** Only an adjacent, complete CI source pair is an edge, never a body number. */
export function ciSourceReferences(description: string) {
  if (classifySubmission(description).kind !== "ciMerge") return [];
  const lines = normalizedDescription(description).split("\n");
  const refs: { changeId: number; sourcePath: string }[] = [];
  for (let i = 0; i + 1 < lines.length; i++) {
    const path = /^\s*合并来源:\s*(\/\/\S+)\s*$/.exec(lines[i]); // i18n-exempt: P4 protocol text
    const cl = /^\s*CL号:\s*([1-9]\d*)\s*$/.exec(lines[i + 1]); // i18n-exempt: P4 protocol text
    if (path && cl && Number.isSafeInteger(Number(cl[1])))
      refs.push({ changeId: Number(cl[1]), sourcePath: path[1] });
  }
  return refs;
}

export function reachableDestinations(
  sourceId: number,
  rows: ChangelistSummary[],
) {
  const unique = new Map(rows.map((row) => [row.id, row]));
  const reverse = new Map<number, number[]>();
  for (const row of unique.values()) {
    if (row.status !== "submitted") continue;
    for (const ref of ciSourceReferences(row.description)) {
      const targets = reverse.get(ref.changeId) ?? [];
      targets.push(row.id);
      reverse.set(ref.changeId, targets);
    }
  }
  const reached = new Set([sourceId]);
  const queue = [sourceId];
  for (let i = 0; i < queue.length; i++) {
    for (const id of reverse.get(queue[i]) ?? []) {
      if (reached.has(id)) continue;
      reached.add(id);
      queue.push(id);
    }
  }
  return [...unique.values()].filter(
    (row) => row.id !== sourceId && reached.has(row.id),
  );
}

/** Normalize only line endings and the document boundary, never tags or body spacing. */
export function normalizedDescription(description: string): string {
  return description.replace(/\r\n?/g, "\n").trim();
}

/** Remove only a contiguous trailing block of the already recognized CI fields.
 * Unknown suffixes and metadata-looking lines inside the body stay significant.
 * The original description is retained on the returned CL for display/preview.
 */
export function ciDescriptionBody(description: string): string {
  const normalized = normalizedDescription(description);
  if (classifySubmission(description).kind !== "ciMerge") return normalized;
  const lines = normalized.split("\n");
  while (
    lines.length &&
    /^\s*(?:提交人:|合并来源:|CL号:)\s*\S.*$/.test(lines[lines.length - 1]) // i18n-exempt: P4 protocol text
  ) {
    lines.pop();
  }
  return lines.join("\n").trim();
}

export function matchesDescriptionDestination(
  source: Pick<ChangelistSummary, "id" | "description">,
  candidate: ChangelistSummary,
): boolean {
  const body = ciDescriptionBody(source.description);
  return (
    body.length > 0 &&
    candidate.id !== source.id &&
    candidate.status === "submitted" &&
    classifySubmission(candidate.description).kind === "ciMerge" &&
    ciDescriptionBody(candidate.description) === body
  );
}
