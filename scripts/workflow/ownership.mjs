#!/usr/bin/env node
// 写域校验：防止 FE/BE/QA 互相改对方的文件（"单写者"从文字约定变成可执行检查）。
//
// 用法:
//   node scripts/workflow/ownership.mjs map src/app/App.tsx           # 这条路径归谁
//   node scripts/workflow/ownership.mjs check --role FE                # 本次 git 改动是否都在 FE 写域
//   node scripts/workflow/ownership.mjs check --role FE --files a,b,c
//   node scripts/workflow/ownership.mjs verify-config                  # 配置本身是否有重叠/漏洞
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CONFIG_PATH = path.join(ROOT, "ForAIDoc", "PM", "工作流", "ownership.json");

function normalize(value) {
  return String(value).trim().replace(/\\/g, "/").replace(/^\.\//, "");
}

/** 最长前缀优先；根文件按名单；其余返回 undefined。 */
export function resolveOwner(config, filePath) {
  const file = normalize(filePath);
  if (config.ignoredPrefixes?.some((prefix) => file.startsWith(prefix) || file === prefix.replace(/\/$/, ""))) {
    return { role: undefined, ignored: true, rule: "ignored" };
  }
  if (!file.includes("/") && config.rootFiles?.names?.includes(file)) {
    return { role: config.rootFiles.role, ignored: false, rule: "rootFiles" };
  }
  let best;
  for (const rule of config.rules ?? []) {
    if (!file.startsWith(rule.prefix)) continue;
    if (!best || rule.prefix.length > best.prefix.length) best = rule;
  }
  if (!best) return { role: undefined, ignored: false, rule: "unmapped" };
  return { role: best.role, ignored: false, rule: best.prefix };
}

export async function loadOwnership() {
  return JSON.parse(await readFile(CONFIG_PATH, "utf8"));
}

/** 从 git 取本次改动（含未跟踪），或使用显式文件列表。 */
export function changedFiles(explicit) {
  if (explicit?.length) return explicit.map(normalize);
  const run = (args) => {
    try {
      return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" })
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
    } catch {
      return [];
    }
  };
  return [...new Set([...run(["diff", "--name-only", "HEAD"]), ...run(["ls-files", "--others", "--exclude-standard"])])].map(normalize);
}

export function checkFiles(config, files, role) {
  const violations = [];
  const ignored = [];
  const unmapped = [];
  for (const file of files) {
    const owner = resolveOwner(config, file);
    if (owner.ignored) {
      ignored.push(file);
      continue;
    }
    if (!owner.role) {
      unmapped.push(file);
      continue;
    }
    if (role && owner.role !== role) violations.push({ file, owner: owner.role, expected: role, rule: owner.rule });
  }
  return { violations, ignored, unmapped };
}

function parseArgs(argv) {
  const args = { files: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--files") {
      args.files = String(argv[index + 1] ?? "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
      index += 1;
    } else if (token === "--role") {
      args.role = String(argv[index + 1] ?? "").toUpperCase();
      index += 1;
    } else if (token === "--json") {
      args.json = true;
    } else if (!token.startsWith("--")) {
      args._ = [...(args._ ?? []), token];
    }
  }
  return args;
}

async function main() {
const [command, ...rest] = process.argv.slice(2);
const args = parseArgs(rest);
const config = await loadOwnership();

if (command === "map") {
  const file = args._?.[0];
  if (!file) {
    process.stderr.write("用法: node scripts/workflow/ownership.mjs map <路径>\n");
    process.exit(2);
  }
  const owner = resolveOwner(config, file);
  process.stdout.write(`${normalize(file)} → ${owner.ignored ? "(忽略)" : owner.role ?? "(未映射)"} [${owner.rule}]\n`);
  process.exit(owner.role || owner.ignored ? 0 : 1);
} else if (command === "verify-config") {
  const problems = [];
  const rules = [...(config.rules ?? [])].sort((a, b) => b.prefix.length - a.prefix.length);
  for (let i = 0; i < rules.length; i += 1) {
    for (let j = i + 1; j < rules.length; j += 1) {
      if (rules[j].prefix.startsWith(rules[i].prefix) && rules[i].role !== rules[j].role) {
        problems.push(`前缀重叠且角色不同: ${rules[i].prefix}(${rules[i].role}) ⊃ ${rules[j].prefix}(${rules[j].role})`);
      }
    }
  }
  for (const role of config.roles ?? []) {
    if (!(config.rules ?? []).some((rule) => rule.role === role)) problems.push(`角色 ${role} 没有任何写域`);
  }
  const report = { ok: problems.length === 0, rules: rules.length, problems };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exit(report.ok ? 0 : 1);
} else if (command === "check") {
  const files = changedFiles(args.files);
  const result = checkFiles(config, files, args.role);
  const report = {
    ok: result.violations.length === 0,
    role: args.role ?? null,
    checked: files.length,
    violations: result.violations,
    unmapped: result.unmapped,
    ignored: result.ignored.length,
  };
  if (args.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else if (report.ok) {
    process.stdout.write(`PASS 写域检查${args.role ? `（${args.role}）` : ""}: ${files.length} 个改动文件无越界\n`);
    if (result.unmapped.length) process.stderr.write(`提示: ${result.unmapped.length} 个未映射路径（不阻塞）\n`);
  } else {
    for (const violation of result.violations) {
      process.stderr.write(`越界: ${violation.file} 属于 ${violation.owner}（当前角色 ${violation.expected}）\n`);
    }
    process.stdout.write(`FAIL 写域检查: ${result.violations.length} 个越界\n`);
  }
  process.exit(report.ok ? 0 : 1);
} else {
  process.stderr.write("usage: node scripts/workflow/ownership.mjs <map|check|verify-config> ...\n");
  process.exit(2);
}
}

export { CONFIG_PATH };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
