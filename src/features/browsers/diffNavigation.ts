import type { DiffRow } from "./diffRows";

export type DiffSideName = "left" | "right";
export interface DiffMatch {
  row: number;
  /** Identical context is one result, highlighted in both panes. */
  side: DiffSideName | "both";
  start: number;
  length: number;
}
export interface DiffNavigation {
  row: number;
  side: DiffSideName;
  sequence: number;
  align: "start" | "center";
}

export function indexDiffRows(rows: DiffRow[]) {
  const hunks: number[] = [];
  const left = new Map<number, number>();
  const right = new Map<number, number>();
  rows.forEach((row, index) => {
    if (row.kind === "hunk") hunks.push(index);
    else {
      if (row.left) left.set(row.left.number, index);
      if (row.right) right.set(row.right.number, index);
    }
  });
  return { hunks, left, right };
}

export function hunkAtRow(hunks: number[], row: number) {
  let low = 0;
  let high = hunks.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (hunks[middle] <= row) low = middle + 1;
    else high = middle;
  }
  return low - 1;
}

export function findDiffMatches(
  rows: DiffRow[],
  query: string,
  limit = 10_000,
) {
  const matches: DiffMatch[] = [];
  if (!query) return { matches, limited: false };
  const pattern = new RegExp(
    query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    "giu",
  );
  for (let row = 0; row < rows.length; row++) {
    const value = rows[row];
    if (value.kind !== "line") continue;
    const shared = value.left && value.left.text === value.right?.text;
    for (const side of ["left", "right"] as const) {
      const line = value[side];
      if (!line || (shared && side === "right")) continue;
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(line.text))) {
        if (matches.length === limit) return { matches, limited: true };
        matches.push({
          row,
          side: shared ? "both" : side,
          start: match.index,
          length: match[0].length,
        });
      }
    }
  }
  return { matches, limited: false };
}
