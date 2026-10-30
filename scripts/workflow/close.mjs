#!/usr/bin/env node
// 批次收尾：刷新状态/看板，并把"该清的构建产物"摆到眼前（只报告，不删除）。
//
//   node scripts/workflow/close.mjs [--json]
//
// 清理仍由人显式执行：cache.mjs clean ...（见输出里的建议命令）。
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { readTodos } from "./human-todos.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function run(args) {
  return spawnSync(process.execPath, args, { cwd: ROOT, encoding: "utf8" });
}

const sync = run(["scripts/workflow/sync.mjs"]);
if (sync.status !== 0) {
  process.stderr.write(`sync 失败:\n${sync.stderr || sync.stdout}\n`);
  process.exit(sync.status ?? 1);
}

let cache = {};
try {
  cache = JSON.parse(run(["scripts/workflow/cache.mjs", "status", "--json"]).stdout);
} catch {}
let state = { packages: [] };
try {
  state = JSON.parse((await readFile(path.join(ROOT, "ForAIDoc", "PM", "工作流", "state.json"), "utf8")).replace(/^\uFEFF/, ""));
} catch {}
const packages = Array.isArray(state.packages) ? state.packages : [];
const todos = (await readTodos()).items.filter((todo) => !todo.done);
const BIG_MB = 10 * 1024;
const report = {
  packages: packages.length,
  archived: packages.filter((entry) => entry.archived === true).length,
  humanTodos: todos.map((todo) => todo.id),
  disk: {},
  big: [],
};
for (const [key, value] of Object.entries(cache)) {
  if (!value || typeof value !== "object") continue;
  if (typeof value.mb === "number") {
    report.disk[key] = `${value.gb}GB`;
    if (value.mb >= BIG_MB) report.big.push(key);
  }
  if (key === "tempCandidates") report.disk.tempCandidates = `${value.count} 个候选`;
}
report.disk.gitLfs = `${cache.gitLfs?.gb ?? 0}GB`;

if (process.argv.includes("--json")) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exit(0);
}

process.stdout.write(`批次收尾：${report.packages ?? "?"} 个包（归档 ${report.archived ?? "?"}）\n`);
process.stdout.write(`人类待办未完成：${report.humanTodos.join(", ") || "无"}\n`);
process.stdout.write(`磁盘：${Object.entries(report.disk).map(([key, value]) => `${key}=${value}`).join("  ")}\n`);
if (report.big.length) {
  process.stdout.write(`超过 10GB 的项：${report.big.join(", ")}\n`);
  process.stdout.write("建议（显式执行）：\n");
  const suggestions = {
    incremental: "node scripts/workflow/cache.mjs clean --incremental",
    release: "node scripts/workflow/cache.mjs clean --release",
    targetQa: "node scripts/workflow/cache.mjs clean --target-qa",
    tempCandidates: "node scripts/workflow/cache.mjs clean --temp-candidates --days 2",
    cargoTarget: "node scripts/workflow/cache.mjs clean --cargo",
    workspaceTarget: "node scripts/workflow/cache.mjs clean --release   # 依赖缓存保留，先清 release",
  };
  for (const key of report.big) {
    if (suggestions[key]) process.stdout.write(`  ${suggestions[key]}\n`);
  }
} else {
  process.stdout.write("磁盘没有超过 10GB 的单项，无需清理。\n");
}
