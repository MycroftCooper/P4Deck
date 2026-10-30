#!/usr/bin/env node
// Build the standalone desktop exe (no installer) and record its identity.
//
//   node scripts/build-desktop.mjs [--allow-dirty] [--skip-verify]
//
// Output: artifacts/desktop/P4Deck.exe, a version+commit stamped copy and
// artifact-info.json (version, commit, dirty flag, size, SHA-256).
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  assertBuildableTree,
  readJson,
  repoRoot,
  runNode,
  sha256File,
  tauriCliVersion,
} from "./lib.mjs";

const argv = process.argv.slice(2);
const allowDirty = argv.includes("--allow-dirty");
const skipVerify = argv.includes("--skip-verify");

const version = readJson("package.json").version;
if (!skipVerify) runNode("scripts/validate-versions.mjs", []);

const { head, dirty } = assertBuildableTree({
  allowDirty,
  command: "scripts/build-desktop.mjs",
});

const startedAt = Date.now();
runNode("node_modules/@tauri-apps/cli/tauri.js", [
  "build",
  "--no-bundle",
  "--ci",
]);

const executable = path.join(
  repoRoot,
  "src-tauri",
  "target",
  "release",
  "p4deck.exe",
);
if (!existsSync(executable)) {
  console.error(
    `Build succeeded but ${path.relative(repoRoot, executable)} is missing.`,
  );
  process.exit(1);
}
const stats = statSync(executable);
if (stats.mtimeMs < startedAt - 5000) {
  console.error(
    "Refusing to package a stale executable: target/release/p4deck.exe was not rewritten by this build.",
  );
  process.exit(1);
}

const sha256 = await sha256File(executable);
const shortHead = head.slice(0, 7);
const outputDirectory = path.join(repoRoot, "artifacts", "desktop");
mkdirSync(outputDirectory, { recursive: true });

const executableName = "P4Deck.exe";
const versionedName = `P4Deck-${version}-${shortHead}.exe`;
copyFileSync(executable, path.join(outputDirectory, executableName));
copyFileSync(executable, path.join(outputDirectory, versionedName));

const info = {
  product: "P4Deck",
  kind: "standalone-exe",
  version,
  versionSource: "package.json",
  gitHead: head,
  gitDirty: dirty,
  builtAt: new Date().toISOString(),
  platform: `${process.platform}-${process.arch}`,
  node: process.version,
  tauriCli: tauriCliVersion(),
  command: "node scripts/build-desktop.mjs",
  executable: {
    name: executableName,
    versionedName,
    path: `artifacts/desktop/${executableName}`,
    sizeBytes: stats.size,
    sha256,
  },
};
writeFileSync(
  path.join(outputDirectory, "artifact-info.json"),
  `${JSON.stringify(info, null, 2)}\n`,
);

process.stdout.write(`${JSON.stringify({ ok: true, ...info })}\n`);
