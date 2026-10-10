import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { classifyStepResult, summarySucceeded } from "./ci-step-result.mjs";

const scriptsDirectory = path.dirname(fileURLToPath(import.meta.url));

test("ordinary exit-code steps retain passed and failed semantics", () => {
  const passed = classifyStepResult({ exitCode: 0 });
  const failed = classifyStepResult({ exitCode: 2 });
  assert.equal(passed.status, "passed");
  assert.equal(passed.accepted, true);
  assert.equal(failed.status, "failed");
  assert.equal(failed.accepted, false);
});

test("a successful P4D protocol result is passed", () => {
  const result = classifyStepResult({
    exitCode: 0,
    protocol: "p4d-e2e-v1",
    protocolResult: {
      schemaVersion: 1,
      suite: "localhost-p4d-e2e",
      status: "passed",
      reason: "completed",
    },
  });
  assert.equal(result.status, "passed");
  assert.equal(result.accepted, true);
});

test("P4D skip is visible and only accepted when optional", () => {
  const protocolResult = {
    schemaVersion: 1,
    suite: "localhost-p4d-e2e",
    status: "skipped",
    reason: "fixture-prerequisite-missing",
  };
  const optional = classifyStepResult({
    exitCode: 0,
    required: false,
    protocol: "p4d-e2e-v1",
    protocolResult,
  });
  const required = classifyStepResult({
    exitCode: 0,
    required: true,
    protocol: "p4d-e2e-v1",
    protocolResult,
  });
  assert.equal(optional.status, "skipped");
  assert.equal(optional.accepted, true);
  assert.equal(required.status, "skipped");
  assert.equal(required.accepted, false);
  assert.equal(summarySucceeded([required], 1), false);
});

async function runMissingFixtureProbe(required) {
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "p4deck-ci-protocol-"),
  );
  try {
    const temporaryScripts = path.join(temporaryRoot, "scripts");
    await mkdir(temporaryScripts, { recursive: true });
    const copiedScript = path.join(temporaryScripts, "test-p4d-e2e.ps1");
    const resultFile = path.join(temporaryRoot, "result.json");
    await copyFile(
      path.join(scriptsDirectory, "test-p4d-e2e.ps1"),
      copiedScript,
    );
    const env = { ...process.env };
    delete env.P4DECK_CI_RUN_P4D;
    delete env.P4DECK_E2E_RESULT_FILE;
    if (required) env.P4DECK_CI_RUN_P4D = "1";
    const exitCode = await new Promise((resolve, reject) => {
      const child = spawn(
        "powershell.exe",
        [
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          copiedScript,
          "-ResultFile",
          resultFile,
        ],
        { env, shell: false, stdio: "ignore" },
      );
      child.once("error", reject);
      child.once("exit", (code) => resolve(code));
    });
    return {
      exitCode,
      result: JSON.parse(await readFile(resultFile, "utf8")),
    };
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

test(
  "missing fixture is a machine-readable optional skip",
  { skip: process.platform !== "win32" },
  async () => {
    const probe = await runMissingFixtureProbe(false);
    assert.equal(probe.exitCode, 0);
    assert.equal(probe.result.status, "skipped");
    assert.equal(probe.result.required, false);
    assert.ok(probe.result.missing.includes("p4"));
    assert.ok(probe.result.missing.includes("p4d"));
  },
);

test(
  "missing fixture fails closed when explicitly required",
  { skip: process.platform !== "win32" },
  async () => {
    const probe = await runMissingFixtureProbe(true);
    assert.notEqual(probe.exitCode, 0);
    assert.equal(probe.result.status, "failed");
    assert.equal(probe.result.required, true);
    assert.equal(probe.result.reason, "fixture-prerequisite-missing");
  },
);
