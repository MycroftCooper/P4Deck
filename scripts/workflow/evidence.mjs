#!/usr/bin/env node
// 把批次回执变成 state.json 里的验收事实（四层状态不再靠手写）。
//
// 用法:
//   node scripts/workflow/evidence.mjs                   扫描 artifacts/evidence 并回填
//   node scripts/workflow/evidence.mjs --dry             只看会改什么
//   node scripts/workflow/evidence.mjs --collect-temp    先从 %TEMP% 的 P4Deck-* 收集可识别回执
//
// 回执识别（看内容，不看文件名）:
//   qa     : noninteractiveQA==="passed" | passed===true
//   apply  : originalApplied===true | (complete===true 且带 mode)
//   manifest: files[].path + manifest sha
// 归因:
//   包   ← apply/qa 回执里的文件路径 命中 package.evidence
//   切片 ← 回执的 task/batchId 命中 slice.id（大小写不敏感，允许前缀）
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
const stripBom = (text) => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const STATE_FILE = path.join(ROOT, "ForAIDoc", "PM", "工作流", "state.json");
const EVIDENCE_DIR = path.join(ROOT, "artifacts", "evidence");
const MAX_RECEIPT_BYTES = 8 * 1024 * 1024;

const args = process.argv.slice(2);
const dryRun = args.includes("--dry");
const collectTemp = args.includes("--collect-temp");

const ADVANCEABLE = new Set(["todo", "in_progress", "frozen", "qa", "qa_with_gap"]);

function normalize(filePath) {
  return String(filePath).replace(/\\/g, "/").replace(/^\.\//, "");
}

function shaOf(payload) {
  if (typeof payload.manifestSha256 === "string") return payload.manifestSha256;
  if (typeof payload.manifestSHA256 === "string") return payload.manifestSHA256;
  if (typeof payload.manifest === "string") return payload.manifest;
  if (payload.manifest && typeof payload.manifest === "object") {
    return payload.manifest.manifestSha256 ?? payload.manifest.sha256;
  }
  return undefined;
}

function pathsOf(payload) {
  const out = new Set();
  for (const key of ["written", "files", "paths", "changed", "verifiedFiles"]) {
    const value = payload[key];
    if (!Array.isArray(value)) continue;
    for (const item of value) {
      if (typeof item === "string") out.add(normalize(item));
      else if (item && typeof item === "object" && typeof item.path === "string") out.add(normalize(item.path));
    }
  }
  return out;
}

function taskOf(payload) {
  const raw = payload.batchId ?? payload.task;
  return typeof raw === "string" ? raw.trim() : undefined;
}

function classify(payload) {
  if (!payload || typeof payload !== "object") return undefined;
  if (payload.noninteractiveQA === "passed" || payload.passed === true) return "qa";
  if (payload.originalApplied === true) return "apply";
  if (payload.complete === true && (payload.mode || payload.written)) return "apply";
  if (Array.isArray(payload.files) && payload.files.some((entry) => entry && typeof entry.path === "string")) {
    return "manifest";
  }
  return undefined;
}

// 候选目录里常带 target/node_modules 等构建产物，递归扫它们会从几百毫秒变两分钟。
const SKIP_DIRS = new Set([
  "node_modules",
  "target",
  "target-qa",
  "dist",
  ".git",
  ".local",
  ".cache",
  "artifacts",
  ".pnpm-store",
  "coverage",
]);

async function walkJson(dir, depth = 0) {
  if (depth > 5) return [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const found = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      found.push(...(await walkJson(full, depth + 1)));
    } else if (entry.name.endsWith(".json")) {
      found.push(full);
    }
  }
  return found;
}

async function readJsonFile(filePath) {
  try {
    const info = await stat(filePath);
    if (info.size > MAX_RECEIPT_BYTES) return undefined;
    return JSON.parse(stripBom(await readFile(filePath, "utf8")));
  } catch {
    return undefined;
  }
}

/** 候选目录里的回执只会出现在少数位置：根、evidence/、source/ 根、source/evidence/。
 *  不再递归整个 source 树（127 个候选 × 全仓副本 = 十几万次 readdir）。 */
async function candidateReceipts(dir) {
  const found = [];
  const scan = async (target, depth) => {
    let entries;
    try {
      entries = await readdir(target, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(target, entry.name);
      if (entry.isDirectory()) {
        if (depth > 0 && !SKIP_DIRS.has(entry.name)) await scan(full, depth - 1);
      } else if (entry.name.endsWith(".json")) {
        found.push(full);
      }
    }
  };
  await scan(dir, 0);
  await scan(path.join(dir, "evidence"), 2);
  await scan(path.join(dir, "source"), 0);
  await scan(path.join(dir, "source", "evidence"), 2);
  return found;
}

/** 从 TEMP 的候选目录收集可识别回执到 artifacts/evidence/<dir>/。 */
async function collectFromTemp() {
  const tempRoot = os.tmpdir();
  let copied = 0;
  let dirs = [];
  try {
    dirs = (await readdir(tempRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("P4Deck-"))
      .map((entry) => path.join(tempRoot, entry.name));
  } catch {
    return copied;
  }
  // 只处理"像回执"的 JSON：候选里大量结果是页面截图数据/构建产物，逐个 parse 太慢。
  const RECEIPT_NAME = /(manifest|approval|apply|handoff|receipt|verify|qa)/i;
  for (const dir of dirs) {
    for (const file of await candidateReceipts(dir)) {
      if (!RECEIPT_NAME.test(path.basename(file))) continue;
      const payload = await readJsonFile(file);
      const kind = classify(payload);
      if (!kind) continue;
      if (dryRun) {
        copied += 1;
        continue;
      }
      const targetDir = path.join(EVIDENCE_DIR, path.basename(dir));
      await mkdir(targetDir, { recursive: true });
      const target = path.join(targetDir, `${kind}-${path.basename(file, ".json")}.json`);
      try {
        await copyFile(file, target);
        copied += 1;
      } catch {
        // 同内容覆盖失败不影响派生
      }
    }
  }
  process.stdout.write(`从 TEMP 收集 ${copied} 份回执到 ${path.relative(ROOT, EVIDENCE_DIR)}\n`);
  return copied;
}

function matchSlice(slices, task) {
  if (!task) return undefined;
  const needle = task.toLowerCase();
  return slices.find((slice) => {
    const id = String(slice.id).toLowerCase();
    return needle === id || needle.startsWith(id) || id.startsWith(needle);
  });
}

export { classify, shaOf, pathsOf, matchSlice };

async function main() {
  if (collectTemp) await collectFromTemp();

  const state = JSON.parse(await readFile(STATE_FILE, "utf8"));
  const files = await walkJson(EVIDENCE_DIR);
  const slices = state.batch?.slices ?? [];

  const qaSlices = new Set();
  const appliedSlices = new Set();
  const qaShas = new Set();
  const appliedShas = new Set();
  const shaPaths = new Map();
  const directQaPackages = new Set();
  const directAppliedPackages = new Set();
  let receiptCount = 0;

  for (const file of files) {
    const payload = await readJsonFile(file);
    const kind = classify(payload);
    if (!kind) continue;
    receiptCount += 1;
    const sha = shaOf(payload);
    const paths = pathsOf(payload);
    if (sha && paths.size) {
      const bucket = shaPaths.get(sha) ?? new Set();
      for (const p of paths) bucket.add(p);
      shaPaths.set(sha, bucket);
    }
    const slice = matchSlice(slices, taskOf(payload));
    if (kind === "qa") {
      if (sha) qaShas.add(sha);
      if (slice) qaSlices.add(slice.id);
      for (const id of payload.packages ?? []) directQaPackages.add(id);
    } else if (kind === "apply") {
      if (sha) appliedShas.add(sha);
      if (slice) appliedSlices.add(slice.id);
      for (const id of payload.packages ?? []) directAppliedPackages.add(id);
    }
  }

  const qaPaths = new Set();
  for (const sha of qaShas) for (const p of shaPaths.get(sha) ?? []) qaPaths.add(p);
  const appliedPaths = new Set();
  for (const sha of appliedShas) for (const p of shaPaths.get(sha) ?? []) appliedPaths.add(p);

  const changes = [];

  // 包：路径或显式 packages 归因
  for (const pkg of state.packages) {
    const verification = pkg.verification ?? { qaPassed: null, applied: null, humanAccepted: null };
    const before = { ...verification };
    const evidencePaths = (pkg.evidence ?? []).map(normalize);
    if (directQaPackages.has(pkg.id) || evidencePaths.some((p) => qaPaths.has(p))) verification.qaPassed = true;
    if (directAppliedPackages.has(pkg.id) || evidencePaths.some((p) => appliedPaths.has(p))) verification.applied = true;
    if (before.qaPassed !== verification.qaPassed || before.applied !== verification.applied) {
      changes.push({ target: `pkg:${pkg.id}`, before: before, after: { ...verification } });
    }
    pkg.verification = verification;
  }

  // 切片：qa/apply 推进状态；blocked/paused/done 不被自动改写
  for (const slice of slices) {
    const before = slice.status;
    if (qaSlices.has(slice.id)) slice.qaPassed = true;
    if (appliedSlices.has(slice.id)) slice.applied = true;
    if (slice.applied && ADVANCEABLE.has(slice.status)) slice.status = "awaiting_accept";
    else if (slice.qaPassed && ADVANCEABLE.has(slice.status)) slice.status = "awaiting_apply";
    if (before !== slice.status) changes.push({ target: `slice:${slice.id}`, before: before, after: slice.status });
  }

  const report = {
    ok: true,
    dryRun,
    receipts: receiptCount,
    qaApprovals: qaShas.size,
    applies: appliedShas.size,
    attributedPaths: { qa: qaPaths.size, applied: appliedPaths.size },
    changes,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

  if (!dryRun && changes.length) {
    state.updatedAt = new Date().toISOString();
    await writeFile(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    process.stdout.write(`已更新 state.json：${changes.length} 处验收事实\n`);
  } else if (!changes.length) {
    process.stdout.write("没有新的可派生事实。\n");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
