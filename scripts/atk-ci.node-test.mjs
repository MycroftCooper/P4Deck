import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseArgs,
  publisherArgs,
  resolvePnpm,
  releasePreflight,
} from "./atk-ci.mjs";

test("publishing is disabled by default and only literal true enables it", () => {
  const preview = parseArgs(["--task", "release"]);
  assert.equal(preview.realPublish, false);
  assert.deepEqual(publisherArgs(preview), [
    "scripts/publish-update.mjs",
    "--skip-publish",
  ]);
  const real = parseArgs(["--task", "release", "--real-publish", "true"]);
  assert.deepEqual(publisherArgs(real), ["scripts/publish-update.mjs"]);
  for (const value of ["1", "yes", "TRUE", "false && echo unsafe"])
    assert.throws(() =>
      parseArgs(["--task", "release", "--real-publish", value]),
    );
  assert.throws(() =>
    parseArgs([
      "--task",
      "release",
      "--real-publish",
      "true",
      "--allow-dirty",
      "true",
    ]),
  );
});
test("local-only dirty opt-in never bypasses the real-publish clean-tree requirement", () => {
  const options = parseArgs([
    "--task",
    "release",
    "--real-publish",
    "false",
    "--allow-dirty",
    "true",
  ]);
  assert.deepEqual(publisherArgs(options), [
    "scripts/publish-update.mjs",
    "--skip-publish",
    "--allow-dirty",
  ]);
  assert.throws(() => parseArgs(["--task", "smoke", "--unknown", "true"]));
  assert.throws(() => parseArgs(["--task", "smoke", "--task", "release"]));
});
test("pnpm resolution selects a JS entry without invoking a .cmd shell", () => {
  assert.throws(() => resolvePnpm({ PATH: "" }));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "p4deck-atk-pnpm-"));
  const entry = path.join(root, "node_modules/pnpm/bin/pnpm.mjs");
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  fs.writeFileSync(entry, "");
  try {
    assert.equal(resolvePnpm({ PATH: root }), entry);
  } finally {
    if (path.dirname(root) !== os.tmpdir())
      throw new Error("Unexpected test cleanup path");
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test("missing current-version release notes is a failed precondition, never an uploaded release", async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const result = await releasePreflight(
    root,
    { realPublish: false, allowDirty: true },
    async () => ({ code: 0 }),
  );
  const notes = path.join(
    root,
    "ForAIDoc/PM/releases",
    "v" + result.version + ".md",
  );
  assert.equal(
    result.checks.find((check) => check.id === "release-notes").status,
    fs.existsSync(notes) ? "passed" : "failed",
  );
  assert.equal(
    result.checks.some((check) => check.id === "remote-tag"),
    false,
  );
});
