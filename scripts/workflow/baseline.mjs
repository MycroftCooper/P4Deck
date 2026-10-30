#!/usr/bin/env node
// 本片基线：不依赖 commit，记录“本片开始时”的文件 hash，之后只比较变化。
//
// 用法:
//   node scripts/workflow/baseline.mjs start            # 记录当前基线
//   node scripts/workflow/baseline.mjs changed [--json] # 相对基线改了哪些文件
//   node scripts/workflow/baseline.mjs status
import { createHash } from "node:crypto";
import { readFile, readdir, stat, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const BASELINE_FILE = process.env.P4DECK_BASELINE ?? path.join(ROOT, "artifacts", "workflow", "baseline.json");
const ROOTS = ["src", "src-tauri", "scripts", "tools", "tests", "ForAIDoc"];
const ROOT_FILES = ["package.json", "tsconfig.json", "tsconfig.app.json", "tsconfig.node.json", "tsconfig.tests.json", "vite.config.ts"];
const SKIP_SEGMENTS = new Set([
  "node_modules",
  "target",
  "target-qa",
  "dist",
  "artifacts",
  ".git",
  ".local",
  "test-results",
  "playwright-report",
  ".cache",
  "coverage",
  ".pnpm-store",
]);
const SKIP_SUFFIX = [".tsbuildinfo", ".log"];

/** 按路径段判断，避免 src-tauri/target(46GB) 之类被当成源码扫描。 */
function shouldSkip(rel) {
  if (rel.split("/").some((segment) => SKIP_SEGMENTS.has(segment))) return true;
  return SKIP_SUFFIX.some((suffix) => rel.endsWith(suffix));
}

async function walk(dir, out = []) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(ROOT, full).split(path.sep).join("/");
    if (shouldSkip(rel)) continue;
    if (entry.isDirectory()) await walk(full, out);
    else out.push(rel);
  }
  return out;
}

async function fileHash(rel) {
  try {
    return createHash("sha256").update(await readFile(path.join(ROOT, rel))).digest("hex").slice(0, 16);
  } catch {
    return null;
  }
}

async function snapshot() {
  const files = [];
  for (const root of ROOTS) files.push(...(await walk(path.join(ROOT, root))));
  for (const name of ROOT_FILES) {
    try {
      await stat(path.join(ROOT, name));
      files.push(name);
    } catch {}
  }
  const hashes = {};
  for (const rel of files) hashes[rel] = await fileHash(rel);
  return hashes;
}

async function start() {
  const hashes = await snapshot();
  await mkdir(path.dirname(BASELINE_FILE), { recursive: true });
  await writeFile(
    BASELINE_FILE,
    `${JSON.stringify({ schemaVersion: 1, startedAt: new Date().toISOString(), files: hashes }, null, 2)}\n`,
    "utf8",
  );
  process.stdout.write(`基线已记录：${Object.keys(hashes).length} 个文件 → ${path.relative(ROOT, BASELINE_FILE)}\n`);
  return 0;
}

async function loadBaseline() {
  try {
    return JSON.parse(await readFile(BASELINE_FILE, "utf8"));
  } catch {
    return undefined;
  }
}

async function changed(args) {
  const baseline = await loadBaseline();
  if (!baseline) {
    process.stderr.write("还没有基线，先跑: node scripts/workflow/baseline.mjs start\n");
    return 2;
  }
  const current = await snapshot();
  const list = [];
  for (const [file, hash] of Object.entries(current)) {
    if (baseline.files[file] !== hash) list.push(file);
  }
  for (const file of Object.keys(baseline.files)) {
    if (!(file in current)) list.push(file);
  }
  list.sort();
  if (args.includes("--json")) {
    process.stdout.write(`${JSON.stringify({ startedAt: baseline.startedAt, count: list.length, files: list }, null, 2)}\n`);
  } else {
    process.stdout.write(`相对基线（${baseline.startedAt}）变化 ${list.length} 个文件\n`);
    for (const file of list.slice(0, 200)) process.stdout.write(`  ${file}\n`);
    if (list.length > 200) process.stdout.write(`  … 还有 ${list.length - 200} 个\n`);
  }
  return 0;
}

const [command] = process.argv.slice(2);
if (command === "start") process.exit(await start());
else if (command === "changed") process.exit(await changed(process.argv.slice(3)));
else if (command === "status") {
  const baseline = await loadBaseline();
  process.stdout.write(`${JSON.stringify({ exists: Boolean(baseline), startedAt: baseline?.startedAt, files: baseline ? Object.keys(baseline.files).length : 0 }, null, 2)}\n`);
} else {
  process.stderr.write("usage: node scripts/workflow/baseline.mjs <start|changed|status>\n");
  process.exit(2);
}
