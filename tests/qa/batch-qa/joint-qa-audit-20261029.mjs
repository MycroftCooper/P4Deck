#!/usr/bin/env node
// QA 独立审计（只读）：CON06 联合候选 fresh verify（旧 manifest 格式）+ 各切片 manifest/QA 绑定 + 联合 QA 缺口。
// 用法: node tests/qa/batch-qa/joint-qa-audit-20261029.mjs
// 只读原树与 %TEMP% 证据；只写 artifacts/evidence/P4Deck-joint-qa-20261029/。
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, stat, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileP = promisify(execFile);
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const TEMP = process.env.TEMP || process.env.TMP;
const OUT_DIR = path.join(REPO, "artifacts", "evidence", "P4Deck-joint-qa-20261029");
const CON06_CAND = path.join(TEMP, "P4Deck-server-status-join01-20261029");
const CON06_MANIFEST = path.join(CON06_CAND, "evidence", "joint-manifest.json");
const CON06_QA = path.join(REPO, "artifacts", "evidence", "P4Deck-server-status-join01-20261029", "qa-qa-approval.json");
const QA_DIR = path.join(TEMP, "P4Deck-action-r01-qa-20261029");
const CONFIG_BASELINE = ["package.json", "pnpm-lock.yaml", "tsconfig.json", "tsconfig.app.json", "tsconfig.node.json", "vite.config.ts"];

const result = { generatedAt: new Date().toISOString(), repo: REPO, temp: TEMP, configBaseline: CONFIG_BASELINE, con06: {}, slices: [], jointGaps: [], tooling: {} };

function sha(buffer) {
  return createHash("sha256").update(buffer).digest("hex").toUpperCase();
}
async function shaFile(p) {
  try {
    const info = await stat(p);
    if (!info.isFile()) return undefined;
    return sha(await readFile(p));
  } catch {
    return undefined;
  }
}
const eq = (a, b) => typeof a === "string" && typeof b === "string" && a.toUpperCase() === b.toUpperCase();

async function main() {
  await mkdir(OUT_DIR, { recursive: true });

  // ---------- 0. batch.mjs verify 现状（机械复现，不写原树） ----------
  const verifyCmd = [path.join(REPO, "scripts", "workflow", "batch.mjs"), "verify", "--manifest", CON06_MANIFEST, "--qa", CON06_QA];
  try {
    const run = await execFileP(process.execPath, verifyCmd, { cwd: REPO, windowsHide: true });
    result.tooling.con06BatchVerify = { exitCode: 0, stdout: run.stdout.trim().slice(0, 2000), stderr: run.stderr.trim().slice(0, 2000) };
  } catch (error) {
    result.tooling.con06BatchVerify = {
      exitCode: error.code ?? null,
      stdout: String(error.stdout ?? "").trim().slice(0, 2000),
      stderr: String(error.stderr ?? "").trim().slice(0, 2000),
    };
  }

  const selftest = await execFileP(process.execPath, [path.join(REPO, "scripts", "workflow", "batch.selftest.mjs")], { cwd: REPO, windowsHide: true }).catch((error) => ({ stdout: String(error.stdout ?? ""), stderr: String(error.stderr ?? ""), code: error.code }));
  result.tooling.batchSelftest = { exitCode: selftest.code ?? 0, summary: selftest.stdout.trim().split(/\r?\n/).filter((line) => /通过|PASS|FAIL/.test(line)).slice(-4) };

  // ---------- 1. CON06 legacy joint manifest fresh verify ----------
  const manifest = JSON.parse(await readFile(CON06_MANIFEST, "utf8"));
  const qa = JSON.parse(await readFile(CON06_QA, "utf8"));
  const qaTemp = await shaFile(path.join(CON06_CAND, "evidence", "qa-approval.json"));
  const qaArtifact = await shaFile(CON06_QA);
  const manifestFileSha = await shaFile(CON06_MANIFEST);
  const schemaRequired = ["schemaVersion", "batchId", "packages", "originalRoot", "candidateRoot", "manifestSha256"];
  const fileSchemaRequired = ["kind", "sourceSha256", "expectedOriginalSha256"];
  const con06 = {
    manifestPath: CON06_MANIFEST,
    manifestFileSha256: manifestFileSha,
    manifestSelfSha256: manifest.manifestSha256 ?? null,
    manifestClaimedSha256: qa.manifestSha256,
    manifestClaimMatchesFileBytes: eq(qa.manifestSha256, manifestFileSha),
    qaPath: CON06_QA,
    qaArtifactSha256: qaArtifact,
    qaTempSha256: qaTemp,
    qaArtifactEqualsTemp: eq(qaArtifact, qaTemp),
    qaFields: { task: qa.task, noninteractiveQA: qa.noninteractiveQA, passed: qa.passed ?? null, originalApplied: qa.originalApplied, appTS: qa.appTS, nodeTS: qa.nodeTS, verifiedFiles: qa.verifiedFiles, nativeTransportRun: qa.nativeTransportRun },
    schemaMissing: schemaRequired.filter((key) => !(key in manifest)),
    fileSchemaMissing: fileSchemaRequired.filter((key) => !(key in (manifest.files?.[0] ?? {}))),
    batchVerifyCompatible: schemaRequired.every((key) => key in manifest) && fileSchemaRequired.every((key) => key in (manifest.files?.[0] ?? {})),
    fileCount: manifest.files.length,
    originalRoot: manifest.original ?? null,
    candidateRoot: manifest.source ?? null,
    files: [],
    candidateConfig: {},
    candidateExtraQaFiles: [],
  };

  for (const file of manifest.files) {
    const originalNow = await shaFile(path.join(manifest.original, file.path));
    const candidateNow = await shaFile(path.join(manifest.source, file.path));
    const expectedBase = file.baseSha256;
    let originalState;
    if (expectedBase === null || expectedBase === undefined) {
      originalState = originalNow === undefined ? "pre-state-ok:absent" : eq(originalNow, file.sha256) ? "already-applied" : "drift:unexpected-file";
    } else if (originalNow === undefined) {
      originalState = "drift:missing-expected-base";
    } else if (eq(originalNow, expectedBase)) {
      originalState = "pre-state-ok:base";
    } else if (eq(originalNow, file.sha256)) {
      originalState = "already-applied";
    } else {
      originalState = "drift";
    }
    con06.files.push({
      path: file.path,
      expectedBaseSha256: expectedBase ?? null,
      candidateSha256: file.sha256,
      originalNowSha256: originalNow ?? null,
      candidateNowSha256: candidateNow ?? null,
      originalState,
      candidateMatchesManifest: eq(candidateNow, file.sha256),
      baseMatchesOriginalNow: expectedBase ? eq(originalNow, expectedBase) : originalNow === undefined,
    });
  }
  for (const name of CONFIG_BASELINE) {
    const cand = await shaFile(path.join(manifest.source, name));
    const orig = await shaFile(path.join(REPO, name));
    con06.candidateConfig[name] = { candidateSha256: cand ?? null, originalSha256: orig ?? null, sameAsOriginal: eq(cand, orig), present: cand !== undefined };
  }
  con06.candidateConfigComplete = CONFIG_BASELINE.every((name) => con06.candidateConfig[name].present);
  con06.candidateConfigEqualsOriginalBaseline = CONFIG_BASELINE.every((name) => con06.candidateConfig[name].sameAsOriginal);
  for (const extra of ["src/test/con06-qa/status-chain.test.tsx", "src/test/server-status.vitest.config.ts"]) {
    const p = path.join(manifest.source, extra);
    con06.candidateExtraQaFiles.push({ path: extra, exists: (await shaFile(p)) !== undefined });
  }
  con06.freshVerifyManual = {
    // 手工按 manifest 自身语义（candidate sha / 原树 base sha）复核；非 batch.mjs PASS
    candidateMismatches: con06.files.filter((f) => !f.candidateMatchesManifest).map((f) => f.path),
    originalDrift: con06.files.filter((f) => !f.originalState.startsWith("pre-state-ok")).map((f) => ({ path: f.path, state: f.originalState })),
  };
  result.con06 = con06;

  // ---------- 2. 切片 manifest / QA 绑定审计 ----------
  const candidates = {
    "S1B-BE": path.join(TEMP, "P4Deck-action-r01-20261029"),
    "S2a-BE": path.join(TEMP, "P4Deck-action-s2a-20261029"),
    "S2b-BE": path.join(TEMP, "P4Deck-action-s2b-20261029"),
    "S2b-noop-BE": path.join(TEMP, "P4Deck-action-s2b-noop-20261029"),
    "S3a-BE": path.join(TEMP, "P4Deck-action-s3a-20261029"),
    "S1B-FE": path.join(TEMP, "P4Deck-action-fe-s1b-20261029"),
    "S2a-FE": path.join(TEMP, "P4Deck-action-fe-s2a-20261029"),
    "S2b-FE": path.join(TEMP, "P4Deck-action-fe-s2b-20261029"),
    "S3-REG01-FE": path.join(TEMP, "P4Deck-action-fe-s3-reg01-20261029"),
  };
  const evidenceIndex = new Map(); // sha -> [paths]
  async function indexFiles(dir, depth = 0, maxBytes = 2 * 1024 * 1024) {
    if (depth > 4) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (["source", "target", "node_modules", "recovery-target"].includes(entry.name)) continue;
        await indexFiles(full, depth + 1, maxBytes);
      } else {
        try {
          const info = await stat(full);
          if (info.size > maxBytes) continue;
          const h = await shaFile(full);
          if (!h) continue;
          const list = evidenceIndex.get(h) ?? [];
          list.push(full);
          evidenceIndex.set(h, list);
        } catch {
          // ignore
        }
      }
    }
  }
  await indexFiles(CON06_CAND);
  for (const dir of Object.values(candidates)) await indexFiles(dir);
  await indexFiles(QA_DIR);
  // 全量 P4Deck-* 的 evidence 目录（用于核对 testLog/fixture 等散落回执 hash）
  try {
    const { readdir: readdirP } = await import("node:fs/promises");
    for (const entry of await readdirP(TEMP, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith("P4Deck-")) continue;
      await indexFiles(path.join(TEMP, entry.name), 0, 1024 * 1024);
    }
  } catch {
    // ignore
  }

  function findClaim(sha256) {
    if (!sha256) return null;
    const list = evidenceIndex.get(String(sha256).toUpperCase());
    return list ? list[0] : null;
  }

  const approvals = [
    { slice: "S1B", layer: "BE", kind: "approval", file: path.join(QA_DIR, "qa-s1b-approval.json"), candidate: "S1B-BE", bindings: ["handoffSha256", "wireSha256", "diagnosticManifestSha256", "testLogSha256"], claimed: { handoffSha256: path.join(TEMP, "P4Deck-action-r01-20261029", "evidence", "s1b-handoff.json"), wireSha256: path.join(TEMP, "P4Deck-action-r01-20261029", "evidence", "s1b-wire.md"), diagnosticManifestSha256: path.join(QA_DIR, "s1b-diagnostic", "diagnostic-manifest.json"), testLogSha256: path.join(QA_DIR, "s1b-diagnostic", "qa-s1b-tests.log") } },
    { slice: "S1B", layer: "FE", kind: "approval", file: path.join(TEMP, "P4Deck-action-fe-s1b-20261029", "evidence", "qa-approval.json"), candidate: "S1B-FE", bindings: ["handoffSha256", "beS1bHandoffSha256", "wireSha256", "testLogSha256"], claimed: { handoffSha256: path.join(TEMP, "P4Deck-action-fe-s1b-20261029", "evidence", "handoff.json"), beS1bHandoffSha256: path.join(TEMP, "P4Deck-action-r01-20261029", "evidence", "s1b-handoff.json"), wireSha256: path.join(TEMP, "P4Deck-action-r01-20261029", "evidence", "s1b-wire.md"), testLogSha256: path.join(TEMP, "P4Deck-action-fe-s1b-20261029", "evidence", "qa-tests.log") } },
    { slice: "S2a", layer: "BE", kind: "approval", file: path.join(QA_DIR, "qa-s2a-approval.json"), candidate: "S2a-BE", bindings: ["handoffSha256", "wireSha256", "diagnosticManifestSha256", "testLogSha256"], claimed: { handoffSha256: path.join(TEMP, "P4Deck-action-s2a-20261029", "evidence", "s2a-handoff.json"), wireSha256: path.join(TEMP, "P4Deck-action-s2a-20261029", "evidence", "s2a-wire.md"), diagnosticManifestSha256: path.join(QA_DIR, "s2a-diagnostic", "diagnostic-manifest.json"), testLogSha256: path.join(QA_DIR, "s2a-diagnostic", "qa-s2a-tests.log") } },
    { slice: "S2a", layer: "FE", kind: "approval", file: path.join(TEMP, "P4Deck-action-fe-s2a-20261029", "evidence", "qa-approval.json"), candidate: "S2a-FE", bindings: ["handoffSha256"], claimed: { handoffSha256: path.join(TEMP, "P4Deck-action-fe-s2a-20261029", "evidence", "handoff.json") } },
    { slice: "S2b", layer: "BE", kind: "status-partial", file: path.join(QA_DIR, "qa-s2b-status.json"), candidate: "S2b-BE", bindings: ["handoffSha256", "wireSha256", "diagnosticManifestSha256"], claimed: { handoffSha256: path.join(TEMP, "P4Deck-action-s2b-20261029", "evidence", "s2b-handoff.json"), wireSha256: path.join(TEMP, "P4Deck-action-s2b-20261029", "evidence", "s2b-wire.md"), diagnosticManifestSha256: path.join(QA_DIR, "s2b-diagnostic", "diagnostic-manifest.json") } },
    { slice: "S2b", layer: "FE", kind: "approval-scope-only", file: path.join(TEMP, "P4Deck-action-fe-s2b-20261029", "evidence", "qa-approval.json"), candidate: "S2b-FE", bindings: ["handoffSha256"], claimed: { handoffSha256: path.join(TEMP, "P4Deck-action-fe-s2b-20261029", "evidence", "handoff.json") } },
    { slice: "S3a", layer: "BE", kind: "approval", file: path.join(QA_DIR, "qa-s3a-approval.json"), candidate: "S3a-BE", bindings: ["handoffSha256", "wireSha256"], claimed: { handoffSha256: path.join(TEMP, "P4Deck-action-s3a-20261029", "evidence", "s3a-handoff.json"), wireSha256: path.join(TEMP, "P4Deck-action-s3a-20261029", "evidence", "s3a-wire.md") } },
    { slice: "S3-REG01", layer: "FE", kind: "approval", file: path.join(TEMP, "P4Deck-action-fe-s3-reg01-20261029", "evidence", "qa-approval.json"), candidate: "S3-REG01-FE", bindings: ["handoffSha256", "qaFixtureSha256", "stage0RowsSha256"], claimed: { handoffSha256: path.join(TEMP, "P4Deck-action-fe-s3-reg01-20261029", "evidence", "handoff.json") } },
  ];

  // 原树当前 hash 缓存
  const repoHashCache = new Map();
  async function repoHash(p) {
    if (!repoHashCache.has(p)) repoHashCache.set(p, (await shaFile(path.join(REPO, p))) ?? null);
    return repoHashCache.get(p);
  }
  // 各候选 source 的 hash 缓存
  const candHashCache = new Map();
  async function candHash(candKey, p) {
    const key = `${candKey}|${p}`;
    if (!candHashCache.has(key)) candHashCache.set(key, (await shaFile(path.join(candidates[candKey], "source", p))) ?? null);
    return candHashCache.get(key);
  }

  for (const approval of approvals) {
    let payload;
    try {
      payload = JSON.parse(await readFile(approval.file, "utf8"));
    } catch (error) {
      result.slices.push({ slice: approval.slice, layer: approval.layer, kind: approval.kind, file: approval.file, error: `无法读取: ${error.message}` });
      continue;
    }
    const entry = {
      slice: approval.slice,
      layer: approval.layer,
      kind: approval.kind,
      file: approval.file,
      fileSha256: await shaFile(approval.file),
      status: payload.status ?? payload.result ?? null,
      applyAllowed: payload.applyAllowed ?? payload.applied ?? null,
      claimedChecks: [],
      productFileChecks: [],
      approvalFieldsForBatchQa: {
        hasPassedTrue: payload.passed === true,
        noninteractiveQA: payload.noninteractiveQA ?? null,
        hasManifestSha256: typeof payload.manifestSha256 === "string",
      },
    };
    for (const key of approval.bindings) {
      const claimed = payload[key];
      const expectedPath = approval.claimed[key];
      const actualAtExpected = expectedPath ? await shaFile(expectedPath) : null;
      entry.claimedChecks.push({
        field: key,
        claimed: claimed ?? null,
        expectedPath: expectedPath ?? null,
        actualAtExpected: actualAtExpected ?? null,
        matchedAtExpected: eq(claimed, actualAtExpected),
        matchedSomewhere: findClaim(claimed) ? path.relative(TEMP, findClaim(claimed)) : null,
      });
    }
    const productFiles = [payload.productFiles, payload.files, payload.frozenFiles].find(Array.isArray) ?? [];
    for (const item of productFiles) {
      if (!item || typeof item.path !== "string") continue;
      const candidateNow = await candHash(approval.candidate, item.path.replace(/\\/g, "/"));
      const originalNow = await repoHash(item.path.replace(/\\/g, "/"));
      let baseMatchedIn = null;
      if (item.baseSha256) {
        if (eq(originalNow, item.baseSha256)) baseMatchedIn = "original-tree";
        else {
          for (const key of Object.keys(candidates)) {
            const h = await candHash(key, item.path.replace(/\\/g, "/"));
            if (eq(h, item.baseSha256)) {
              baseMatchedIn = key;
              break;
            }
          }
        }
      }
      entry.productFileChecks.push({
        path: item.path,
        approvalSha256: item.sha256 ?? null,
        candidateNowSha256: candidateNow,
        candidateMatchesApproval: eq(candidateNow, item.sha256),
        baseSha256: item.baseSha256 ?? null,
        originalNowSha256: originalNow,
        baseMatchesOriginalTree: item.baseSha256 ? eq(originalNow, item.baseSha256) : originalNow === null,
        baseMatchedIn,
      });
    }
    entry.bindingValid = entry.claimedChecks.every((check) => check.matchedAtExpected) && entry.productFileChecks.every((check) => check.candidateMatchesApproval);
    entry.unchangedSinceApproval = entry.bindingValid;
    result.slices.push(entry);
  }

  // ---------- 3. 候选快照 manifest / 配置完整性 ----------
  for (const [key, dir] of Object.entries(candidates)) {
    const snapshotPath = path.join(dir, "snapshot-manifest.json");
    const snapshotSha = await shaFile(snapshotPath);
    const record = { candidate: key, dir, snapshotManifest: null, config: {}, configComplete: false };
    if (snapshotSha) {
      const snapshot = JSON.parse(await readFile(snapshotPath, "utf8"));
      const files = snapshot.files ?? [];
      const keyName = files.some((file) => "sha256" in file) ? "sha256" : "hash";
      let mismatches = 0;
      const sample = [];
      for (const file of files) {
        const actual = await shaFile(path.join(dir, "source", file.path));
        if (!eq(actual, file[keyName])) {
          mismatches += 1;
          if (sample.length < 10) sample.push({ path: file.path, expected: file[keyName], actual: actual ?? null });
        }
      }
      record.snapshotManifest = { path: snapshotPath, fileSha256: snapshotSha, baseHandoffSha256: snapshot.baseHandoffSha256 ?? null, hashKey: keyName, fileCount: files.length, mismatches, changedSample: sample };
    }
    for (const name of CONFIG_BASELINE) {
      const h = await shaFile(path.join(dir, "source", name));
      const orig = await shaFile(path.join(REPO, name));
      record.config[name] = { present: h !== undefined, sha256: h ?? null, sameAsOriginalBaseline: eq(h, orig) };
    }
    record.configComplete = CONFIG_BASELINE.every((name) => record.config[name].present);
    record.configEqualsOriginalBaseline = CONFIG_BASELINE.every((name) => record.config[name].sameAsOriginalBaseline);
    result.slices.push({ candidateRecord: record });
  }

  // ---------- 4. evidence.mjs 是否可识别这些回执 ----------
  const { pathToFileURL } = await import("node:url");
  const { classify } = await import(pathToFileURL(path.join(REPO, "scripts", "workflow", "evidence.mjs")).href);
  const receiptRecognition = [];
  for (const approval of approvals) {
    try {
      const payload = JSON.parse(await readFile(approval.file, "utf8"));
      receiptRecognition.push({ slice: approval.slice, layer: approval.layer, file: path.basename(approval.file), classifiedAs: classify(payload) ?? "unrecognized" });
    } catch {
      receiptRecognition.push({ slice: approval.slice, layer: approval.layer, file: path.basename(approval.file), classifiedAs: "unreadable" });
    }
  }
  for (const qaFile of [CON06_QA]) {
    const payload = JSON.parse(await readFile(qaFile, "utf8"));
    receiptRecognition.push({ slice: "CON06", layer: "joint", file: path.basename(qaFile), classifiedAs: classify(payload) ?? "unrecognized" });
  }
  result.evidenceRecognition = receiptRecognition;

  // ---------- 5. 联合 QA 缺口（结论性） ----------
  const con06Drift = con06.freshVerifyManual.originalDrift;
  const con06CandidateMismatch = con06.freshVerifyManual.candidateMismatches;
  result.jointGaps = [
    {
      id: "GAP-01",
      title: "CON06 冻结 manifest 是旧自定义格式，当前 batch.mjs verify 无法验证（直接抛 TypeError），不能给出官方 PASS",
      evidence: `batch.mjs verify exit=${result.tooling.con06BatchVerify.exitCode}; schemaMissing=${JSON.stringify(con06.schemaMissing)}; fileSchemaMissing=${JSON.stringify(con06.fileSchemaMissing)}`,
      need: "BE 用 batch.mjs manifest --candidate <完整联合候选> --paths <全部变更文件> --packages CON06,ACTION 重新冻结 v1 manifest（20+ 文件），QA 重新绑定后跑 batch.mjs verify；旧 EEFA 批准不能直接复用为官方 Verify PASS",
    },
    {
      id: "GAP-02",
      title: "CON06 批准绑定的是 manifest 文件字节 sha（EEFA…），不是 batch.mjs 规范 manifestSha256；原树/候选需按 v1 manifest 复核",
      evidence: `manifestFileSha=${con06.manifestFileSha256}; manifestSelfSha=${con06.manifestSelfSha256}; qaClaim=${con06.manifestClaimedSha256}; match=${con06.manifestClaimMatchesFileBytes}`,
      need: "新 v1 manifest 的 manifestSha256 重新出 QA 批准；当前 EEFA 只能证明 joint-manifest.json 文件未被改动",
    },
    {
      id: "GAP-03",
      title: "原树 fresh 复核结果（旧 manifest 语义）",
      evidence: `20 文件中 candidateMismatch=${con06CandidateMismatch.length ? con06CandidateMismatch.join(",") : "0"}；原树 drift=${con06Drift.length ? con06Drift.map((d) => `${d.path}:${d.state}`).join(",") : "0"}`,
      need: "若原树已有漂移，Apply 前需 BE 重新从当前原树建完整候选并重冻结；QA 不能替 BE 补 manifest",
    },
    {
      id: "GAP-04",
      title: "不存在覆盖 CON06+S1A/S1B/S2a/S2b/S3a 的统一联合候选；各切片候选基线/配置不齐",
      evidence: result.slices.filter((entry) => entry.candidateRecord).map((entry) => `${entry.candidateRecord.candidate}:configComplete=${entry.candidateRecord.configComplete},mismatch=${entry.candidateRecord.snapshotManifest?.mismatches ?? "no-snapshot"}`).join(" | "),
      need: "BE 在完整原基线（package/lock、全部 tsconfig、vite.config.ts、实际引用测试配置）上叠加全部已批准切片，建唯一联合候选并用 batch.mjs manifest 冻结；QA 在联合 manifest 上跑全 app/node TS",
    },
    {
      id: "GAP-05",
      title: "S1B/S2a/S2b/S3a 的 QA 回执均为切片自定义 JSON，未绑定 batch.mjs manifestSha256，且 evidence.mjs 不识别为 QA 通过（无 passed===true/noninteractiveQA）",
      evidence: receiptRecognition.map((r) => `${r.slice}/${r.layer}:${r.classifiedAs}`).join(" | "),
      need: "最终联合 QA 必须产出 batch.mjs 兼容 qa-approval.json（task/manifestSha256/noninteractiveQA=passed/passed=true/originalApplied=false）并放 artifacts/evidence/<batch>/",
    },
    {
      id: "GAP-06",
      title: "S2a 聚合 TS 明确失败（TS18003），S2b 阻塞（retained/no-op 未闭环），S3 仅 S3a/REG01 部分，不能算 ACTION 全矩阵完成",
      evidence: "S2a FE qa-approval aggregateTsExit=2; S2b status=PARTIAL; qa-s3a status=no full phase approval",
      need: "S2a 在完整基线配置候选上重跑全 TS；S2b 按 NOOP-01 契约补 retained/no-op 正向证据；S3 逐行给出入口→adapter→host 迁移证据后才可联合 QA",
    },
  ];

  await writeFile(path.join(OUT_DIR, "joint-qa-audit.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
  const summary = {
    con06: {
      manifestFileSha: con06.manifestFileSha256,
      claimed: con06.manifestClaimedSha256,
      claimMatchesFileBytes: con06.manifestClaimMatchesFileBytes,
      batchVerifyCompatible: con06.batchVerifyCompatible,
      batchVerifyExit: result.tooling.con06BatchVerify.exitCode,
      candidateMismatches: con06CandidateMismatch,
      originalDrift: con06Drift,
      candidateConfigComplete: con06.candidateConfigComplete,
    },
    slices: result.slices.filter((entry) => entry.slice).map((entry) => ({
      slice: `${entry.slice}/${entry.layer}`,
      kind: entry.kind,
      bindingValid: entry.bindingValid ?? null,
      productFiles: entry.productFileChecks?.length ?? null,
      failedBindings: (entry.claimedChecks ?? []).filter((c) => !c.matchedAtExpected).map((c) => c.field),
      failedFiles: (entry.productFileChecks ?? []).filter((c) => !c.candidateMatchesApproval).map((c) => c.path),
    })),
    candidates: result.slices.filter((entry) => entry.candidateRecord).map((entry) => ({ candidate: entry.candidateRecord.candidate, configComplete: entry.candidateRecord.configComplete, snapshotMismatches: entry.candidateRecord.snapshotManifest?.mismatches ?? null })),
    evidenceRecognition: receiptRecognition,
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  process.stdout.write(`\n审计报告: ${path.join(OUT_DIR, "joint-qa-audit.json")}\n`);
}

await main();
