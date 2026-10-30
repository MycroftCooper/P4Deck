#!/usr/bin/env node
// 联合 manifest vs union.json 对账（v2 复核用，含 lead 裁决的 port 规则）：
//   node tests/qa/batch-qa/compare-manifest-union-20261029.mjs --manifest <joint manifest> [--out <json>]
// pass=true 定义（lead 更新）：
//  路径集=union 90（types.ts 按 port 说明、domain.rs 按 portTargets）+ 缺失 0 + 无溯源 extra 0
//  + ours==base exactSha 全等 + port 文件四 sha 齐全（contracts.ts / domain.rs merged sha 必须提供并与 manifest 一致）
//  另：manifest 不得写 src/shared/contracts/types.ts；FE 文件期望 sha 采用 import 重写后的 expectedManifestSha256。
import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const REPO = "D:/GitCode/P4Deck";
const UNION = path.join(REPO, "artifacts", "evidence", "joint-qa-20261029", "union.json");
const args = process.argv.slice(2);
const arg = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const manifestPath = arg("--manifest");
if (!manifestPath) { process.stderr.write("缺少 --manifest <file>\n"); process.exit(2); }
const outPath = arg("--out") || path.join(REPO, "artifacts", "evidence", "joint-qa-20261029", "manifest-union-compare.json");
const sha = (b) => createHash("sha256").update(b).digest("hex").toUpperCase();
async function hashFile(p) { try { if (!(await stat(p)).isFile()) return null; return sha(await readFile(p)); } catch { return null; } }

const union = JSON.parse(await readFile(UNION, "utf8"));
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const unionMap = new Map(union.uniqueFiles.map((f) => [f.path, f]));
const excluded = new Map((union.excluded || []).map((e) => [e.path, e.reason]));
const manifestMap = new Map(manifest.files.map((f) => [f.path, f]));
const manifestPaths = manifest.files.map((f) => f.path);

// port 规则
const portedSources = new Map();
for (const f of union.uniqueFiles) if (f.portedTo) portedSources.set(f.path, { target: f.portedTo, mergedSha256: f.portMergedSha256 ?? null, fourSha: f.fourSha ?? null });
const legalTargets = new Map();
for (const [src, info] of portedSources) legalTargets.set(info.target, { source: src, mergedSha256: info.mergedSha256, fourSha: info.fourSha });
for (const pt of union.portTargets || []) legalTargets.set(pt.target, { source: pt.source, mergedSha256: pt.mergedSha256 ?? null, fourSha: pt.fourSha ?? null, assertions: pt.assertions });

const missing = union.uniqueFiles.filter((f) => !manifestMap.has(f.path) && !f.portedTo).map((f) => f.path);
const extra = manifestPaths.filter((p) => !unionMap.has(p) && !legalTargets.has(p) && !excluded.has(p));
const excludedForbiddenPresent = manifestPaths.filter((p) => excluded.has(p));
const portViolations = [];
const portChecks = [];

for (const [src, info] of portedSources) {
  if (manifestMap.has(src)) portViolations.push({ path: src, reason: "lead 裁决 manifest 不写 types.ts；已 port 到 " + info.target });
  const targetEntry = manifestMap.get(info.target);
  if (!targetEntry) portViolations.push({ path: info.target, reason: "port target 未写入 manifest" });
  const merged = info.mergedSha256 ?? null;
  if (!merged) portViolations.push({ path: info.target, reason: "port merged sha 尚未提供（v2 最终需 contracts.ts merged sha）" });
  if (targetEntry && merged && (targetEntry.sourceSha256 || "").toUpperCase() !== merged) portViolations.push({ path: info.target, reason: "contracts.ts manifest sha 与 merged 不一致（" + targetEntry.sourceSha256 + " vs " + merged + "）" });
  portChecks.push({ kind: "types-port", source: src, target: info.target, mergedSha256: merged, manifestHasSource: manifestMap.has(src), manifestHasTarget: !!targetEntry });
}
for (const pt of union.portTargets || []) {
  const targetEntry = manifestMap.get(pt.target);
  const merged = pt.mergedSha256 ?? null;
  if (!targetEntry) portViolations.push({ path: pt.target, reason: "portTarget 未写入 manifest" });
  if (!merged) portViolations.push({ path: pt.target, reason: "portTarget merged sha 尚未提供（v2 最终需 domain.rs merged sha）" });
  if (pt.source && manifestMap.has(pt.source)) portViolations.push({ path: pt.source, reason: "被排除的 source 不应出现在 manifest" });
  if (targetEntry && merged && (targetEntry.sourceSha256 || "").toUpperCase() !== merged) portViolations.push({ path: pt.target, reason: "domain.rs manifest sha 与 merged 不一致（" + targetEntry.sourceSha256 + " vs " + merged + "）" });
  portChecks.push({ kind: "path-port", source: pt.source, target: pt.target, mergedSha256: merged, manifestHasTarget: !!targetEntry, assertions: pt.assertions });
}

const perFile = [];
let nonconforming = 0;
for (const u of union.uniqueFiles) {
  if (u.portedTo) continue;
  const m = manifestMap.get(u.path);
  if (!m) continue;
  const actual = (m.sourceSha256 || "").toUpperCase();
  const ours = await hashFile(path.join(manifest.originalRoot, u.path));
  const base = u.baseSha256;
  const expected = u.expectedManifestSha256 ?? u.resultSha256;
  const exactRequired = !ours || !base || ours === base;
  const ok = exactRequired ? actual === expected : true;
  if (!ok) nonconforming += 1;
  perFile.push({ path: u.path, subset: u.subset, oursSha256: ours, baseSha256: base, mappingFinalSha256: u.mappingFinalSha256 ?? u.resultSha256, expectedManifestSha256: expected, importRewriteApplied: !!u.importRewriteApplied, manifestSha256: actual, exactRequired, shaMatch: actual === expected, ok });
}
const report = {
  schemaVersion: 1,
  kind: "manifest-union-compare",
  generatedAt: new Date().toISOString(),
  manifestPath,
  manifestSha256: manifest.manifestSha256,
  unionPath: UNION,
  unionFullSha: await hashFile(UNION),
  counts: {
    unionFiles: union.uniqueFiles.length,
    manifestFiles: manifestPaths.length,
    missingFromManifest: missing.length,
    extraWithoutProvenance: extra.length,
    excludedForbiddenPresent: excludedForbiddenPresent.length,
    exactShaNonconforming: nonconforming,
    exactShaChecked: perFile.filter((f) => f.exactRequired).length,
    portViolations: portViolations.length,
    portTargetsInManifest: [...legalTargets.keys()].filter((t) => manifestMap.has(t)).length,
  },
  pass: missing.length === 0 && extra.length === 0 && excludedForbiddenPresent.length === 0 && nonconforming === 0 && portViolations.length === 0,
  missingFromManifest: missing,
  extraWithoutProvenance: extra,
  excludedForbiddenPresent,
  portViolations,
  portChecks,
  perFile,
};
await writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ out: outPath, pass: report.pass, counts: report.counts, missingSample: missing.slice(0, 10), extraSample: extra.slice(0, 10), portViolations: portViolations.slice(0, 10) }, null, 1)}\n`);
if (!report.pass) process.exitCode = 1;
