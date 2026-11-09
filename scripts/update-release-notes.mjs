#!/usr/bin/env node
// Replace the release notes of an already published GitHub release with a
// bilingual notes file. Only the release body changes: no build, no upload, no
// asset or signature touched, and the tag/release itself stays published.
//
//   node scripts/update-release-notes.mjs --version 0.1.12 \
//     --notes-file artifacts/release-notes-0.1.12.md --dry-run
//   node scripts/update-release-notes.mjs --version 0.1.12 \
//     --notes-file artifacts/release-notes-0.1.12.md
//
// Env: GITHUB_TOKEN, or the github.com credential stored for git (same
// resolution as scripts/publish-update.mjs); GITHUB_API_URL overrides the API
// host for a local test server.
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  deriveRepoFromEndpoint,
  findRelease,
  loadUpdaterConfig,
  releaseTag,
  resolveGithubToken,
} from "./publish-update.mjs";
import {
  buildReleaseBody,
  parseBilingualNotes,
  validateBilingualNotes,
} from "./release-notes.mjs";
import { validateNotesText } from "./validate-release-notes.mjs";

const USAGE = [
  "用法: node scripts/update-release-notes.mjs --version x.y.z --notes-file <file> [--repo owner/name] [--dry-run]",
  "  --version x.y.z   已发布 release 的版本号（不带 v 前缀）",
  "  --notes-file <f>  中英双语发布说明文件（## 中文 / ## English）",
  "  --repo <o/n>      默认从 tauri.conf.json 的 updater endpoint 推导",
  "  --dry-run         只校验并打印将要写入的正文，不发请求",
].join("\n");

export function parseUpdateArgs(argv) {
  const args = {
    version: undefined,
    notesFile: undefined,
    repo: undefined,
    dryRun: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--help" || token === "-h") {
      args.help = true;
      continue;
    }
    if (token === "--dry-run") {
      args.dryRun = true;
      continue;
    }
    const valueOptions = {
      "--version": "version",
      "--notes-file": "notesFile",
      "--repo": "repo",
    };
    if (token in valueOptions) {
      const next = argv[index + 1];
      if (!next || next.startsWith("--"))
        throw new Error(`${token} expects a value`);
      args[valueOptions[token]] = next;
      index += 1;
      continue;
    }
    throw new Error(`unknown option ${token}`);
  }
  return args;
}

/** The bilingual body for one notes file, or throw with the reasons. */
export function buildBodyForFile({ version, notesFile }) {
  const text = readFileSync(path.resolve(notesFile), "utf8");
  const { notes, problems } = validateNotesText(text, { version });
  const allProblems = [...problems, ...validateBilingualNotes(notes)];
  if (allProblems.length > 0) {
    throw new Error(
      `release notes ${notesFile} are not publishable:\n- ${allProblems.join("\n- ")}`,
    );
  }
  return buildReleaseBody(notes);
}

async function main() {
  let args;
  try {
    args = parseUpdateArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n${USAGE}\n`,
    );
    return 2;
  }
  if (args.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (!/^\d+\.\d+\.\d+$/.test(args.version ?? "")) {
    process.stderr.write(`--version must be x.y.z\n${USAGE}\n`);
    return 2;
  }
  if (!args.notesFile) {
    process.stderr.write(`--notes-file is required\n${USAGE}\n`);
    return 2;
  }

  let body;
  try {
    body = buildBodyForFile({
      version: args.version,
      notesFile: args.notesFile,
    });
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }

  const apiUrl = (
    process.env.GITHUB_API_URL?.trim() || "https://api.github.com"
  ).replace(/\/$/, "");
  let repo = args.repo?.trim() || process.env.P4DECK_RELEASES_REPO?.trim();
  if (!repo) {
    try {
      const config = loadUpdaterConfig();
      repo = config.endpoints
        .map((endpoint) => deriveRepoFromEndpoint(endpoint))
        .find(Boolean);
    } catch {
      repo = undefined;
    }
  }
  if (!repo) {
    process.stderr.write(
      "cannot determine the release repo: pass --repo, set P4DECK_RELEASES_REPO, or configure a GitHub updater endpoint.\n",
    );
    return 1;
  }
  const tag = releaseTag(args.version);

  if (args.dryRun) {
    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        dryRun: true,
        repo,
        tag,
        notesFile: path.resolve(args.notesFile),
        bodyPreview: body.split("\n").slice(0, 12),
        bodyChars: body.length,
      })}\n`,
    );
    return 0;
  }

  const token = resolveGithubToken();
  if (!token) {
    process.stderr.write(
      "no GitHub token available: set GITHUB_TOKEN or store a github.com credential for git.\n",
    );
    return 1;
  }

  let release;
  try {
    release = await findRelease({ apiUrl, token, repo, tag });
  } catch (error) {
    process.stderr.write(
      `lookup failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }
  if (!release) {
    process.stderr.write(
      `no release ${tag} in ${repo}; publish it first or fix --version.\n`,
    );
    return 1;
  }
  if (release.draft) {
    process.stderr.write(
      `release ${tag} is still a draft; the body update applies, but check whether it should be published.\n`,
    );
  }

  try {
    const response = await fetch(
      `${apiUrl}/repos/${repo}/releases/${release.id}`,
      {
        method: "PATCH",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "User-Agent": "p4deck-release-notes",
        },
        body: JSON.stringify({ body }),
        signal: AbortSignal.timeout(30_000),
      },
    );
    const raw = await response.text();
    let parsed = null;
    try {
      parsed = raw ? JSON.parse(raw) : null;
    } catch {
      parsed = null;
    }
    if (!response.ok) {
      process.stderr.write(
        `update of ${tag} failed: HTTP ${response.status} ${parsed?.message ?? raw.slice(0, 300)}\n`,
      );
      return 1;
    }
    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        repo,
        tag,
        releaseUrl: parsed?.html_url ?? release.html_url,
        bodyChars: body.length,
      })}\n`,
    );
    return 0;
  } catch (error) {
    process.stderr.write(
      `update of ${tag} failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  process.exitCode = await main();
}
