#!/usr/bin/env node
// 把 v2 的 port merged sha 与 7 条 LEAD 批准 adaptation 写入 union.json（可复跑）。
// 证据：artifacts/evidence/joint-v2/joint-handoff-v2.json（currentTreePorts/testAdaptations/nonconformingExplained）
// 用法: node tests/qa/batch-qa/apply-v2-ports-adaptations-20261030.mjs
import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const REPO = "D:/GitCode/P4Deck";
const UNION = path.join(REPO, "artifacts", "evidence", "joint-qa-20261029", "union.json");
const V2_EVIDENCE = path.join(REPO, "artifacts", "evidence", "joint-v2");
const MANIFEST = path.join(V2_EVIDENCE, "joint-v2-manifest-final.json");
const HANDOFF = path.join(V2_EVIDENCE, "joint-handoff-v2.json");

const CONTRACTS_MERGED = "98457714BE1E3CF17F81544ABDAB6CAC0DEDACDF248889C280489FCFD0C15736";
const DOMAIN_MERGED = "866C6E0A5EA0B1652A76985C24831C38746A75CE721F7943C9965D52F9218658";
const sha = (b) => createHash("sha256").update(b).digest("hex").toUpperCase();
const hashFile = async (p) => sha(await readFile(p));

const union = JSON.parse(await readFile(UNION, "utf8"));
const manifest = JSON.parse(await readFile(MANIFEST, "utf8"));
const handoff = JSON.parse(await readFile(HANDOFF, "utf8"));
const manifestMap = new Map(manifest.files.map((f) => [f.path, f]));

// 1) ports
const typesEntry = union.uniqueFiles.find((f) => f.path === "src/shared/contracts/types.ts");
if (typesEntry) {
  typesEntry.portMergedSha256 = CONTRACTS_MERGED;
  typesEntry.fourSha = { ...(typesEntry.fourSha || {}), mergedSha256: CONTRACTS_MERGED, resultSha256: typesEntry.resultSha256, target: "src/shared/contracts.ts" };
  typesEntry.portEvidence = { handoff: HANDOFF, currentTreePorts: "src/shared/contracts/types.ts", note: "v2 把类型增量端口进 contracts.ts，import 全部重写；manifest 不应写 types.ts（见 v2 偏差记录）" };
}
const domainPort = (union.portTargets || []).find((p) => p.target === "src-tauri/src/domain.rs");
if (domainPort) {
  domainPort.mergedSha256 = DOMAIN_MERGED;
  domainPort.fourSha = { ...(domainPort.fourSha || {}), mergedSha256: DOMAIN_MERGED };
  domainPort.evidence = { handoff: HANDOFF, note: "v2 domain.rs 含 WorkflowFileState::Retained + FileActionExecution，cargo 测试绿" };
}
const contractsPort = [...(union.portTargets || [])].find((p) => p.target === "src/shared/contracts.ts");
if (!contractsPort) {
  union.portTargets = [
    ...(union.portTargets || []),
    { source: "src/shared/contracts/types.ts", sourceStatus: "ported", target: "src/shared/contracts.ts", mergedSha256: CONTRACTS_MERGED, fourSha: { baseSha256: null, oursSha256: null, resultSha256: typesEntry?.resultSha256 ?? null, mergedSha256: CONTRACTS_MERGED }, evidence: { handoff: HANDOFF } },
  ];
}

// 2) accepted adaptations（LEAD 批准，逐条给证据）
const ADAPT_REASONS = {
  "action-s1b.vitest.config.ts": "current-tree vitest config layout port（setupFiles src/test/setupCache.ts→src/testSetup.ts；define __P4DECK_DESKTOP__=false）",
  "action-s2a.vitest.config.ts": "current-tree vitest config layout port（setupFiles setupCache.ts→src/testSetup.ts；define __P4DECK_DESKTOP__=false）",
  "action-s2b.vitest.config.ts": "current-tree vitest config layout port（setupFiles setupCache.ts→src/testSetup.ts；define __P4DECK_DESKTOP__=false）",
  "action-s3-reg01.vitest.config.ts": "current-tree vitest config layout port（setupFiles setupCache.ts→src/testSetup.ts；define __P4DECK_DESKTOP__=false）",
  "action-s3a.vitest.config.ts": "current-tree vitest config layout port（setupFiles setupCache.ts→src/testSetup.ts；define __P4DECK_DESKTOP__=false）",
  "src-tauri/src/app/revert_action.rs": "-x 契约测试适配（LEAD 裁决；保留 exact paths/不扩 wildcard 安全断言）",
  "src-tauri/src/lib.rs": "LEAD 批准 final D5496A43 + CON06 两 handler 增量注册",
};
const accepted = [];
for (const [p, reason] of Object.entries(ADAPT_REASONS)) {
  const m = manifestMap.get(p);
  if (!m) continue;
  accepted.push({ path: p, approvedBy: "LEAD", expectedManifestSha256: m.sourceSha256, reason, evidence: { manifest: MANIFEST, handoff: HANDOFF, adaptation: handoff.testAdaptations?.[p] ?? handoff.nonconformingExplained?.find?.((x) => x.path === p) ?? null } });
  const u = union.uniqueFiles.find((f) => f.path === p);
  if (u) {
    u.acceptedAdaptation = true;
    u.adaptationReason = reason;
    u.expectedManifestSha256 = m.sourceSha256;
  }
}
union.acceptedAdaptations = accepted;

// 3) v2 实录（含偏差登记，不静默通过）
union.v2 = {
  manifestPath: MANIFEST,
  manifestSha256: manifest.manifestSha256,
  manifestFileSha256: await hashFile(MANIFEST),
  files: manifest.files.length,
  handoffPath: HANDOFF,
  handoffSha256: await hashFile(HANDOFF),
  candidateRoot: manifest.candidateRoot,
  ports: { contractsTs: CONTRACTS_MERGED, domainRs: DOMAIN_MERGED },
  adaptations: accepted.length,
};
union.v2Deviation = {
  path: "src/shared/contracts/types.ts",
  kindInManifest: manifestMap.get("src/shared/contracts/types.ts")?.kind ?? null,
  sha256InManifest: manifestMap.get("src/shared/contracts/types.ts")?.sourceSha256 ?? null,
  rule: "lead 裁决：manifest 不写 types.ts（已 port 到 contracts.ts；候选内 import 全部重写，types.ts 成为 0 引用的孤儿文件）",
  impact: "候选内 types.ts 存在但无任何文件 import（QA 全候选扫描 import contracts/types = 0）；apply 会新增一个与 contracts.ts 并存的孤儿类型文件，违背 current-tree 单文件迁移裁决",
  compareEffect: "compare-manifest-union 会把它计为 portViolation（types.ts 不应在 manifest）；因此本次不给最终批准",
  recommendedFix: "BE 从 manifest 移除 src/shared/contracts/types.ts 并重 freeze（92→91 文件），新 sha 后 QA 复跑即可；或 LEAD 显式豁免该条（QA 记录为 approved deviation）",
};
union.updatedForV2At = new Date().toISOString();
await writeFile(UNION, `${JSON.stringify(union, null, 2)}\n`, "utf8");
const outSha = await hashFile(UNION);
process.stdout.write(`${JSON.stringify({ union: UNION, unionSha256: outSha, ports: union.v2.ports, adaptations: accepted.length, deviation: union.v2Deviation.path }, null, 1)}\n`);
