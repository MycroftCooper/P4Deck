#!/usr/bin/env node
// Publish a signed Tauri auto-update release to GitHub Releases.
//
// Flow:
//   1. validate the three version files (package.json / tauri.conf.json / Cargo.toml)
//   2. build the NSIS installer plus its signed updater artifact. Tauri v2 signs the
//      installer itself (`-setup.exe` + `.exe.sig`) and the updater runs that executable;
//      a `createUpdaterArtifacts: "v1Compatible"` build yields `.nsis.zip` + `.sig` instead.
//      Both layouts are accepted here. The key never leaves the machine and is never printed.
//   3. verify the updater signature against the pubkey baked into tauri.conf.json, so a
//      mismatch between the release key and the shipped app is caught before upload.
//   4. write latest.json (Tauri v2 update manifest) under artifacts/updater/v<version>/
//   5. upload the installer (which is also the updater payload for the native exe layout),
//      its `.sig` and latest.json to a DRAFT GitHub release and only then publish it. A failed
//      run leaves an unpublished draft, so `releases/latest` never serves a half-published
//      update; rerunning the command replaces the stale draft.
//
// Usage:
//   node scripts/publish-update.mjs                  # build + publish (needs GITHUB_TOKEN)
//   node scripts/publish-update.mjs --dry-run        # reuse existing bundle; no build, no network
//   node scripts/publish-update.mjs --skip-publish   # build + write latest.json only
//   node scripts/publish-update.mjs --skip-build     # reuse existing bundle + publish
//
// Options:
//   --notes <text>              release notes (also the "notes" field of latest.json)
//   --notes-file <path>         read release notes from a text file
//   --repo <owner/name>         release repo (default: derived from the updater endpoint)
//   --bundle-dir <path>         directory holding the built NSIS artifacts (default: target/release/bundle/nsis)
//   --offline-webview2          build with the ~215MB offline WebView2 installer
//   --ignore-version-mismatches  opt in to `tauri build --ignore-version-mismatches`
//                                (only when the npm/Rust Tauri mismatch is verified benign)
//   --allow-dirty               allow building from a dirty worktree
//   --replace --confirm         replace an already published release with the same tag
//   --allow-endpoint-mismatch   publish to a repo that differs from the updater endpoint
//
// Env:
//   TAURI_SIGNING_PRIVATE_KEY_PATH      default %USERPROFILE%\.p4deck\updater.key
//   TAURI_SIGNING_PRIVATE_KEY_PASSWORD  default read from %USERPROFILE%\.p4deck\updater.key.password
//   GITHUB_TOKEN                        required to publish (never written to disk);
//                                       fallback: the github.com credential stored for git
//   GITHUB_API_URL                      default https://api.github.com (override for a local test host)
//   P4DECK_RELEASES_REPO                default derived from the updater endpoint
//
// Uploads are deliberately not retried: rerun the command after fixing the cause. The stale
// draft is deleted first, so a rerun cannot produce duplicate assets.
import { spawnSync } from "node:child_process";
import {
  createHash,
  createPublicKey,
  verify as verifyEd25519,
} from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertBuildableTree,
  gitDirty,
  gitHead,
  repoRoot,
  sha256File,
} from "./lib.mjs";

export const PRODUCT = "P4Deck";
export const RELEASE_NOTES_DEFAULT = "";

/**
 * Reject release notes that carry the Windows codepage mojibake signature:
 * Chinese text that was passed inline on the command line (or through a
 * non-UTF-8 console) gets folded so every CJK char becomes an ASCII `?` and
 * full-width punctuation is best-fit folded (`：`→`:`, `…`→`.`, `（`→`(`).
 * A legitimate note for this product is Chinese and therefore contains CJK
 * characters; a fully-mangled note has none while still containing stray `?`.
 * Set P4DECK_ALLOW_NOTES_QUERY=1 only for a genuine English-only note that has
 * a literal ASCII `?` in it.
 */
export function assertNotesNotMojibake(notes) {
  if (!notes) return;
  const asciiQueryCount = (notes.match(/\?/g) || []).length;
  const hasCjk =
    /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3000-\u303f\uff00-\uffef]/.test(
      notes,
    );
  if (asciiQueryCount > 0 && !hasCjk) {
    throw new Error(
      `release notes contain ${asciiQueryCount} ASCII '?' but no CJK characters — this is the Windows codepage mojibake signature (Chinese folded to '?'). ` +
        "Put the Chinese notes in a UTF-8 file and pass --notes-file, and do not pass them inline via --notes from a legacy console. " +
        "To publish a genuine English-only note that contains a literal '?', set P4DECK_ALLOW_NOTES_QUERY=1.",
    );
  }
}
const DEFAULT_KEY_DIR = ".p4deck";
const DEFAULT_API_URL = "https://api.github.com";
const NSIS_BUNDLE_DIR = path.join(
  "src-tauri",
  "target",
  "release",
  "bundle",
  "nsis",
);
// DER prefix for a raw 32-byte Ed25519 public key (SPKI), used by node's crypto.verify.
const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const DOWNLOAD_TIMEOUT_MS = 120_000;
const UPLOAD_TIMEOUT_MS = 300_000;

// ---------------------------------------------------------------------------
// argument parsing
// ---------------------------------------------------------------------------

export function parseArgs(argv) {
  const args = {
    notes: undefined,
    notesFile: undefined,
    repo: undefined,
    bundleDir: undefined,
    dryRun: false,
    skipBuild: false,
    skipPublish: false,
    offlineWebview2: false,
    ignoreVersionMismatches: false,
    allowDirty: false,
    replace: false,
    confirm: false,
    allowEndpointMismatch: false,
  };
  const valueOptions = {
    "--notes": "notes",
    "--notes-file": "notesFile",
    "--repo": "repo",
    "--bundle-dir": "bundleDir",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token in valueOptions) {
      const next = argv[index + 1];
      if (!next || next.startsWith("--")) {
        throw new Error(`${token} expects a value`);
      }
      args[valueOptions[token]] = next;
      index += 1;
      continue;
    }
    switch (token) {
      case "--dry-run":
        args.dryRun = true;
        break;
      case "--skip-build":
        args.skipBuild = true;
        break;
      case "--skip-publish":
        args.skipPublish = true;
        break;
      case "--offline-webview2":
        args.offlineWebview2 = true;
        break;
      case "--ignore-version-mismatches":
        args.ignoreVersionMismatches = true;
        break;
      case "--allow-dirty":
        args.allowDirty = true;
        break;
      case "--replace":
        args.replace = true;
        break;
      case "--confirm":
        args.confirm = true;
        break;
      case "--allow-endpoint-mismatch":
        args.allowEndpointMismatch = true;
        break;
      default:
        throw new Error(`unknown argument: ${token}`);
    }
  }
  if (args.dryRun) {
    args.skipBuild = true;
    args.skipPublish = true;
  }
  return args;
}

// ---------------------------------------------------------------------------
// config / versions / signing key
// ---------------------------------------------------------------------------

function readJsonAt(filePath, label) {
  let text;
  try {
    text = readFileSync(filePath, "utf8");
  } catch (error) {
    throw new Error(
      `${label} is not readable at ${filePath}: ${error.message}`,
    );
  }
  try {
    return JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch {
    throw new Error(`${label} is not valid JSON: ${filePath}`);
  }
}

export function loadUpdaterConfig(root = repoRoot) {
  const configPath = path.join(root, "src-tauri", "tauri.conf.json");
  const config = readJsonAt(configPath, "src-tauri/tauri.conf.json");
  const updater = config.plugins?.updater;
  if (!updater || typeof updater !== "object") {
    throw new Error(
      "src-tauri/tauri.conf.json is missing plugins.updater (pubkey/endpoints). Run the UPD-01 config change first.",
    );
  }
  const pubkey = String(updater.pubkey ?? "").trim();
  if (!pubkey) {
    throw new Error(
      "plugins.updater.pubkey is empty; the updater cannot verify any release.",
    );
  }
  const endpoints = Array.isArray(updater.endpoints) ? updater.endpoints : [];
  if (endpoints.length === 0) {
    throw new Error(
      "plugins.updater.endpoints is empty; shipped apps would have nowhere to check for updates.",
    );
  }
  const windowsInstallMode = updater.windows?.installMode ?? "passive";
  const createUpdaterArtifacts = config.bundle?.createUpdaterArtifacts === true;
  return {
    configPath,
    version: String(config.version ?? ""),
    pubkey,
    endpoints,
    windowsInstallMode,
    createUpdaterArtifacts,
  };
}

/** Derive `<owner>/<repo>` from a GitHub `.../releases/latest/download/latest.json` endpoint. */
export function deriveRepoFromEndpoint(endpoint) {
  const match = String(endpoint).match(
    /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/releases\/latest\/download\/latest\.json$/,
  );
  return match ? `${match[1]}/${match[2]}` : undefined;
}

/**
 * GITHUB_TOKEN wins; otherwise fall back to the credential helper git already uses for
 * github.com (Windows Credential Manager). The token is only ever held in memory.
 */
export function resolveGithubToken(
  env = process.env,
  { gitExecutable = "git" } = {},
) {
  const fromEnv = env.GITHUB_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  const result = spawnSync(gitExecutable, ["credential", "fill"], {
    input: "protocol=https\nhost=github.com\n\n",
    encoding: "utf8",
  });
  if (result.error || result.status !== 0) return undefined;
  const passwordLine = result.stdout
    .split(/\r?\n/)
    .find((line) => line.startsWith("password="));
  const token = passwordLine?.slice("password=".length).trim();
  return token || undefined;
}

export function expectedEndpoint(repo) {
  return `https://github.com/${repo}/releases/latest/download/latest.json`;
}

function signingKeyDir(env) {
  const override = env.P4DECK_UPDATER_KEY_DIR?.trim();
  return override && override.length > 0
    ? override
    : path.join(os.homedir(), DEFAULT_KEY_DIR);
}

/**
 * Resolve the updater signing material without ever printing it.
 * `optional: true` returns null when no key exists (used by the plain packaging script).
 */
export function resolveSigningMaterial({
  env = process.env,
  optional = false,
} = {}) {
  const keyDir = signingKeyDir(env);
  const keyPath =
    env.TAURI_SIGNING_PRIVATE_KEY_PATH?.trim() ||
    path.join(keyDir, "updater.key");
  const passwordPath = path.join(keyDir, "updater.key.password");
  if (!existsSync(keyPath)) {
    if (optional) return null;
    throw new Error(
      [
        `updater signing key not found at ${keyPath}.`,
        "Expected the UPD-01 key or override it with TAURI_SIGNING_PRIVATE_KEY_PATH.",
        "Never commit the key; it belongs outside the repository.",
      ].join(" "),
    );
  }
  const keyContent = readFileSync(keyPath, "utf8").trim();
  if (keyContent.length === 0) {
    throw new Error(`updater signing key file is empty: ${keyPath}`);
  }
  const password =
    env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD?.trim() ||
    (existsSync(passwordPath) ? readFileSync(passwordPath, "utf8").trim() : "");
  if (password.length === 0) {
    throw new Error(
      `updater signing password is missing. Set TAURI_SIGNING_PRIVATE_KEY_PASSWORD or keep it in ${passwordPath}.`,
    );
  }
  return { keyPath, keyContent, password };
}

function runValidateVersions() {
  const result = spawnSync(
    process.execPath,
    [path.join(repoRoot, "scripts", "validate-versions.mjs")],
    {
      cwd: repoRoot,
      encoding: "utf8",
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `version mismatch between package.json / tauri.conf.json / Cargo.toml:\n${result.stdout}${result.stderr}`,
    );
  }
  const parsed = JSON.parse(result.stdout.trim());
  return parsed.version;
}

// ---------------------------------------------------------------------------
// minisign verification (same algorithm the Tauri updater uses)
// ---------------------------------------------------------------------------

export function parseMinisignPublicKey(pubkeyBase64) {
  const decoded = Buffer.from(String(pubkeyBase64).trim(), "base64").toString(
    "utf8",
  );
  const lines = decoded.split(/\r?\n/).filter((line) => line.length > 0);
  if (lines.length < 2) {
    throw new Error(
      "plugins.updater.pubkey is not a base64 minisign public key (expected two decoded lines).",
    );
  }
  const bin = Buffer.from(lines[1], "base64");
  if (bin.length !== 42) {
    throw new Error(
      `minisign public key payload is ${bin.length} bytes, expected 42.`,
    );
  }
  const algorithm = bin.subarray(0, 2).toString("latin1");
  if (algorithm !== "Ed" && algorithm !== "ED") {
    throw new Error(
      `unsupported minisign public key algorithm ${JSON.stringify(algorithm)}.`,
    );
  }
  return {
    algorithm,
    keyId: bin.subarray(2, 10).toString("hex"),
    key: bin.subarray(10, 42),
  };
}

export function parseMinisignSignature(signature) {
  const trimmed = String(signature).trim();
  if (trimmed.length === 0) throw new Error("updater signature is empty.");
  const text = trimmed.startsWith("untrusted comment:")
    ? trimmed
    : Buffer.from(trimmed, "base64").toString("utf8");
  const lines = text.split(/\r?\n/);
  if (lines.length < 4)
    throw new Error("updater signature is not a 4-line minisign signature.");
  const bin1 = Buffer.from(lines[1], "base64");
  if (bin1.length !== 74) {
    throw new Error(
      `minisign signature payload is ${bin1.length} bytes, expected 74.`,
    );
  }
  const bin2 = Buffer.from(lines[3], "base64");
  if (bin2.length !== 64) {
    throw new Error(
      `minisign global signature is ${bin2.length} bytes, expected 64.`,
    );
  }
  if (!lines[2].startsWith("trusted comment: ")) {
    throw new Error("minisign signature is missing its trusted comment line.");
  }
  const algorithm = bin1.subarray(0, 2).toString("latin1");
  if (algorithm !== "Ed" && algorithm !== "ED") {
    throw new Error(
      `unsupported minisign signature algorithm ${JSON.stringify(algorithm)}.`,
    );
  }
  return {
    algorithm,
    // minisign-verify maps "Ed" to a raw signature and "ED" to a Blake2b-512 prehashed one.
    prehashed: algorithm === "ED",
    keyId: bin1.subarray(2, 10).toString("hex"),
    signature: bin1.subarray(10, 74),
    trustedComment: lines[2].slice("trusted comment: ".length),
    globalSignature: bin2,
  };
}

function ed25519Verify(data, rawKey, rawSignature) {
  const keyObject = createPublicKey({
    key: Buffer.concat([SPKI_ED25519_PREFIX, rawKey]),
    format: "der",
    type: "spki",
  });
  return verifyEd25519(null, data, keyObject, rawSignature);
}

/** Reads the `version:<x>` field the Tauri CLI may embed in the trusted comment. */
export function signedVersionFromTrustedComment(trustedComment) {
  return trustedComment
    .split("\t")
    .find((field) => field.startsWith("version:"))
    ?.slice("version:".length);
}

export function verifyMinisignSignature({ data, signature, pubkey }) {
  const publicKey = parseMinisignPublicKey(pubkey);
  const parsed = parseMinisignSignature(signature);
  if (publicKey.keyId !== parsed.keyId) {
    throw new Error(
      `updater signature was produced by a different key (signature key id ${parsed.keyId}, configured pubkey ${publicKey.keyId}).`,
    );
  }
  const signedData = parsed.prehashed
    ? createHash("blake2b512").update(data).digest()
    : data;
  if (!ed25519Verify(signedData, publicKey.key, parsed.signature)) {
    throw new Error(
      "updater signature does not verify against the pubkey in tauri.conf.json.",
    );
  }
  const globalData = Buffer.concat([
    parsed.signature,
    Buffer.from(parsed.trustedComment, "utf8"),
  ]);
  if (!ed25519Verify(globalData, publicKey.key, parsed.globalSignature)) {
    throw new Error("minisign trusted comment signature is invalid.");
  }
  return {
    keyId: publicKey.keyId,
    trustedComment: parsed.trustedComment,
    prehashed: parsed.prehashed,
    signedVersion: signedVersionFromTrustedComment(parsed.trustedComment),
  };
}

// ---------------------------------------------------------------------------
// build artifacts + latest.json
// ---------------------------------------------------------------------------

export function bundleDirectory(root = repoRoot) {
  return path.join(root, NSIS_BUNDLE_DIR);
}

/**
 * Locate the freshly built NSIS installer, the updater payload and its signature.
 * `newerThan` (epoch ms) rejects stale files left over from an earlier build.
 *
 * Tauri v2 signs the NSIS installer itself (`-setup.exe` + `.exe.sig`) and the updater
 * runs that executable; `bundle.createUpdaterArtifacts: "v1Compatible"` instead packs it
 * as `.nsis.zip` + `.nsis.zip.sig`. The updater crate accepts both, so accept both here
 * and prefer the zip only when the build actually produced one.
 */
export function planUpdaterArtifacts({ bundleDir, version, newerThan } = {}) {
  if (!existsSync(bundleDir)) {
    throw new Error(
      `NSIS bundle directory is missing: ${bundleDir}. Build first (node scripts/publish-update.mjs) or pass --bundle-dir.`,
    );
  }
  const entries = readdirSync(bundleDir)
    .map((name) => {
      const filePath = path.join(bundleDir, name);
      return { name, filePath, stats: statSync(filePath) };
    })
    .filter((entry) => entry.stats.isFile())
    .filter((entry) => !newerThan || entry.stats.mtimeMs >= newerThan)
    .filter((entry) => entry.name.includes(`_${version}_`));

  const pick = (predicate, label) => {
    const found = entries
      .filter((entry) => predicate(entry.name))
      .sort((left, right) => right.stats.mtimeMs - left.stats.mtimeMs);
    if (found.length === 0) {
      throw new Error(
        `no ${label} for version ${version} found in ${bundleDir}.`,
      );
    }
    return found[0];
  };

  const installer = pick(
    (name) => name.endsWith(".exe") && !name.endsWith(".sig"),
    "NSIS installer (.exe)",
  );
  const nsisZip = entries
    .filter((entry) => entry.name.endsWith(".nsis.zip"))
    .sort((left, right) => right.stats.mtimeMs - left.stats.mtimeMs)[0];
  const payload = nsisZip ?? installer;
  const payloadKind = nsisZip ? "nsis-zip" : "exe";
  const signature = pick(
    (name) => name === `${payload.name}.sig`,
    `signature file (${payload.name}.sig)`,
  );
  return { installer, payload, signature, payloadKind };
}

export function buildLatestJson({
  version,
  notes = RELEASE_NOTES_DEFAULT,
  pubDate,
  signature,
  url,
  platform = "windows-x86_64",
}) {
  return {
    version,
    notes,
    pub_date: pubDate ?? new Date().toISOString(),
    platforms: {
      [platform]: { signature, url },
    },
  };
}

export function validateLatestJson(
  manifest,
  { version, repo, payloadName } = {},
) {
  if (!manifest || typeof manifest !== "object")
    throw new Error("latest.json is not an object.");
  if (typeof manifest.version !== "string" || manifest.version.trim() === "") {
    throw new Error("latest.json is missing a version string.");
  }
  if (version && manifest.version !== version) {
    throw new Error(
      `latest.json version ${manifest.version} does not match the app version ${version}.`,
    );
  }
  if (
    typeof manifest.pub_date !== "string" ||
    Number.isNaN(Date.parse(manifest.pub_date))
  ) {
    throw new Error("latest.json pub_date is not an ISO-8601 timestamp.");
  }
  const platform = manifest.platforms?.["windows-x86_64"];
  if (!platform || typeof platform !== "object") {
    throw new Error('latest.json is missing platforms["windows-x86_64"].');
  }
  if (
    typeof platform.signature !== "string" ||
    platform.signature.trim() === ""
  ) {
    throw new Error("latest.json platforms.windows-x86_64.signature is empty.");
  }
  let url;
  try {
    url = new URL(platform.url);
  } catch {
    throw new Error(
      "latest.json platforms.windows-x86_64.url is not an absolute URL.",
    );
  }
  if (url.protocol !== "https:") {
    throw new Error("latest.json platforms.windows-x86_64.url must be https.");
  }
  if (repo && !url.pathname.startsWith(`/${repo}/releases/download/`)) {
    throw new Error(
      `latest.json artifact URL does not point at a ${repo} release download: ${platform.url}`,
    );
  }
  if (
    payloadName &&
    decodeURIComponent(url.pathname.split("/").pop()) !== payloadName
  ) {
    throw new Error(
      `latest.json artifact URL does not point at ${payloadName}: ${platform.url}`,
    );
  }
  return manifest;
}

/** Latest.json artifact URL for a release tag (the updater downloads this payload). */
export function releaseAssetUrl({ repo, tag, assetName }) {
  return `https://github.com/${repo}/releases/download/${tag}/${encodeURIComponent(assetName)}`;
}

export function releaseTag(version) {
  return `v${version}`;
}

// ---------------------------------------------------------------------------
// GitHub API (no automatic retries: a failed upload must be retried by a human)
// ---------------------------------------------------------------------------

function apiHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "P4Deck-updater-publish",
  };
}

async function githubRequest({
  token,
  method = "GET",
  url,
  body,
  allow404 = false,
}) {
  const response = await fetch(url, {
    method,
    headers: {
      ...apiHeaders(token),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  const raw = await response.text();
  let data = null;
  if (raw) {
    try {
      data = JSON.parse(raw);
    } catch {
      data = null;
    }
  }
  if (response.status === 404 && allow404) return null;
  if (!response.ok) {
    const detail = data?.message ?? raw.slice(0, 300);
    throw new Error(
      `GitHub API ${method} ${url} failed: HTTP ${response.status} ${detail}`,
    );
  }
  return data;
}

export async function findRelease({ apiUrl, token, repo, tag }) {
  return githubRequest({
    token,
    url: `${apiUrl}/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`,
    allow404: true,
  });
}

async function deleteRelease({ apiUrl, token, repo, releaseId }) {
  await githubRequest({
    token,
    method: "DELETE",
    url: `${apiUrl}/repos/${repo}/releases/${releaseId}`,
  });
}

async function createDraftRelease({ apiUrl, token, repo, tag, name, body }) {
  return githubRequest({
    token,
    method: "POST",
    url: `${apiUrl}/repos/${repo}/releases`,
    body: { tag_name: tag, name, body, draft: true, prerelease: false },
  });
}

async function publishDraftRelease({ apiUrl, token, repo, releaseId }) {
  return githubRequest({
    token,
    method: "PATCH",
    url: `${apiUrl}/repos/${repo}/releases/${releaseId}`,
    body: { draft: false },
  });
}

async function uploadAsset({
  token,
  uploadUrlTemplate,
  filePath,
  name,
  contentType,
}) {
  const uploadUrl = `${uploadUrlTemplate.replace(/\{.*\}$/, "")}?name=${encodeURIComponent(name)}`;
  const data = readFileSync(filePath);
  const response = await fetch(uploadUrl, {
    method: "POST",
    headers: { ...apiHeaders(token), "Content-Type": contentType },
    body: data,
    signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
  });
  const raw = await response.text();
  let parsed = null;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    parsed = null;
  }
  if (!response.ok) {
    throw new Error(
      `upload of ${name} failed: HTTP ${response.status} ${parsed?.message ?? raw.slice(0, 300)}`,
    );
  }
  return parsed;
}

export async function publishRelease({
  apiUrl,
  token,
  repo,
  version,
  tag,
  assets,
  notes,
  replace = false,
  confirm = false,
  log = (message) => process.stderr.write(`${message}\n`),
}) {
  const existing = await findRelease({ apiUrl, token, repo, tag });
  if (existing && !existing.draft) {
    if (!replace) {
      throw new Error(
        `release ${tag} is already published (${existing.html_url}). Bump the version instead of reusing it.`,
      );
    }
    if (!confirm) {
      throw new Error(
        `--replace would delete the published release ${tag}; pass --confirm as well (clients may be mid-update).`,
      );
    }
    log(
      `deleting published release ${tag} (id ${existing.id}) because --replace --confirm was given`,
    );
    await deleteRelease({ apiUrl, token, repo, releaseId: existing.id });
  } else if (existing?.draft) {
    log(
      `removing stale draft release ${tag} (id ${existing.id}) left by an earlier failed run`,
    );
    await deleteRelease({ apiUrl, token, repo, releaseId: existing.id });
  }

  const draft = await createDraftRelease({
    apiUrl,
    token,
    repo,
    tag,
    name: `${PRODUCT} ${version}`,
    body: notes ?? "",
  });
  log(`draft release ${tag} created (id ${draft.id}); uploading assets`);

  const uploaded = [];
  for (const asset of assets) {
    const result = await uploadAsset({
      token,
      uploadUrlTemplate: draft.upload_url,
      filePath: asset.filePath,
      name: asset.name,
      contentType: asset.contentType,
    });
    uploaded.push({
      name: asset.name,
      role: asset.role,
      sizeBytes: asset.sizeBytes,
      sha256: asset.sha256,
      assetId: result?.id,
      browserDownloadUrl: result?.browser_download_url,
    });
    log(`uploaded ${asset.name} (${asset.sizeBytes} bytes)`);
  }

  const published = await publishDraftRelease({
    apiUrl,
    token,
    repo,
    releaseId: draft.id,
  });
  log(`published release ${tag}: ${published.html_url}`);
  return { ...published, uploaded };
}

// ---------------------------------------------------------------------------
// orchestration
// ---------------------------------------------------------------------------

function runTauriBuild({ offlineWebview2, ignoreVersionMismatches, signing }) {
  const buildArgs = ["build", "--bundles", "nsis", "--ci"];
  if (offlineWebview2) {
    buildArgs.push("--config", "src-tauri/tauri.package.offline.conf.json");
  }
  if (ignoreVersionMismatches) {
    // Explicit opt-in only: the mismatch is normally a real dependency problem.
    buildArgs.push("--ignore-version-mismatches");
  }
  const env = {
    ...process.env,
    TAURI_SIGNING_PRIVATE_KEY: signing.keyContent,
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD: signing.password,
    TAURI_SIGNING_PRIVATE_KEY_PATH: signing.keyPath,
  };
  const result = spawnSync(
    process.execPath,
    [
      path.join(repoRoot, "node_modules", "@tauri-apps", "cli", "tauri.js"),
      ...buildArgs,
    ],
    { cwd: repoRoot, stdio: "inherit", env },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `tauri build failed with exit code ${result.status ?? 1}. Fix the build before publishing; nothing was uploaded.`,
    );
  }
}

async function collectAssets({ plan, version, repo, tag, outputDir, notes }) {
  const exeCopy = path.join(outputDir, plan.installer.name);
  const signatureCopy = path.join(outputDir, `${plan.payload.name}.sig`);
  const payloadIsInstaller = plan.payload.name === plan.installer.name;
  copyFileSync(plan.installer.filePath, exeCopy);
  copyFileSync(plan.signature.filePath, signatureCopy);
  if (!payloadIsInstaller) {
    copyFileSync(
      plan.payload.filePath,
      path.join(outputDir, plan.payload.name),
    );
  }

  const signatureContents = readFileSync(signatureCopy, "utf8").trim();
  const latest = buildLatestJson({
    version,
    notes,
    signature: signatureContents,
    url: releaseAssetUrl({ repo, tag, assetName: plan.payload.name }),
  });
  validateLatestJson(latest, { version, repo, payloadName: plan.payload.name });
  const latestPath = path.join(outputDir, "latest.json");
  writeFileSync(latestPath, `${JSON.stringify(latest, null, 2)}\n`);

  const sha = async (filePath) => (await sha256File(filePath)).toLowerCase();
  const payloadAsset = {
    role: payloadIsInstaller ? "installer-updater-payload" : "updater-payload",
    name: plan.payload.name,
    filePath: payloadIsInstaller
      ? exeCopy
      : path.join(outputDir, plan.payload.name),
    contentType: "application/octet-stream",
  };
  const assets = payloadIsInstaller
    ? [
        payloadAsset,
        {
          role: "updater-signature",
          name: `${plan.payload.name}.sig`,
          filePath: signatureCopy,
          contentType: "application/octet-stream",
        },
        {
          role: "update-manifest",
          name: "latest.json",
          filePath: latestPath,
          contentType: "application/json",
        },
      ]
    : [
        payloadAsset,
        {
          role: "updater-signature",
          name: `${plan.payload.name}.sig`,
          filePath: signatureCopy,
          contentType: "application/octet-stream",
        },
        {
          role: "installer",
          name: plan.installer.name,
          filePath: exeCopy,
          contentType: "application/octet-stream",
        },
        {
          role: "update-manifest",
          name: "latest.json",
          filePath: latestPath,
          contentType: "application/json",
        },
      ];
  for (const asset of assets) {
    asset.sizeBytes = statSync(asset.filePath).size;
    asset.sha256 = await sha(asset.filePath);
  }
  return { assets, latest, latestPath, payloadKind: plan.payloadKind };
}

function writePublishManifest({ outputDir, manifest, publish }) {
  const record = {
    ...manifest,
    publish,
  };
  writeFileSync(
    path.join(outputDir, "updater-manifest.json"),
    `${JSON.stringify(record, null, 2)}\n`,
  );
}

async function main() {
  const log = (message) => process.stderr.write(`${message}\n`);
  const fail = (error) => {
    log(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
    process.stderr.write(
      `${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`,
    );
    // Not process.exit(): exiting while an aborted fetch is still tearing down trips a libuv
    // assertion on Windows (STATUS_STACK_BUFFER_OVERRUN) and hides the real exit code.
    process.exitCode = 1;
  };

  let args;
  let config;
  try {
    args = parseArgs(process.argv.slice(2));
    config = loadUpdaterConfig();
  } catch (error) {
    fail(error);
    return;
  }

  const endpointRepo = config.endpoints
    .map((endpoint) => deriveRepoFromEndpoint(endpoint))
    .find(Boolean);
  const repo =
    args.repo ?? process.env.P4DECK_RELEASES_REPO?.trim() ?? endpointRepo;
  if (!repo) {
    fail(
      new Error(
        "cannot determine the release repo: the updater endpoint is not a GitHub releases/latest/download URL and --repo/P4DECK_RELEASES_REPO is unset.",
      ),
    );
    return;
  }
  const endpoint = expectedEndpoint(repo);
  if (
    !args.skipPublish &&
    endpointRepo &&
    repo !== endpointRepo &&
    !args.allowEndpointMismatch
  ) {
    fail(
      new Error(
        `release repo ${repo} does not match the tauri.conf.json updater endpoint repo ${endpointRepo}. Pass --allow-endpoint-mismatch only if the endpoint is intentionally different.`,
      ),
    );
    return;
  }
  if (!config.createUpdaterArtifacts && !args.skipBuild) {
    fail(
      new Error(
        "bundle.createUpdaterArtifacts is false in tauri.conf.json, so the build cannot produce signed updater artifacts (.exe.sig / .nsis.zip.sig).",
      ),
    );
    return;
  }

  let version;
  try {
    version = runValidateVersions();
  } catch (error) {
    fail(error);
    return;
  }
  const tag = releaseTag(version);
  const outputDir = path.join(repoRoot, "artifacts", "updater", tag);
  const bundleDir = args.bundleDir
    ? path.resolve(args.bundleDir)
    : bundleDirectory();

  log(
    `${PRODUCT} ${version} -> ${repo} (${tag}); mode=${args.dryRun ? "dry-run" : args.skipPublish ? "local-only" : "publish"}`,
  );

  let plan;
  let builtAt = new Date().toISOString();
  let gitHeadValue;
  let gitDirtyValue;
  try {
    if (!args.skipBuild) {
      const buildable = assertBuildableTree({
        allowDirty: args.allowDirty,
        command: "scripts/publish-update.mjs",
      });
      gitHeadValue = buildable.head;
      gitDirtyValue = buildable.dirty;
      const signing = resolveSigningMaterial();
      log(
        "building NSIS installer + updater artifacts with the local signing key",
      );
      const startedAt = Date.now();
      runTauriBuild({
        offlineWebview2: args.offlineWebview2,
        ignoreVersionMismatches: args.ignoreVersionMismatches,
        signing,
      });
      plan = planUpdaterArtifacts({
        bundleDir,
        version,
        newerThan: startedAt - 5000,
      });
    } else {
      gitHeadValue = gitHead();
      gitDirtyValue = gitDirty() ?? true;
      log(`reusing existing artifacts in ${bundleDir}`);
      plan = planUpdaterArtifacts({ bundleDir, version });
    }
  } catch (error) {
    fail(error);
    return;
  }

  let collected;
  let signatureInfo;
  try {
    mkdirSync(outputDir, { recursive: true });
    for (const name of readdirSync(outputDir)) {
      rmSync(path.join(outputDir, name), { force: true, recursive: true });
    }
    const payloadBytes = readFileSync(plan.payload.filePath);
    const signatureContents = readFileSync(
      plan.signature.filePath,
      "utf8",
    ).trim();
    signatureInfo = verifyMinisignSignature({
      data: payloadBytes,
      signature: signatureContents,
      pubkey: config.pubkey,
    });
    log(
      `updater signature verified against the configured pubkey (key id ${signatureInfo.keyId})`,
    );
    if (
      signatureInfo.signedVersion &&
      signatureInfo.signedVersion !== version
    ) {
      throw new Error(
        `the updater payload was signed for version ${signatureInfo.signedVersion}, but the app version is ${version}.`,
      );
    }
    const notes =
      args.notes ??
      (args.notesFile
        ? readFileSync(path.resolve(args.notesFile), "utf8").trim()
        : RELEASE_NOTES_DEFAULT);
    if (!process.env.P4DECK_ALLOW_NOTES_QUERY) {
      assertNotesNotMojibake(notes);
    }
    collected = await collectAssets({
      plan,
      version,
      repo,
      tag,
      outputDir,
      notes,
    });
    // Re-verify the copied payload + signature pair, exactly what latest.json will serve.
    const copiedLatest = readFileSync(collected.latestPath, "utf8");
    const copiedSignature =
      JSON.parse(copiedLatest).platforms["windows-x86_64"].signature;
    verifyMinisignSignature({
      data: readFileSync(path.join(outputDir, plan.payload.name)),
      signature: copiedSignature,
      pubkey: config.pubkey,
    });
    collected.assets.forEach((asset) =>
      log(
        `asset ${asset.name}: ${asset.sizeBytes} bytes sha256=${asset.sha256}`,
      ),
    );
  } catch (error) {
    fail(error);
    return;
  }

  const manifest = {
    product: PRODUCT,
    version,
    tag,
    repo,
    endpoint,
    gitHead: gitHeadValue,
    gitDirty: gitDirtyValue,
    builtAt,
    command: "node scripts/publish-update.mjs",
    latest: {
      file: "latest.json",
      sha256: collected.assets.find((asset) => asset.role === "update-manifest")
        .sha256,
      url: releaseAssetUrl({ repo, tag, assetName: "latest.json" }),
    },
    payload: {
      kind: collected.payloadKind,
      name: plan.payload.name,
      signature: `${plan.payload.name}.sig`,
    },
    assets: collected.assets.map(({ role, name, sizeBytes, sha256 }) => ({
      role,
      name,
      sizeBytes,
      sha256,
    })),
    signature: {
      verified: true,
      keyId: signatureInfo.keyId,
      trustedComment: signatureInfo.trustedComment,
      prehashed: signatureInfo.prehashed,
      signedVersion: signatureInfo.signedVersion ?? null,
    },
  };

  if (args.skipPublish) {
    writePublishManifest({
      outputDir,
      manifest,
      publish: { mode: "local-only" },
    });
    process.stdout.write(
      `${JSON.stringify({ ok: true, mode: "local-only", version, repo, tag, outputDir, missing: ["GITHUB_TOKEN for upload"] })}\n`,
    );
    return;
  }

  const token = resolveGithubToken();
  if (!token) {
    fail(
      new Error(
        `no GitHub token available, so ${tag} cannot be published. Set GITHUB_TOKEN, or store a github.com credential for git (Windows Credential Manager), or use --skip-publish to build + write latest.json only.`,
      ),
    );
    return;
  }
  const apiUrl = (
    process.env.GITHUB_API_URL?.trim() || DEFAULT_API_URL
  ).replace(/\/$/, "");

  try {
    const release = await publishRelease({
      apiUrl,
      token,
      repo,
      version,
      tag,
      assets: collected.assets,
      notes: collected.latest.notes,
      replace: args.replace,
      confirm: args.confirm,
      log,
    });
    const publish = {
      mode: "published",
      releaseId: release.id,
      releaseUrl: release.html_url,
      tag,
      publishedAt: new Date().toISOString(),
      assets: release.uploaded,
    };
    writePublishManifest({ outputDir, manifest, publish });
    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        mode: "published",
        version,
        repo,
        tag,
        releaseUrl: release.html_url,
        outputDir,
        assets: publish.assets,
      })}\n`,
    );
  } catch (error) {
    writePublishManifest({
      outputDir,
      manifest,
      publish: {
        mode: "failed",
        error: error instanceof Error ? error.message : String(error),
      },
    });
    log(
      "publish failed. Any draft release it created is unpublished, so `releases/latest` still serves the previous update.",
    );
    log(
      "fix the cause and rerun the same command: a stale draft is replaced automatically.",
    );
    fail(error);
  }
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  await main();
}
