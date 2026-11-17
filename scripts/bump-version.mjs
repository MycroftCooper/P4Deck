#!/usr/bin/env node
// Move the repository to a new version in one step, instead of hand-editing the
// same number in four files and then remembering the changelog.
//
//   node scripts/bump-version.mjs --version 0.1.16 \
//     --notes-file ForAIDoc/PM/releases/v0.1.16.md
//   node scripts/bump-version.mjs --version 0.1.16 --dry-run
//
// What it does:
//   1. refuses a version that is not x.y.z or not greater than the current one;
//   2. writes the version into package.json, src-tauri/tauri.conf.json,
//      src-tauri/Cargo.toml and src-tauri/Cargo.lock (the four places the build
//      and the updater actually read);
//   3. when --notes-file is given, prepends the matching in-app changelog entry
//      generated from that bilingual file, so the changelog cannot drift from
//      the release page;
//   4. runs validate-versions and validate-changelog and reports their verdict.
//
// The notes file is the single source for both the GitHub release page and the
// in-app changelog: it is committed under ForAIDoc/PM/releases/, which keeps the
// historical notes reviewable instead of leaving them in the ignored artifacts/.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  parseBilingualNotes,
  validateBilingualNotes,
} from "./release-notes.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SEMVER = /^\d+\.\d+\.\d+$/;

const USAGE = [
  "用法: node scripts/bump-version.mjs --version <x.y.z> [--notes-file <file>] [--date YYYY-MM-DD] [--dry-run]",
  "  --version <x.y.z>    新版本号，必须大于当前版本",
  "  --notes-file <file>  中英双语发布说明；给出时会同时生成应用内更新日志条目",
  "  --date <YYYY-MM-DD>  更新日志日期，默认今天（本地时区）",
  "  --dry-run            只打印将要做的修改，不写文件",
].join("\n");

/** Compare two x.y.z versions; returns a positive number when `a` is newer. */
export function compareSemver(a, b) {
  const left = String(a).split(".").map(Number);
  const right = String(b).split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/**
 * Bullets from one language section of a notes file. The changelog renders one
 * line per bullet, so a paragraph of prose is a mistake worth reporting rather
 * than silently collapsing into a single unreadable line.
 */
export function bulletsFromSection(text, language) {
  const lines = String(text ?? "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  // A notes file groups bullets under headings such as "新功能："; those headings
  // belong to the release page, not to the one-bullet-per-line changelog.
  const marked = lines
    .filter((line) => /^[-*]\s+/.test(line))
    .map((line) => line.replace(/^[-*]\s+/, "").trim());
  const bullets = (marked.length > 0 ? marked : lines).filter(Boolean);
  if (bullets.length === 0) {
    throw new Error(`the ${language} section of the release notes has no text`);
  }
  return bullets;
}

/**
 * Render one `ChangelogRelease` entry, indented for `CHANGELOG` in
 * `src/app/update/changelog.ts`. Strings go through JSON.stringify so quotes and
 * backslashes are escaped exactly as TypeScript expects.
 */
export function renderChangelogEntry({ version, date, zh, en }) {
  const lines = [
    "  {",
    `    version: ${JSON.stringify(version)},`,
    `    date: ${JSON.stringify(date)},`,
    "    notes: {",
    "      zh: [",
    ...zh.map((bullet) => `        ${JSON.stringify(bullet)},`),
    "      ],",
    "      en: [",
    ...en.map((bullet) => `        ${JSON.stringify(bullet)},`),
    "      ],",
    "    },",
    "  },",
  ];
  return `${lines.join("\n")}\n`;
}

/**
 * Put the new entry at the top of the list. Refuses to touch a file that already
 * carries the version, so re-running a bump cannot duplicate the entry.
 */
export function insertChangelogEntry(source, entry, version) {
  const marker = "export const CHANGELOG: readonly ChangelogRelease[] = [\n";
  const start = source.indexOf(marker);
  if (start === -1) {
    throw new Error(
      "src/app/update/changelog.ts does not declare CHANGELOG the expected way",
    );
  }
  if (
    new RegExp(`version:\\s*"${version.replace(/\./g, "\\.")}"`).test(source)
  ) {
    throw new Error(`the changelog already has an entry for ${version}`);
  }
  const insertAt = start + marker.length;
  return `${source.slice(0, insertAt)}${entry}${source.slice(insertAt)}`;
}

/** Set `version` in a JSON config, preserving the 2-space formatting. */
export function updateJsonVersion(text, version, file) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`${file}: invalid JSON`);
  }
  data.version = version;
  return `${JSON.stringify(data, null, 2)}\n`;
}

/** Set the `[package]` version in Cargo.toml, leaving every other version alone. */
export function updateCargoTomlVersion(text, version, file) {
  const lines = text.split(/\r?\n/);
  let inPackage = false;
  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    if (trimmed === "[package]") {
      inPackage = true;
      continue;
    }
    if (inPackage && trimmed.startsWith("[")) break;
    if (inPackage && /^version\s*=\s*"[^"]+"/.test(trimmed)) {
      lines[index] = `version = "${version}"`;
      return lines.join("\n");
    }
  }
  throw new Error(`${file}: missing version in [package]`);
}

/** Set the workspace package version recorded for this crate in Cargo.lock. */
export function updateCargoLockVersion(text, version, file) {
  const pattern = /(name = "p4deck"\r?\nversion = ")[^"]+(")/;
  if (!pattern.test(text)) {
    throw new Error(`${file}: no p4deck package entry to bump`);
  }
  return text.replace(pattern, `$1${version}$2`);
}

function read(relative) {
  return readFileSync(path.join(ROOT, relative), "utf8");
}

function write(relative, contents) {
  writeFileSync(path.join(ROOT, relative), contents);
}

function localDate() {
  // `sv-SE` renders an ISO-like YYYY-MM-DD in the machine's own time zone, which
  // is what the changelog dates have always been.
  return new Date().toLocaleDateString("sv-SE");
}

function runValidator(script) {
  const result = spawnSync(process.execPath, [script], {
    cwd: ROOT,
    encoding: "utf8",
  });
  return {
    script,
    ok: result.status === 0,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim(),
  };
}

function main(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  const valueOf = (flag) => {
    const index = argv.indexOf(flag);
    return index >= 0 ? String(argv[index + 1] ?? "").trim() : "";
  };
  const version = valueOf("--version");
  const notesFile = valueOf("--notes-file");
  const date = valueOf("--date") || localDate();
  const dryRun = argv.includes("--dry-run");

  if (!version) {
    process.stderr.write(`缺少 --version\n${USAGE}\n`);
    return 2;
  }
  if (!SEMVER.test(version)) {
    process.stderr.write(`--version 必须是 x.y.z（当前 "${version}"）\n`);
    return 2;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    process.stderr.write(`--date 必须是 YYYY-MM-DD（当前 "${date}"）\n`);
    return 2;
  }

  const current = JSON.parse(read("package.json")).version;
  if (compareSemver(version, current) <= 0) {
    process.stderr.write(
      `新版本 ${version} 不大于当前版本 ${current}；如需回退请手动修改。\n`,
    );
    return 2;
  }

  const changes = [];
  changes.push({
    file: "package.json",
    next: updateJsonVersion(read("package.json"), version, "package.json"),
  });
  changes.push({
    file: "src-tauri/tauri.conf.json",
    next: updateJsonVersion(
      read("src-tauri/tauri.conf.json"),
      version,
      "src-tauri/tauri.conf.json",
    ),
  });
  changes.push({
    file: "src-tauri/Cargo.toml",
    next: updateCargoTomlVersion(
      read("src-tauri/Cargo.toml"),
      version,
      "src-tauri/Cargo.toml",
    ),
  });
  changes.push({
    file: "src-tauri/Cargo.lock",
    next: updateCargoLockVersion(
      read("src-tauri/Cargo.lock"),
      version,
      "src-tauri/Cargo.lock",
    ),
  });

  if (notesFile) {
    const notesText = readFileSync(path.resolve(ROOT, notesFile), "utf8");
    const notes = parseBilingualNotes(notesText);
    const problems = validateBilingualNotes(notes);
    if (problems.length > 0) {
      process.stderr.write(
        `${notesFile} 还不是可发布的双语说明：\n- ${problems.join("\n- ")}\n` +
          "运行 `node scripts/validate-release-notes.mjs <file>` 查看详情。\n",
      );
      return 2;
    }
    const entry = renderChangelogEntry({
      version,
      date,
      zh: bulletsFromSection(notes.zh, "中文"),
      en: bulletsFromSection(notes.en, "English"),
    });
    changes.push({
      file: "src/app/update/changelog.ts",
      next: insertChangelogEntry(
        read("src/app/update/changelog.ts"),
        entry,
        version,
      ),
    });
  }

  const changed = changes.filter((change) => change.next !== read(change.file));
  if (changed.length === 0) {
    process.stdout.write(`已经是 ${version}，没有需要修改的文件。\n`);
    return 0;
  }

  if (dryRun) {
    process.stdout.write(
      `将把 ${current} -> ${version} 并修改：\n` +
        changed.map((change) => `  ${change.file}\n`).join("") +
        (notesFile
          ? ""
          : "\n注意：未提供 --notes-file，应用内更新日志不会自动生成。\n"),
    );
    return 0;
  }

  for (const change of changed) write(change.file, change.next);
  process.stdout.write(
    `${current} -> ${version}，已修改：\n` +
      changed.map((change) => `  ${change.file}\n`).join(""),
  );
  if (!notesFile) {
    process.stderr.write(
      "\n注意：未提供 --notes-file，应用内更新日志没有新增条目；" +
        "validate-changelog 会在最新版本与 package.json 不一致时报错。\n",
    );
  }

  const results = [
    runValidator("scripts/validate-versions.mjs"),
    runValidator("scripts/validate-changelog.mjs"),
  ];
  for (const result of results) {
    process.stdout.write(
      `${result.ok ? "✓" : "✗"} ${result.script}\n${result.output}\n`,
    );
  }
  return results.every((result) => result.ok) ? 0 : 1;
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
    process.exitCode = 1;
  }
}
