// DIFF-02 evidence: compare the old full-text diff path with the new
// parse-the-backend-patch path on the same 100k-line content.
// Run from the repository root: node src/features/browsers/bench/diffParseBench.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDiffFromFile, parsePatchFiles } from "@pierre/diffs";

const LINE_COUNT = 100_000;
const ITERATIONS = 5;
const CHANGED = [
  120, 1_530, 4_400, 9_100, 15_600, 22_300, 30_050, 38_000, 47_000, 56_000,
  65_000, 74_000, 83_000, 91_000, 97_500,
];

const base = Array.from({ length: LINE_COUNT }, (_, index) => {
  return `line ${index + 1}: the quick brown fox jumps over the lazy dog`;
});
const changed = [...base];
for (const line of CHANGED)
  changed[line - 1] = `${base[line - 1]} (edited)`;

const oldText = `${base.join("\n")}\n`;
const newText = `${changed.join("\n")}\n`;

/** Build the unified patch similar (context radius 3) would emit for this pair. */
function buildPatch() {
  const rows = ["--- Have", "+++ Workspace"];
  for (const line of CHANGED) {
    const start = Math.max(1, line - 3);
    const before = line - start;
    const after = Math.min(3, LINE_COUNT - line);
    const deletionCount = before + 1 + after;
    const additionCount = before + 1 + after;
    rows.push(`@@ -${start},${deletionCount} +${start},${additionCount} @@`);
    for (let index = start; index < line; index++)
      rows.push(` ${base[index - 1]}`);
    rows.push(`-${base[line - 1]}`);
    rows.push(`+${changed[line - 1]}`);
    for (let index = line + 1; index <= line + after; index++)
      rows.push(` ${base[index - 1]}`);
  }
  return `${rows.join("\n")}\n`;
}

const patch = buildPatch();

function measure(run) {
  const before = process.memoryUsage().heapUsed;
  const start = performance.now();
  const result = run();
  const elapsed = performance.now() - start;
  const heapDelta = process.memoryUsage().heapUsed - before;
  return { elapsed, heapDelta, result };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function summarize(samples) {
  const times = samples.map((sample) => sample.elapsed);
  return {
    runsMs: times.map((value) => Number(value.toFixed(2))),
    medianMs: Number(median(times).toFixed(2)),
    minMs: Number(Math.min(...times).toFixed(2)),
    medianHeapDeltaBytes: median(samples.map((sample) => sample.heapDelta)),
  };
}

// Warm up both paths so module init and shiki registry are out of the numbers.
measure(() => parseDiffFromFile({ name: "file.txt", contents: oldText }, { name: "file.txt", contents: newText }));
measure(() => parsePatchFiles(patch, "bench", true));

const oldSamples = [];
const newSamples = [];
for (let iteration = 0; iteration < ITERATIONS; iteration++) {
  oldSamples.push(
    measure(() =>
      parseDiffFromFile(
        { name: "file.txt", contents: oldText },
        { name: "file.txt", contents: newText },
      ),
    ),
  );
  newSamples.push(
    measure(() => parsePatchFiles(patch, `bench-${iteration}`, true)),
  );
}

const oldMeta = oldSamples.at(-1).result;
const newMeta = newSamples.at(-1).result[0]?.files[0];
const oldSummary = summarize(oldSamples);
const newSummary = summarize(newSamples);
const report = {
  task: "DIFF-02",
  generatedAt: new Date().toISOString(),
  environment: {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
  },
  input: {
    lineCount: LINE_COUNT,
    changedLines: CHANGED.length,
    oldBytes: Buffer.byteLength(oldText),
    newBytes: Buffer.byteLength(newText),
    patchBytes: Buffer.byteLength(patch),
  },
  oldPath: {
    api: "parseDiffFromFile(oldFile, newFile)",
    ...oldSummary,
    hunks: oldMeta.hunks.length,
    isPartial: oldMeta.isPartial,
  },
  newPath: {
    api: "parsePatchFiles(patch, cacheKey, true)",
    ...newSummary,
    hunks: newMeta.hunks.length,
    isPartial: newMeta.isPartial,
  },
  speedup: Number((oldSummary.medianMs / newSummary.medianMs).toFixed(2)),
};
report.verified =
  report.oldPath.hunks === report.newPath.hunks &&
  report.oldPath.hunks === CHANGED.length;

const here = dirname(fileURLToPath(import.meta.url));
const evidenceDir = resolve(
  here,
  "../../../../artifacts/evidence/2026-10-31-DIFF-02",
);
mkdirSync(evidenceDir, { recursive: true });
writeFileSync(
  resolve(evidenceDir, "benchmark.json"),
  `${JSON.stringify(report, null, 2)}\n`,
  "utf8",
);

const markdown = [
  "# DIFF-02 benchmark (100k lines)",
  "",
  `- Generated: ${report.generatedAt}`,
  `- Node: ${report.environment.node} (${report.environment.platform}/${report.environment.arch})`,
  `- Input: ${LINE_COUNT} lines, ${CHANGED.length} changed lines, patch ${report.input.patchBytes} bytes`,
  `- Iterations: ${ITERATIONS} after one warm-up; values are wall-clock milliseconds`,
  "",
  "| path | api | median | min | hunk count | isPartial |",
  "| --- | --- | ---: | ---: | ---: | --- |",
  `| old | \`parseDiffFromFile\` | ${oldSummary.medianMs} | ${oldSummary.minMs} | ${oldMeta.hunks.length} | ${oldMeta.isPartial} |`,
  `| new | \`parsePatchFiles\` | ${newSummary.medianMs} | ${newSummary.minMs} | ${newMeta.hunks.length} | ${newMeta.isPartial} |`,
  "",
  `- Median speedup of parsing the backend patch over re-diffing both full texts: **${report.speedup}x**`,
  `- Median heap delta: old ${oldSummary.medianHeapDeltaBytes} bytes, new ${newSummary.medianHeapDeltaBytes} bytes`,
  `- Verified hunk counts match: ${report.verified}`,
  "",
  "The new path never calls jsdiff over the file contents: it parses the unified patch that Rust's `similar` already produced. The old path re-runs the diff algorithm in the renderer.",
  "",
].join("\n");
writeFileSync(resolve(evidenceDir, "REPORT.md"), markdown, "utf8");

console.log(JSON.stringify(report, null, 2));
