import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

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
const pnpmStep = (name, script) => [
  name,
  packageManager[0],
  [...packageManager[1], script],
];
const childEnvironment = { ...process.env };
for (const secretName of [
  "P4PASSWD",
  "TAURI_SIGNING_PRIVATE_KEY",
  "TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
]) {
  delete childEnvironment[secretName];
}
const steps = [
  ["validate-ci", process.execPath, ["scripts/validate-ci.mjs"]],
  [
    "release-config-tests",
    process.execPath,
    ["--test", "scripts/release-config.test.mjs"],
  ],
  pnpmStep("web-format", "format:check"),
  [
    "rust-format",
    "cargo",
    ["fmt", "--manifest-path", "src-tauri/Cargo.toml", "--", "--check"],
  ],
  pnpmStep("web-check", "check:web"),
  [
    "rust-check",
    "cargo",
    ["check", "--manifest-path", "src-tauri/Cargo.toml", "--all-targets"],
  ],
  [
    "rust-clippy",
    "cargo",
    [
      "clippy",
      "--manifest-path",
      "src-tauri/Cargo.toml",
      "--all-targets",
      "--",
      "-D",
      "warnings",
    ],
  ],
  pnpmStep("web-test", "test:web"),
  ["rust-test", "cargo", ["test", "--manifest-path", "src-tauri/Cargo.toml"]],
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
    steps.push(pnpmStep("localhost-p4d-e2e", "test:e2e:p4d:win"));
  }
}

const results = [];
for (const [name, command, args] of steps) {
  const startedAt = new Date().toISOString();
  const start = performance.now();
  const exitCode = await new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      shell: false,
      env: childEnvironment,
    });
    child.once("error", () => resolve(127));
    child.once("exit", (code, signal) => resolve(signal ? 128 : (code ?? 1)));
  });
  results.push({
    name,
    startedAt,
    durationMs: Math.round(performance.now() - start),
    exitCode,
  });
  if (exitCode !== 0) break;
}

const summary = {
  schemaVersion: 1,
  mode,
  platform: process.platform,
  architecture: process.arch,
  ok:
    results.length === steps.length &&
    results.every((result) => result.exitCode === 0),
  results,
};
await mkdir(path.resolve("artifacts", "ci"), { recursive: true });
await writeFile(
  path.resolve("artifacts", "ci", `${mode}-latest.json`),
  `${JSON.stringify(summary, null, 2)}\n`,
);
process.stdout.write(`${JSON.stringify(summary)}\n`);
if (!summary.ok) process.exitCode = 1;
