/** Pure helpers shared by the diff toolbar and the @pierre/diffs renderer. */

import type { FileDiffMetadata, Hunk } from "@pierre/diffs";

export type DiffSideName = "left" | "right";

export interface DiffHunk {
  header: string;
  leftStart: number;
  leftCount: number;
  rightStart: number;
  rightCount: number;
  /** First changed line on each side; undefined when the hunk has none there. */
  firstLeft?: number;
  firstRight?: number;
}

/** One searchable source line; context appears once with both numbers. */
export interface DiffSearchLine {
  left?: number;
  right?: number;
  text: string;
}

export interface DiffMatch {
  line: number;
  /** Identical context is one result, highlighted in both panes. */
  side: DiffSideName | "both";
  start: number;
  length: number;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Parser line arrays keep the line terminator; the UI does not want it. */
function cleanLine(value: string | undefined) {
  return (value ?? "").replace(/\r?\n$/, "");
}

/**
 * Prepare the backend's unified patch for `parsePatchFiles`: normalize line
 * endings, tolerate a missing trailing newline, and add a synthetic file header
 * when only hunk bodies were supplied. `\ No newline at end of file` markers
 * are left to the parser, which understands them.
 */
export function normalizeUnifiedPatch(patch: string, name = "file"): string {
  let text = patch.replace(/\r\n?/g, "\n");
  if (!text.trim()) return "";
  const lines = text.split("\n");
  const hasHeader =
    lines[0]?.startsWith("--- ") && lines[1]?.startsWith("+++ ");
  if (!hasHeader && lines.some((line) => line.startsWith("@@ ")))
    text = `--- a/${name}\n+++ b/${name}\n${text}`;
  if (!text.endsWith("\n")) text += "\n";
  return text;
}

/**
 * Project the library's parsed hunks into the toolbar's navigation shape. The
 * first changed line is derived from the hunk content so hunk jumps land on a
 * changed line instead of a context line.
 */
export function hunksFromMetadata(hunks: readonly Hunk[]): DiffHunk[] {
  return hunks.map((hunk) => {
    let left = hunk.deletionStart;
    let right = hunk.additionStart;
    let firstLeft: number | undefined;
    let firstRight: number | undefined;
    for (const content of hunk.hunkContent) {
      if (content.type === "context") {
        left += content.lines;
        right += content.lines;
        continue;
      }
      if (content.deletions > 0) firstLeft ??= left;
      if (content.additions > 0) firstRight ??= right;
      left += content.deletions;
      right += content.additions;
    }
    return {
      header:
        cleanLine(hunk.hunkSpecs) ||
        `@@ -${hunk.deletionStart},${hunk.deletionCount} +${hunk.additionStart},${hunk.additionCount} @@`,
      leftStart: hunk.deletionStart,
      leftCount: hunk.deletionCount,
      rightStart: hunk.additionStart,
      rightCount: hunk.additionCount,
      firstLeft,
      firstRight,
    };
  });
}

/**
 * Searchable lines straight from the parsed hunk metadata, so partial results
 * do not re-parse the patch a second time.
 */
export function searchLinesFromMetadata(
  fileDiff: FileDiffMetadata,
): DiffSearchLine[] {
  const lines: DiffSearchLine[] = [];
  for (const hunk of fileDiff.hunks) {
    let left = hunk.deletionStart;
    let right = hunk.additionStart;
    let leftIndex = hunk.deletionLineIndex;
    let rightIndex = hunk.additionLineIndex;
    for (const content of hunk.hunkContent) {
      if (content.type === "context") {
        for (let index = 0; index < content.lines; index++) {
          lines.push({
            left: left + index,
            right: right + index,
            text: cleanLine(fileDiff.additionLines[rightIndex + index]),
          });
        }
        left += content.lines;
        right += content.lines;
        leftIndex += content.lines;
        rightIndex += content.lines;
        continue;
      }
      for (let index = 0; index < content.deletions; index++) {
        lines.push({
          left: left + index,
          text: cleanLine(fileDiff.deletionLines[leftIndex + index]),
        });
      }
      left += content.deletions;
      leftIndex += content.deletions;
      for (let index = 0; index < content.additions; index++) {
        lines.push({
          right: right + index,
          text: cleanLine(fileDiff.additionLines[rightIndex + index]),
        });
      }
      right += content.additions;
      rightIndex += content.additions;
    }
  }
  return lines;
}

/** Source lines inside the patch hunks; fallback when metadata is unavailable. */
function parseUnifiedLines(unified: string): DiffSearchLine[] {
  const lines: DiffSearchLine[] = [];
  let left = 0;
  let right = 0;
  let inHunk = false;
  for (const rawLine of unified.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    const header = HUNK_HEADER.exec(line);
    if (header) {
      left = Number(header[1]);
      right = Number(header[3]);
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line === "\\ No newline at end of file") continue;
    if (line.startsWith("-")) {
      lines.push({ left: left++, text: line.slice(1) });
    } else if (line.startsWith("+")) {
      lines.push({ right: right++, text: line.slice(1) });
    } else if (line.startsWith(" ")) {
      lines.push({ left: left++, right: right++, text: line.slice(1) });
    }
  }
  return lines;
}

function sourceLines(text: string, side: DiffSideName): DiffSearchLine[] {
  const normalized = text.replace(/\r\n/g, "\n");
  if (!normalized) return [];
  const rows = normalized.split("\n");
  if (normalized.endsWith("\n")) rows.pop();
  return rows.map((line, index) =>
    side === "left"
      ? { left: index + 1, text: line }
      : { right: index + 1, text: line },
  );
}

/**
 * Complete sources can be searched outside the hunks. Partial or truncated
 * results only expose the lines the patch actually contains.
 */
export function buildSearchLines(
  unified: string,
  full?: { left: string; right: string },
): DiffSearchLine[] {
  return full
    ? [...sourceLines(full.left, "left"), ...sourceLines(full.right, "right")]
    : parseUnifiedLines(unified);
}

export function findDiffMatches(
  lines: DiffSearchLine[],
  query: string,
  limit = 10_000,
) {
  const matches: DiffMatch[] = [];
  if (!query) return { matches, limited: false };
  const pattern = new RegExp(
    query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    "giu",
  );
  for (const line of lines) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(line.text))) {
      if (matches.length === limit) return { matches, limited: true };
      if (line.left !== undefined && line.right !== undefined)
        matches.push({
          line: line.right,
          side: "both",
          start: match.index,
          length: match[0].length,
        });
      else if (line.left !== undefined)
        matches.push({
          line: line.left,
          side: "left",
          start: match.index,
          length: match[0].length,
        });
      else if (line.right !== undefined)
        matches.push({
          line: line.right,
          side: "right",
          start: match.index,
          length: match[0].length,
        });
    }
  }
  return { matches, limited: false };
}

/** Hunk containing a source line on the requested side, or -1. */
export function hunkAtLine(
  hunks: DiffHunk[],
  side: DiffSideName,
  line: number,
) {
  return hunks.findIndex((hunk) => {
    const start = side === "left" ? hunk.leftStart : hunk.rightStart;
    const count = side === "left" ? hunk.leftCount : hunk.rightCount;
    return count > 0 && line >= start && line < start + count;
  });
}

/** First changed line of a hunk, preferring the requested side. */
export function hunkTargetLine(hunk: DiffHunk, side: DiffSideName) {
  return side === "left"
    ? (hunk.firstLeft ?? hunk.firstRight ?? hunk.leftStart)
    : (hunk.firstRight ?? hunk.firstLeft ?? hunk.rightStart);
}

/**
 * Map a source line in unchanged context to the additions line number that
 * @pierre/diffs uses for `revealLine`/context expansion.
 */
export function contextLineToRight(
  hunks: DiffHunk[],
  side: DiffSideName,
  line: number,
): number | undefined {
  if (side === "right") return line;
  const next = hunks.find((hunk) => hunk.leftStart > line);
  if (next) return line + (next.rightStart - next.leftStart);
  const last = hunks.at(-1);
  if (!last) return undefined;
  const delta =
    last.rightStart + last.rightCount - (last.leftStart + last.leftCount);
  return line + delta;
}
