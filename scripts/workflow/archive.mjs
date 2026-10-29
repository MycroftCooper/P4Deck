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
const ARCHIVE_DIR = path.join(ROOT, "ForAIDoc", "PM", "归档");

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const keepIndex = args.indexOf("--keep");
const keep = keepIndex >= 0 ? Number(args[keepIndex + 1]) : 2;

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
