#!/usr/bin/env node
// 候选环境报告/校验（不修改任何文件，不设置父进程环境）。
// 用法:
//   node scripts/workflow/env-candidate.mjs --candidate <候选 source 目录>
//   node scripts/workflow/env-candidate.mjs --candidate <目录> --json
//
// 真正跑 cargo 时用包装器（Windows 执行策略禁止 .ps1，故用 .cmd）:
//   scripts\workflow\cargo-candidate.cmd check --offline --locked --lib
import { mkdir, copyFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const argv = process.argv.slice(2);
const index = argv.indexOf("--candidate");
const candidate = index >= 0 ? argv[index + 1] : undefined;

if (!candidate) {
  process.stderr.write("用法: node scripts/workflow/env-candidate.mjs --candidate <候选 source 目录> [--json]\n");
  process.exit(2);
}

const candidatePath = path.resolve(candidate);
const problems = [];
if (!existsSync(path.join(candidatePath, "package.json"))) {
  problems.push(`候选缺 package.json，不像 source 根: ${candidatePath}`);
}
const rel = path.relative(ROOT, candidatePath);
if (!rel.startsWith("..") && !path.isAbsolute(rel)) {
  problems.push(`候选必须位于原树之外；检测到 ${candidatePath}`);
}

const sharedRoot = path.join(os.tmpdir(), "p4deck-shared");
const cargoTarget = path.join(sharedRoot, "cargo-target");
const sccache = existsSync(path.join(sharedRoot, "sccache.exe")) ? path.join(sharedRoot, "sccache.exe") : undefined;

// 把原树的 tsc 增量产物复制进候选，避免候选里 tsc 每次冷跑（10s）。
// tsbuildinfo 记录的是文件哈希，候选源码不同时会自动重查差异文件，不会误判。
const copiedBuildInfo = [];
if (argv.includes("--copy-tsbuildinfo")) {
  for (const name of ["tsconfig.app.tsbuildinfo", "tsconfig.node.tsbuildinfo"]) {
    const from = path.join(ROOT, name);
    const to = path.join(candidatePath, name);
    if (!existsSync(from) || existsSync(to)) continue;
    await copyFile(from, to);
    copiedBuildInfo.push(name);
  }
}

const report = {
  candidate: candidatePath,
  outsideRepo: problems.length === 0,
  problems,
  copiedBuildInfo,
  env: {
    CARGO_TARGET_DIR: cargoTarget,
    RUSTC_WRAPPER: sccache ?? null,
  },
  powershell: [
    `$env:CARGO_TARGET_DIR = "${cargoTarget}"`,
    ...(sccache ? [`$env:RUSTC_WRAPPER = "${sccache}"`] : []),
    "# 或直接使用包装器: .\\scripts\\workflow\\cargo-candidate.cmd check --offline --locked --lib",
  ],
};

if (problems.length === 0) {
  await mkdir(cargoTarget, { recursive: true });
}

if (argv.includes("--json")) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  process.stdout.write(`候选: ${report.candidate}\n`);
  process.stdout.write(`共享 Rust 缓存: ${cargoTarget}\n`);
  process.stdout.write(`sccache: ${sccache ?? "未发现（仅共享 target 生效）"}\n`);
  if (copiedBuildInfo.length) process.stdout.write(`已复制 tsc 增量缓存: ${copiedBuildInfo.join(", ")}\n`);
  for (const line of report.powershell) process.stdout.write(`${line}\n`);
  if (problems.length) {
    process.stderr.write(`问题: ${problems.join("; ")}\n`);
  }
}
if (problems.length) process.exitCode = 1;
