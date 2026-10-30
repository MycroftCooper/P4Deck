// Shared helpers for the local build/package entry points.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

export function readJson(relativePath) {
  return JSON.parse(
    readFileSync(path.join(repoRoot, relativePath), "utf8").replace(
      /^\uFEFF/,
      "",
    ),
  );
}

export function tauriCliVersion() {
  return readJson("node_modules/@tauri-apps/cli/package.json").version;
}

export function git(args, { allowFailure = false } = {}) {
  const result = spawnSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (allowFailure) return null;
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr?.trim()}`);
  }
  return result.stdout.trim();
}

export function gitHead() {
  return git(["rev-parse", "HEAD"]);
}

// `null` means "could not determine" and is treated as dirty by the callers.
export function gitDirty() {
  const status = git(["status", "--porcelain"], { allowFailure: true });
  return status === null ? null : status.length > 0;
}

export function assertBuildableTree({ allowDirty, command }) {
  const head = gitHead();
  const dirty = gitDirty();
  if (dirty !== false && !allowDirty) {
    console.error(
      [
        "Refusing to build from a dirty worktree.",
        `Re-run with --allow-dirty (recorded in artifact-info.json), e.g.`,
        `  node ${command} --allow-dirty`,
      ].join("\n"),
    );
    process.exit(1);
  }
  return { head, dirty: dirty ?? true };
}

export function runNode(relativePath, args, { cwd = repoRoot } = {}) {
  const result = spawnSync(
    process.execPath,
    [path.join(repoRoot, relativePath), ...args],
    { cwd, stdio: "inherit" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    console.error(`node ${relativePath} exited with ${result.status ?? 1}`);
    process.exit(result.status ?? 1);
  }
}

export function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}
