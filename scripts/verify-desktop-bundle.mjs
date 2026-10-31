#!/usr/bin/env node
// Guards the P0 invariant: the packaged desktop bundle must not contain the
// browser mock backend. Run after `pnpm build:desktop` (ci:local does this).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const dist = path.join(repoRoot, "dist");
const assets = path.join(dist, "assets");

const failures = [];
if (!existsSync(path.join(dist, "index.html"))) {
  failures.push(
    `missing ${path.relative(repoRoot, path.join(dist, "index.html"))}`,
  );
}
if (!existsSync(assets)) {
  failures.push(`missing ${path.relative(repoRoot, assets)}`);
}

const jsAssets = existsSync(assets)
  ? readdirSync(assets).filter((file) => file.endsWith(".js"))
  : [];

const offenders = jsAssets.filter((file) => {
  if (/mockBackend/i.test(file)) return true;
  const content = readFileSync(path.join(assets, file), "utf8");
  // `mockConnection` is the localStorage key the mock backend owns.
  return /mockBackend|mockConnection/.test(content);
});

for (const file of offenders) {
  failures.push(
    `desktop bundle still contains mock backend code: dist/assets/${file}`,
  );
}

const result = {
  ok: failures.length === 0,
  jsAssets: jsAssets.length,
  failures,
};
process.stdout.write(`${JSON.stringify(result)}\n`);
if (!result.ok) {
  for (const failure of failures) process.stderr.write(`${failure}\n`);
  process.exitCode = 1;
}
