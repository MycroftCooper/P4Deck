#!/usr/bin/env node
// Build the frontend into `dist/`.
//
// `--mode desktop` is the native build: it sets `__P4DECK_DESKTOP__` so the
// browser-only mock backend is tree-shaken out of the bundle.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const argv = process.argv.slice(2);

function option(name, fallback) {
  const index = argv.indexOf(name);
  return index === -1 ? fallback : argv[index + 1];
}

const mode = option("--mode", "production");
const tsc = path.join(repoRoot, "node_modules", "typescript", "bin", "tsc");
const vite = path.join(repoRoot, "node_modules", "vite", "bin", "vite.js");

for (const tool of [tsc, vite]) {
  if (!existsSync(tool)) {
    console.error(
      `Missing ${path.relative(repoRoot, tool)}. Run \`pnpm install\` first.`,
    );
    process.exit(1);
  }
}

function run(tool, args) {
  const result = spawnSync(process.execPath, [tool, ...args], {
    cwd: repoRoot,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run(tsc, ["-b"]);
run(vite, ["build", "--mode", mode]);
