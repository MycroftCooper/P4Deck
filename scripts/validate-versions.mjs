#!/usr/bin/env node
// Single source of truth for the app version: package.json, tauri.conf.json and
// src-tauri/Cargo.toml must agree. Run by `pnpm validate:versions` and by the
// packaging scripts before they build anything.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

export function parseJsonVersion(text, file) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`${file}: invalid JSON`);
  }
  const version = data?.version;
  if (typeof version !== "string" || version.trim() === "") {
    throw new Error(`${file}: missing "version"`);
  }
  return version.trim();
}

export function parseCargoVersion(text, file) {
  let inPackage = false;
  let sawPackage = false;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "[package]") {
      inPackage = true;
      sawPackage = true;
      continue;
    }
    if (inPackage && trimmed.startsWith("[")) break;
    if (inPackage) {
      const match = trimmed.match(/^version\s*=\s*"([^"]+)"/);
      if (match) return match[1];
    }
  }
  if (!sawPackage) throw new Error(`${file}: missing [package] section`);
  throw new Error(`${file}: missing version in [package]`);
}

export function compareVersions(entries) {
  const [first, ...rest] = entries;
  return rest.filter((entry) => entry.version !== first.version);
}

const VERSION_FILES = [
  { file: "package.json", parse: parseJsonVersion },
  { file: "src-tauri/tauri.conf.json", parse: parseJsonVersion },
  { file: "src-tauri/Cargo.toml", parse: parseCargoVersion },
];

// Bundle overlays must never carry their own version: the version comes from
// the three files above so packaging cannot silently ship a different one.
const OVERLAY_FILES = [
  "src-tauri/tauri.windows.conf.json",
  "src-tauri/tauri.package.offline.conf.json",
];

export function validateRepoVersions(readFile) {
  const read =
    readFile ?? ((file) => readFileSync(path.join(repoRoot, file), "utf8"));
  const entries = VERSION_FILES.map(({ file, parse }) => ({
    file,
    version: parse(read(file), file),
  }));
  const overlays = OVERLAY_FILES.map((file) => {
    let data;
    try {
      data = JSON.parse(read(file));
    } catch {
      return { file, error: "invalid JSON" };
    }
    return data?.version === undefined
      ? { file }
      : { file, error: `overlay must not declare version (${data.version})` };
  }).filter((overlay) => overlay.error);
  const mismatches = compareVersions(entries);
  return {
    ok: mismatches.length === 0 && overlays.length === 0,
    version: entries[0]?.version,
    entries,
    mismatches,
    overlays,
  };
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const result = validateRepoVersions();
  if (!result.ok) {
    for (const mismatch of result.mismatches) {
      process.stderr.write(
        `version mismatch: ${mismatch.file} is ${mismatch.version}\n`,
      );
    }
    for (const overlay of result.overlays) {
      process.stderr.write(`${overlay.file}: ${overlay.error}\n`);
    }
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }
}
