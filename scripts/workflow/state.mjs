#!/usr/bin/env node
// 工作流状态库工具。state.json 是任务/批次状态的唯一机读真值。
// 用法:
//   node scripts/workflow/state.mjs import    从 ForAIDoc/PM/Windows本机私用TODO.md 迁移
//   node scripts/workflow/state.mjs check     校验状态库（CI/交接前必跑）
//   node scripts/workflow/state.mjs board     渲染人类看板 ForAIDoc/PM/工作流/看板.md
//   node scripts/workflow/state.mjs task <ID> 打印单个任务的短任务单（≤200 字口径）
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const TODO_DOC = path.join(ROOT, "ForAIDoc", "PM", "Windows本机私用TODO.md");
const STATE_DIR = path.join(ROOT, "ForAIDoc", "PM", "工作流");
const STATE_FILE = path.join(STATE_DIR, "state.json");
const BOARD_FILE = path.join(STATE_DIR, "看板.md");

const STAGES = ["done", "implemented", "partial", "in-progress", "todo", "blocked", "proposed"];
const TYPES = ["bug", "feature", "refactor"];

// 状态迁移表：按前缀匹配，顺序敏感（长前缀在前）。
const STAGE_PATTERNS = [
  ["已实现且有相应验收证据", "done"],
  ["已实现待验收", "implemented"],
  ["限定dev人工通过", "implemented"],
  ["部分实现", "partial"],
  ["待实现", "todo"],
  ["受阻", "blocked"],
  ["进行中", "in-progress"],
  ["建议待确认", "proposed"],
];

const TYPE_PATTERNS = [
  ["Bug修复", "bug"],
  ["功能需求", "feature"],
  ["重构与代码优化", "refactor"],
];

const ID_RE = /^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+$/;

function repoRelative(absolutePath) {
  return path.relative(ROOT, absolutePath).split(path.sep).join("/");
}

function splitRow(line) {
  const cells = line.split("|");
  cells.shift();
  cells.pop();
  return cells.map((cell) => cell.trim());
}

function mapPrefix(value, patterns) {
  for (const [prefix, mapped] of patterns) {
    if (value.startsWith(prefix)) return mapped;
  }
  return undefined;
}

function extractLinks(text, baseDir) {
  const links = [];
  for (const match of text.matchAll(/\[([^\]]+)\]\(([^)]+)\)/g)) {
    const target = match[2].trim();
    if (/^[a-z]+:/i.test(target) || target.startsWith("#")) continue;
    const resolved = path.resolve(baseDir, target.split("#")[0]);
    links.push(repoRelative(resolved));
  }
  return [...new Set(links)];
}

function extractDeps(text) {
  const raw = text.split(/[；;、,，/]/).map((item) => item.trim()).filter(Boolean);
  return [...new Set(raw)];
}

/** 解析 TODO.md 中的表格区块。返回 { main, archived, subitems } 行数组。 */
function parseTodo(markdown) {
  const lines = markdown.split(/\r?\n/);
  const baseDir = path.dirname(TODO_DOC);
  const headingText = (line) => (/^#{2,4}\s/.test(line) ? line.replace(/^#+\s*/, "").trim() : undefined);
  const sectionIndex = (title) =>
    lines.findIndex((line) => headingText(line)?.startsWith(title));
  const sliceBetween = (fromTitle, toTitles) => {
    const start = sectionIndex(fromTitle);
    if (start < 0) return [];
    const candidates = toTitles.map((title) => sectionIndex(title)).filter((index) => index > start);
    const end = candidates.length ? Math.min(...candidates) : lines.length;
    return lines.slice(start + 1, end);
  };

  const toPackage = (line, { archived }) => {
    const cells = splitRow(line);
    if (cells.length < 7 || !ID_RE.test(cells[0])) return undefined;
    const [id, typeRaw, owner, moduleRange, statusRaw, priority] = cells;
    const note = cells.slice(7, -1).join(" | ");
    const depsRaw = cells.length > 7 ? cells.at(-1) : "";
    const moduleName = moduleRange.includes("：") ? moduleRange.split("：")[0] : moduleRange;
    return {
      id,
      type: mapPrefix(typeRaw, TYPE_PATTERNS),
      typeRaw,
      owner,
      module: moduleName,
      scope: moduleRange,
      stage: mapPrefix(statusRaw, STAGE_PATTERNS),
      statusRaw,
      priority,
      evidence: extractLinks(cells[6] ?? "", baseDir),
      note,
      depsRaw,
      deps: [],
      archived,
      migrated: true,
      verification: { qaPassed: null, applied: null, humanAccepted: null },
      updatedAt: null,
    };
  };

  const main = [];
  for (const line of sliceBetween("唯一任务表", ["完成项归档"])) {
    if (!line.startsWith("|")) continue;
    const entry = toPackage(line, { archived: false });
    if (entry) main.push(entry);
  }

  const archived = [];
  for (const line of sliceBetween("完成项归档", ["下一批最优先任务"])) {
    if (!line.startsWith("|")) continue;
    const entry = toPackage(line, { archived: true });
    if (entry) archived.push(entry);
  }

  // 关联子项表：列布局不同（子ID / 父项 | 类型 | 负责人 | 优先级 | 状态 | 依赖 | 验收）
  const subitems = [];
  for (const line of sliceBetween("混合工作包关联子项", ["最新调度覆盖"])) {
    if (!line.startsWith("|")) continue;
    const cells = splitRow(line);
    if (cells.length < 6) continue;
    const idMatch = cells[0].match(/^([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+)\s*\/\s*([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+)$/);
    if (!idMatch) continue;
    const [, subId, parentId] = idMatch;
    subitems.push({
      id: subId,
      parentId,
      type: mapPrefix(cells[1], TYPE_PATTERNS),
      typeRaw: cells[1],
      owner: cells[2],
      priority: cells[3],
      statusRaw: cells[4],
      stage: mapPrefix(cells[4], STAGE_PATTERNS) ?? "partial",
      depsRaw: cells[5],
      note: cells.slice(6).join(" | "),
      migrated: true,
    });
  }

  return { main, archived, subitems };
}

function buildState({ main, archived, subitems }, previous) {
  const known = new Set(main.map((entry) => entry.id));
  for (const entry of [...main, ...archived]) {
    entry.deps = extractDeps(entry.depsRaw).filter((dep) => known.has(dep) && dep !== entry.id);
  }
  return {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    source: {
      kind: "migrated",
      from: "ForAIDoc/PM/Windows本机私用TODO.md",
      note: "由 scripts/workflow/state.mjs import 生成；此后 state.json 为唯一真值，TODO 表为历史台账。",
    },
    batch: previous?.batch ?? {
      id: "CON06+ACTION-R01",
      goal: "只完成 CON06（服务器状态）与 ACTION-R01 全矩阵迁移及必要 QA",
      stopCondition: "两项完成 + 联合 QA 通过 → BE 一次性 Apply 到本地原树 → 全员停工",
      devClosedByUser: false,
      applyMode: "batched",
      openQuestions: ["Apply 前需用户确认 dev 已关闭且无在途操作"],
    },
    counts: {
      main: main.length,
      archived: archived.length,
      total: main.length + archived.length,
      subitems: subitems.length,
    },
    packages: [...main, ...archived],
    subitems,
  };
}

async function cmdImport() {
  const markdown = await readFile(TODO_DOC, "utf8");
  let previous;
  try {
    previous = JSON.parse(await readFile(STATE_FILE, "utf8"));
  } catch {
    previous = undefined;
  }
  const parsed = parseTodo(markdown);
  const state = buildState(parsed, previous);
  if (state.counts.total !== 52) {
    process.stderr.write(
      `警告: 解析到 ${state.counts.total} 个主工作包（含归档），文档声称 52，请核对 TODO 表结构是否变化。\n`,
    );
  }
  await mkdir(STATE_DIR, { recursive: true });
  await writeFile(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  process.stdout.write(
    `已写入 ${repoRelative(STATE_FILE)}: 主包 ${state.counts.main} + 归档 ${state.counts.archived} = ${state.counts.total}，子项 ${state.counts.subitems}\n`,
  );
}

async function loadState() {
  return JSON.parse(await readFile(STATE_FILE, "utf8"));
}

function stageOf(state, id) {
  return [...state.packages, ...state.subitems].find((entry) => entry.id === id);
}

function summarize(state) {
  const byStage = Object.fromEntries(STAGES.map((stage) => [stage, 0]));
  const byModule = new Map();
  // 含归档项，才是文档“52 主工作包”的口径。
  for (const pkg of state.packages) {
    byStage[pkg.stage ?? "unknown"] = (byStage[pkg.stage ?? "unknown"] ?? 0) + 1;
    if (pkg.archived) {
      const archivedBucket = byModule.get("已完成归档") ?? { total: 0, stages: {} };
      archivedBucket.total += 1;
      archivedBucket.stages[pkg.stage ?? "unknown"] = (archivedBucket.stages[pkg.stage ?? "unknown"] ?? 0) + 1;
      byModule.set("已完成归档", archivedBucket);
      continue;
    }
    const bucket = byModule.get(pkg.module) ?? { total: 0, stages: {} };
    bucket.total += 1;
    bucket.stages[pkg.stage ?? "unknown"] = (bucket.stages[pkg.stage ?? "unknown"] ?? 0) + 1;
    byModule.set(pkg.module, bucket);
  }
  return { byStage, byModule };
}

async function cmdCheck() {
  const state = await loadState();
  const errors = [];
  const warnings = [];
  const seen = new Set();
  const known = new Set(state.packages.map((entry) => entry.id));

  for (const pkg of state.packages) {
    if (seen.has(pkg.id)) errors.push(`重复任务 ID: ${pkg.id}`);
    seen.add(pkg.id);
    if (!TYPES.includes(pkg.type)) errors.push(`${pkg.id}: 未知类型 ${pkg.typeRaw}`);
    if (!STAGES.includes(pkg.stage)) errors.push(`${pkg.id}: 未知状态 ${pkg.statusRaw}`);
    for (const dep of pkg.deps) {
      if (!known.has(dep)) errors.push(`${pkg.id}: 依赖不存在 ${dep}`);
    }
    for (const evidence of pkg.evidence) {
      try {
        await readFile(path.join(ROOT, evidence));
      } catch {
        warnings.push(`${pkg.id}: 证据路径不存在 ${evidence}`);
      }
    }
  }

  const mainCount = state.packages.filter((entry) => !entry.archived).length;
  if (mainCount === 0) errors.push("没有主工作包");
  if (!state.batch?.id || !state.batch?.stopCondition) errors.push("缺少当前批次 id/停机条件");
  if (!state.packages.some((entry) => entry.archived)) warnings.push("没有归档任务，迁移可能不完整");

  const summary = summarize(state);
  const report = {
    ok: errors.length === 0,
    checked: state.packages.length,
    main: mainCount,
    archived: state.packages.length - mainCount,
    subitems: state.subitems.length,
    byStage: summary.byStage,
    errors,
    warnings,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  await mkdir(path.join(ROOT, "artifacts", "workflow"), { recursive: true });
  await writeFile(
    path.join(ROOT, "artifacts", "workflow", "state-check.json"),
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8",
  );
  if (!report.ok) process.exitCode = 1;
}

function truncate(text, limit) {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

async function cmdBoard() {
  const state = await loadState();
  const summary = summarize(state);
  const lines = [];
  lines.push("# 工作流看板（自动生成，勿手改）", "");
  lines.push(`> 由 \`node scripts/workflow/state.mjs board\` 从 [state.json](state.json) 生成。`);
  lines.push(`> 当前批次：**${state.batch.id}** — ${state.batch.goal}`);
  lines.push(`> 停机条件：${state.batch.stopCondition}`, "");
  lines.push("## 状态分布（52 主工作包口径，含 2 个已完成归档）", "");
  lines.push(`| 状态 | 数量 |`, `|---|---:|`);
  for (const stage of STAGES) lines.push(`| ${stage} | ${summary.byStage[stage] ?? 0} |`);
  lines.push("", "## 模块分布", "");
  lines.push("| 模块 | 总数 | 分布 |", "|---|---:|---|");
  for (const [moduleName, bucket] of summary.byModule) {
    const detail = Object.entries(bucket.stages)
      .map(([stage, count]) => `${stage}:${count}`)
      .join(" ");
    lines.push(`| ${moduleName} | ${bucket.total} | ${detail} |`);
  }
  lines.push("", "## 主工作包（含归档，归档项标 †）", "");
  lines.push("| ID | 类型 | 负责人 | 优先级 | 状态 | 证据 | 剩余步骤 |", "|---|---|---|---|---|---:|---|");
  for (const pkg of state.packages) {
    lines.push(
      `| ${pkg.archived ? `${pkg.id} †` : pkg.id} | ${pkg.type ?? "?"} | ${truncate(pkg.owner, 18)} | ${truncate(pkg.priority, 12)} | ${pkg.stage ?? "?"} | ${pkg.evidence.length} | ${truncate(pkg.note, 60)} |`,
    );
  }
  lines.push("", "## 关联子项（不单独计数）", "");
  lines.push("| 子项 | 父项 | 类型 | 负责人 | 状态 |", "|---|---|---|---|---|");
  for (const item of state.subitems) {
    lines.push(`| ${item.id} | ${item.parentId} | ${item.type ?? "?"} | ${truncate(item.owner, 18)} | ${item.stage} |`);
  }
  lines.push("");
  await writeFile(BOARD_FILE, lines.join("\n"), "utf8");
  process.stdout.write(`已写入 ${repoRelative(BOARD_FILE)}\n`);
}

async function cmdTask(id) {
  if (!id) {
    process.stderr.write("用法: node scripts/workflow/state.mjs task <ID>\n");
    process.exit(2);
  }
  const state = await loadState();
  const pkg = stageOf(state, id);
  if (!pkg) {
    process.stderr.write(`未知任务: ${id}\n`);
    process.exit(1);
  }
  const writeScope =
    pkg.owner?.includes("BE") && pkg.owner?.includes("FE")
      ? "src/** + src-tauri/**（FE/BE 分片，共享文件单写者）"
      : pkg.owner?.includes("BE")
        ? "src-tauri/**"
        : pkg.owner?.includes("QA")
          ? "src/test/batch-qa/**"
          : "src/**";
  const lines = [
    `任务 ${pkg.id} ｜ ${pkg.type} ｜ ${pkg.priority} ｜ ${pkg.module}`,
    `范围: ${truncate(pkg.scope, 120)}`,
    `写域: ${writeScope}`,
    `依赖: ${pkg.deps.length ? pkg.deps.join("、") : "无"}`,
    `退出: ${truncate(pkg.note || "见 TODO 表剩余步骤", 160)}`,
    `禁做: 生产 P4（含只读）/ 真实工具 / 打包发布 / 改写他人写域 / 整文件覆盖共享文件`,
    `证据: ${pkg.evidence.length ? pkg.evidence.join(" ") : "待补"}`,
    `预算: 单角色 ≤12 轮；超限停笔报告`,
  ];
  process.stdout.write(`${lines.join("\n")}\n`);
}

const command = process.argv[2] ?? "";
switch (command) {
  case "import":
    await cmdImport();
    break;
  case "check":
    await cmdCheck();
    break;
  case "board":
    await cmdBoard();
    break;
  case "task":
    await cmdTask(process.argv[3]);
    break;
  default:
    process.stderr.write("usage: node scripts/workflow/state.mjs <import|check|board|task <ID>>\n");
    process.exit(2);
}
