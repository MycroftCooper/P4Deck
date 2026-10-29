#!/usr/bin/env node
// 一条命令收尾：import → evidence → board(md) → board(html)，并记一行量测。
// 用法: node scripts/workflow/sync.mjs [--quiet]
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const START = Date.now();

function run(args) {
  const result = spawnSync(process.execPath, args, { cwd: ROOT, encoding: "utf8" });
  return { ok: result.status === 0, out: (result.stdout ?? "").trim(), err: (result.stderr ?? "").trim() };
}

const steps = [
  ["import", ["scripts/workflow/state.mjs", "import"]],
  ["evidence", ["scripts/workflow/evidence.mjs"]],
  ["board", ["scripts/workflow/state.mjs", "board"]],
  ["html", ["scripts/workflow/board.mjs"]],
];

const results = [];
for (const [name, args] of steps) {
  const result = run(args);
  results.push({ name, ...result });
  if (!result.ok) {
    process.stderr.write(`${name} 失败:\n${result.err || result.out}\n`);
    process.exit(1);
  }
}

const totalMs = Date.now() - START;
run([
  "scripts/workflow/measure.mjs",
  "record",
  "--batch",
  "CON06+ACTION-R01",
  "--role",
  "LEAD",
  "--event",
  "sync",
  "--gateMs",
  String(totalMs),
]);

const check = run(["scripts/workflow/state.mjs", "check"]);
let summary = { ok: check.ok };
try {
  summary = JSON.parse(check.out.slice(check.out.indexOf("{")));
} catch {}
process.stdout.write(
  `sync 完成 ${totalMs}ms｜包 ${summary.checked ?? "?"}｜切片 ${summary.slices ?? "?"}｜警告 ${summary.warningCount ?? 0}｜看板已刷新\n`,
);
if (!check.ok) process.exit(1);
