// Local CI runner.
//
// Three modes:
//   quick  - contracts/versions/format/typecheck/vitest + rustfmt/clippy/cargo test
//   local  - quick base groups, then browser/desktop builds, bundle audit and perf gates
//   bundle - version consistency + desktop build + mock-backend audit (~10s)
//
// Designed for AI-driven loops: child output is captured to a per-step log and
// only a compact result/digest is printed, failures do not abort the run by
// default (quick/bundle), web and rust groups run in parallel, and every step
// has a timeout so a stuck process cannot stall the agent.
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { classifyStepResult, summarySucceeded } from "./ci-step-result.mjs";

const MODES = ["quick", "local", "bundle"];
const DEFAULTS = {
  quick: { continueOnFailure: true, parallel: true },
  local: { continueOnFailure: false, parallel: true },
  bundle: { continueOnFailure: false, parallel: false },
};

const usage = () => {
  process.stderr.write(
    [
      "usage: node scripts/ci-runner.mjs <quick|local|bundle> [options]",
      "  --continue | --fail-fast   keep going after failures (quick default) / stop (local default)",
      "  --verbose                  stream full child output instead of capturing it",
      "  --serial | --parallel      disable/enable web+rust group parallelism",
      "  --timeout-ms <ms>          per-step timeout (default 900000)",
      "  --files <a,b>              changed files; docs-only input skips code gates",
      "  --json                     only print the compact JSON summary",
    ].join("\n") + "\n",
  );
};

function parseArguments(argv) {
  const options = {};
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--continue") options.continueOnFailure = true;
    else if (argument === "--fail-fast") options.continueOnFailure = false;
    else if (argument === "--verbose") options.verbose = true;
    else if (argument === "--json") options.json = true;
    else if (argument === "--serial") options.parallel = false;
    else if (argument === "--parallel") options.parallel = true;
    else if (argument === "--timeout-ms") {
      options.timeoutMs = Number(argv[(index += 1)]);
    } else if (argument.startsWith("--timeout-ms=")) {
      options.timeoutMs = Number(argument.split("=")[1]);
    } else if (argument === "--files") {
      options.files = argv[(index += 1)];
    } else if (argument.startsWith("--files=")) {
      options.files = argument.slice("--files=".length);
    } else if (argument.startsWith("-")) {
      process.stderr.write(`unknown option: ${argument}\n`);
      usage();
      process.exit(2);
    } else {
      positional.push(argument);
    }
  }
  return { options, positional };
}

const { options, positional } = parseArguments(process.argv.slice(2));
const mode = positional[0] ?? "quick";
if (!MODES.includes(mode)) {
  process.stderr.write(`unknown mode: ${mode}\n`);
  usage();
  process.exit(2);
}

const settings = {
  continueOnFailure:
    options.continueOnFailure ?? DEFAULTS[mode].continueOnFailure,
  parallel: options.parallel ?? DEFAULTS[mode].parallel,
  verbose: options.verbose ?? false,
  json: options.json ?? false,
  timeoutMs: options.timeoutMs ?? 900000,
};
if (!Number.isFinite(settings.timeoutMs) || settings.timeoutMs <= 0) {
  process.stderr.write("--timeout-ms must be a positive number\n");
  process.exit(2);
}

const summaryFile = path.resolve("artifacts", "ci", `${mode}-latest.json`);
const logsDir = path.resolve("artifacts", "ci", "logs", mode);
const showProgress = Boolean(process.stdout.isTTY) && !settings.json;

function writeSummary(summary) {
  mkdirSync(path.dirname(summaryFile), { recursive: true });
  writeFileSync(summaryFile, `${JSON.stringify(summary, null, 2)}\n`);
}

function finish(summary, compact) {
  writeSummary(summary);
  process.stdout.write(`${JSON.stringify(compact)}\n`);
  if (!summary.ok) process.exitCode = 1;
}

// --files docs-only shortcut: editing prose should not trigger code gates.
if (options.files) {
  const files = options.files
    .split(",")
    .map((file) => file.trim())
    .filter(Boolean);
  const docsOnly = files.every(
    (file) =>
      /\.(md|mdx|txt)$/i.test(file) ||
      file.replace(/\\/g, "/").startsWith("ForAIDoc/"),
  );
  if (files.length > 0 && docsOnly) {
    const summary = {
      schemaVersion: 1,
      mode,
      scope: "docs-only",
      ok: true,
      durationMs: 0,
      files,
      results: [],
    };
    finish(summary, {
      ok: true,
      mode,
      scope: "docs-only",
      files: files.length,
    });
    process.exit(0);
  }
}

if (!process.env.npm_execpath) {
  process.stderr.write(
    "Run this entry point through pnpm ci:quick / ci:local / ci:bundle.\n",
  );
  process.exit(2);
}
const packageManager = [process.execPath, [process.env.npm_execpath]];

const pnpmStep = (name, kind, script, group) => ({
  name,
  kind,
  group,
  command: packageManager[0],
  args: [...packageManager[1], script],
});
const nodeStep = (name, kind, script, args = [], group = "web") => ({
  name,
  kind,
  group,
  command: process.execPath,
  args: [script, ...args],
});

const childEnvironment = { ...process.env };
for (const secretName of [
  "P4PASSWD",
  "TAURI_SIGNING_PRIVATE_KEY",
  "TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
]) {
  delete childEnvironment[secretName];
}
delete childEnvironment.P4DECK_E2E_RESULT_FILE;

const webSteps = [
  nodeStep(
    "frontend-contracts",
    "contracts",
    "scripts/validate-frontend-contracts.mjs",
  ),
  nodeStep("ipc-surface", "contracts", "scripts/validate-ipc-surface.mjs"),
  nodeStep("version-consistency", "versions", "scripts/validate-versions.mjs"),
  nodeStep("changelog", "versions", "scripts/validate-changelog.mjs"),
  nodeStep("i18n-literals", "i18n", "scripts/validate-no-cjk-literals.mjs"),
  nodeStep("i18n-key-quality", "i18n", "scripts/validate-i18n-key-quality.mjs"),
  nodeStep("ci-step-result-tests", "node-test", "--test", [
    "scripts/ci-step-result.test.mjs",
  ]),
  nodeStep("version-tests", "node-test", "--test", [
    "scripts/validate-versions.test.mjs",
  ]),
  nodeStep("changelog-tests", "node-test", "--test", [
    "scripts/validate-changelog.test.mjs",
  ]),
  nodeStep("release-notes-tests", "node-test", "--test", [
    "scripts/release-notes.test.mjs",
  ]),
  nodeStep("ipc-surface-tests", "node-test", "--test", [
    "scripts/validate-ipc-surface.test.mjs",
  ]),
  nodeStep("theme-contrast-tests", "node-test", "--test", [
    "scripts/theme-contrast.test.mjs",
  ]),
  pnpmStep("web-format", "prettier", "format:check", "web"),
  pnpmStep("web-check", "tsc", "check:web", "web"),
  pnpmStep("web-test", "vitest", "test:web:ci", "web"),
];

const rustSteps = [
  {
    name: "rust-format",
    kind: "rustfmt",
    group: "rust",
    command: "cargo",
    args: ["fmt", "--manifest-path", "src-tauri/Cargo.toml", "--", "--check"],
  },
  {
    name: "rust-clippy",
    kind: "clippy",
    group: "rust",
    command: "cargo",
    args: [
      "clippy",
      "--manifest-path",
      "src-tauri/Cargo.toml",
      "--all-targets",
      "--",
      "-D",
      "warnings",
    ],
  },
  {
    name: "rust-test",
    kind: "cargo-test",
    group: "rust",
    command: "cargo",
    args: ["test", "--quiet", "--manifest-path", "src-tauri/Cargo.toml"],
  },
];

const basePlan = [...webSteps, ...rustSteps];

// Workflow state check: only when the state store exists (candidate copies may not
// include ForAIDoc and must not turn red because of that).
if (
  existsSync("ForAIDoc/PM/工作流/state.json") &&
  existsSync("scripts/workflow/state.mjs")
) {
  basePlan.splice(
    2,
    0,
    nodeStep("workflow-state", "node-test", "scripts/workflow/state.mjs", [
      "check",
    ]),
  );
}

const p4dStep = {
  ...pnpmStep("localhost-p4d-e2e", "p4d", "test:e2e:p4d:win", "serial"),
  required: true,
  protocol: "p4d-e2e-v1",
  resultFile: path.resolve("artifacts", "ci", "p4d-e2e-latest.json"),
};

let plan = basePlan;
if (mode === "local") {
  plan = [
    ...basePlan,
    pnpmStep("web-build", "build", "build", "serial"),
    pnpmStep("desktop-build", "build", "build:desktop", "serial"),
    nodeStep(
      "desktop-bundle-audit",
      "audit",
      "scripts/verify-desktop-bundle.mjs",
      [],
      "serial",
    ),
    pnpmStep("web-performance", "perf", "test:perf", "serial"),
    pnpmStep("backend-performance", "perf", "test:perf:backend", "serial"),
  ];
  if (process.env.P4DECK_CI_RUN_P4D === "1") {
    if (process.platform !== "win32") {
      process.stderr.write(
        "P4DECK_CI_RUN_P4D=1 is supported only by the Windows local runner.\n",
      );
      process.exit(2);
    }
    childEnvironment.P4DECK_CI_RUN_P4D = "1";
    plan.push(p4dStep);
  }
} else if (mode === "bundle") {
  plan = [
    nodeStep(
      "version-consistency",
      "versions",
      "scripts/validate-versions.mjs",
      [],
      "serial",
    ),
    pnpmStep("desktop-build", "build", "build:desktop", "serial"),
    nodeStep(
      "desktop-bundle-audit",
      "audit",
      "scripts/verify-desktop-bundle.mjs",
      [],
      "serial",
    ),
  ];
}

const start = Date.now();
if (!settings.verbose) {
  rmSync(logsDir, { recursive: true, force: true });
  mkdirSync(logsDir, { recursive: true });
}

const results = new Array(plan.length);

function killTree(child) {
  if (!child.pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
    });
    return;
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // already gone
    }
  }
}

function spawnStep(step) {
  return new Promise((resolve) => {
    const chunks = [];
    const child = spawn(step.command, step.args, {
      stdio: settings.verbose ? "inherit" : ["ignore", "pipe", "pipe"],
      env: {
        ...childEnvironment,
        ...(step.resultFile ? { P4DECK_E2E_RESULT_FILE: step.resultFile } : {}),
      },
      detached: process.platform !== "win32",
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, settings.timeoutMs);
    if (!settings.verbose) {
      child.stdout.on("data", (chunk) => chunks.push(chunk));
      child.stderr.on("data", (chunk) => chunks.push(chunk));
    }
    child.once("error", () => {
      clearTimeout(timer);
      resolve({
        exitCode: 127,
        output: Buffer.concat(chunks).toString("utf8"),
        timedOut,
      });
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({
        exitCode: timedOut ? 124 : signal ? 128 : (code ?? 1),
        output: Buffer.concat(chunks).toString("utf8"),
        timedOut,
      });
    });
  });
}

function clip(text, max = 240) {
  const singleLine = text.replace(/\s+/g, " ").trim();
  return singleLine.length > max ? `${singleLine.slice(0, max)}…` : singleLine;
}

function relativePath(file) {
  const cwd = process.cwd();
  return file.startsWith(cwd) ? path.relative(cwd, file) : file;
}

function digestFailure(kind, output) {
  const normalized = output.replace(/\r/g, "");
  const lines = normalized.split("\n");
  const compact = (items) => items.slice(0, 12).map((line) => clip(line));

  if (kind === "rustfmt") {
    const files = [
      ...new Set(
        [...normalized.matchAll(/^Diff in (.+?):\d+:/gm)].map((match) =>
          relativePath(match[1].replace(/^\\\\\?\\/, "")),
        ),
      ),
    ];
    return compact([
      `未格式化文件 ${files.length} 个: ${files.slice(0, 8).join(", ")}${files.length > 8 ? " …" : ""}`,
    ]);
  }
  if (kind === "prettier") {
    const files = [
      ...new Set(
        lines
          .filter(
            (line) =>
              line.startsWith("[warn] ") &&
              !line.includes("Code style issues found"),
          )
          .map((line) => relativePath(line.slice("[warn] ".length).trim())),
      ),
    ];
    return compact([
      `未格式化文件 ${files.length} 个: ${files.slice(0, 8).join(", ")}${files.length > 8 ? " …" : ""}`,
    ]);
  }
  if (kind === "contracts") {
    const relevant = [
      ...new Set(
        lines.filter((line) =>
          /missing:|extra:|Error:|Cannot find module|error TS/.test(line),
        ),
      ),
    ];
    return compact(relevant.length > 0 ? relevant : lines.slice(-8));
  }
  if (kind === "clippy") {
    const errors = [
      ...new Set(
        [...normalized.matchAll(/^error(?:\[[^\]]+\])?:\s+(.+)$/gm)]
          .map((match) => match[1].trim())
          .filter((line) => !/could not compile/.test(line)),
      ),
    ];
    const compileLines = [
      ...new Set(
        lines
          .filter((line) => /could not compile/.test(line))
          .map((line) => clip(line)),
      ),
    ];
    return compact([...errors.slice(0, 8), ...compileLines]);
  }
  if (kind === "cargo-test") {
    const names = [];
    let inFailures = false;
    for (const line of lines) {
      if (/^failures:$/.test(line.trim())) {
        inFailures = true;
        continue;
      }
      if (inFailures) {
        if (line.trim() === "") break;
        names.push(line.trim());
      }
    }
    const summaryLine = [...lines]
      .reverse()
      .find((line) => /^test result:/.test(line.trim()));
    return compact(
      [
        summaryLine ? clip(summaryLine) : "",
        names.length > 0
          ? `失败测试 ${names.length} 个: ${names.slice(0, 8).join(", ")}`
          : "",
      ].filter(Boolean),
    );
  }
  if (kind === "vitest") {
    const failures = [
      ...new Set(
        [...normalized.matchAll(/^\s*FAIL\s+(.+)$/gm)].map((match) =>
          match[1].trim(),
        ),
      ),
    ];
    const stats = lines.filter((line) => /^\s*(Test Files|Tests)\s/.test(line));
    return compact([
      ...stats.slice(-2),
      `失败用例文件 ${failures.length} 个: ${failures.slice(0, 5).join(" | ")}`,
    ]);
  }
  return compact(lines.filter((line) => line.trim()).slice(-12));
}

function formatDuration(durationMs) {
  return durationMs >= 1000
    ? `${(durationMs / 1000).toFixed(1)}s`
    : `${durationMs}ms`;
}

function reportResult(result) {
  if (settings.json) return;
  const mark = result.accepted ? "✓" : "✗";
  const suffix = result.timedOut
    ? " timeout"
    : result.exitCode === 0
      ? ""
      : ` exit=${result.exitCode}`;
  process.stdout.write(
    `${mark} ${result.name} ${formatDuration(result.durationMs)}${suffix}\n`,
  );
  if (!result.accepted && !settings.verbose) {
    for (const line of result.digest) {
      process.stdout.write(`  ${line}\n`);
    }
    if (result.logPath) {
      process.stdout.write(`  日志: ${result.logPath}\n`);
    }
  }
}

async function runStep(step, index) {
  if (showProgress) process.stdout.write(`» ${step.name}\n`);
  const startedAt = new Date().toISOString();
  const started = Date.now();
  const raw = await spawnStep(step);
  const durationMs = Date.now() - started;

  let logPath;
  if (!settings.verbose) {
    const logFile = path.join(
      logsDir,
      `${step.name.replace(/[^a-zA-Z0-9._-]+/g, "_")}.log`,
    );
    writeFileSync(logFile, raw.output);
    logPath = path.relative(process.cwd(), logFile);
  }

  let protocolResult;
  if (step.resultFile) {
    try {
      protocolResult = JSON.parse(readFileSync(step.resultFile, "utf8"));
    } catch {
      protocolResult = undefined;
    }
  }

  const classified = classifyStepResult({
    exitCode: raw.exitCode,
    required: step.required ?? true,
    protocol: step.protocol ?? "exit-code",
    protocolResult,
  });
  if (raw.timedOut) {
    classified.status = "failed";
    classified.accepted = false;
    classified.reason = "timeout";
  }

  const result = {
    name: step.name,
    kind: step.kind,
    startedAt,
    durationMs,
    logPath,
    digest: raw.timedOut
      ? [`步骤超时（${settings.timeoutMs}ms），已终止进程树`]
      : classified.accepted
        ? []
        : digestFailure(step.kind, raw.output),
    ...classified,
    timedOut: raw.timedOut,
  };
  results[index] = result;
  reportResult(result);
  return result;
}

async function runSequential(items) {
  for (const { step, index } of items) {
    const result = await runStep(step, index);
    if (!result.accepted && !settings.continueOnFailure) return;
  }
}

const indexed = plan.map((step, index) => ({ step, index }));
const base = indexed.filter(({ step }) => step.group !== "serial");
const tail = indexed.filter(({ step }) => step.group === "serial");

if (settings.parallel && base.length > 0) {
  const groups = new Map();
  for (const item of base) {
    const group = item.step.group;
    groups.set(group, [...(groups.get(group) ?? []), item]);
  }
  await Promise.all([...groups.values()].map(runSequential));
} else {
  await runSequential(base);
}

const failedBeforeTail = results.some((result) => result && !result.accepted);
if (!(failedBeforeTail && !settings.continueOnFailure)) {
  await runSequential(tail);
}

const completed = results.filter(Boolean);
const summary = {
  schemaVersion: 1,
  mode,
  platform: process.platform,
  architecture: process.arch,
  ok: summarySucceeded(completed, plan.length),
  durationMs: Date.now() - start,
  failed: completed
    .filter((result) => !result.accepted)
    .map((result) => result.name),
  options: {
    continueOnFailure: settings.continueOnFailure,
    parallel: settings.parallel,
    verbose: settings.verbose,
    timeoutMs: settings.timeoutMs,
  },
  results: completed,
};
finish(summary, {
  ok: summary.ok,
  mode,
  durationMs: summary.durationMs,
  failed: summary.failed,
  summary: path.relative(process.cwd(), summaryFile),
});
