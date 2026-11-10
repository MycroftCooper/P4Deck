#!/usr/bin/env node
// Guard the bundled in-app changelog (src/app/update/changelog.ts).
//
// A release is only visible in Settings -> Updates -> View changelog when it has
// entered this file. The guard fails when the running version has no entry, when
// a release is missing either language, when the English bullets still contain
// Chinese, or when the list is not ordered newest first. It runs in `ci:quick`
// and `ci:local`, so a version bump without release notes is caught before the
// build instead of after the release.
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
const SEMVER = /^\d+\.\d+\.\d+$/;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

const compare = (left, right) => {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
};

/**
 * Validate a changelog release list. Returns human-readable problems; an empty
 * array means the history is publishable.
 */
export function validateChangelogHistory(releases, { version } = {}) {
  if (!Array.isArray(releases) || releases.length === 0) {
    return ["the changelog has no releases"];
  }
  const problems = [];
  const seen = new Set();
  let previous = null;
  releases.forEach((release, index) => {
    const label =
      typeof release?.version === "string"
        ? release.version
        : `entry #${index + 1}`;
    if (!SEMVER.test(release?.version ?? "")) {
      problems.push(`${label}: version is not x.y.z`);
    }
    if (seen.has(release?.version)) {
      problems.push(`${label}: duplicate version`);
    }
    seen.add(release?.version);

    const parts = String(release?.version ?? "")
      .split(".")
      .map((part) => Number.parseInt(part, 10));
    if (previous && compare(previous.parts, parts) <= 0) {
      problems.push(
        `${label}: releases must be newest first; it appears after ${previous.label}`,
      );
    }
    previous = { label, parts };

    for (const [language, bullets] of [
      ["zh", release?.notes?.zh],
      ["en", release?.notes?.en],
    ]) {
      if (!Array.isArray(bullets) || bullets.length === 0) {
        problems.push(`${label}: ${language} notes are empty`);
        continue;
      }
      if (
        bullets.some(
          (note) => typeof note !== "string" || note.trim().length === 0,
        )
      ) {
        problems.push(`${label}: ${language} notes contain an empty bullet`);
      }
    }
    const zh = Array.isArray(release?.notes?.zh) ? release.notes.zh : [];
    const en = Array.isArray(release?.notes?.en) ? release.notes.en : [];
    if (zh.length > 0 && !zh.some((note) => CJK.test(note))) {
      problems.push(`${label}: Chinese notes contain no Chinese characters`);
    }
    const untranslated = en.filter((note) => CJK.test(note));
    if (untranslated.length > 0) {
      problems.push(
        `${label}: English notes still contain Chinese (${untranslated.length} bullet(s))`,
      );
    }

    if (release?.date !== undefined) {
      if (!ISO_DAY.test(release.date)) {
        problems.push(`${label}: date "${release.date}" is not YYYY-MM-DD`);
      } else if (Number.isNaN(Date.parse(`${release.date}T00:00:00Z`))) {
        problems.push(`${label}: date "${release.date}" is not a real day`);
      }
    }
  });
  if (version && !releases.some((release) => release?.version === version)) {
    problems.push(
      `no changelog entry for ${version}; add the release notes before bumping the version`,
    );
  }
  return problems;
}

async function main() {
  const packageVersion = JSON.parse(
    readFileSync(path.join(repoRoot, "package.json"), "utf8"),
  ).version;
  const changelogUrl = pathToFileURL(
    path.join(repoRoot, "src", "app", "update", "changelog.ts"),
  );
  let changelog;
  try {
    changelog = await import(changelogUrl.href);
  } catch (error) {
    process.stderr.write(
      `✗ cannot load src/app/update/changelog.ts: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }
  const problems = validateChangelogHistory(changelog.CHANGELOG, {
    version: packageVersion,
  });
  if (problems.length > 0) {
    process.stderr.write("✗ the in-app changelog is not publishable:\n");
    for (const problem of problems) process.stderr.write(`  - ${problem}\n`);
    return 1;
  }
  const newest = changelog.CHANGELOG[0];
  process.stdout.write(
    `✓ changelog OK: ${changelog.CHANGELOG.length} releases, newest ${newest.version} matches package.json, zh/en bullets present\n`,
  );
  return 0;
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  process.exitCode = await main();
}
