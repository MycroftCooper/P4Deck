#!/usr/bin/env node
// 归档轮转：把 并行交接.md 里较旧的段落搬到 归档/并行交接-YYYY-MM.md，主文件只留最近 N 段 + 指针。
// 默认 dry-run；--apply 才写。写之前会二次核对 mtime/size，期间有人改动就放弃（防并发覆盖）。
//
// 用法:
//   node scripts/workflow/archive.mjs               # dry-run，看会移动多少
//   node scripts/workflow/archive.mjs --keep 3      # 保留最近 3 段
//   node scripts/workflow/archive.mjs --apply       # 真正执行
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const LIVE_FILE = path.join(ROOT, "ForAIDoc", "PM", "并行交接.md");
const TODO_FILE = path.join(ROOT, "ForAIDoc", "PM", "Windows本机私用TODO.md");
const ARCHIVE_DIR = path.join(ROOT, "ForAIDoc", "PM", "归档");

/** TODO 顶部叙事轮转：只移"台账之前"的叙事段，保留 import 依赖的表格段。 */
async function rotateTodo() {
  const raw = await readFile(TODO_FILE, "utf8");
  const beforeStat = await stat(TODO_FILE);
  const lines = raw.split(/\r?\n/);
  const firstHeading = lines.findIndex((line) => line.startsWith("## "));
  const markerTitle = "当前结论与状态口径";
  const marker = lines.findIndex((line) => line.startsWith(`## ${markerTitle}`));
  if (firstHeading < 0 || marker < 0 || marker < firstHeading) {
    process.stdout.write("TODO 结构不符（找不到台账起点），放弃轮转，不改文件。\n");
    return;
  }
  if (marker === firstHeading) {
    process.stdout.write(`${JSON.stringify({ dryRun: !apply, movedSections: 0, beforeChars: raw.length, afterChars: raw.length, note: "台账之前没有叙事段，无需轮转" }, null, 2)}\n`);
    return;
  }
  const header = lines.slice(0, firstHeading);
  const movedLines = lines.slice(firstHeading, marker);
  const keptLines = lines.slice(marker);
  const now = new Date();
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const archiveFile = path.join(ARCHIVE_DIR, `TODO-叙事-${month}.md`);
  const pointer = [
    `> 历史叙事（S2B-QA / ACTION 集成 / 阶段2b / 当前批次调度）已于 ${now.toISOString()} 轮转至 [归档/TODO-叙事-${month}.md](归档/TODO-叙事-${month}.md)。`,
    "> 本文件只保留：数量汇总、唯一任务表、完成项归档、关联子项、验收定义。状态真值见 `工作流/state.json` 与 `工作流/当前批次.md`。",
    "",
  ];
  const next = [...header, ...pointer, ...keptLines].join("\n");
  const report = {
    dryRun: !apply,
    movedSections: movedLines.filter((line) => line.startsWith("## ")).length,
    beforeChars: raw.length,
    afterChars: next.length,
    archiveFile: path.relative(ROOT, archiveFile).split(path.sep).join("/"),
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!apply) {
    process.stdout.write("dry-run：未写文件。确认后加 --todo --apply。\n");
    return;
  }
  const afterStat = await stat(TODO_FILE);
  if (afterStat.mtimeMs !== beforeStat.mtimeMs || afterStat.size !== beforeStat.size) {
    process.stderr.write("TODO 在读取后被改动，放弃轮转（避免覆盖别人的写入）。\n");
    process.exit(3);
  }
  await mkdir(ARCHIVE_DIR, { recursive: true });
  let existing = "";
  try {
    existing = await readFile(archiveFile, "utf8");
  } catch {
    existing = `# TODO 历史叙事归档（${month}）\n\n> 由 archive.mjs --todo 从 Windows本机私用TODO.md 轮转而来，只读追溯用。\n\n`;
  }
  await writeFile(archiveFile, `${existing.trimEnd()}\n\n${movedLines.join("\n").trim()}\n`, "utf8");
  await writeFile(TODO_FILE, `${next.trimEnd()}\n`, "utf8");
  process.stdout.write(`已轮转 TODO 叙事到 ${path.relative(ROOT, archiveFile)}（${report.beforeChars} → ${report.afterChars} 字符）\n`);
}

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const keepIndex = args.indexOf("--keep");
const keep = keepIndex >= 0 ? Number(args[keepIndex + 1]) : 2;

if (args.includes("--todo")) {
  await rotateTodo();
  process.exit(0);
}

const original = await readFile(LIVE_FILE, "utf8");
const before = await stat(LIVE_FILE);
const lines = original.split(/\r?\n/);

// 保留文件头（第一个二级标题之前的所有内容，含横幅）
const firstHeading = lines.findIndex((line) => line.startsWith("## "));
if (firstHeading < 0) {
  process.stdout.write("没有二级标题，无需轮转。\n");
  process.exit(0);
}
const header = lines.slice(0, firstHeading);
const body = lines.slice(firstHeading);

// 按二级标题切段
const sections = [];
for (const line of body) {
  if (line.startsWith("## ")) sections.push({ title: line.slice(3).trim(), lines: [line] });
  else if (sections.length) sections.at(-1).lines.push(line);
}

// 文档是"最新在前"：保留前 keep 段（最新），把后面的旧段移入归档。
const moveCount = Math.max(0, sections.length - keep);
const kept = sections.slice(0, keep);
const moved = sections.slice(keep);

if (!moveCount) {
  process.stdout.write(`只有 ${sections.length} 段（保留 ${keep}），无需轮转。\n`);
  process.exit(0);
}

const now = new Date();
const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
const archiveFile = path.join(ARCHIVE_DIR, `并行交接-${month}.md`);
const movedChars = moved.reduce((sum, section) => sum + section.lines.join("\n").length, 0);

const pointer = [
  `> 轮转于 ${now.toISOString()}：更早的 ${moveCount} 段已移入 [归档/并行交接-${month}.md](归档/并行交接-${month}.md)。`,
  `> 本文件只保留最近 ${keep} 段；原始总长度 ${original.length} 字符，本次移动约 ${movedChars} 字符。`,
  "",
];
const nextLive = [...header, ...pointer, ...kept.map((section) => section.lines.join("\n"))].join("\n");

const report = {
  dryRun: !apply,
  sections: sections.length,
  keep,
  move: moveCount,
  movedChars,
  archiveFile: path.relative(ROOT, archiveFile).split(path.sep).join("/"),
  liveBeforeChars: original.length,
  liveAfterChars: nextLive.length,
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

if (!apply) {
  process.stdout.write("dry-run：未写文件。确认后加 --apply。\n");
  process.exit(0);
}

const after = await stat(LIVE_FILE);
if (after.mtimeMs !== before.mtimeMs || after.size !== before.size) {
  process.stderr.write("文件在读取后被改动，放弃轮转（避免覆盖别人的写入）。\n");
  process.exit(3);
}

await mkdir(ARCHIVE_DIR, { recursive: true });
let existing = "";
try {
  existing = await readFile(archiveFile, "utf8");
} catch {
  existing = `# 并行交接归档（${month}）\n\n> 由 archive.mjs 从 并行交接.md 轮转而来，只读追溯用。\n\n`;
}
const append = moved.map((section) => section.lines.join("\n")).join("\n\n");
await writeFile(archiveFile, `${existing.trimEnd()}\n\n${append}\n`, "utf8");
await writeFile(LIVE_FILE, `${nextLive.trimEnd()}\n`, "utf8");
process.stdout.write(`已轮转 ${moveCount} 段到 ${path.relative(ROOT, archiveFile)}\n`);
