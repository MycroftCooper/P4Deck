#!/usr/bin/env node
// 缓存体检：共享 Rust target 已经到 GB 级，需要能被看见和清理。
// 用法:
//   node scripts/workflow/cache.mjs status
//   node scripts/workflow/cache.mjs clean [--cargo] [--baseline] [--evidence] [--all] [--dry]
import { rm, readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CARGO_TARGET = path.join(os.tmpdir(), "p4deck-shared", "cargo-target");
const BASELINE = path.join(ROOT, "artifacts", "workflow", "baseline.json");
const EVIDENCE = path.join(ROOT, "artifacts", "evidence");
const METRICS = path.join(ROOT, "artifacts", "workflow", "metrics.jsonl");

async function sizeOf(target) {
  let bytes = 0;
  let files = 0;
  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      try {
        if (entry.isDirectory()) await walk(full);
        else {
          bytes += (await stat(full)).size;
          files += 1;
        }
      } catch {}
    }
  }
  await walk(target);
  return { bytes, files, mb: Math.round(bytes / 1024 / 1024) };
}

const args = process.argv.slice(2);
const command = args[0] ?? "status";

if (command === "status") {
  const cargo = await sizeOf(CARGO_TARGET);
  const evidence = await sizeOf(EVIDENCE);
  let baseline;
  try {
    baseline = (await stat(BASELINE)).mtime.toISOString();
  } catch {}
  let metrics = 0;
  try {
    metrics = (await (await stat(METRICS)).size);
  } catch {}
  process.stdout.write(
    `${JSON.stringify(
      {
        cargoTarget: { path: CARGO_TARGET, mb: cargo.mb, files: cargo.files },
        evidence: { mb: evidence.mb, files: evidence.files },
        baseline: baseline ?? null,
        metricsBytes: metrics,
      },
      null,
      2,
    )}\n`,
  );
} else if (command === "clean") {
  const dry = args.includes("--dry");
  const all = args.includes("--all");
  const targets = [];
  if (all || args.includes("--cargo")) targets.push({ name: "cargoTarget", path: CARGO_TARGET });
  if (all || args.includes("--baseline")) targets.push({ name: "baseline", path: BASELINE });
  if (all || args.includes("--evidence")) targets.push({ name: "evidence", path: EVIDENCE });
  if (!targets.length) {
    process.stderr.write("用法: cache.mjs clean [--cargo|--baseline|--evidence|--all] [--dry]\n");
    process.exit(2);
  }
  for (const target of targets) {
    const size = await sizeOf(target.path);
    if (dry) {
      process.stdout.write(`[dry] 将删除 ${target.name}（${size.mb}MB / ${size.files} files）\n`);
    } else {
      await rm(target.path, { recursive: true, force: true });
      process.stdout.write(`已删除 ${target.name}（${size.mb}MB）\n`);
    }
  }
} else {
  process.stderr.write("用法: node scripts/workflow/cache.mjs <status|clean> ...\n");
  process.exit(2);
}
