#!/usr/bin/env node
// 快速层门禁：只跑与改动相关的检查，并且并行执行。
// 与 ci:quick（11 步串行、完整）分工：本命令属于“每片开发中”，ci:quick 属于“freeze 前”。
// 用法: node scripts/workflow/ci-fast.mjs
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { buildPlan } from "./select-tests.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ARTIFACT_DIR = path.join(ROOT, "artifacts", "workflow");

function resolveCommand(command) {
  const [name, ...args] = command;
  if (name === "pnpm") {
    if (process.env.npm_execpath) return { command: process.execPath, args: [process.env.npm_execpath, ...args] };
    return { command: "pnpm", args, shell: process.platform === "win32" };
  }
  return { command: name, args };
}

function runStep(step) {
  const { command, args, shell } = resolveCommand(step.command);
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: ROOT, stdio: "inherit", shell: Boolean(shell) });
    child.once("error", () => resolve({ name: step.name, status: "failed", exitCode: 127, durationMs: Date.now() - startedAt }));
    child.once("exit", (code) => {
      const ok = code === 0;
      resolve({
        name: step.name,
        status: ok ? "passed" : "failed",
        exitCode: code ?? 1,
        durationMs: Date.now() - startedAt,
      });
    });
  });
}

const planFilesIndex = process.argv.indexOf("--files");
const explicitFiles =
  planFilesIndex >= 0 && process.argv[planFilesIndex + 1]
    ? process.argv[planFilesIndex + 1]
        .split(",")
        .map((file) => file.trim().replace(/\\/g, "/"))
        .filter(Boolean)
    : undefined;
const plan = buildPlan(explicitFiles);
if (plan.broad && !explicitFiles) {
  process.stderr.write(
    "警告: 改动文件过多（>20），本次接近全量门禁。建议 --files a,b,c 指定本片改动，或先做基线 commit。\n",
  );
}
const hasWeb = plan.changed.web.length > 0 || plan.changed.tests.length > 0;
const hasRust = plan.changed.rust.length > 0;

const steps = [];
if (hasWeb) {
  steps.push({ name: "format:changed", command: plan.commands.format });
  steps.push({ name: "typecheck", command: plan.commands.typecheck });
  if (plan.commands.webRelated) steps.push({ name: "vitest:related", command: plan.commands.webRelated });
}
if (plan.changed.scripts.some((file) => file.endsWith(".mjs"))) {
  steps.push({ name: "script-syntax", command: plan.commands.scriptSyntax });
}

// 预检：写域越界 / 工作流状态不健康时，先停下再浪费测试时间。
const roleIndex = process.argv.indexOf("--role");
const role = roleIndex >= 0 ? String(process.argv[roleIndex + 1] ?? "").toUpperCase() : process.env.P4DECK_ROLE?.toUpperCase();
const preflight = [];
if (role) {
  const ownershipArgs = ["scripts/workflow/ownership.mjs", "check", "--role", role];
  if (explicitFiles?.length) ownershipArgs.push("--files", explicitFiles.join(","));
  preflight.push({ name: "ownership", command: [process.execPath, ...ownershipArgs] });
}
if (
  plan.changed.docs.some((file) => file.startsWith("ForAIDoc/PM/工作流/")) ||
  plan.changed.scripts.some((file) => file.startsWith("scripts/workflow/"))
) {
  preflight.push({
    name: "workflow-state",
    command: [process.execPath, "scripts/workflow/state.mjs", "check"],
  });
}
if (process.argv.includes("--plan")) {
  const planned = [
    ...preflight,
    ...steps,
    ...(hasRust ? [{ name: "rust:offline-check", command: plan.commands.rustCheck }] : []),
  ];
  process.stdout.write(
    `${JSON.stringify(
      {
        schemaVersion: 1,
        planOnly: true,
        role: role ?? null,
        scope: { web: plan.changed.web.length, rust: plan.changed.rust.length, tests: plan.changed.tests.length },
        steps: planned.map((step) => ({ name: step.name, command: step.command.join(" ") })),
      },
      null,
      2,
    )}\n`,
  );
  process.exit(0);
}

const preflightResults = [];
for (const step of preflight) {
  const result = await runStep(step);
  preflightResults.push(result);
  if (result.status !== "passed") break;
}
if (preflightResults.some((result) => result.status !== "passed")) {
  const summary = {
    schemaVersion: 1,
    ok: false,
    role: role ?? null,
    stoppedAt: "preflight",
    steps: preflightResults,
    note: "预检失败，未执行测试。先修写域越界或状态库错误。",
  };
  await mkdir(ARTIFACT_DIR, { recursive: true });
  await writeFile(path.join(ARTIFACT_DIR, "ci-fast-latest.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  process.stdout.write(`\n${JSON.stringify(summary, null, 2)}\n`);
  process.exit(1);
}

if (!steps.length && !hasRust && !preflight.length) {
  const summary = {
    schemaVersion: 1,
    ok: true,
    scope: "docs-only",
    durationMs: 0,
    steps: [],
    note: "只有文档改动。请改为运行: node scripts/workflow/state.mjs check",
  };
  await mkdir(ARTIFACT_DIR, { recursive: true });
  await writeFile(path.join(ARTIFACT_DIR, "ci-fast-latest.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  process.exit(0);
}

const startedAt = Date.now();
const parallelResults = await Promise.all(steps.map(runStep));
const results = [...preflightResults, ...parallelResults];

if (hasRust) {
  results.push(await runStep({ name: "rust:offline-check", command: plan.commands.rustCheck }));
}

const summary = {
  schemaVersion: 1,
  ok: results.every((step) => step.status === "passed"),
  scope: { web: plan.changed.web.length, rust: plan.changed.rust.length, tests: plan.changed.tests.length },
  durationMs: Date.now() - startedAt,
  steps: results,
  note: "快速层通过不等于 freeze 通过；freeze 前仍需 pnpm ci:quick 及 QA 定向验证。",
};
await mkdir(ARTIFACT_DIR, { recursive: true });
await writeFile(path.join(ARTIFACT_DIR, "ci-fast-latest.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
process.stdout.write(`\n${JSON.stringify(summary, null, 2)}\n`);
if (!summary.ok) process.exitCode = 1;
