#!/usr/bin/env node
// 发布：把 dev 合并进 release（发布线）并打 v<semver> tag。默认 dry-run。
//
//   node scripts/workflow/release.mjs --version 0.1.7 [--note "发布说明"]
//   node scripts/workflow/release.mjs --version 0.1.7 --apply
//
// 规则：
//   - 只能在 dev 上发起（--from 可覆盖）；工作树必须干净（--allow-dirty 可覆盖）
//   - 必须有通过且不早于最后一次 dev 提交的 ci:quick 证据（--skip-gate 可覆盖）
//   - release 是发布线（主分支）：只接受本次 merge（--no-ff），不直接提交
//   - --apply 后自行 git push origin dev release --follow-tags
import { spawnSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const GATE_FILE = path.join(ROOT, "artifacts", "ci", "quick-latest.json");

const USAGE = [
  "用法: node scripts/workflow/release.mjs --version <semver> [--note \"说明\"] [--apply] [--dry]",
  "  --version <semver>  发布版本号（不带 v 前缀，需与 package.json 一致）",
  "  --note <text>       annotated tag 的说明",
  "  --apply             真正执行 merge + tag（默认只打印计划）",
  "  --from <branch>     从哪个分支合并（默认 dev）",
  "  --skip-gate         跳过 ci:quick 通过检查（不推荐）",
  "  --allow-dirty       允许工作树有未提交改动（不推荐）",
].join("\n");

function git(args, { allowFailure = false } = {}) {
  const result = spawnSync("git", args, { cwd: ROOT, encoding: "utf8" });
  if (result.status !== 0) {
    if (allowFailure) return { ok: false, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
    throw new Error(`git ${args.join(" ")} 失败: ${(result.stderr || result.stdout || "").trim()}`);
  }
  return { ok: true, stdout: (result.stdout ?? "").trim(), stderr: (result.stderr ?? "").trim() };
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) {
  process.stdout.write(`${USAGE}\n`);
  process.exit(0);
}
const valueOf = (flag) => {
  const index = argv.indexOf(flag);
  return index >= 0 ? String(argv[index + 1] ?? "").trim() : "";
};
const version = valueOf("--version");
const note = valueOf("--note") || `release v${version}`;
const from = valueOf("--from") || "dev";
const apply = argv.includes("--apply");
const skipGate = argv.includes("--skip-gate");
const allowDirty = argv.includes("--allow-dirty");

if (!/^\d+\.\d+\.\d+$/.test(version)) fail(`--version 必须是 x.y.z（当前 "${version}"）\n${USAGE}`);

const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]).stdout;
if (branch !== from) fail(`发布必须从 ${from} 发起，当前在 ${branch}（可用 --from 覆盖）`);

const packageVersion = JSON.parse(await readFile(path.join(ROOT, "package.json"), "utf8")).version;
if (packageVersion !== version) {
  fail(`版本不一致：package.json=${packageVersion}，--version=${version}。先跑 pnpm validate:versions 并同步版本。`);
}

const dirty = git(["status", "--porcelain"]).stdout;
if (dirty && !allowDirty) {
  fail(`工作树不干净（${dirty.split(/\r?\n/).length} 项）。先提交或 stash；确需发布用 --allow-dirty。`);
}

if (!skipGate) {
  let gate;
  try {
    gate = JSON.parse(await readFile(GATE_FILE, "utf8"));
  } catch {
    fail(`缺少门禁证据 ${path.relative(ROOT, GATE_FILE)}；先跑 pnpm ci:quick，或用 --skip-gate。`);
  }
  if (gate.ok !== true) fail("最近一次 ci:quick 未通过；修绿后再发布，或用 --skip-gate。");
  const gateMtime = (await stat(GATE_FILE)).mtimeMs;
  const lastCommitSeconds = Number(git(["log", "-1", "--format=%ct"]).stdout);
  if (gateMtime < lastCommitSeconds * 1000) {
    fail("ci:quick 证据早于最后一次提交（可能过期）；重跑 pnpm ci:quick，或用 --skip-gate。");
  }
}

const tag = `v${version}`;
const existingTag = git(["rev-parse", "-q", "--verify", `refs/tags/${tag}`], { allowFailure: true });
if (existingTag.ok) fail(`tag ${tag} 已存在`);

const plan = {
  dryRun: !apply,
  from,
  to: "release",
  version,
  tag,
  note,
  steps: [
    `git checkout release`,
    `git merge --no-ff ${from} -m "chore(release): ${tag}"`,
    `git tag -a ${tag} -m "${note}"`,
    `git checkout ${from}`,
  ],
};

if (!apply) {
  process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
  process.stdout.write("dry-run：未执行。加 --apply 真正发布。\n");
  process.exit(0);
}

git(["checkout", "release"]);
const merge = spawnSync("git", ["merge", "--no-ff", from, "-m", `chore(release): ${tag}`], {
  cwd: ROOT,
  encoding: "utf8",
});
if (merge.status !== 0) {
  process.stderr.write(`merge 失败，停在 release 上等人工处理：\n${merge.stdout ?? ""}${merge.stderr ?? ""}\n`);
  process.stderr.write(`处理完后：git checkout ${from}\n`);
  process.exit(1);
}
const tagResult = spawnSync("git", ["tag", "-a", tag, "-m", note], { cwd: ROOT, encoding: "utf8" });
if (tagResult.status !== 0) {
  process.stderr.write(`打 tag 失败，已 merge 但未 tag：${tagResult.stderr ?? ""}\n`);
  process.exit(1);
}
git(["checkout", from]);
process.stdout.write(
  `已发布 ${tag}：${from} → release（no-ff）+ annotated tag。\n` +
    "需要时自行：git push origin dev release --follow-tags\n",
);
