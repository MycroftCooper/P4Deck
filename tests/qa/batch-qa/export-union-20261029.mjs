#!/usr/bin/env node
// 导出联合文件并集（lead 最终口径）：67 核心子集 + 有冻结证据溯源的 prerequisite 扩展子集。
// 输出: artifacts/evidence/joint-qa-20261029/union.json
// 只读切片证据/候选树/原树/joint 候选；不改产品。
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const REPO = "D:/GitCode/P4Deck";
const TEMP = process.env.TEMP || process.env.TMP;
const OUT = path.join(REPO, "artifacts", "evidence", "joint-qa-20261029", "union.json");
const JOINT_CAND = path.join(TEMP, "P4Deck-joint-20261029", "source");
const FE_UNION = path.join(TEMP, "P4Deck-fe-union-20261029");

const up = (v) => (typeof v === "string" ? v.toUpperCase() : null);
async function hashFile(p) {
  try {
    const info = await stat(p);
    if (!info.isFile()) return null;
    return createHash("sha256").update(await readFile(p)).digest("hex").toUpperCase();
  } catch {
    return null;
  }
}
const json = async (p) => JSON.parse(await readFile(p, "utf8"));
const norm = (p) => String(p).replace(/\\/g, "/");

const slices = [];
async function addSlice({ slice, domain, tier = "handoff/manifest", evidence, candidateTree = null, files }) {
  const entry = { slice, domain, tier, evidence, evidenceSha256: await hashFile(evidence), candidateTree, files: [] };
  for (const f of files) {
    if (!f || !f.path) continue;
    const base = up(f.baseSha256 ?? f.base);
    const result = up(f.resultSha256 ?? f.result ?? f.finalSha256 ?? f.sha256);
    if (!result) continue;
    entry.files.push({ path: norm(f.path), mode: f.kind ?? f.operation ?? (base ? "modify" : "create"), baseSha256: base, resultSha256: result });
  }
  slices.push(entry);
}

// ---- core-67 来源（BE 9 片口径，98 entries -> 67 unique） ----
{
  const p = path.join(TEMP, "P4Deck-server-status-join01-20261029", "evidence", "joint-manifest.json");
  const j = await json(p);
  await addSlice({ slice: "CON06", domain: "rust", evidence: p, files: j.files.map((f) => ({ path: f.path, resultSha256: f.sha256, baseSha256: f.baseSha256 ?? null, kind: f.baseSha256 ? "modify" : "create" })) });
}
for (const [slice, dir, file] of [
  ["S1A", "P4Deck-action-r01-20261029", "s1a-handoff.json"],
  ["S1B", "P4Deck-action-r01-20261029", "s1b-handoff.json"],
  ["S2a-BE", "P4Deck-action-s2a-20261029", "s2a-handoff.json"],
  ["S3a-BE", "P4Deck-action-s3a-20261029", "s3a-handoff.json"],
  ["S2b-FE@93926597", "P4Deck-action-fe-s2b-20261029", "handoff.json"],
]) {
  const p = path.join(TEMP, dir, "evidence", file);
  const j = await json(p);
  await addSlice({ slice, domain: slice.includes("FE") ? "fe" : "rust", evidence: p, files: j.files || [] });
}
for (const [slice, domain, name] of [
  ["S2b-BE", "rust", "P4Deck-action-s2b-noop-20261029-manifest.json"],
  ["S2a-FE", "fe", "P4Deck-action-fe-s2a-20261029-manifest.json"],
  ["S3a-FE", "fe", "P4Deck-action-fe-s3a-20261029-manifest.json"],
  ["S2b-FE-NOOP@0F4719FE", "fe", "P4Deck-action-fe-s2b-noop-20261029-manifest.json"],
]) {
  const p = path.join(REPO, "artifacts", "workflow", name);
  const j = await json(p);
  await addSlice({ slice, domain, evidence: p, files: j.files.map((f) => ({ path: f.path, resultSha256: f.sourceSha256, baseSha256: f.expectedOriginalSha256 ?? null, kind: f.kind })) });
}
const CORE_SLICES = new Set(["CON06", "S1A", "S1B", "S2a-BE", "S2b-BE", "S2a-FE", "S3a-BE", "S3a-FE", "S2b-FE@93926597", "S2b-FE-NOOP@0F4719FE"]);

// ---- prerequisite 扩展：有冻结 handoff 证据的 FE 前置片 ----
for (const [slice, dir, file] of [
  ["FE-S1A", "P4Deck-action-fe-s1a-20261029", "handoff.json"],
  ["FE-S2-pure", "P4Deck-action-fe-s2-pure-20261029", "handoff.json"],
  ["S1B-FE", "P4Deck-action-fe-s1b-20261029", "handoff.json"],
  ["S3-REG01-FE", "P4Deck-action-fe-s3-reg01-20261029", "handoff.json"],
]) {
  const p = path.join(TEMP, dir, "evidence", file);
  const j = await json(p);
  await addSlice({ slice, domain: "fe", tier: "handoff", evidence: p, candidateTree: path.join(TEMP, dir, "source"), files: j.files || [] });
}

// ---- prerequisite 扩展：从 core FE 运行时文件做相对 import 闭包（只收原树不存在且非 test 的依赖） ----
const chainRoots = [
  ["FE-S1A", "P4Deck-action-fe-s1a-20261029"],
  ["FE-S2-pure", "P4Deck-action-fe-s2-pure-20261029"],
  ["S1B-FE", "P4Deck-action-fe-s1b-20261029"],
  ["S3-REG01-FE", "P4Deck-action-fe-s3-reg01-20261029"],
  ["S2a-FE", "P4Deck-action-fe-s2a-20261029"],
  ["S2b-FE@93926597", "P4Deck-action-fe-s2b-20261029"],
  ["S3a-FE", "P4Deck-action-fe-s3a-20261029"],
  ["S2b-FE-NOOP@0F4719FE", "P4Deck-action-fe-s2b-noop-20261029"],
].map(([slice, dir]) => ({ slice, dir, source: path.join(TEMP, dir, "source"), evidence: path.join(TEMP, dir, "evidence", "handoff.json") }));
const exists = async (p) => stat(p).then(() => true).catch(() => false);
async function findInRoots(rel) {
  for (const r of chainRoots) {
    const full = path.join(r.source, rel);
    if (await exists(full)) return { ...r, full, sha: await hashFile(full) };
  }
  return null;
}
const corePaths = new Set();
for (const s of slices) if (CORE_SLICES.has(s.slice)) for (const f of s.files) corePaths.add(f.path);
const closure = new Map();
const queue = [...corePaths].filter((p) => p.startsWith("src/") && !/\.test\.|src\/test\//.test(p));
const seen = new Set(queue);
while (queue.length && closure.size < 500) {
  const importer = queue.shift();
  const loc = await findInRoots(importer);
  if (!loc) continue;
  const text = await readFile(loc.full, "utf8").catch(() => "");
  const specs = new Set();
  for (const m of text.matchAll(/(?:from\s*|import\s*)["']([^"']+)["']/g)) specs.add(m[1]);
  for (const spec of specs) {
    if (!spec.startsWith(".")) continue;
    const base = path.posix.normalize(path.posix.join(path.posix.dirname(importer), spec));
    const candidates = [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`];
    for (const rel of candidates) {
      if (seen.has(rel)) continue;
      if (await exists(path.join(REPO, rel))) continue;
      const found = await findInRoots(rel);
      if (!found) continue;
      if (!rel.startsWith("src/") || /\.test\.|src\/test\//.test(rel)) continue;
      seen.add(rel);
      closure.set(rel, { path: rel, slice: found.slice, evidence: found.evidence, candidateTree: found.source, resultSha256: found.sha });
      queue.push(rel);
      break;
    }
  }
}
const bySlice = new Map();
for (const item of closure.values()) {
  if (!bySlice.has(item.slice)) bySlice.set(item.slice, []);
  bySlice.get(item.slice).push({ path: item.path, kind: "create", baseSha256: null, resultSha256: item.resultSha256 });
}
for (const [slice, files] of bySlice) {
  const r = chainRoots.find((x) => x.slice === slice);
  await addSlice({ slice: `${slice}@import-closure`, domain: "fe", tier: "import-closure", evidence: r.evidence, candidateTree: r.source, files });
}
// ---- compose union ----
const map = new Map();
for (const s of slices) {
  for (const f of s.files) {
    if (!map.has(f.path)) map.set(f.path, { path: f.path, contributions: [] });
    const entry = map.get(f.path);
    if (entry.contributions.some((c) => c.slice === s.slice)) continue;
    entry.contributions.push({ slice: s.slice, domain: s.domain, tier: s.tier, mode: f.mode, baseSha256: f.baseSha256, resultSha256: f.resultSha256, evidence: s.evidence, candidateTree: s.candidateTree });
  }
}

const APPROVED_FINAL = {
  "src-tauri/src/lib.rs": { result: "D5496A43BBB0A97717FB7839785946A60D62E62E774D610E88521C9BCC18FCCF", note: "lead 批准跨片终值（handler 注册合并）" },
  "src-tauri/src/ipc/commands.rs": { result: "9F46906B93BB61B38788ACCA9EFF33D14C7B65DCAF4471AC64CFCF1640CC9265", note: "lead 批准跨片终值（capture/retention + CON06/S1A handlers 合并目标）" },
  "src-tauri/src/app/mod.rs": { result: "A14DDE701D4704022E4505D795D061479A8A3ADA405884B2351219A796CB4EE0", note: "lead 批准跨片终值" },
};
const EXCLUDE = {
  "src-tauri/src/domain/mod.rs": "lead 裁决排除：当前原树已迁移为 src-tauri/src/domain.rs；v2 需以 domain.rs 提供等价证据（S3a execution + S2b Retained）",
};
const RESOLUTION = {
  "src/shared/contracts/types.ts": { source: "3way(FE-S2b-NOOP 8B82BB16 + FE-S3a E1B9D15B)", note: "retained + FileActionExecution 并存；joint v1.2 merged 8E9DC8C3；待 FE mapping 复核", threeWay: true },
  "src/app/shell/CommandBar.tsx": { source: "FE-S3a", note: "lead/joint：S3a 7C36F288 为 superset，覆盖 S2b/NOOP 51AD89BE", threeWay: true },
  "src/app/App.tsx": { source: "3way(CON06 152EAEAE + FE-chain fixup)", note: "joint v1.2 FE proposal 解析；待 FE mapping 复核", threeWay: true },
  "src/app/shell/StatusBar.test.tsx": { source: "3way(CON06 3765DE83 + FE-chain fixup)", note: "joint v1.2 FE proposal 解析；待 FE mapping 复核", threeWay: true },
};
const jointHash = async (rel) => hashFile(path.join(JOINT_CAND, rel));
const feOrder = ["FE-S1A", "FE-S2-pure", "S1B-FE", "S3-REG01-FE", "S2a-FE", "S2b-FE@93926597", "S3a-FE", "S2b-FE-NOOP@0F4719FE"];

const FE_MAP_PATH = path.join(FE_UNION, "mapping.json");
const feMappingSha = await hashFile(FE_MAP_PATH);
const feMappingDoc = feMappingSha ? await json(FE_MAP_PATH) : null;
const feMappingByPath = new Map((feMappingDoc?.files ?? []).map((f) => [norm(f.path), f]));

const uniqueFiles = [];
const excluded = [];
const threeWay = [];
for (const entry of [...map.values()].sort((a, b) => a.path.localeCompare(b.path))) {
  if (EXCLUDE[entry.path]) {
    excluded.push({ path: entry.path, reason: EXCLUDE[entry.path] });
    continue;
  }
  const ours = await hashFile(path.join(REPO, entry.path));
  const mode = ours ? "modify" : "create";
  const domain = entry.contributions.some((c) => c.domain === "rust") ? "rust" : "fe";
  const inCore = entry.contributions.some((c) => CORE_SLICES.has(c.slice));
  const rec = {
    path: entry.path,
    subset: inCore ? "core-67" : "prerequisite-extension",
    mode,
    domain,
    provenance: entry.contributions.map((c) => ({ slice: c.slice, tier: c.tier, evidence: c.evidence, candidateTree: c.candidateTree, baseSha256: c.baseSha256, resultSha256: c.resultSha256 })),
    sourceSlices: [...new Set(entry.contributions.map((c) => c.slice))],
    baseSha256: entry.contributions.find((c) => c.baseSha256)?.baseSha256 ?? null,
    resultSha256: null,
    oursSha256: ours,
  };
  const single = [...new Set(entry.contributions.map((c) => c.resultSha256))];
  if (APPROVED_FINAL[entry.path]) {
    rec.resultSha256 = APPROVED_FINAL[entry.path].result;
    rec.resolution = APPROVED_FINAL[entry.path].note;
  } else if (RESOLUTION[entry.path]) {
    rec.resultSha256 = await jointHash(entry.path);
    rec.resolution = RESOLUTION[entry.path].note;
    rec.resolutionSource = RESOLUTION[entry.path].source;
    threeWay.push({ path: entry.path, subset: rec.subset, reason: "3-way/joint resolution（QA 以 diff+测试验语义，不要求 sha 相等）" });
  } else if (single.length === 1) {
    rec.resultSha256 = single[0];
  } else if (domain === "fe") {
    const known = entry.contributions.filter((c) => c.tier !== "candidate-tree");
    const ordered = [...known].sort((a, b) => feOrder.indexOf(b.slice) - feOrder.indexOf(a.slice));
    const pick = ordered[0] ?? entry.contributions[entry.contributions.length - 1];
    rec.resultSha256 = pick.resultSha256;
    rec.resolution = "FE 冻结链后片覆盖前片（含 prerequisite 前置片）；candidate-tree 仅作缺 handoff 时的溯源";
  } else {
    const base = entry.contributions.find((c) => c.baseSha256)?.baseSha256 ?? null;
    const nodes = entry.contributions;
    const roots = nodes.filter((n) => !n.baseSha256 || n.baseSha256 === ours || !nodes.some((m) => m.resultSha256 === n.baseSha256));
    const leaves = nodes.filter((n) => !nodes.some((m) => m.baseSha256 === n.resultSha256));
    if (roots.length === 1 && leaves.length === 1) {
      rec.resultSha256 = leaves[0].resultSha256;
      rec.resolution = "单链 superset（base=前片 result）";
    } else {
      rec.resultSha256 = await jointHash(entry.path);
      rec.resolution = "多分支三路合并；result 仅参考 joint v1.2 合并值，QA 按四 sha+diff/测试验语义";
      threeWay.push({ path: entry.path, subset: rec.subset, reason: "rust siblings/3-way" });
    }
  }
  if (feMappingByPath.has(entry.path)) {
    const m = feMappingByPath.get(entry.path);
    rec.resultSha256 = up(m.finalSha256) ?? rec.resultSha256;
    rec.feMapping = { mappingPath: FE_MAP_PATH, mappingSha256: feMappingSha, method: m.method, sourceSlice: m.sourceSlice, baseSha256: up(m.baseSha256), originalSha256: up(m.originalSha256) };
    rec.resolution = `FE union mapping(${m.method}, ${m.sourceSlice})`;
  }  const feFour = (feMappingDoc?.feFourSha ?? []).find((x) => x.path === entry.path);
  if (feFour) {
    rec.fourSha = { baseSha256: up(feFour.baseSha256), oursSha256: up(feFour.oursSha256), resultSha256: up(feFour.resultSha256), mergedSha256: up(feFour.mergedSha256), note: feFour.note };
    if (!threeWay.some((t) => t.path === entry.path)) threeWay.push({ path: entry.path, subset: rec.subset, reason: "FE 3-way 四 sha（QA 以 diff+测试验语义）" });
  }  if (entry.path === "src-tauri/src/domain/mod.rs") rec.layoutPort = { currentTreePath: "src-tauri/src/domain.rs", currentTreeSha256: await hashFile(path.join(REPO, "src-tauri/src/domain.rs")) };
  uniqueFiles.push(rec);
}

// ---- lead 裁决：types.ts port 到 contracts.ts + domain portTargets + import 重写清单 ----
const typesEntry = uniqueFiles.find((f) => f.path === "src/shared/contracts/types.ts");
const contractsTargetSha = await hashFile(path.join(REPO, "src/shared/contracts.ts"));
if (typesEntry) {
  typesEntry.portedTo = "src/shared/contracts.ts";
  typesEntry.status = "not-in-manifest-ported";
  typesEntry.portMergedSha256 = null; // BE 提供
  typesEntry.portRule = "当前原树已迁移为单文件 src/shared/contracts.ts（HEAD contracts/types.ts 已合并）；不重建 types.ts；切片类型增量端口进 contracts.ts；70 FE resolved 文件 import 重写 shared/contracts/types -> shared/contracts；manifest 不写 types.ts";
  typesEntry.fourSha = { baseSha256: null, resultSha256: typesEntry.resultSha256, mergedSha256: null, target: "src/shared/contracts.ts", targetCurrentSha256: contractsTargetSha };
}
const DOMAIN_SOURCE_RESULT = "53B5B1FC387D4C4A7621345DE038B6D838326A62D6F130E3CB834EE29B01EE77"; // S2b domain/mod.rs 冻结 result
const domainTargetSha = await hashFile(path.join(REPO, "src-tauri/src/domain.rs"));
const portTargets = [
  {
    source: "src-tauri/src/domain/mod.rs",
    sourceStatus: "excluded-from-union",
    target: "src-tauri/src/domain.rs",
    provenance: {
      beHandoff: path.join(TEMP, "P4Deck-joint-20261029", "evidence", "joint-handoff.json"),
      requirement: "BE 等价端口证据：domain.rs 必须含 WorkflowFileState::Retained（S2b）+ FileActionExecution/execution（S3a），相关 cargo 测试绿；当前原树 domain.rs 已迁移，不再有 domain/mod.rs",
    },
    targetCurrentSha256: domainTargetSha,
    sourceResultSha256: DOMAIN_SOURCE_RESULT,
    mergedSha256: null, // BE 提供
    fourSha: { baseSha256: null, oursSha256: domainTargetSha, resultSha256: DOMAIN_SOURCE_RESULT, mergedSha256: null },
    assertions: ["WorkflowFileState contains Retained", "FileActionExecution present", "cargo tests green (retained/revert/execution)"],
  },
];
const importRewriteFiles = [];
for (const f of uniqueFiles.filter((x) => !x.path.startsWith("src-tauri/"))) {
  const p = path.join(FE_UNION, "resolved", f.path);
  const txt = await readFile(p, "utf8").catch(() => null);
  if (txt && txt.includes("shared/contracts/types")) importRewriteFiles.push(f.path);
}
// 机械 import 重写后的期望 manifest sha（FE 文件）：shared/contracts/types -> shared/contracts
for (const f of uniqueFiles.filter((x) => !x.path.startsWith("src-tauri/"))) {
  const p = path.join(FE_UNION, "resolved", f.path);
  const txt = await readFile(p, "utf8").catch(() => null);
  if (!txt) continue;
  const rewritten = txt.replace(/shared\/contracts\/types/g, "shared/contracts");
  f.mappingFinalSha256 = f.resultSha256;
  f.importRewriteApplied = rewritten !== txt;
  if (rewritten !== txt) f.expectedManifestSha256 = createHash("sha256").update(rewritten).digest("hex").toUpperCase();
}
const importRewrites = {
  rule: "在 70 个 FE resolved 文件中把 import 说明符 `shared/contracts/types` 机械重写为 `shared/contracts`（相对路径形式保持不变，如 ../../shared/contracts/types -> ../../shared/contracts）",
  independentGeneratedCount: importRewriteFiles.length,
  files: importRewriteFiles,
  beListPending: true,
  verify: "v2 候选/manifest 的 70 个 FE 文件中不得再出现 `shared/contracts/types` 说明符；contracts.ts merged sha 必须==BE 值；tsc -b exit0",
};

const coreCount = uniqueFiles.filter((f) => f.subset === "core-67").length;
const feMapping = path.join(FE_UNION, "mapping.json");
const feMappingExists = await stat(feMapping).then(() => true).catch(() => false);
const h = (s) => createHash("sha256").update(JSON.stringify(s)).digest("hex").toUpperCase();
const out = {
  schemaVersion: 1,
  kind: "joint-approved-file-union",
  batch: "CON06+ACTION-R01",
  generatedAt: new Date().toISOString(),
  purpose: "lead 最终口径：67 核心子集 + 有冻结证据溯源的 prerequisite 扩展子集；每个文件必须有 provenance（slice+evidence+base/result），无溯源=FAIL；BE v2 绑定与 QA 独立复核共用",
  constraints: {
    rule: "ours==base → 最终 sha 必须==resultSha256；ours≠base（漂移）→ 允许 3-way（保留 ours 结构 + 合入 result 语义），QA 按 base/ours/result/merged 四 sha + diff/测试验语义，不要求 sha 相等",
    prerequisiteRule: "扩展文件必须有冻结证据溯源（handoff 或冻结候选树）；无 provenance 的 wholesale 树文件不得纳入（FAIL-2 底线）",
    approvedFinals: APPROVED_FINAL,
    excluded: Object.keys(EXCLUDE),
    closeGuard: "close_guard 测试适配到 107 且保留 admission 断言（107 命令全带守卫）",
    ipcRequired: {
      handlers: ["confirm_revert_action", "workflow_action_lookup", "action_write_fences", "action_release_unknown", "selected_move_reconcile", "get_server_status", "check_server_status", "selected_move_lookup"],
      requirement: "v2 handoff 需提供 IPC handler 存在性表（定义位置+lib.rs 注册行+来源切片）；全部必须同时定义并注册",
      retentionWiring: ["revert_retention::capture 前后接线", "result_with_retention", "domain WorkflowFileState::Retained", "FE 可收到 state:\"retained\""],
    },
    handoffConsistency: "v2 handoff 叙述必须与实际一致（不得再有过期描述）",
  },
  feResolvedMapping: {
    path: FE_MAP_PATH,
    status: feMappingSha ? "present" : "missing-at-generation",
    mappingSha256: feMappingSha,
    resolvedTotal: feMappingDoc?.files?.length ?? 0,
    covers: "union 全部非 src-tauri 路径（70）；旧 mapping sha 04E0E707 作废",
    fourSha: feMappingDoc?.feFourSha ?? [],
  },
  sources: slices.map((s) => ({ slice: s.slice, domain: s.domain, tier: s.tier, evidence: s.evidence, evidenceSha256: s.evidenceSha256, candidateTree: s.candidateTree, fileCount: s.files.length })),
  portTargets,
  importRewrites,
  slices: slices.map((s) => ({ slice: s.slice, domain: s.domain, tier: s.tier, evidence: s.evidence, evidenceSha256: s.evidenceSha256, candidateTree: s.candidateTree, files: s.files })),
  uniqueFiles,
  excluded,
  threeWayFiles: threeWay,
  feWarningReview: await readFile(path.join(REPO, "artifacts", "evidence", "joint-qa-20261029", "fe-7-review", "review.json"), "utf8").then(JSON.parse).then((r) => ({ path: "artifacts/evidence/joint-qa-20261029/fe-7-review/review.json", verdict: r.verdict, files: r.files.map((f) => ({ path: f.path, verdict: f.verdict, note: f.note })) })).catch(() => null),  coreSubsetPathCount: coreCount,
  counts: {
    sliceEntries: slices.length,
    uniqueFiles: uniqueFiles.length,
    core67: coreCount,
    core67Declared: coreCount + (excluded.length ? 1 : 0),
    prerequisiteExtension: uniqueFiles.length - coreCount,
    create: uniqueFiles.filter((f) => f.mode === "create").length,
    modify: uniqueFiles.filter((f) => f.mode === "modify").length,
    threeWayAnnotated: threeWay.length,
    excluded: excluded.length,
  },
};
await mkdir(path.dirname(OUT), { recursive: true });
await writeFile(OUT, `${JSON.stringify(out, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ out: OUT, counts: out.counts, extensionPaths: uniqueFiles.filter((f) => f.subset !== "core-67").map((f) => f.path), threeWay: threeWay.map((t) => t.path), excluded: out.excluded.map((e) => e.path), feResolvedMapping: out.feResolvedMapping.status }, null, 1)}\n`);
