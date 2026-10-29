#!/usr/bin/env node
// 工作流状态库工具。state.json 是任务/批次状态与切片状态的唯一机读真值。
// 用法:
//   node scripts/workflow/state.mjs import               从 TODO 迁移（保留已有 verification / 批次切片）
//   node scripts/workflow/state.mjs check [--strict]     校验状态库（可挂进 CI）
//   node scripts/workflow/state.mjs board                渲染 Markdown 看板
//   node scripts/workflow/state.mjs task <ID> [--for FE|BE|QA|LEAD] [--json|--message]
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const TODO_DOC = path.join(ROOT, "ForAIDoc", "PM", "Windows本机私用TODO.md");
const STATE_DIR = path.join(ROOT, "ForAIDoc", "PM", "工作流");
const STATE_FILE = path.join(STATE_DIR, "state.json");
const BOARD_FILE = path.join(STATE_DIR, "看板.md");
const OWNERSHIP_FILE = path.join(STATE_DIR, "ownership.json");
const ARTIFACT_DIR = path.join(ROOT, "artifacts", "workflow");

const STAGES = ["done", "implemented", "partial", "in-progress", "todo", "blocked", "proposed"];
const TYPES = ["bug", "feature", "refactor"];
const SLICE_STAGES = ["todo", "in_progress", "frozen", "qa", "qa_with_gap", "awaiting_apply", "awaiting_accept", "blocked", "done", "paused"];

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

// 当前批次的交付切片。状态由 LEAD 维护，看板与当前批次文档都从它生成。
const DEFAULT_SLICES = [
  {
    id: "CON06",
    label: "CON06 服务器状态",
    status: "awaiting_apply",
    qaPassed: null,
    applied: null,
    owner: "BE",
    exit: "联合 QA 通过 → 与 ACTION 一起 Apply",
    evidence: "artifacts/evidence",
    note: "QA 已过（20 文件 manifest），待一次联合应用",
  },
  {
    id: "S1A",
    label: "ACTION S1A：MOVE 持久回执",
    status: "done",
    owner: "BE",
    exit: "冻结 + QA 通过",
    evidence: "artifacts/evidence",
    note: "作为 S1B 基线",
  },
  {
    id: "S1B",
    label: "ACTION S1B：宿主准入与 unknown 解除",
    status: "frozen",
    owner: "BE",
    exit: "跨窗互斥 / 排队取消零写 / 解除边界 通过 QA",
    evidence: "artifacts/evidence",
    note: "host57 / FE+pure98 仅模块证据",
  },
  {
    id: "S2a",
    label: "ACTION S2a：SHELF 真实入口",
    status: "qa_with_gap",
    owner: "BE",
    exit: "完整基线配置下重跑全 TS + 联合 QA",
    evidence: "artifacts/evidence",
    note: "53mock/17hash 通过；候选缺 vite.config.ts 导致 TS18003",
  },
  {
    id: "S2b",
    label: "ACTION S2b：Revert 真实入口",
    status: "blocked",
    owner: "BE",
    exit: "NOOP-01 闭环：retained/no-op 有可验证事实来源 + 新 hash QA",
    evidence: "artifacts/evidence",
    note: "正常保留正向验收未闭环",
  },
  {
    id: "S3",
    label: "ACTION 技术阶段3：全矩阵迁移",
    status: "in_progress",
    owner: "BE",
    exit: "逐行 入口→adapter→host 链有证据，旧路径退出",
    evidence: "artifacts/evidence",
    note: "S3a host 24 纯测/6hash；REG01 仅注册覆盖",
  },
  {
    id: "UPD",
    label: "PKG-02 软件更新",
    status: "paused",
    owner: "BE",
    exit: "本批结束后再议",
    evidence: "artifacts/evidence",
    note: "暂停，保留离线检查点",
  },
];

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
    links.push(repoRelative(path.resolve(baseDir, target.split("#")[0])));
  }
  return [...new Set(links)];
}

function extractDeps(text) {
  return [...new Set(String(text).split(/[；;、,，/]/).map((item) => item.trim()).filter(Boolean))];
}

/** 解析 TODO.md 中的表格区块。 */
function parseTodo(markdown) {
  const lines = markdown.split(/\r?\n/);
  const baseDir = path.dirname(TODO_DOC);
  const headingText = (line) => (/^#{2,4}\s/.test(line) ? line.replace(/^#+\s*/, "").trim() : undefined);
  const sectionIndex = (title) => lines.findIndex((line) => headingText(line)?.startsWith(title));
  const sliceBetween = (fromTitle, toTitles) => {
    const start = sectionIndex(fromTitle);
    if (start < 0) return [];
    const candidates = toTitles.map((title) => sectionIndex(title)).filter((index) => index > start);
    return lines.slice(start + 1, candidates.length ? Math.min(...candidates) : lines.length);
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

  const subitems = [];
  for (const line of sliceBetween("混合工作包关联子项", ["最新调度覆盖"])) {
    if (!line.startsWith("|")) continue;
    const cells = splitRow(line);
    if (cells.length < 6) continue;
    const idMatch = cells[0].match(/^([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+)\s*\/\s*([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+)$/);
    if (!idMatch) continue;
    subitems.push({
      id: idMatch[1],
      parentId: idMatch[2],
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

function defaultBatch() {
  return {
    id: "CON06+ACTION-R01",
    goal: "只完成 CON06（服务器状态）与 ACTION-R01 全矩阵迁移及必要 QA",
    stopCondition: "两项完成 + 联合 QA 通过 → BE 核会话安全/漂移/备份 → 一次 Apply 到本地原树 → 全员停工",
    devClosedByUser: false,
    applyMode: "batched",
    openQuestions: ["Apply 前需用户确认 dev 已关闭且无在途操作"],
    slices: DEFAULT_SLICES,
  };
}

/** 迁移时按 id 合并：保留人工/派生字段，不回退已有证据。 */
function mergePackage(previous, next) {
  if (!previous) return { ...next, firstSeenAt: new Date().toISOString() };
  return {
    ...next,
    verification: {
      qaPassed: previous.verification?.qaPassed ?? null,
      applied: previous.verification?.applied ?? null,
      humanAccepted: previous.verification?.humanAccepted ?? null,
    },
    firstSeenAt: previous.firstSeenAt ?? new Date().toISOString(),
  };
}

function buildState({ main, archived, subitems }, previous) {
  const known = new Set(main.map((entry) => entry.id));
  const previousById = new Map((previous?.packages ?? []).map((pkg) => [pkg.id, pkg]));
  for (const entry of [...main, ...archived]) {
    entry.deps = extractDeps(entry.depsRaw).filter((dep) => known.has(dep) && dep !== entry.id);
  }
  const packages = [...main, ...archived].map((entry) => mergePackage(previousById.get(entry.id), entry));
  const batch = previous?.batch ? { ...defaultBatch(), ...previous.batch } : defaultBatch();
  if (!Array.isArray(batch.slices) || batch.slices.length === 0) batch.slices = DEFAULT_SLICES;
  return {
    schemaVersion: 2,
    updatedAt: new Date().toISOString(),
    source: {
      kind: "migrated",
      from: "ForAIDoc/PM/Windows本机私用TODO.md",
      note: "由 state.mjs import 生成；此后 state.json 为唯一真值。verification 由 evidence.mjs 从回执派生。",
    },
    batch,
    counts: {
      main: main.length,
      archived: archived.length,
      total: main.length + archived.length,
      subitems: subitems.length,
      slices: batch.slices.length,
    },
    packages,
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
  const state = buildState(parseTodo(markdown), previous);
  if (state.counts.total !== 52) {
    process.stderr.write(`警告: 解析到 ${state.counts.total} 个主工作包（含归档），文档声称 52。\n`);
  }
  await mkdir(STATE_DIR, { recursive: true });
  await writeFile(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  process.stdout.write(
    `已写入 ${repoRelative(STATE_FILE)}: 主包 ${state.counts.main} + 归档 ${state.counts.archived} = ${state.counts.total}，切片 ${state.counts.slices}，子项 ${state.counts.subitems}\n`,
  );
}

async function loadState() {
  return JSON.parse(await readFile(STATE_FILE, "utf8"));
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function summarize(state) {
  const byStage = Object.fromEntries(STAGES.map((stage) => [stage, 0]));
  const byModule = new Map();
  for (const pkg of state.packages) {
    byStage[pkg.stage ?? "unknown"] = (byStage[pkg.stage ?? "unknown"] ?? 0) + 1;
    if (pkg.archived) {
      const bucket = byModule.get("已完成归档") ?? { total: 0, stages: {} };
      bucket.total += 1;
      bucket.stages[pkg.stage ?? "unknown"] = (bucket.stages[pkg.stage ?? "unknown"] ?? 0) + 1;
      byModule.set("已完成归档", bucket);
      continue;
    }
    const bucket = byModule.get(pkg.module) ?? { total: 0, stages: {} };
    bucket.total += 1;
    bucket.stages[pkg.stage ?? "unknown"] = (bucket.stages[pkg.stage ?? "unknown"] ?? 0) + 1;
    byModule.set(pkg.module, bucket);
  }
  const slices = Object.fromEntries(SLICE_STAGES.map((stage) => [stage, 0]));
  for (const slice of state.batch?.slices ?? []) slices[slice.status] = (slices[slice.status] ?? 0) + 1;
  return { byStage, byModule, slices };
}

async function cmdCheck(args) {
  const state = await loadState();
  const strict = args.includes("--strict");
  const errors = [];
  const warnings = [];
  const known = new Set(state.packages.map((entry) => entry.id));
  const seen = new Set();

  for (const pkg of state.packages) {
    if (seen.has(pkg.id)) errors.push(`重复任务 ID: ${pkg.id}`);
    seen.add(pkg.id);
    if (!TYPES.includes(pkg.type)) errors.push(`${pkg.id}: 未知类型 ${pkg.typeRaw}`);
    if (!STAGES.includes(pkg.stage)) errors.push(`${pkg.id}: 未知状态 ${pkg.statusRaw}`);
    if (!pkg.owner || !pkg.owner.trim()) errors.push(`${pkg.id}: 缺负责人`);
    for (const dep of pkg.deps) if (!known.has(dep)) errors.push(`${pkg.id}: 依赖不存在 ${dep}`);
    for (const evidence of pkg.evidence) {
      try {
        await readFile(path.join(ROOT, evidence));
      } catch {
        warnings.push(`${pkg.id}: 证据路径不存在 ${evidence}`);
      }
    }
    const verification = pkg.verification ?? {};
    const hasVerification = Object.values(verification).some((value) => value !== null && value !== undefined);
    if (!hasVerification) {
      const message = `${pkg.id}: verification 全空（未从回执派生，也未人工确认）`;
      if (strict && !pkg.migrated) errors.push(message);
      else warnings.push(message);
    }
  }

  if (!state.batch?.id) errors.push("batch 缺 id");
  if (!state.batch?.goal) errors.push("batch 缺 goal");
  if (!state.batch?.stopCondition) errors.push("batch 缺停机条件");
  const sliceIds = new Set();
  for (const slice of state.batch?.slices ?? []) {
    if (!slice.id) errors.push("切片缺 id");
    if (sliceIds.has(slice.id)) errors.push(`切片 id 重复: ${slice.id}`);
    sliceIds.add(slice.id);
    if (!SLICE_STAGES.includes(slice.status)) errors.push(`切片 ${slice.id}: 未知状态 ${slice.status}`);
    if (!slice.owner) errors.push(`切片 ${slice.id}: 缺 owner`);
    if (!slice.exit) errors.push(`切片 ${slice.id}: 缺退出条件`);
  }
  if (!(state.batch?.slices ?? []).length) errors.push("batch 缺切片列表");
  const mainCount = state.packages.filter((entry) => !entry.archived).length;
  if (mainCount === 0) errors.push("没有主工作包");

  const summary = summarize(state);
  const report = {
    ok: errors.length === 0,
    strict,
    checked: state.packages.length,
    main: mainCount,
    archived: state.packages.length - mainCount,
    slices: (state.batch?.slices ?? []).length,
    subitems: state.subitems.length,
    byStage: summary.byStage,
    bySlice: summary.slices,
    errors,
    warnings,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  await mkdir(ARTIFACT_DIR, { recursive: true });
  await writeFile(path.join(ARTIFACT_DIR, "state-check.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  if (!report.ok) process.exitCode = 1;
}

function truncate(text, limit) {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

const SLICE_LABELS = {
  todo: "待开始",
  in_progress: "进行中",
  frozen: "已冻结",
  qa: "QA 中",
  qa_with_gap: "QA 有缺口",
  awaiting_apply: "待应用",
  awaiting_accept: "已应用待人验",
  blocked: "阻塞",
  done: "完成",
  paused: "暂停",
};

async function cmdBoard() {
  const state = await loadState();
  const summary = summarize(state);
  const lines = [];
  lines.push("# 工作流看板（自动生成，勿手改）", "");
  lines.push("> 由 `node scripts/workflow/state.mjs board` 从 [state.json](state.json) 生成。");
  lines.push(`> 当前批次：**${state.batch.id}** — ${state.batch.goal}`);
  lines.push(`> 停机条件：${state.batch.stopCondition}`, "");
  lines.push("## 批次切片", "");
  lines.push("| 切片 | 状态 | 负责人 | 退出条件 | 备注 |", "|---|---|---|---|---|");
  for (const slice of state.batch.slices ?? []) {
    lines.push(
      `| ${slice.label ?? slice.id} | ${SLICE_LABELS[slice.status] ?? slice.status} | ${slice.owner} | ${truncate(slice.exit, 40)} | ${truncate(slice.note, 40)} |`,
    );
  }
  lines.push("", "## 状态分布（52 主工作包口径，含 2 个已完成归档）", "");
  lines.push("| 状态 | 数量 |", "|---|---:|");
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
  lines.push("| ID | 类型 | 负责人 | 优先级 | 状态 | 验收 | 剩余步骤 |", "|---|---|---|---|---|---|---|");
  for (const pkg of state.packages) {
    const verification = pkg.verification ?? {};
    const marks = [verification.qaPassed ? "QA" : "", verification.applied ? "已应用" : "", verification.humanAccepted ? "人验" : ""]
      .filter(Boolean)
      .join("/");
    lines.push(
      `| ${pkg.archived ? `${pkg.id} †` : pkg.id} | ${pkg.type ?? "?"} | ${truncate(pkg.owner, 18)} | ${truncate(pkg.priority, 12)} | ${pkg.stage ?? "?"} | ${marks || "—"} | ${truncate(pkg.note, 50)} |`,
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

/** 该角色在 ownership.json 里的写域，用于任务单。 */
async function roleScope(role) {
  const ownership = await readJson(OWNERSHIP_FILE, undefined);
  if (!ownership) return "(ownership.json 缺失)";
  const parts = (ownership.rules ?? []).filter((rule) => rule.role === role).map((rule) => `${rule.prefix}**`);
  if (ownership.rootFiles?.role === role) parts.push(`根配置文件: ${ownership.rootFiles.names.join(", ")}`);
  return parts.length ? parts.join("；") : "无写域（不应派活）";
}

async function cmdTask(id, args) {
  if (!id) {
    process.stderr.write("用法: node scripts/workflow/state.mjs task <ID> [--for ROLE] [--json|--message]\n");
    process.exit(2);
  }
  const state = await loadState();
  const pkg = [...state.packages, ...state.subitems].find((entry) => entry.id === id);
  if (!pkg) {
    process.stderr.write(`未知任务: ${id}\n`);
    process.exit(1);
  }
  const roleIndex = args.indexOf("--for");
  const role = roleIndex >= 0 ? String(args[roleIndex + 1] ?? "").toUpperCase() : undefined;
  const scope = role ? await roleScope(role) : "按 ownership.json 解析";
  const commands = ["node scripts/workflow/ci-fast.mjs --files <本片改动>", "node scripts/workflow/ownership.mjs check --role " + (role ?? "FE")];
  const ticket = {
    id: pkg.id,
    type: pkg.type,
    priority: pkg.priority,
    module: pkg.module,
    role: role ?? pkg.owner,
    scope: pkg.scope,
    writeScope: scope,
    deps: pkg.deps ?? [],
    exit: pkg.note || "见 TODO 表剩余步骤",
    forbidden: "生产 P4（含只读）/ 真实工具 / 打包发布 / 改写他人写域 / 整文件覆盖共享文件",
    evidence: pkg.evidence ?? [],
    gates: commands,
    budget: "≤12 轮；超限停笔报告",
  };
  if (args.includes("--json")) {
    process.stdout.write(`${JSON.stringify(ticket, null, 2)}\n`);
    return;
  }
  if (args.includes("--message")) {
    const lines = [
      `任务 ${ticket.id} ｜ ${ticket.type} ｜ ${ticket.priority} ｜ ${ticket.module}`,
      `范围 ${truncate(ticket.scope, 90)}`,
      `写域 ${truncate(ticket.writeScope, 120)}`,
      `依赖 ${ticket.deps.length ? ticket.deps.join("、") : "无"}`,
      `退出 ${truncate(ticket.exit, 120)}`,
      `禁做 ${ticket.forbidden}`,
      `门禁 ${ticket.gates.join(" ； ")}`,
      `证据 ${ticket.evidence.length ? ticket.evidence.join(" ") : "待补"}`,
      `预算 ${ticket.budget}`,
    ];
    process.stdout.write(`${lines.join("\n")}\n`);
    return;
  }
  const lines = [
    `任务 ${ticket.id} ｜ ${ticket.type} ｜ ${ticket.priority} ｜ ${ticket.module}`,
    `范围: ${truncate(ticket.scope, 120)}`,
    `写域: ${truncate(ticket.writeScope, 200)}`,
    `依赖: ${ticket.deps.length ? ticket.deps.join("、") : "无"}`,
    `退出: ${truncate(ticket.exit, 160)}`,
    `门禁: ${ticket.gates.join(" ； ")}`,
    `禁做: ${ticket.forbidden}`,
    `证据: ${ticket.evidence.length ? ticket.evidence.join(" ") : "待补"}`,
    `预算: ${ticket.budget}`,
  ];
  process.stdout.write(`${lines.join("\n")}\n`);
}

const [command, ...rest] = process.argv.slice(2);
switch (command) {
  case "import":
    await cmdImport();
    break;
  case "check":
    await cmdCheck(rest);
    break;
  case "board":
    await cmdBoard();
    break;
  case "task":
    await cmdTask(rest[0], rest.slice(1));
    break;
  default:
    process.stderr.write("usage: node scripts/workflow/state.mjs <import|check|board|task <ID>>\n");
    process.exit(2);
}
