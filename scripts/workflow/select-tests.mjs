#!/usr/bin/env node
// 按改动文件做测试选择，避免每片都跑全量 app TS/mock。
// 用法:
//   node scripts/workflow/select-tests.mjs           输出计划 JSON
//   node scripts/workflow/select-tests.mjs --json    同上（显式）
//   node scripts/workflow/select-tests.mjs --quiet   只输出命令
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function changedFiles() {
  const collect = (args) => {
    const result = spawnSync("git", args, { cwd: ROOT, encoding: "utf8" });
    if (result.status !== 0) return [];
    return result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  };
  const tracked = collect(["diff", "--name-only", "HEAD"]);
  const untracked = collect(["ls-files", "--others", "--exclude-standard"]);
  return [...new Set([...tracked, ...untracked])].map((file) => file.replace(/\\/g, "/"));
}

export function buildPlan(files = changedFiles()) {
  const web = files.filter(
    (file) => /^src\//.test(file) && /\.(ts|tsx|css)$/.test(file) && !/\.(test|spec)\.(ts|tsx)$/.test(file),
  );
  const rust = files.filter((file) => /^src-tauri\/(src|tests)\//.test(file) && /\.rs$/.test(file));
  const docs = files.filter((file) => /^(ForAIDoc|docs)\//.test(file));
  const scripts = files.filter((file) => /^scripts\//.test(file));
  const touchedTests = files.filter((file) => /\.(test|spec)\.(ts|tsx)$/.test(file));

  const commands = {};
  commands.format = ["pnpm", "exec", "prettier", "--check", ...(web.length ? web : ["src/**/*.{ts,tsx,css}"])];
  commands.typecheck = ["pnpm", "check:web"];
  if (web.length || touchedTests.length) {
    commands.webRelated = ["pnpm", "exec", "vitest", "related", "--run", ...web, ...touchedTests];
  }
  if (rust.length) {
    commands.rustCheck = ["cargo", "check", "--offline", "--locked", "--lib", "--manifest-path", "src-tauri/Cargo.toml"];
  }
  if (scripts.length) {
    commands.scriptSyntax = [process.execPath, "--check", ...scripts.filter((file) => file.endsWith(".mjs"))];
  }

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    changed: { total: files.length, web, rust, docs, scripts, tests: touchedTests },
    broad: web.length > 20,
    commands,
    notes: [
      "web 改动走 vitest related（按 import 图选测），不再无条件全量 test:web。",
      "rust 改动只做 offline locked lib check；完整 cargo test 留给 freeze 前的重层门禁。",
      "docs-only 改动可只跑状态校验：node scripts/workflow/state.mjs check。",
    ],
  };
}

const isMainEntry = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainEntry) {
  const argv = process.argv.slice(2);
  const args = new Set(argv);
  const filesIndex = argv.indexOf("--files");
  const explicitFiles =
    filesIndex >= 0 && argv[filesIndex + 1]
      ? argv[filesIndex + 1]
          .split(",")
          .map((file) => file.trim().replace(/\\/g, "/"))
          .filter(Boolean)
      : undefined;
  const plan = buildPlan(explicitFiles);
  if (explicitFiles) plan.source = "explicit";
  if (args.has("--quiet")) {
    for (const [name, command] of Object.entries(plan.commands)) {
      process.stdout.write(`${name}: ${command.join(" ")}\n`);
    }
  } else {
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
  }
  if (plan.broad && !explicitFiles) {
    process.stderr.write(
      "提示: 改动文件过多，选测接近全量。可用 --files a,b,c 只指定本片改动，或先做一次基线 commit。\n",
    );
  }
}
