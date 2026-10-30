#!/usr/bin/env node
// batch.mjs 自测：全部在系统临时目录内进行，不写原树、不读取用户改动。
// 用法: node scripts/workflow/batch.selftest.mjs
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const BATCH = path.join(ROOT, "scripts", "workflow", "batch.mjs");

function run(args) {
  const result = spawnSync(process.execPath, [BATCH, ...args], { encoding: "utf8" });
  return { code: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

const checks = [];
function check(name, ok, detail = "") {
  checks.push({ name, ok, detail });
  process.stdout.write(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}\n`);
}

const workDir = await mkdtemp(path.join(os.tmpdir(), "p4deck-batch-selftest-"));
const originalRoot = path.join(workDir, "original");
const candidateRoot = path.join(workDir, "candidate");
const relPath = "src/shared/lib/selftest-sample.ts";
const originalText = "export const sample = 1;\n";
const changedText = "export const sample = 2;\n";

try {
  for (const root of [originalRoot, candidateRoot]) {
    await mkdir(path.dirname(path.join(root, relPath)), { recursive: true });
  }
  await writeFile(path.join(originalRoot, relPath), originalText, "utf8");
  await writeFile(path.join(candidateRoot, relPath), changedText, "utf8");

  const manifestPath = path.join(workDir, "manifest.json");
  const manifestRun = run([
    "manifest",
    "--candidate",
    candidateRoot,
    "--original",
    originalRoot,
    "--paths",
    relPath,
    "--batch",
    "selftest",
    "--out",
    manifestPath,
  ]);
  check("manifest 生成", manifestRun.code === 0 && manifestRun.stdout.includes("sha="), manifestRun.stderr.trim());

  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  check("manifest 记录 expectedOriginalSha", typeof manifest.files[0].expectedOriginalSha256 === "string");
  check("manifest kind=modify", manifest.files[0].kind === "modify");
  check("manifest shape", /^[0-9A-F]{64}$/.test(manifest.manifestSha256));

  const verifyOk = run(["verify", "--manifest", manifestPath]);
  check("verify 干净通过", verifyOk.code === 0 && verifyOk.stdout.includes("PASS"), verifyOk.stdout.trim());

  // PowerShell 5.1 的 Set-Content -Encoding utf8 会写 BOM；手工写 manifest/qa-approval 是文档姿势，必须能读。
  const bomManifestPath = path.join(workDir, "manifest-bom.json");
  await writeFile(bomManifestPath, `\uFEFF${await readFile(manifestPath, "utf8")}`, "utf8");
  const verifyBomManifest = run(["verify", "--manifest", bomManifestPath]);
  check("manifest 带 BOM 仍可读", verifyBomManifest.code === 0, verifyBomManifest.stdout.trim());

  const qaBomPath = path.join(workDir, "qa-bom.json");
  await writeFile(
    qaBomPath,
    `\uFEFF${JSON.stringify({ passed: true, manifestSha256: manifest.manifestSha256, originalApplied: false })}`,
    "utf8",
  );
  const verifyBomQa = run(["verify", "--manifest", manifestPath, "--qa", qaBomPath]);
  check("qa-approval 带 BOM 仍可读", verifyBomQa.code === 0, verifyBomQa.stdout.trim());

  // QA 绑定：hash 不一致必须拒绝
  const qaBadPath = path.join(workDir, "qa-bad.json");
  await writeFile(qaBadPath, JSON.stringify({ passed: true, manifestSha256: "0".repeat(64), originalApplied: false }));
  const verifyBadQa = run(["verify", "--manifest", manifestPath, "--qa", qaBadPath]);
  check("verify 拒绝错误 QA 绑定", verifyBadQa.code === 1 && !verifyBadQa.stdout.startsWith("PASS"));

  // 原树漂移必须被抓住
  await writeFile(path.join(originalRoot, relPath), "export const sample = 99;\n", "utf8");
  const verifyDrift = run(["verify", "--manifest", manifestPath]);
  check("verify 抓住原树漂移", verifyDrift.code === 1);
  await writeFile(path.join(originalRoot, relPath), originalText, "utf8");

  // 候选被改动同样必须拒绝
  await writeFile(path.join(candidateRoot, relPath), "export const sample = 3;\n", "utf8");
  const verifyCandidate = run(["verify", "--manifest", manifestPath]);
  check("verify 抓住候选改动", verifyCandidate.code === 1);
  await writeFile(path.join(candidateRoot, relPath), changedText, "utf8");

  // dry-run 不写
  const dryRun = run(["apply", "--manifest", manifestPath]);
  const dryPay = JSON.parse(dryRun.stdout.slice(dryRun.stdout.indexOf("{")));
  check("apply 默认 dry-run", dryRun.code === 0 && dryPay.dryRun === true);
  check("dry-run 未改原树", (await readFile(path.join(originalRoot, relPath), "utf8")) === originalText);

  // 缺 --confirm-dev-closed 必须拒绝
  const noConfirm = run(["apply", "--manifest", manifestPath, "--apply"]);
  check("apply 拒绝无确认写入", noConfirm.code !== 0);

  // 正式 apply（临时树）写入 + 备份 + 回执
  const backupDir = path.join(workDir, "backup");
  const applied = run(["apply", "--manifest", manifestPath, "--apply", "--confirm-dev-closed", "--backup", backupDir]);
  const appliedPay = JSON.parse(applied.stdout.slice(applied.stdout.indexOf("{")));
  check("apply 执行成功", applied.code === 0 && appliedPay.originalApplied === true);
  check("apply 后内容正确", (await readFile(path.join(originalRoot, relPath), "utf8")) === changedText);
  check(
    "apply 生成备份",
    (await readFile(path.join(backupDir, relPath), "utf8")) === originalText,
  );
  check("apply 回执齐备", Boolean(appliedPay.applyReceipt && appliedPay.verifyReceipt));

  // 路径白名单：拒绝 .git / 上跳 / 绝对路径
  const badPath = run([
    "manifest",
    "--candidate",
    candidateRoot,
    "--original",
    originalRoot,
    "--paths",
    "../escape.ts",
    "--out",
    path.join(workDir, "bad.json"),
  ]);
  check("manifest 拒绝上跳路径", badPath.code !== 0);
} finally {
  await rm(workDir, { recursive: true, force: true });
}

const failed = checks.filter((entry) => !entry.ok);
process.stdout.write(`\n${checks.length - failed.length}/${checks.length} 通过\n`);
if (failed.length) {
  process.stdout.write(`失败项: ${failed.map((entry) => entry.name).join(", ")}\n`);
  process.exitCode = 1;
}
