import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { classifyStepResult, summarySucceeded } from "./ci-step-result.mjs";

const MODES = ["quick", "local", "e2e"];
const mode = process.argv[2] ?? "quick";
if (!MODES.includes(mode)) {
  process.stderr.write("usage: node scripts/ci-runner.mjs <quick|local|e2e>\n");
  process.exit(2);
}

if (!process.env.npm_execpath) {
  process.stderr.write(
    "Run this entry point through pnpm ci:quick / ci:local / ci:e2e.\n",
  );
  process.exit(2);
}
const packageManager = [process.execPath, [process.env.npm_execpath]];
const pnpmStep = (name, script) => ({
  name,
  command: packageManager[0],
  args: [...packageManager[1], script],
});
const nodeStep = (name, script, args = []) => ({
  name,
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

const baseSteps = [
  nodeStep("frontend-contracts", "scripts/validate-frontend-contracts.mjs"),
  nodeStep("validate-ci", "scripts/validate-ci.mjs"),
  nodeStep("version-consistency", "scripts/validate-versions.mjs"),
  nodeStep("ci-step-result-tests", "--test", [
    "scripts/ci-step-result.test.mjs",
  ]),
  nodeStep("version-tests", "--test", ["scripts/validate-versions.test.mjs"]),
  nodeStep("theme-contrast-tests", "--test", [
    "scripts/theme-contrast.test.mjs",
  ]),
  pnpmStep("web-format", "format:check"),
  {
    name: "rust-format",
    command: "cargo",
    args: ["fmt", "--manifest-path", "src-tauri/Cargo.toml", "--", "--check"],
  },
  pnpmStep("web-check", "check:web"),
  {
    name: "rust-clippy",
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
  pnpmStep("web-test", "test:web"),
  {
    name: "rust-test",
    command: "cargo",
    args: ["test", "--manifest-path", "src-tauri/Cargo.toml"],
  },
];

// 工作流状态库校验：只有在存在状态库与脚本时才跑（候选白名单副本通常不含 ForAIDoc，不应因此变红）。
if (existsSync("ForAIDoc/PM/工作流/state.json") && existsSync("scripts/workflow/state.mjs")) {
  baseSteps.splice(2, 0, nodeStep("workflow-state", "scripts/workflow/state.mjs", ["check"]));
}

const p4dStep = {
  ...pnpmStep("localhost-p4d-e2e", "test:e2e:p4d:win"),
  required: true,
  protocol: "p4d-e2e-v1",
  resultFile: path.resolve("artifacts", "ci", "p4d-e2e-latest.json"),
};

let steps = [];
if (mode === "quick") {
  steps = baseSteps;
} else if (mode === "local") {
  steps = [
    ...baseSteps,
    pnpmStep("web-build", "build"),
    pnpmStep("desktop-build", "build:desktop"),
    nodeStep("desktop-bundle-audit", "scripts/verify-desktop-bundle.mjs"),
    pnpmStep("web-performance", "test:perf"),
    pnpmStep("backend-performance", "test:perf:backend"),
  ];
  if (process.env.P4DECK_CI_RUN_P4D === "1") {
    if (process.platform !== "win32") {
      process.stderr.write(
        "P4DECK_CI_RUN_P4D=1 is supported only by the Windows local runner.\n",
      );
      process.exit(2);
    }
    childEnvironment.P4DECK_CI_RUN_P4D = "1";
    steps.push(p4dStep);
  }
} else {
  // Dedicated CI entry point: only the isolated localhost p4d suite, still
  // reported through the shared JSON result protocol.
  if (process.platform !== "win32") {
    process.stderr.write("ci:e2e is supported only on the Windows runner.\n");
    process.exit(2);
  }
  childEnvironment.P4DECK_CI_RUN_P4D = "1";
  steps = [p4dStep];
}

const results = [];
for (const step of steps) {
  const { name, command, args } = step;
  if (step.resultFile) {
    await rm(step.resultFile, { force: true });
  }
  const startedAt = new Date().toISOString();
  const start = performance.now();
  const exitCode = await new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      shell: false,
      env: {
        ...childEnvironment,
        ...(step.resultFile ? { P4DECK_E2E_RESULT_FILE: step.resultFile } : {}),
      },
    });
    child.once("error", () => resolve(127));
    child.once("exit", (code, signal) => resolve(signal ? 128 : (code ?? 1)));
  });
  let protocolResult;
  if (step.resultFile) {
    try {
      protocolResult = JSON.parse(await readFile(step.resultFile, "utf8"));
    } catch {
      protocolResult = undefined;
    }
  }
  const classified = classifyStepResult({
    exitCode,
    required: step.required ?? true,
    protocol: step.protocol ?? "exit-code",
    protocolResult,
  });
  results.push({
    name,
    startedAt,
    durationMs: Math.round(performance.now() - start),
    ...classified,
  });
  if (!classified.accepted) break;
}

const summary = {
  schemaVersion: 1,
  mode,
  platform: process.platform,
  architecture: process.arch,
  ok: summarySucceeded(results, steps.length),
  results,
};
await mkdir(path.resolve("artifacts", "ci"), { recursive: true });
await writeFile(
  path.resolve("artifacts", "ci", `${mode}-latest.json`),
  `${JSON.stringify(summary, null, 2)}\n`,
);
process.stdout.write(`${JSON.stringify(summary)}\n`);
if (!summary.ok) process.exitCode = 1;
