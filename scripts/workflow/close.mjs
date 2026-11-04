#!/usr/bin/env node
// 批次收尾：刷新状态/看板，自动清增量编译缓存，并把"该清的构建产物"摆到眼前。
//
//   node scripts/workflow/close.mjs [--json] [--dry] [--no-clean]
//
// 默认自动删除 src-tauri/target/debug/incremental（到达阈值时；阈值用
// P4DECK_CLOSE_CLEAN_MB 调，默认 2048）。--dry 只报告不删除，--no-clean 整体跳过。
// 其余 target 产物仍然只报告，由人显式执行 cache.mjs clean --release / --workspace-target。
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { readTodos } from "./human-todos.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const configuredLimit = Number(process.env.P4DECK_CLOSE_CLEAN_MB || 2048);
const CLEAN_LIMIT_MB = Number.isFinite(configuredLimit) ? configuredLimit : 2048;
const noClean = process.argv.includes("--no-clean");
const dryRun = process.argv.includes("--dry");

function run(args) {
  return spawnSync(process.execPath, args, { cwd: ROOT, encoding: "utf8" });
}

function toGb(mb) {
  return `${Math.round((mb / 1024) * 100) / 100}GB`;
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

// 增量缓存是纯缓存：收尾时自动回收，避免像 2026-11 那样堆到 31GB。
// 体积用 status 已经量过的值传给 clean，省掉一次全量扫描。
const incrementalMb = Number(cache.incremental?.mb ?? 0);
let cleaned = null;
if (!noClean && incrementalMb > 0 && incrementalMb >= CLEAN_LIMIT_MB) {
  const cleanArgs = ["scripts/workflow/cache.mjs", "clean", "--incremental", "--size-mb", String(incrementalMb)];
  if (dryRun) cleanArgs.push("--dry");
  const result = run(cleanArgs);
  if (result.status === 0) {
    // 先攒着，等 --json 分支退出后再打，避免污染 JSON 输出。
    cleaned = {
      mb: incrementalMb,
      gb: toGb(incrementalMb),
      dry: dryRun,
      output: (result.stdout ?? "").trim(),
    };
    if (!dryRun && cache.incremental) {
      cache.incremental.mb = 0;
      cache.incremental.gb = 0;
    }
  } else {
    process.stderr.write(`清增量缓存失败：${result.stderr || result.stdout}\n`);
  }
}

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
  incrementalCleanup: {
    mb: incrementalMb,
    limitMb: CLEAN_LIMIT_MB,
    cleaned: cleaned ? !cleaned.dry : false,
    dryRun,
    skipped: cleaned ? null : noClean ? "--no-clean" : "below-limit",
  },
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
if (cleaned) {
  report.disk.incremental = cleaned.dry ? `${cleaned.gb}（dry-run 待清）` : "0GB（已清）";
}

if (process.argv.includes("--json")) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exit(0);
}

process.stdout.write(`批次收尾：${report.packages ?? "?"} 个包（归档 ${report.archived ?? "?"}）\n`);
process.stdout.write(`人类待办未完成：${report.humanTodos.join(", ") || "无"}\n`);
process.stdout.write(`磁盘：${Object.entries(report.disk).map(([key, value]) => `${key}=${value}`).join("  ")}\n`);
if (cleaned) {
  if (cleaned.output) process.stdout.write(`${cleaned.output}\n`);
  process.stdout.write(
    cleaned.dry
      ? `增量缓存：将清理 ${cleaned.gb}（dry-run，未删除）\n`
      : `增量缓存：已清理 ${cleaned.gb}（下次首次编译会重建）\n`,
  );
} else if (noClean) {
  process.stdout.write(`增量缓存：${toGb(incrementalMb)}，--no-clean 跳过清理\n`);
} else {
  process.stdout.write(`增量缓存：${toGb(incrementalMb)}，未达 ${toGb(CLEAN_LIMIT_MB)} 阈值，保留\n`);
}
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
