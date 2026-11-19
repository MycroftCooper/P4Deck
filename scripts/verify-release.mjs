#!/usr/bin/env node
// Post-publish verification against the real public GitHub release (anonymous,
// no token required).
//
//   node scripts/verify-release.mjs --version 0.1.14
//   node scripts/verify-release.mjs --version 0.1.14 --earlier v0.1.12,v0.1.13
//
// Checks that the published release is what the build produced: `releases/latest`
// points at this tag and is published (not draft, not prerelease), the asset list
// is exactly the installer/signature/latest.json trio, the anonymously downloaded
// latest.json and installer match the local copies byte for byte, the installer's
// minisign signature verifies against the pubkey compiled into the app and carries
// the signed version, and the updater config still demands signed versions.
//
// The report is written under ForAIDoc/PM/releases/ so the evidence is committed
// with the release instead of disappearing with the ignored artifacts/ tree.
// Local byte comparisons are reported as `skipped` (not `failed`) when this
// machine no longer holds the build output, which keeps the script useful for
// auditing an older release from a fresh clone.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  bundleDirectory,
  deriveRepoFromEndpoint,
  loadUpdaterConfig,
  parseMinisignPublicKey,
  parseMinisignSignature,
  verifyMinisignSignature,
} from "./publish-update.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const USAGE = [
  "用法: node scripts/verify-release.mjs [--version x.y.z] [--tag vX.Y.Z] [--earlier vA,vB] [--out <file>]",
  "  --version x.y.z  要核验的版本，默认取 package.json",
  "  --tag vX.Y.Z     显式指定 GitHub tag，默认 v<version>",
  "  --earlier <list> 额外核验这些旧 tag 仍存在且可下载（逗号分隔）",
  "  --out <file>     报告路径，默认 ForAIDoc/PM/releases/verify-<version>.json",
].join("\n");

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

const results = [];
const check = (name, status, detail = "") => {
  const normalized =
    status === true ? "ok" : status === false ? "failed" : status;
  results.push({ name, status: normalized, detail });
  const mark =
    normalized === "ok" ? "ok  " : normalized === "skipped" ? "skip" : "FAIL";
  process.stderr.write(`${mark} ${name}${detail ? `: ${detail}` : ""}\n`);
};

async function fetchBuffer(url) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`GET ${url} -> HTTP ${response.status}`);
  return {
    bytes: Buffer.from(await response.arrayBuffer()),
    finalUrl: response.url,
  };
}

async function fetchRelease(repo, tag) {
  const url =
    tag === "latest"
      ? `https://api.github.com/repos/${repo}/releases/latest`
      : `https://api.github.com/repos/${repo}/releases/tags/${tag}`;
  const response = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "P4Deck-release-verify",
    },
  });
  return {
    ok: response.ok,
    status: response.status,
    release: response.ok ? await response.json() : null,
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
  const packageVersion = JSON.parse(
    readFileSync(path.join(ROOT, "package.json"), "utf8"),
  ).version;
  const tag = valueOf("--tag") || `v${valueOf("--version") || packageVersion}`;
  const version = tag.replace(/^v/, "");
  const earlierTags = valueOf("--earlier")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .filter((entry) => entry !== tag);
  const outPath =
    valueOf("--out") ||
    path.join(ROOT, "ForAIDoc", "PM", "releases", `verify-${version}.json`);

  return run({ tag, version, earlierTags, outPath });
}

async function run({ tag, version, earlierTags, outPath }) {
  const config = loadUpdaterConfig(ROOT);
  const endpoint = config.endpoints?.[0];
  const repo = deriveRepoFromEndpoint(endpoint);
  if (!repo) {
    process.stderr.write(
      `无法从 updater endpoint 推导仓库：${endpoint}\n` +
        "请确认 tauri.conf.json 的 plugins.updater.endpoints 指向 GitHub releases。\n",
    );
    return 2;
  }
  const pubkey = config.pubkey;
  const expectedKeyId = parseMinisignPublicKey(pubkey).keyId;
  const rawConfig = JSON.parse(readFileSync(config.configPath, "utf8"));

  const localLatestPath = path.join(
    ROOT,
    "artifacts",
    "updater",
    tag,
    "latest.json",
  );
  const localLatest = existsSync(localLatestPath)
    ? readFileSync(localLatestPath)
    : null;

  // The installer name is fixed by the bundler, but read it back from the local
  // manifest when one exists so a naming change cannot silently skip a check.
  let exe = `P4Deck_${version}_x64-setup.exe`;
  if (localLatest) {
    const localManifest = JSON.parse(localLatest.toString("utf8"));
    const localUrl = localManifest.platforms?.["windows-x86_64"]?.url;
    if (typeof localUrl === "string" && localUrl.length > 0) {
      exe = path.basename(localUrl);
    }
  }
  const localExePath = path.join(bundleDirectory(ROOT), exe);
  const localExe = existsSync(localExePath) ? readFileSync(localExePath) : null;

  process.stderr.write(`repo ${repo} tag ${tag}\n`);

  // 1. The public release record itself. The API is rate limited for anonymous
  // callers, so a 403 degrades these checks to `skipped` instead of aborting:
  // everything below is verified from the public download URLs themselves.
  const latestLookup = await fetchRelease(repo, "latest");
  const release = latestLookup.release;
  if (!release) {
    check(
      "GitHub API releases/latest responds 200",
      "skipped",
      `HTTP ${latestLookup.status} (anonymous rate limit); release record checks skipped, downloads still verified`,
    );
  } else {
    check("GitHub API releases/latest responds 200", true);
    check(
      `latest release tag is ${tag}`,
      release.tag_name === tag,
      release.tag_name,
    );
    check(
      "latest release is published (not draft)",
      release.draft === false,
      String(release.draft),
    );
    check(
      "latest release is not a prerelease",
      release.prerelease === false,
      String(release.prerelease),
    );

    const expectedAssets = [exe, `${exe}.sig`, "latest.json"].sort();
    const assetNames = (release.assets ?? []).map((asset) => asset.name).sort();
    check(
      "release has exactly the expected assets",
      JSON.stringify(assetNames) === JSON.stringify(expectedAssets),
      JSON.stringify(assetNames),
    );
  }

  // 2. The public update manifest.
  const latestUrl = `https://github.com/${repo}/releases/latest/download/latest.json`;
  const publicLatest = await fetchBuffer(latestUrl);
  check(
    "public latest.json comes from the release asset host",
    publicLatest.finalUrl.includes("release-assets.githubusercontent.com") ||
      publicLatest.finalUrl.includes(`/releases/download/${tag}/`),
    publicLatest.finalUrl.split("?")[0],
  );
  check(
    localLatest
      ? "public latest.json is byte-identical to the local manifest"
      : "public latest.json byte comparison",
    localLatest
      ? sha256(publicLatest.bytes) === sha256(localLatest)
      : "skipped",
    localLatest
      ? `${sha256(publicLatest.bytes)} vs ${sha256(localLatest)}`
      : `no local manifest at artifacts/updater/${tag}/latest.json`,
  );

  const latest = JSON.parse(publicLatest.bytes.toString("utf8"));
  const platform = latest.platforms?.["windows-x86_64"];
  check(
    `public latest.json version is ${version}`,
    latest.version === version,
    latest.version,
  );
  check(
    "public latest.json has an ISO pub_date",
    !Number.isNaN(Date.parse(latest.pub_date)),
    latest.pub_date,
  );
  check(
    "public latest.json notes are not empty",
    String(latest.notes ?? "").trim().length > 0,
  );
  check(
    "public latest.json url points at the release installer",
    platform?.url ===
      `https://github.com/${repo}/releases/download/${tag}/${exe}`,
    platform?.url,
  );

  const publicSig = await fetchBuffer(
    `https://github.com/${repo}/releases/download/${tag}/${exe}.sig`,
  );
  check(
    "public latest.json signature equals the served .sig asset",
    platform?.signature === publicSig.bytes.toString("utf8").trim(),
  );

  // 3. The installer users actually download.
  const publicExe = await fetchBuffer(platform.url);
  check(
    localExe
      ? "public installer download is byte-identical to the built exe"
      : "public installer byte comparison",
    localExe ? sha256(publicExe.bytes) === sha256(localExe) : "skipped",
    localExe
      ? `${sha256(publicExe.bytes)} vs ${sha256(localExe)}`
      : `no local installer at ${path.relative(ROOT, localExePath)}`,
  );

  let signature = null;
  try {
    signature = verifyMinisignSignature({
      data: publicExe.bytes,
      signature: platform.signature,
      pubkey,
    });
    check("downloaded installer verifies against the shipped pubkey", true);
  } catch (error) {
    check(
      "downloaded installer verifies against the shipped pubkey",
      false,
      error instanceof Error ? error.message : String(error),
    );
  }
  check(
    "signature key id matches the configured pubkey",
    signature ? signature.keyId === expectedKeyId : "skipped",
    signature
      ? `${signature.keyId} vs ${expectedKeyId}`
      : "signature did not verify",
  );
  check(
    `signature trusted comment carries version:${version}`,
    signature
      ? signature.signedVersion === version &&
          parseMinisignSignature(platform.signature).trustedComment.includes(
            `version:${version}`,
          )
      : "skipped",
    signature?.trustedComment,
  );

  // 4. The updater policy the build shipped with.
  check(
    "the shipped config requires signed versions",
    rawConfig.plugins?.updater?.requireSignedVersion === true,
  );
  check(
    "Windows install mode stayed passive",
    config.windowsInstallMode === "passive",
    config.windowsInstallMode,
  );

  // 5. Sizes reported by the API must match the downloads.
  const byName = new Map(
    (release?.assets ?? []).map((asset) => [asset.name, asset]),
  );
  check(
    "API installer size matches the download",
    release ? byName.get(exe)?.size === publicExe.bytes.length : "skipped",
  );
  check(
    "API latest.json size matches the download",
    release
      ? byName.get("latest.json")?.size === publicLatest.bytes.length
      : "skipped",
  );

  // 6. Older releases must stay downloadable: an update path is worthless if the
  // previous installers disappeared.
  for (const earlierTag of earlierTags) {
    const earlierVersion = earlierTag.replace(/^v/, "");
    const earlierExe = `P4Deck_${earlierVersion}_x64-setup.exe`;
    const lookup = await fetchRelease(repo, earlierTag);
    check(
      `${earlierTag} release still exists and is published`,
      lookup.ok &&
        lookup.release?.tag_name === earlierTag &&
        lookup.release?.draft === false,
      `HTTP ${lookup.status}`,
    );
    check(
      `${earlierTag} still exposes its installer asset`,
      (lookup.release?.assets ?? []).some((asset) => asset.name === earlierExe),
    );
  }

  const failed = results.filter((entry) => entry.status === "failed").length;
  const skipped = results.filter((entry) => entry.status === "skipped").length;
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    anonymous: true,
    repo,
    tag,
    version,
    release: {
      id: release?.id ?? null,
      htmlUrl:
        release?.html_url ?? `https://github.com/${repo}/releases/tag/${tag}`,
      publishedAt: release?.published_at ?? null,
      draft: release?.draft ?? null,
      prerelease: release?.prerelease ?? null,
      assets: (release?.assets ?? []).map((asset) => ({
        name: asset.name,
        sizeBytes: asset.size,
        contentType: asset.content_type,
        url: asset.browser_download_url,
      })),
    },
    latestJson: {
      url: latestUrl,
      resolvedUrl: publicLatest.finalUrl.split("?")[0],
      version: latest.version,
      pubDate: latest.pub_date,
      notesHead: String(latest.notes ?? "").split("\n")[0],
      platformUrl: platform?.url,
      sha256: sha256(publicLatest.bytes),
    },
    installer: {
      name: exe,
      sizeBytes: publicExe.bytes.length,
      sha256: sha256(publicExe.bytes),
      signatureKeyId: signature?.keyId ?? null,
      signedVersion: signature?.signedVersion ?? null,
    },
    checks: results,
    passed: results.filter((entry) => entry.status === "ok").length,
    skipped,
    failed,
  };

  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stderr.write(`report: ${path.relative(ROOT, outPath)}\n`);
  process.stdout.write(
    `${JSON.stringify({
      ok: failed === 0,
      passed: report.passed,
      skipped,
      failed,
      tag,
      release: report.release.htmlUrl,
    })}\n`,
  );
  return failed === 0 ? 0 : 1;
}

try {
  const code = main(process.argv.slice(2));
  process.exitCode = typeof code === "number" ? code : await code;
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
  process.exitCode = 1;
}
