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

// 不再额外跑一次 state check（board/import 已读同一份 state）；计数直接取 import 输出。
const importOut = results.find((step) => step.name === "import")?.out ?? "";
const counts = importOut.match(/主包 (\d+) \+ 归档 (\d+) = (\d+)，切片 (\d+)，子项 (\d+)/);
process.stdout.write(
  `sync 完成 ${totalMs}ms｜包 ${counts?.[3] ?? "?"}（归档 ${counts?.[2] ?? "?"}）｜切片 ${counts?.[4] ?? "?"}｜看板已刷新\n`,
);
