import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { classifyStepResult, summarySucceeded } from "./ci-step-result.mjs";

const mode = process.argv[2] ?? "quick";
if (!new Set(["quick", "local"]).has(mode)) {
  process.stderr.write("usage: node scripts/ci-runner.mjs <quick|local>\n");
  process.exit(2);
}

if (!process.env.npm_execpath) {
  process.stderr.write(
    "Run this entry point through pnpm ci:quick or pnpm ci:local.\n",
  );
  process.exit(2);
}
const packageManager = [process.execPath, [process.env.npm_execpath]];
const pnpmStep = (name, script) => ({
  name,
  command: packageManager[0],
  args: [...packageManager[1], script],
});
const childEnvironment = { ...process.env };
for (const secretName of [
  "P4PASSWD",
  "TAURI_SIGNING_PRIVATE_KEY",
  "TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
]) {
  delete childEnvironment[secretName];
}
const steps = [
  {
    name: "frontend-contracts",
    command: process.execPath,
    args: ["scripts/validate-frontend-contracts.mjs"],
  },
  {
    name: "validate-ci",
    command: process.execPath,
    args: ["scripts/validate-ci.mjs"],
  },
  {
    name: "release-config-tests",
    command: process.execPath,
    args: ["--test", "scripts/release-config.test.mjs"],
  },
  {
    name: "ci-step-result-tests",
    command: process.execPath,
    args: ["--test", "scripts/ci-step-result.test.mjs"],
  },
  {
    name: "theme-contrast-tests",
    command: process.execPath,
    args: ["--test", "scripts/theme-contrast.test.mjs"],
  },
  pnpmStep("web-format", "format:check"),
  {
    name: "rust-format",
    command: "cargo",
    args: ["fmt", "--manifest-path", "src-tauri/Cargo.toml", "--", "--check"],
  },
  pnpmStep("web-check", "check:web"),
  {
    name: "rust-check",
    command: "cargo",
    args: ["check", "--manifest-path", "src-tauri/Cargo.toml", "--all-targets"],
  },
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

if (mode === "local") {
  steps.push(
    pnpmStep("web-build", "build"),
    pnpmStep("web-performance", "test:perf"),
    pnpmStep("backend-performance", "test:perf:backend"),
  );
  if (process.env.P4DECK_CI_RUN_P4D === "1") {
    if (process.platform !== "win32") {
      process.stderr.write(
        "P4DECK_CI_RUN_P4D=1 is supported only by the Windows local runner.\n",
      );
      process.exit(2);
    }
    steps.push({
      ...pnpmStep("localhost-p4d-e2e", "test:e2e:p4d:win"),
      required: true,
      protocol: "p4d-e2e-v1",
      resultFile: path.resolve("artifacts", "ci", "p4d-e2e-latest.json"),
    });
  }
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
