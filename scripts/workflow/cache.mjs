#!/usr/bin/env node
// 磁盘/缓存体检：Rust target、git LFS 残留、TEMP 候选目录都要能被看见和清理。
//
// 用法:
//   node scripts/workflow/cache.mjs status [--json]
//   node scripts/workflow/cache.mjs clean --incremental [--dry]
//   node scripts/workflow/cache.mjs clean --release|--target-qa|--workspace-target [--dry]
//   node scripts/workflow/cache.mjs clean --lfs [--dry]          # git lfs prune（只删未引用对象）
//   node scripts/workflow/cache.mjs clean --temp-candidates --days 2 [--dry]
//   node scripts/workflow/cache.mjs clean --cargo|--baseline|--evidence|--all [--dry]
import { rm, readdir, stat, mkdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const TEMP = os.tmpdir();
const PATHS = {
  cargoTarget: path.join(TEMP, "p4deck-shared", "cargo-target"),
  workspaceTarget: path.join(ROOT, "src-tauri", "target"),
  incremental: path.join(ROOT, "src-tauri", "target", "debug", "incremental"),
  release: path.join(ROOT, "src-tauri", "target", "release"),
  targetQa: path.join(ROOT, "src-tauri", "target-qa"),
  gitLfs: path.join(ROOT, ".git", "lfs"),
  baseline: path.join(ROOT, "artifacts", "workflow", "baseline.json"),
  evidence: path.join(ROOT, "artifacts", "evidence"),
  metrics: path.join(ROOT, "artifacts", "workflow", "metrics.jsonl"),
};

async function sizeOf(target) {
  let entries;
  try {
    entries = await readdir(target, { recursive: true, withFileTypes: true });
  } catch {
    return { bytes: 0, files: 0, mb: 0 };
  }
  const paths = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const base = entry.parentPath ?? entry.path ?? target;
    paths.push(path.join(base, entry.name));
  }
  let bytes = 0;
  let files = 0;
  const CHUNK = 512;
  for (let index = 0; index < paths.length; index += CHUNK) {
    const stats = await Promise.all(
      paths.slice(index, index + CHUNK).map((file) => stat(file).catch(() => null)),
    );
    for (const info of stats) {
      if (!info) continue;
      bytes += info.size;
      files += 1;
    }
  }
  return { bytes, files, mb: Math.round(bytes / 1024 / 1024) };
}

async function tempCandidates() {
  let entries = [];
  try {
    entries = await readdir(TEMP, { withFileTypes: true });
  } catch {
    return [];
  }
  const list = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith("P4Deck-")) continue;
    const full = path.join(TEMP, entry.name);
    let info;
    try {
      info = await stat(full);
    } catch {
      continue;
    }
    list.push({ name: entry.name, path: full, mtime: info.mtimeMs });
  }
  return list;
}

function gb(bytes) {
  return Math.round((bytes / 1024 ** 3) * 100) / 100;
}

const args = process.argv.slice(2);
const command = args[0] ?? "status";

if (command === "status") {
  const labels = [
    ["cargoTarget", PATHS.cargoTarget],
    ["workspaceTarget", PATHS.workspaceTarget],
    ["incremental", PATHS.incremental],
    ["release", PATHS.release],
    ["targetQa", PATHS.targetQa],
    ["gitLfs", PATHS.gitLfs],
    ["evidence", PATHS.evidence],
  ];
  const report = {};
  for (const [name, target] of labels) report[name] = { path: target, ...(await sizeOf(target)), gb: 0 };
  for (const key of Object.keys(report)) report[key].gb = gb(report[key].bytes);
  const candidates = await tempCandidates();
  let candidateBytes = 0;
  if (args.includes("--sizes")) {
    for (const candidate of candidates) candidateBytes += (await sizeOf(candidate.path)).bytes;
  }
  report.tempCandidates = {
    count: candidates.length,
    bytes: candidateBytes,
    gb: gb(candidateBytes),
    note: args.includes("--sizes") ? undefined : "只统计数量；加 --sizes 才遍历体积（129 个候选约 150GB，很慢）",
  };
  try {
    report.baseline = { mtime: (await stat(PATHS.baseline)).mtime.toISOString() };
  } catch {
    report.baseline = null;
  }
  const output = args.includes("--json") ? JSON.stringify(report, null, 2) : JSON.stringify(report, null, 2);
  process.stdout.write(`${output}\n`);
} else if (command === "clean") {
  const dry = args.includes("--dry");
  const daysIndex = args.indexOf("--days");
  const days = daysIndex >= 0 ? Number(args[daysIndex + 1]) : 1;
  const targets = [];
  if (args.includes("--cargo")) targets.push({ name: "cargoTarget", path: PATHS.cargoTarget });
  if (args.includes("--baseline")) targets.push({ name: "baseline", path: PATHS.baseline });
  if (args.includes("--evidence")) targets.push({ name: "evidence", path: PATHS.evidence });
  if (args.includes("--incremental")) targets.push({ name: "incremental", path: PATHS.incremental });
  if (args.includes("--release")) targets.push({ name: "release", path: PATHS.release });
  if (args.includes("--target-qa")) targets.push({ name: "targetQa", path: PATHS.targetQa });
  if (args.includes("--workspace-target")) targets.push({ name: "workspaceTarget", path: PATHS.workspaceTarget });
  if (args.includes("--all")) {
    targets.push({ name: "cargoTarget", path: PATHS.cargoTarget });
    targets.push({ name: "baseline", path: PATHS.baseline });
    targets.push({ name: "evidence", path: PATHS.evidence });
  }

  for (const target of targets) {
    const size = await sizeOf(target.path);
    if (dry) {
      process.stdout.write(`[dry] 将删除 ${target.name}（${size.mb}MB / ${size.files} files）\n`);
    } else {
      await rm(target.path, { recursive: true, force: true });
      await mkdir(target.path, { recursive: true }).catch(() => {});
      process.stdout.write(`已删除 ${target.name}（${size.mb}MB）\n`);
    }
  }

  if (args.includes("--lfs")) {
    if (dry) {
      const result = spawnSync("git", ["lfs", "prune", "--dry-run"], { cwd: ROOT, encoding: "utf8" });
      process.stdout.write(`[dry] git lfs prune\n${(result.stdout || "").trim().split("\n").slice(0, 3).join("\n")}\n`);
    } else {
      const result = spawnSync("git", ["lfs", "prune"], { cwd: ROOT, encoding: "utf8" });
      process.stdout.write(`git lfs prune: ${(result.stdout || "").trim().split("\n").slice(-2).join(" / ")}\n`);
    }
  }

  if (args.includes("--temp-candidates")) {
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    const candidates = (await tempCandidates()).filter((candidate) => candidate.mtime < cutoff);
    let reclaimed = 0;
    for (const candidate of candidates) {
      const size = await sizeOf(candidate.path);
      reclaimed += size.bytes;
      if (dry) process.stdout.write(`[dry] 将删除候选 ${candidate.name}（${size.mb}MB）\n`);
      else {
        await rm(candidate.path, { recursive: true, force: true });
        process.stdout.write(`已删除候选 ${candidate.name}（${size.mb}MB）\n`);
      }
    }
    process.stdout.write(`TEMP 候选：${candidates.length} 个，合计 ${gb(reclaimed)}GB${dry ? "（dry-run）" : ""}\n`);
  }

  if (!targets.length && !args.includes("--lfs") && !args.includes("--temp-candidates")) {
    process.stderr.write(
      "用法: cache.mjs clean [--cargo|--baseline|--evidence|--incremental|--release|--target-qa|--workspace-target|--lfs|--temp-candidates --days N|--all] [--dry]\n",
    );
    process.exit(2);
  }
} else {
  process.stderr.write("用法: node scripts/workflow/cache.mjs <status|clean> ...\n");
  process.exit(2);
}
