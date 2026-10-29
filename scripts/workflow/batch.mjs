#!/usr/bin/env node
// 批次工具：把“每批手写 manifest/备份/Verify/Apply 脚本”固化为一个可复用命令。
//
// 用法:
//   node scripts/workflow/batch.mjs manifest --candidate <目录> --paths a,b,c --out <manifest.json> [--batch <id>]
//   node scripts/workflow/batch.mjs verify  --manifest <manifest.json> [--qa <qa-approval.json>] [--json]
//   node scripts/workflow/batch.mjs apply   --manifest <manifest.json> [--apply --confirm-dev-closed] [--allow-delete]
//
// 安全约束（与 ForAIDoc/PM/工作流/README.md 一致）:
//   - 默认 dry-run；真正写原树必须同时给 --apply 和 --confirm-dev-closed。
//   - 任何路径漂移即停；不覆盖用户改动。
//   - 只允许写产品/文档/脚本白名单路径，拒绝 .git、node_modules、artifacts。
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ARTIFACT_DIR = path.join(ROOT, "artifacts", "workflow");

const ALLOWED_PREFIXES = ["src/", "src-tauri/", "ForAIDoc/", "scripts/", "tests/", "public/"];
const ALLOWED_ROOT_FILE = /\.(json|ts|mjs|js|html|ya?ml|toml|md)$/i;
const FORBIDDEN_PREFIXES = [".git/", "node_modules/", "artifacts/", "dist/", "target/"];

function fail(message, code = 2) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex").toUpperCase();
}

async function hashFile(absolutePath) {
  try {
    const info = await stat(absolutePath);
    if (!info.isFile()) return undefined;
    return sha256(await readFile(absolutePath));
  } catch {
    return undefined;
  }
}

function normalizeRepoPath(raw) {
  const value = String(raw).trim().replace(/\\/g, "/");
  if (!value) fail("空路径");
  if (path.posix.isAbsolute(value) || /^[A-Za-z]:/.test(value)) fail(`拒绝绝对路径: ${value}`);
  const normalized = path.posix.normalize(value);
  if (normalized.startsWith("../") || normalized === "..") fail(`拒绝上跳路径: ${value}`);
  if (FORBIDDEN_PREFIXES.some((prefix) => normalized.startsWith(prefix))) fail(`拒绝受保护路径: ${value}`);
  const allowed = ALLOWED_PREFIXES.some((prefix) => normalized.startsWith(prefix));
  const rootFile = !normalized.includes("/") && ALLOWED_ROOT_FILE.test(normalized);
  if (!allowed && !rootFile) fail(`不在可写白名单内: ${value}`);
  return normalized;
}

function computeManifestSha(manifest) {
  const lines = ["p4deck-manifest-v1", manifest.batchId];
  for (const file of [...manifest.files].sort((a, b) => a.path.localeCompare(b.path))) {
    lines.push(
      `${file.path}\t${file.kind}\t${file.sourceSha256 ?? "-"}\t${file.expectedOriginalSha256 ?? "-"}`,
    );
  }
  return sha256(lines.join("\n"));
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      args._.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      index += 1;
    }
  }
  return args;
}

async function loadJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function writeReceipt(name, payload) {
  await mkdir(ARTIFACT_DIR, { recursive: true });
  const target = path.join(ARTIFACT_DIR, name);
  await writeFile(target, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return path.relative(ROOT, target).split(path.sep).join("/");
}

async function cmdManifest(args) {
  if (!args.candidate) fail("缺少 --candidate <候选 source 目录>");
  const candidateRoot = path.resolve(String(args.candidate));
  const originalRoot = path.resolve(String(args.original ?? ROOT));
  const batchId = String(args.batch ?? path.basename(candidateRoot));
  const pathList = String(args.paths ?? "")
    .split(/[,\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
  if (!pathList.length) fail("缺少 --paths（仓库相对路径，逗号分隔）");

  const files = [];
  for (const rawPath of pathList) {
    const repoPath = normalizeRepoPath(rawPath);
    const candidatePath = path.join(candidateRoot, repoPath);
    const originalPath = path.join(originalRoot, repoPath);
    const sourceSha256 = await hashFile(candidatePath);
    const expectedOriginalSha256 = await hashFile(originalPath);
    if (!sourceSha256 && !expectedOriginalSha256) fail(`${repoPath}: 候选与原树都不存在`);
    files.push({
      path: repoPath,
      kind: sourceSha256 ? (expectedOriginalSha256 ? "modify" : "create") : "delete",
      sourceSha256,
      expectedOriginalSha256,
    });
  }

  const manifest = {
    schemaVersion: 1,
    batchId,
    createdAt: new Date().toISOString(),
    originalRoot,
    candidateRoot,
    files,
    manifestSha256: undefined,
  };
  manifest.manifestSha256 = computeManifestSha(manifest);

  const outPath = path.resolve(String(args.out ?? path.join(ARTIFACT_DIR, `${batchId}-manifest.json`)));
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const counts = files.reduce((acc, file) => ({ ...acc, [file.kind]: (acc[file.kind] ?? 0) + 1 }), {});
  process.stdout.write(
    `manifest: ${path.relative(ROOT, outPath)} | batch=${batchId} | 文件 ${files.length} (${JSON.stringify(counts)}) | sha=${manifest.manifestSha256}\n`,
  );
}

async function verifyManifest(manifest, qaPath) {
  const checks = [];
  const drift = [];
  const recomputed = computeManifestSha(manifest);
  checks.push({
    name: "manifest-sha",
    ok: recomputed === manifest.manifestSha256,
    detail: `${recomputed} vs ${manifest.manifestSha256}`,
  });

  for (const file of manifest.files) {
    const originalPath = path.join(manifest.originalRoot, file.path);
    const candidatePath = path.join(manifest.candidateRoot, file.path);
    const currentOriginal = await hashFile(originalPath);
    const currentCandidate = await hashFile(candidatePath);

    const originalOk = currentOriginal === file.expectedOriginalSha256;
    if (!originalOk) drift.push({ path: file.path, expected: file.expectedOriginalSha256, actual: currentOriginal });
    checks.push({ name: `drift:${file.path}`, ok: originalOk, detail: originalOk ? "unchanged" : "原树已漂移" });

    const candidateOk = currentCandidate === file.sourceSha256;
    checks.push({
      name: `candidate:${file.path}`,
      ok: candidateOk,
      detail: candidateOk ? "matches" : "候选已被改动",
    });
  }

  if (qaPath) {
    let qa;
    try {
      qa = await loadJson(path.resolve(qaPath));
    } catch {
      checks.push({ name: "qa-approval", ok: false, detail: `无法读取 ${qaPath}` });
      qa = undefined;
    }
    if (qa) {
      checks.push({
        name: "qa-manifest-binding",
        ok: qa.manifestSha256 === manifest.manifestSha256,
        detail: `${qa.manifestSha256 ?? "(缺)"} vs ${manifest.manifestSha256}`,
      });
      const passed = qa.passed === true || qa.noninteractiveQA === "passed";
      checks.push({ name: "qa-passed", ok: passed, detail: passed ? "passed" : "QA 未通过" });
      checks.push({
        name: "qa-not-yet-applied",
        ok: qa.originalApplied !== true,
        detail: qa.originalApplied === true ? "该批准已应用过，禁止复用" : "not applied",
      });
    }
  }

  return { ok: checks.every((check) => check.ok), checks, drift };
}

async function cmdVerify(args) {
  if (!args.manifest) fail("缺少 --manifest <文件>");
  const manifest = await loadJson(path.resolve(String(args.manifest)));
  const result = await verifyManifest(manifest, args.qa ? String(args.qa) : undefined);
  const receipt = await writeReceipt(`verify-${Date.now()}.json`, {
    schemaVersion: 1,
    kind: "verify",
    manifestSha256: manifest.manifestSha256,
    batchId: manifest.batchId,
    checkedAt: new Date().toISOString(),
    ...result,
  });
  if (args.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    const failed = result.checks.filter((check) => !check.ok);
    process.stdout.write(
      result.ok
        ? `PASS ${manifest.batchId}: ${result.checks.length} 项检查通过 | 回执 ${receipt}\n`
        : `FAIL ${manifest.batchId}: ${failed.map((check) => `${check.name}(${check.detail})`).join(", ")}\n`,
    );
  }
  if (!result.ok) process.exitCode = 1;
}

async function cmdApply(args) {
  if (!args.manifest) fail("缺少 --manifest <文件>");
  const manifest = await loadJson(path.resolve(String(args.manifest)));
  const verdict = await verifyManifest(manifest, args.qa ? String(args.qa) : undefined);
  const deletable = manifest.files.filter((file) => file.kind === "delete");
  const plan = {
    schemaVersion: 1,
    kind: "apply-plan",
    batchId: manifest.batchId,
    manifestSha256: manifest.manifestSha256,
    createdAt: new Date().toISOString(),
    dryRun: args.apply !== true,
    files: manifest.files.length,
    creates: manifest.files.filter((file) => file.kind === "create").map((file) => file.path),
    modifies: manifest.files.filter((file) => file.kind === "modify").map((file) => file.path),
    deletes: deletable.map((file) => file.path),
    verify: verdict.ok,
  };

  if (!verdict.ok) {
    process.stdout.write(`${JSON.stringify({ ...plan, error: "verify-failed" }, null, 2)}\n`);
    fail("Verify 未通过，拒绝 Apply（原树漂移或候选被改动）", 1);
  }
  if (args.apply !== true) {
    const receipt = await writeReceipt(`apply-plan-${Date.now()}.json`, plan);
    process.stdout.write(`${JSON.stringify({ ...plan, receipt }, null, 2)}\n`);
    process.stderr.write("dry-run：未写原树。确认 dev 已关闭后追加 --apply --confirm-dev-closed。\n");
    return;
  }
  if (args["confirm-dev-closed"] !== true) fail("真正 Apply 需要 --confirm-dev-closed（用户已确认 dev 关闭且无在途操作）");
  if (deletable.length && args["allow-delete"] !== true) fail("本次含删除项，需显式 --allow-delete");

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupDir = path.resolve(String(args.backup ?? path.join(ARTIFACT_DIR, "backup", `${manifest.batchId}-${stamp}`)));
  await mkdir(backupDir, { recursive: true });

  const applied = [];
  const backups = [];
  for (const file of manifest.files) {
    const originalPath = path.join(manifest.originalRoot, file.path);
    const candidatePath = path.join(manifest.candidateRoot, file.path);
    if (file.expectedOriginalSha256) {
      const backupPath = path.join(backupDir, file.path);
      await mkdir(path.dirname(backupPath), { recursive: true });
      await copyFile(originalPath, backupPath);
      backups.push({ path: file.path, sha256: await hashFile(backupPath) });
    }
    if (file.kind === "delete") {
      await rm(originalPath, { force: true });
    } else {
      await mkdir(path.dirname(originalPath), { recursive: true });
      await copyFile(candidatePath, originalPath);
    }
    applied.push({ path: file.path, kind: file.kind, sha256: await hashFile(originalPath) });
  }

  const postVerify = {
    schemaVersion: 1,
    kind: "post-apply-verify",
    batchId: manifest.batchId,
    manifestSha256: manifest.manifestSha256,
    appliedAt: new Date().toISOString(),
    verifiedFiles: applied.length,
    mismatches: applied
      .filter((file) => {
        const source = manifest.files.find((entry) => entry.path === file.path);
        return file.kind === "delete" ? file.sha256 !== undefined : file.sha256 !== source?.sourceSha256;
      })
      .map((file) => file.path),
  };
  postVerify.originalApplied = postVerify.mismatches.length === 0;
  postVerify.backupVerified = backups.every((backup) => backup.sha256 !== undefined);

  const applyReceipt = await writeReceipt(`apply-${stamp}.json`, {
    ...plan,
    dryRun: false,
    appliedAt: postVerify.appliedAt,
    applied,
    backups: backups.length,
    backupDir: path.relative(ROOT, backupDir).split(path.sep).join("/"),
  });
  const verifyReceipt = await writeReceipt(`post-apply-verify-${stamp}.json`, postVerify);
  process.stdout.write(`${JSON.stringify({ ...postVerify, applyReceipt, verifyReceipt }, null, 2)}\n`);
  if (!postVerify.originalApplied) process.exitCode = 1;
}

const [command, ...rest] = process.argv.slice(2);
const args = parseArgs(rest);
switch (command) {
  case "manifest":
    await cmdManifest(args);
    break;
  case "verify":
    await cmdVerify(args);
    break;
  case "apply":
    await cmdApply(args);
    break;
  default:
    fail("usage: node scripts/workflow/batch.mjs <manifest|verify|apply> ...");
}
