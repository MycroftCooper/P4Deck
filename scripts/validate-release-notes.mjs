#!/usr/bin/env node
// Validate a bilingual release-notes file before it is attached to a GitHub
// release. publish-update.mjs runs the same checks before it builds anything,
// so a malformed file cannot reach the release page.
//
//   node scripts/validate-release-notes.mjs artifacts/release-notes-0.1.13.md
//   node scripts/validate-release-notes.mjs --version 0.1.13 artifacts/release-notes-0.1.13.md
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  parseBilingualNotes,
  validateBilingualNotes,
} from "./release-notes.mjs";

const USAGE = [
  "用法: node scripts/validate-release-notes.mjs [--version x.y.z] <file...>",
  "  --version x.y.z  要求文件标题（# P4Deck x.y.z）提到该版本",
].join("\n");

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Validate one notes file's text. Returns the parsed sections and the list of
 * problems (empty array = valid).
 */
export function validateNotesText(text, { version } = {}) {
  const notes = parseBilingualNotes(text);
  const problems = validateBilingualNotes(notes);
  if (version) {
    if (!notes.title) {
      problems.push(
        `missing title line: start the file with "# P4Deck ${version}"`,
      );
    } else {
      const pattern = new RegExp(
        `(^|[^\\d.])${escapeRegExp(version)}(?![\\d.])`,
      );
      if (!pattern.test(notes.title)) {
        problems.push(
          `the title does not mention version ${version}: "${notes.title}"`,
        );
      }
    }
  }
  return { notes, problems };
}

function main(argv) {
  const files = [];
  let version;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--help" || token === "-h") {
      process.stdout.write(`${USAGE}\n`);
      return 0;
    }
    if (token === "--version") {
      version = argv[index + 1];
      if (!version || version.startsWith("--")) {
        process.stderr.write(`--version expects a value\n${USAGE}\n`);
        return 2;
      }
      index += 1;
      continue;
    }
    if (token.startsWith("--")) {
      process.stderr.write(`unknown option ${token}\n${USAGE}\n`);
      return 2;
    }
    files.push(token);
  }
  if (files.length === 0) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  let failed = false;
  for (const file of files) {
    const resolved = path.resolve(file);
    let text;
    try {
      text = readFileSync(resolved, "utf8");
    } catch (error) {
      process.stderr.write(
        `✗ ${file}: cannot read (${error instanceof Error ? error.message : String(error)})\n`,
      );
      failed = true;
      continue;
    }
    const { notes, problems } = validateNotesText(text, { version });
    if (problems.length > 0) {
      process.stderr.write(`✗ ${file}: not publishable\n`);
      for (const problem of problems) process.stderr.write(`  - ${problem}\n`);
      failed = true;
      continue;
    }
    const count = (section) =>
      section.split("\n").filter((line) => line.trim() !== "").length;
    process.stdout.write(
      `✓ ${file}: bilingual release notes OK (zh ${count(notes.zh)} lines, en ${count(notes.en)} lines)\n`,
    );
  }
  return failed ? 1 : 0;
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  process.exitCode = main(process.argv.slice(2));
}
