export interface DiffLine {
  number: number;
  text: string;
  noNewline?: boolean;
}

export type DiffRow =
  | { kind: "hunk"; label: string }
  | {
      kind: "line";
      changed: boolean;
      left?: DiffLine;
      right?: DiffLine;
    };

/** Align each replacement block without inventing lines on its shorter side. */
export function buildDiffRows(
  unified: string,
  sources?: { left: string; right: string },
): DiffRow[] {
  const rows: DiffRow[] = [];
  let leftNumber = 0;
  let rightNumber = 0;
  let inHunk = false;
  let removed: DiffLine[] = [];
  let added: DiffLine[] = [];
  let previousLeft: DiffLine | undefined;
  let previousRight: DiffLine | undefined;
  const flush = () => {
    for (
      let index = 0;
      index < Math.max(removed.length, added.length);
      index++
    ) {
      rows.push({
        kind: "line",
        changed: true,
        left: removed[index],
        right: added[index],
      });
    }
    removed = [];
    added = [];
  };
  for (const rawLine of unified.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      flush();
      leftNumber = Number(hunk[1]);
      rightNumber = Number(hunk[2]);
      inHunk = true;
      previousLeft = undefined;
      previousRight = undefined;
      rows.push({ kind: "hunk", label: line });
      continue;
    }
    if (!inHunk) continue;
    if (line === "\\ No newline at end of file") {
      if (previousLeft) previousLeft.noNewline = true;
      if (previousRight) previousRight.noNewline = true;
      continue;
    }
    switch (line[0]) {
      case "-": {
        const removedLine = { number: leftNumber++, text: line.slice(1) };
        removed.push(removedLine);
        previousLeft = removedLine;
        previousRight = undefined;
        break;
      }
      case "+": {
        const addedLine = { number: rightNumber++, text: line.slice(1) };
        added.push(addedLine);
        previousLeft = undefined;
        previousRight = addedLine;
        break;
      }
      case " ": {
        flush();
        const left = { number: leftNumber++, text: line.slice(1) };
        const right = { number: rightNumber++, text: line.slice(1) };
        rows.push({
          kind: "line",
          changed: false,
          left,
          right,
        });
        previousLeft = left;
        previousRight = right;
        break;
      }
      // File headers precede hunks; the trailing patch newline consumes no line.
    }
  }
  flush();
  return sources ? expandContext(rows, sources) : rows;
}

function sourceLines(text: string): DiffLine[] {
  const normalized = text.replace(/\r\n/g, "\n");
  if (!normalized) return [];
  const lines = normalized.split("\n");
  if (normalized.endsWith("\n")) lines.pop();
  return lines.map((text, index) => ({
    number: index + 1,
    text,
    ...(index === lines.length - 1 && !normalized.endsWith("\n")
      ? { noNewline: true }
      : {}),
  }));
}

/** Fill omitted context only when the complete sources agree with the patch. */
function expandContext(
  patch: DiffRow[],
  sources: { left: string; right: string },
): DiffRow[] {
  const left = sourceLines(sources.left);
  const right = sourceLines(sources.right);
  const rows: DiffRow[] = [];
  let l = 0;
  let r = 0;
  const contextUntil = (leftEnd: number, rightEnd: number) => {
    if (
      leftEnd < l ||
      rightEnd < r ||
      leftEnd > left.length ||
      rightEnd > right.length ||
      leftEnd - l !== rightEnd - r
    )
      return false;
    while (l < leftEnd) {
      if (
        left[l].text !== right[r].text ||
        left[l].noNewline !== right[r].noNewline
      )
        return false;
      rows.push({
        kind: "line",
        changed: false,
        left: left[l++],
        right: right[r++],
      });
    }
    return true;
  };
  for (const row of patch) {
    if (row.kind === "hunk") {
      const bounds = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(
        row.label,
      )!;
      // A zero-length range starts after the specified line (e.g. -3,0).
      const leftStart = Number(bounds[1]) - (bounds[2] === "0" ? 0 : 1);
      const rightStart = Number(bounds[3]) - (bounds[4] === "0" ? 0 : 1);
      if (!contextUntil(leftStart, rightStart)) return patch;
      rows.push(row);
    } else {
      if (
        (row.left &&
          (row.left.number !== l + 1 || row.left.text !== left[l]?.text)) ||
        (row.right &&
          (row.right.number !== r + 1 || row.right.text !== right[r]?.text))
      )
        return patch;
      rows.push({
        ...row,
        left: row.left ? left[l++] : undefined,
        right: row.right ? right[r++] : undefined,
      });
    }
  }
  return contextUntil(left.length, right.length) ? rows : patch;
}
