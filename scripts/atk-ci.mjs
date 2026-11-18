#!/usr/bin/env node
// Project adapter for ATK. CI definitions live in .atk/automations.
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
export function parseArgs(argv) {
  const options = { task: "", realPublish: false, allowDirty: false };
  const keys = {
    "--task": "task",
    "--real-publish": "realPublish",
    "--allow-dirty": "allowDirty",
  };
  const seen = new Set();
  for (let i = 0; i < argv.length; i++) {
    const key = keys[argv[i]],
      value = argv[++i];
    if (!key || value === undefined || seen.has(key))
      throw new Error(
        "Use --task <smoke|release-preflight|release-check|release> and explicit boolean options",
      );
    seen.add(key);
    if (key === "task") options.task = value;
    else {
      if (!["true", "false"].includes(value))
        throw new Error(key + " must be true or false");
      options[key] = value === "true";
    }
  }
  if (
    !["smoke", "release-preflight", "release-check", "release"].includes(
      options.task,
    )
  )
    throw new Error("Unknown task");
  if (options.realPublish && options.allowDirty)
    throw new Error(
      "Real publishing always requires a clean worktree; disable allowDirty",
    );
  return options;
}
export function publisherArgs(options) {
  const args = ["scripts/publish-update.mjs"];
  if (!options.realPublish) args.push("--skip-publish");
  if (options.allowDirty && !options.realPublish) args.push("--allow-dirty");
  return args;
}
export function resolvePnpm(env = process.env) {
  const candidates = [];
  if (env.npm_execpath && /pnpm|corepack/i.test(env.npm_execpath))
    candidates.push(env.npm_execpath);
  for (const dir of (env.PATH ?? env.Path ?? "")
    .split(path.delimiter)
    .filter(Boolean)) {
    for (const file of [
      "node_modules/pnpm/bin/pnpm.mjs",
      "node_modules/pnpm/bin/pnpm.cjs",
      "node_modules/corepack/dist/pnpm.js",
    ])
      candidates.push(path.join(dir, file));
  }
  if (env.PNPM_HOME)
    for (const file of [
      "bin/node_modules/pnpm/bin/pnpm.mjs",
      "node_modules/pnpm/bin/pnpm.cjs",
    ])
      candidates.push(path.join(env.PNPM_HOME, file));
  const found = candidates.find(
    (file) => fs.existsSync(file) && /\.(?:[cm]?js)$/i.test(file),
  );
  if (!found)
    throw new Error(
      "pnpm JS entry not found. Install the package.json pnpm version and add it to PATH or set PNPM_HOME.",
    );
  return found;
}
function emit(type, data = {}) {
  console.log("::atk::" + JSON.stringify({ schemaVersion: 1, type, ...data }));
}
function runNode(root, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: root,
      env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let partial = "",
      lastJson;
    child.stdout.setEncoding("utf8").on("data", (text) => {
      process.stdout.write(text);
      partial += text;
      const lines = partial.split(/\r?\n/);
      partial = lines.pop();
      for (const line of lines) {
        try {
          lastJson = JSON.parse(line);
        } catch {
          /* Human-readable output is retained. */
        }
      }
      if (partial.length > 1024 * 1024) partial = "";
    });
    child.stderr.on("data", (text) => process.stderr.write(text));
    child.once("error", reject);
    child.once("close", (code) => {
      if (partial) {
        try {
          lastJson = JSON.parse(partial);
        } catch {}
      }
      resolve({ code, summary: lastJson });
    });
  });
}
function git(root, args) {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.error || result.status !== 0)
    throw new Error("Git release precondition failed: " + args.join(" "));
  return result.stdout.trim();
}
export async function releasePreflight(root, options, execute = runNode) {
  const checks = [];
  const version = JSON.parse(
    fs.readFileSync(path.join(root, "package.json"), "utf8"),
  ).version;
  const versionCheck = await execute(
    root,
    ["scripts/validate-versions.mjs"],
    process.env,
  );
  checks.push({
    id: "versions",
    name: "版本一致性",
    status: versionCheck.code === 0 ? "passed" : "failed",
  });
  const notes = path.join(root, "ForAIDoc/PM/releases", "v" + version + ".md");
  if (!fs.existsSync(notes))
    checks.push({
      id: "release-notes",
      name: "当前版本双语发布说明",
      status: "failed",
      message: `Missing ForAIDoc/PM/releases/v${version}.md; prepare notes and commit them before releasing.`,
    });
  else {
    const result = await execute(
      root,
      ["scripts/validate-release-notes.mjs", "--version", version, notes],
      process.env,
    );
    checks.push({
      id: "release-notes",
      name: "当前版本双语发布说明",
      status: result.code === 0 ? "passed" : "failed",
    });
  }
  const dirty = git(root, ["status", "--porcelain"]).length > 0;
  checks.push({
    id: "worktree",
    name: "发布源码状态",
    status: dirty && !options.allowDirty ? "failed" : "passed",
    message: dirty
      ? options.allowDirty
        ? "Local-only build explicitly allows uncommitted changes."
        : "Commit/reconcile the working tree first, or allow dirty only for a local-only build."
      : "Clean worktree.",
  });
  if (options.realPublish) {
    const branch = git(root, ["branch", "--show-current"]),
      head = git(root, ["rev-parse", "HEAD"]);
    const tag = "v" + version;
    checks.push({
      id: "release-branch",
      name: "发布分支",
      status: branch === "release" ? "passed" : "failed",
      message:
        "Real publishing uses the prepared release branch; ATK does not merge, commit or push.",
    });
    let matchingTag = false;
    try {
      matchingTag = git(root, ["rev-parse", tag + "^{commit}"]) === head;
    } catch {}
    checks.push({
      id: "release-tag",
      name: "本地发布标签",
      status: matchingTag ? "passed" : "failed",
      message: tag + " must point to HEAD.",
    });
    if (matchingTag && branch === "release" && !dirty) {
      const refs = git(root, [
        "ls-remote",
        "--exit-code",
        "origin",
        "refs/tags/" + tag,
        "refs/tags/" + tag + "^{}",
      ]);
      const remote = new Map(
        refs.split(/\r?\n/).map((line) => line.split(/\s+/).reverse()),
      );
      checks.push({
        id: "remote-tag",
        name: "远端发布标签",
        status:
          (remote.get("refs/tags/" + tag + "^{}") ??
            remote.get("refs/tags/" + tag)) === head
            ? "passed"
            : "failed",
        message: "Push the prepared release tag before uploading artifacts.",
      });
    }
  }
  return { version, checks };
}

export async function main(argv = process.argv.slice(2)) {
  const output = process.env.ATK_OUTPUT_DIR;
  if (!output || !process.env.ATK_RUN_ID || !process.env.ATK_STEP_ID)
    throw new Error(
      "Run this adapter through ATK so output and identity are allocated per run.",
    );
  fs.mkdirSync(output, { recursive: true });
  let options,
    checks = [],
    summary = "",
    failed = false;
  const heartbeat = setInterval(() => emit("heartbeat"), 10000);
  heartbeat.unref();
  try {
    options = parseArgs(argv);
    emit("info", {
      values: {
        realPublish: options.realPublish,
        allowDirty: options.allowDirty,
        task: options.task,
      },
    });
    if (options.task === "release-preflight") {
      emit("progress", {
        current: "release-preflight",
        message: "核对版本、双语说明和发布源码条件",
      });
      const result = await releasePreflight(projectRoot, options);
      checks = result.checks;
      emit("info", { values: { version: result.version } });
      fs.writeFileSync(
        path.join(output, "release-plan.json"),
        JSON.stringify(
          {
            version: result.version,
            realPublish: options.realPublish,
            args: publisherArgs(options),
            checks,
          },
          null,
          2,
        ),
      );
      failed = checks.some((check) => check.status === "failed");
      summary = failed
        ? "发布前置条件未满足；没有构建、上传或发布"
        : "发布前置条件通过";
    } else if (options.task === "smoke" || options.task === "release-check") {
      const mode = options.task === "smoke" ? "quick" : "local",
        ciOutput = path.join(output, "ci");
      const env = {
        ...process.env,
        npm_execpath: resolvePnpm(),
        P4DECK_CI_OUTPUT_DIR: ciOutput,
      };
      delete env.P4DECK_CI_RUN_P4D;
      delete env.P4PASSWD;
      delete env.GITHUB_TOKEN;
      emit("progress", {
        current: "ci:" + mode,
        message: "执行项目现有本地门禁，不启动 P4 fixture",
      });
      const result = await runNode(
        projectRoot,
        ["scripts/ci-runner.mjs", mode],
        env,
      );
      const reportFile = path.join(ciOutput, mode + "-latest.json");
      const native = fs.existsSync(reportFile)
        ? JSON.parse(fs.readFileSync(reportFile, "utf8"))
        : null;
      failed = result.code !== 0 || native?.ok !== true;
      checks = (native?.results ?? []).map((item) => ({
        id: item.name,
        name: item.name,
        status: item.accepted
          ? item.status === "skipped"
            ? "skipped"
            : "passed"
          : "failed",
        durationMs: item.durationMs,
        message: item.digest?.join("; ").slice(0, 2048) ?? "",
      }));
      if (!native)
        checks.push({
          id: "ci-report",
          name: "CI report",
          status: "failed",
          message: "CI exited without its per-run summary.",
        });
      summary = failed
        ? `ci:${mode} 检查失败，详见归档日志`
        : `ci:${mode} 全部通过`;
    } else {
      const preflight = await releasePreflight(projectRoot, options);
      checks = preflight.checks;
      if (checks.some((check) => check.status === "failed"))
        throw new Error(
          "Release preconditions changed or are not satisfied; no publication attempted.",
        );
      const stage = options.realPublish
        ? "签名构建并上传发布"
        : "签名构建并生成本地发布产物（不上传）";
      emit("progress", { current: "publish:update", message: stage });
      const env = { ...process.env };
      if (!options.realPublish) delete env.GITHUB_TOKEN;
      const result = await runNode(projectRoot, publisherArgs(options), env);
      if (result.code !== 0 || result.summary?.ok !== true)
        throw new Error(
          "Publish command failed; inspect the retained command output.",
        );
      const expectedMode = options.realPublish ? "published" : "local-only";
      if (
        result.summary.mode !== expectedMode ||
        result.summary.version !== preflight.version
      )
        throw new Error(
          "Publisher result does not match the requested mode/version.",
        );
      const source = path.resolve(result.summary.outputDir),
        expected = path.join(
          projectRoot,
          "artifacts/updater",
          "v" + preflight.version,
        );
      if (source !== expected || fs.lstatSync(source).isSymbolicLink())
        throw new Error("Unexpected publisher output directory");
      fs.cpSync(source, path.join(output, "release"), {
        recursive: true,
        dereference: false,
      });
      checks.push({
        id: "signed-package",
        name: "构建和签名校验",
        status: "passed",
      });
      checks.push({
        id: "github-release",
        name: "GitHub 真实发布",
        status: options.realPublish ? "passed" : "skipped",
        message: options.realPublish
          ? result.summary.releaseUrl
          : "realPublish=false: no upload or publication",
      });
      emit("info", {
        values: {
          mode: expectedMode,
          version: preflight.version,
          releaseUrl: result.summary.releaseUrl ?? "未发布",
        },
      });
      summary = options.realPublish
        ? "签名产物已真实发布到 GitHub Releases"
        : "本地签名发布产物已生成；没有上传或真实发版";
    }
  } catch (error) {
    failed = true;
    summary = error.message;
    checks.push({
      id: "adapter",
      name: "ATK CI adapter",
      status: "failed",
      message: error.message.slice(0, 2048),
    });
    console.error(error.message);
  } finally {
    clearInterval(heartbeat);
  }
  fs.writeFileSync(
    path.join(output, "result.json"),
    JSON.stringify(
      {
        schemaVersion: 1,
        runId: process.env.ATK_RUN_ID,
        stepId: process.env.ATK_STEP_ID,
        status: failed ? "failed" : "passed",
        summary: summary.slice(0, 2048),
        checks,
      },
      null,
      2,
    ),
  );
  process.exitCode = failed ? 1 : 0;
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
