// Unit tests for the version bump helpers. The CLI needs the repository files,
// so the interesting logic (bullet extraction, changelog rendering, the four
// version rewrites) is exported as pure functions and tested here.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  bulletsFromSection,
  compareSemver,
  insertChangelogEntry,
  renderChangelogEntry,
  updateCargoLockVersion,
  updateCargoTomlVersion,
  updateJsonVersion,
} from "./bump-version.mjs";

test("compareSemver orders x.y.z numerically, not lexically", () => {
  assert.ok(compareSemver("0.1.10", "0.1.9") > 0);
  assert.ok(compareSemver("0.1.9", "0.1.10") < 0);
  assert.equal(compareSemver("0.2.0", "0.2.0"), 0);
  assert.ok(compareSemver("1.0.0", "0.99.99") > 0);
});

test("bulletsFromSection keeps list items and drops section headings", () => {
  const text = [
    "新功能：",
    "- 第一条",
    "- 第二条",
    "",
    "改进与修复：",
    "- 第三条",
  ].join("\n");
  assert.deepEqual(bulletsFromSection(text, "中文"), [
    "第一条",
    "第二条",
    "第三条",
  ]);
});

test("bulletsFromSection falls back to plain lines when nothing is a bullet", () => {
  assert.deepEqual(bulletsFromSection("只有一段话", "English"), ["只有一段话"]);
});

test("bulletsFromSection rejects an empty section", () => {
  assert.throws(() => bulletsFromSection("   \n\n", "English"), /no text/);
});

test("renderChangelogEntry escapes quotes and keeps the changelog shape", () => {
  const entry = renderChangelogEntry({
    version: "0.1.16",
    date: "2026-11-17",
    zh: ['带"引号"的一条'],
    en: ["a bullet"],
  });
  assert.match(entry, /^ {2}\{$/m);
  assert.match(entry, /^ {4}version: "0\.1\.16",$/m);
  assert.match(entry, /^ {4}date: "2026-11-17",$/m);
  assert.match(entry, /^ {8}"带\\"引号\\"的一条",$/m);
  assert.match(entry, /^ {8}"a bullet",$/m);
  // The trailing comma after the object keeps prettier from reflowing the list.
  assert.ok(entry.trimEnd().endsWith("},"));
});

test("insertChangelogEntry prepends to the newest-first list", () => {
  const source = [
    "export interface ChangelogRelease {}",
    "",
    "export const CHANGELOG: readonly ChangelogRelease[] = [",
    "  {",
    '    version: "0.1.14",',
    "  },",
    "];",
    "",
  ].join("\n");
  const entry = renderChangelogEntry({
    version: "0.1.15",
    date: "2026-11-17",
    zh: ["新"],
    en: ["new"],
  });
  const next = insertChangelogEntry(source, entry, "0.1.15");
  const inserted = next.indexOf('version: "0.1.15"');
  const existing = next.indexOf('version: "0.1.14"');
  assert.ok(inserted > 0 && inserted < existing);
  assert.equal(next.match(/export const CHANGELOG/g).length, 1);
});

test("insertChangelogEntry refuses to duplicate a version", () => {
  const source = [
    "export const CHANGELOG: readonly ChangelogRelease[] = [",
    "  {",
    '    version: "0.1.15",',
    "  },",
    "];",
  ].join("\n");
  assert.throws(
    () => insertChangelogEntry(source, "  {},\n", "0.1.15"),
    /already has an entry/,
  );
});

test("insertChangelogEntry refuses an unexpected file shape", () => {
  assert.throws(
    () => insertChangelogEntry("const OTHER = []", "  {},\n", "0.1.15"),
    /does not declare CHANGELOG/,
  );
});

test("updateJsonVersion only rewrites the version key", () => {
  const source = JSON.stringify({ name: "p4deck", version: "0.1.14" }, null, 2);
  const next = updateJsonVersion(`${source}\n`, "0.1.15", "package.json");
  assert.deepEqual(JSON.parse(next), { name: "p4deck", version: "0.1.15" });
  assert.ok(next.endsWith("\n"));
});

test("updateCargoTomlVersion leaves dependency versions alone", () => {
  const source = [
    "[package]",
    'name = "p4deck"',
    'version = "0.1.14"',
    "",
    "[dependencies]",
    'serde = { version = "1.0.0" }',
  ].join("\n");
  const next = updateCargoTomlVersion(source, "0.1.15", "Cargo.toml");
  assert.match(next, /^version = "0\.1\.15"$/m);
  assert.match(next, /serde = \{ version = "1\.0\.0" \}/);
});

test("updateCargoTomlVersion reports a file without a package version", () => {
  assert.throws(
    () =>
      updateCargoTomlVersion('[package]\nname = "x"\n', "0.1.15", "Cargo.toml"),
    /missing version/,
  );
});

test("updateCargoLockVersion rewrites only the p4deck entry", () => {
  const source = [
    "[[package]]",
    'name = "p4deck"',
    'version = "0.1.14"',
    "",
    "[[package]]",
    'name = "serde"',
    'version = "1.0.0"',
  ].join("\n");
  const next = updateCargoLockVersion(source, "0.1.15", "Cargo.lock");
  assert.match(next, /name = "p4deck"\nversion = "0\.1\.15"/);
  assert.match(next, /name = "serde"\nversion = "1\.0\.0"/);
});

test("updateCargoLockVersion reports a lock file without the crate", () => {
  assert.throws(
    () => updateCargoLockVersion('name = "other"', "0.1.15", "Cargo.lock"),
    /no p4deck package entry/,
  );
});
