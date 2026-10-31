#!/usr/bin/env node
// 敏捷通道（默认）：定向门禁 + 证据回执 + 5 分钟用户验收清单。
//
// 只有「发版」才走 freeze → 独立 QA → apply → 全量 CI；日常 bug 修复、文案/布局/
// 小逻辑改动走本命令：跑 ci-fast（写域 + 状态 + 相关格式/类型/测试），把改动、
// 门禁结果、改动前备份和验收清单落进 artifacts/evidence/agile-<n>/。
//
// 用法:
//   node scripts/workflow/agile.mjs --files src/a.ts,src/a.test.ts --role FE --title "修复…"
//   node scripts/workflow/agile.mjs --since-baseline --role LEAD --title "轮换文档"
//   node scripts/workflow/agile.mjs --files a.ts --role FE --skip-gate --title "只记录证据"
//   node scripts/workflow/agile.mjs --files a.ts --role FE --plan        # 只打印计划
//   node scripts/workflow/agile.mjs --files a.ts --role FE --todo        # 顺带加人类待办
//
// 选项: --files a,b | --since-baseline | --role ROLE | --title TEXT | --id N
//       --skip-gate | --plan | --json | --todo | --help
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const EVIDENCE_ROOT = path.join(ROOT, "artifacts", "evidence");
const WORKFLOW_ARTIFACTS = path.join(ROOT, "artifacts", "workflow");
const TEMPLATE_ROOT = path.join(ROOT, "scripts", "workflow", "templates");
const CI_FAST_REPORT = path.join(WORKFLOW_ARTIFACTS, "ci-fast-latest.json");

const IGNORED_PREFIXES = ["artifacts/", ".local/", "test-results/", "playwright-report/", "node_modules/", "dist/"];

const FALLBACK_REPORT = `# AGILE-{{ID}}：{{TITLE}}

> {{DATE}}｜角色 \`{{ROLE}}\`｜通道：**敏捷（默认）**｜门禁：**{{GATE_STATUS}}**（{{GATE_DURATION}}）
> 证据目录：\`{{EVIDENCE_DIR}}\`

## 1. 改动范围

| 文件 | 类型 | sha256（改后） | 改动前备份 |
|---|---|---|---|
{{FILES_TABLE}}

## 2. 门禁结果（\`ci-fast\`）

| 步骤 | 结果 | 退出码 | 耗时 |
|---|---|---|---|
{{GATE_TABLE}}

- 未跑：{{NOT_RUN}}

## 3. 用户验收（约 5 分钟）

见 [\`ACCEPTANCE.md\`](ACCEPTANCE.md)。
`;

const FALLBACK_ACCEPTANCE = `# 5 分钟验收清单：AGILE-{{ID}} {{TITLE}}

> 只验这次改动，不重测历史项。

- [ ] 启动应用，窗口正常、无报错。
- [ ] 打开与本次改动相关的页面，走一遍主流程。
- [ ] 边界/窄窗/深浅主题下改动区域正常。
- [ ] 结论：通过 / 不通过（现象：____）

未覆盖：{{NOT_COVERED}}
回滚：{{ROLLBACK}}
`;

function usage() {
  return [
    "敏捷通道：定向门禁 + 证据 + 5 分钟验收清单（不发版时默认走这里）",
    "",
    "用法:",
    "  node scripts/workflow/agile.mjs --files <a,b> --role <FE|BE|QA|LEAD> --title <text>",
    "  node scripts/workflow/agile.mjs --since-baseline --role <role> --title <text>",
    "",
    "选项:",
    "  --files <a,b>      本次改动文件（逗号分隔；省略时用 --since-baseline 或 git 改动）",
    "  --since-baseline   从 baseline.mjs changed 读取改动",
    "  --role <ROLE>      写域检查角色（默认 $P4DECK_ROLE）",
    "  --title <text>     验收标题（会写进报告和清单）",
    "  --id <n>           指定 agile 编号（默认自动递增）",
    "  --skip-gate        不跑 ci-fast（仅记录证据；文档/已验改动才用）",
    "  --plan             只打印计划，不写文件、不跑门禁",
    "  --json             机器可读输出（门禁输出转到 stderr）",
    "  --todo             顺带在人类待办里加一条验收项",
    "  --help             显示本说明",
    "",
    "退出码: 0 通过或跳过门禁；1 门禁失败；2 用法错误。",
  ].join("\n");
}

function parseArgs(argv) {
  const options = { _: [], files: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index]);
    if (!token.startsWith("-")) {
      options._.push(token);
      continue;
    }
    const body = token.replace(/^--?/, "");
    const equals = body.indexOf("=");
    if (equals !== -1) {
      assign(options, body.slice(0, equals), body.slice(equals + 1));
      continue;
    }
    const next = argv[index + 1];
    if (next !== undefined && !String(next).startsWith("-")) {
      assign(options, body, String(next));
      index += 1;
    } else {
      assign(options, body, true);
    }
  }
  return options;
}

function assign(options, key, value) {
  if (key === "files") {
    options.files.push(...String(value).split(",").map((item) => item.trim()).filter(Boolean));
    return;
  }
  options[key] = value;
}

function localIso(date = new Date()) {
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const abs = Math.abs(offset);
  const pad = (value, width = 2) => String(value).padStart(width, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(
    date.getMinutes(),
  )}:${pad(date.getSeconds())}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

function toPosix(value) {
  return String(value).replace(/\\/g, "/");
}

function repoRelative(absolute) {
  return toPosix(path.relative(ROOT, absolute));
}

function formatDuration(ms) {
  if (!Number.isFinite(ms)) return "?";
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(2)}s`;
}

function runProcess(args, { capture = true } = {}) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn(process.execPath, args, {
      cwd: ROOT,
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    if (capture) {
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
    }
    child.on("error", () => resolve({ code: 127, stdout, stderr, durationMs: Date.now() - startedAt }));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr, durationMs: Date.now() - startedAt }));
  });
}

function runGit(args) {
  return new Promise((resolve) => {
    const child = spawn("git", args, { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", () => resolve({ ok: false, stdout: "", stderr: "" }));
    child.on("close", (code) => resolve({ ok: code === 0, stdout, stderr }));
  });
}

async function changedFilesFromGit() {
  const result = await runGit(["status", "--porcelain=v1"]);
  if (!result.ok) return [];
  const files = [];
  for (const line of result.stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let file = line.slice(3).trim();
    const rename = file.match(/^(.*?) -> (.*)$/);
    if (rename) file = rename[2];
    file = file.replace(/^"|"$/g, "").replace(/\\/g, "/");
    if (!file) continue;
    if (IGNORED_PREFIXES.some((prefix) => file.startsWith(prefix))) continue;
    if (!(await stat(path.join(ROOT, file)).catch(() => null))) continue;
    files.push(file);
  }
  return files;
}

async function changedFilesFromBaseline() {
  const result = await runProcess(["scripts/workflow/baseline.mjs", "changed", "--json"]);
  try {
    const parsed = JSON.parse(result.stdout);
    return Array.isArray(parsed.files) ? parsed.files.map(toPosix) : [];
  } catch {
    return [];
  }
}

async function nextAgileId() {
  const entries = await readdir(EVIDENCE_ROOT, { withFileTypes: true }).catch(() => []);
  let max = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const match = entry.name.match(/^agile-(\d+)$/);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return max + 1;
}

async function sha256File(file) {
  const content = await readFile(file);
  return createHash("sha256").update(content).digest("hex");
}

async function fileStatus(file) {
  const result = await runGit(["status", "--porcelain=v1", "--", file]);
  const code = result.stdout.trim().slice(0, 2);
  if (code === "??") return "new";
  if (code.startsWith("D") || code.endsWith("D")) return "deleted";
  return "modified";
}

async function backupFromHead(file, backupDir) {
  const shown = await runGit(["show", `HEAD:${file}`]);
  if (!shown.ok) return false;
  const target = path.join(backupDir, `${file}.bak`);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, shown.stdout, "utf8");
  return true;
}

async function loadTemplate(name, fallback) {
  try {
    return await readFile(path.join(TEMPLATE_ROOT, name), "utf8");
  } catch {
    return fallback;
  }
}

function render(template, vars) {
  const output = template.replace(/\{\{([A-Z0-9_]+)\}\}/g, (match, key) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : match,
  );
  const unresolved = output.match(/\{\{[A-Z0-9_]+\}\}/);
  if (unresolved) throw new Error(`模板存在未替换占位符 ${unresolved[0]}`);
  return output;
}

function renderFilesTable(files) {
  if (!files.length) return "| （无） | — | — | — |";
  return files
    .map(
      (file) =>
        `| \`${file.path}\` | ${file.kind} | \`${file.sha256.slice(0, 12)}…\` | ${file.backup ? "有" : "无"} |`,
    )
    .join("\n");
}

function renderGateTable(steps) {
  if (!steps.length) return "| （未跑） | — | — | — |";
  return steps
    .map(
      (step) =>
        `| ${step.name} | ${step.status === "passed" ? "通过" : "失败"} | ${step.exitCode ?? "—"} | ${formatDuration(step.durationMs)} |`,
    )
    .join("\n");
}

function gateStepsFromReport(report) {
  if (!report || !Array.isArray(report.steps)) return [];
  return report.steps;
}

async function readGateReport(minMtimeMs) {
  try {
    const info = await stat(CI_FAST_REPORT);
    if (minMtimeMs && info.mtimeMs < minMtimeMs - 2000) return null;
    return JSON.parse(await readFile(CI_FAST_REPORT, "utf8"));
  } catch {
    return null;
  }
}

function gateTableFromReport(report, gateResult) {
  const steps = gateStepsFromReport(report);
  if (steps.length) return renderGateTable(steps);
  return `| ci-fast | ${gateResult.code === 0 ? "通过" : "失败"} | ${gateResult.code} | ${formatDuration(gateResult.durationMs)} |`;
}

function firstFilesHint(files) {
  const names = files.map((file) => file.path);
  const shown = names.slice(0, 3).join("、");
  return names.length > 3 ? `${shown} 等 ${names.length} 个文件` : shown || "（未列出）";
}

async function gateArgs(files, role) {
  const args = ["scripts/workflow/ci-fast.mjs", "--files", files.map((file) => file.path).join(",")];
  if (role) args.push("--role", role);
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help === true || args._[0] === "help") {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }

  const role = String(args.role ?? process.env.P4DECK_ROLE ?? "").trim().toUpperCase() || null;
  const title = String(args.title ?? "").trim() || "未命名改动";
  const skipGate = args["skip-gate"] === true;
  const planOnly = args.plan === true;
  const json = args.json === true;

  let files = args.files;
  if (!files.length) {
    files = args["since-baseline"] === true ? await changedFilesFromBaseline() : await changedFilesFromGit();
  }
  files = [...new Set(files.map(toPosix))].filter(Boolean);
  if (!files.length) {
    process.stderr.write("没有可记录的改动文件。用 --files a,b 指定，或先确认工作树有改动。\n");
    return 2;
  }

  const id = args.id !== undefined ? String(args.id).replace(/\D/g, "") || String(await nextAgileId()) : String(await nextAgileId());
  const evidenceDirRel = `artifacts/evidence/agile-${id}`;
  const evidenceDir = path.join(EVIDENCE_ROOT, `agile-${id}`);

  if (planOnly) {
    const planned = {
      schemaVersion: 1,
      planOnly: true,
      id: `AGILE-${id}`,
      title,
      role,
      evidenceDir: evidenceDirRel,
      files,
      gate: skipGate ? "skipped" : ["scripts/workflow/ci-fast.mjs", "--files", files.join(","), ...(role ? ["--role", role] : [])],
      writes: ["REPORT.md", "ACCEPTANCE.md", "hashes.json", "gate.log", "backup/<tracked files>.bak"],
    };
    process.stdout.write(`${JSON.stringify(planned, null, 2)}\n`);
    return 0;
  }

  const startedAt = localIso();
  const startedAtMs = Date.now();
  const gitHead = (await runGit(["rev-parse", "HEAD"])).stdout.trim() || null;
  const gitDirty = (await runGit(["status", "--porcelain=v1"])).stdout.trim().length > 0;
  await mkdir(evidenceDir, { recursive: true });
  const backupDir = path.join(evidenceDir, "backup");

  const fileEntries = [];
  for (const file of files) {
    const absolute = path.join(ROOT, file);
    const kind = await fileStatus(file);
    const entry = {
      path: file,
      kind,
      sha256: await sha256File(absolute).catch(() => ""),
      backup: false,
    };
    if (kind !== "new") entry.backup = await backupFromHead(file, backupDir);
    fileEntries.push(entry);
  }

  let gate = { code: 0, stdout: "", stderr: "", durationMs: 0 };
  if (skipGate) {
    gate.stdout = "（本次使用 --skip-gate，未运行 ci-fast）\n";
  } else {
    const childArgs = await gateArgs(fileEntries, role);
    const child = spawn(process.execPath, childArgs, {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const started = Date.now();
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (!json) process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      process.stderr.write(chunk);
    });
    gate = await new Promise((resolve) => {
      child.on("error", () => resolve({ code: 127, stdout, stderr, durationMs: Date.now() - started }));
      child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr, durationMs: Date.now() - started }));
    });
  }

  const report = skipGate ? null : await readGateReport(startedAtMs);
  const gateStatus = skipGate ? "已跳过" : report?.ok === true || (!report && gate.code === 0) ? "通过" : "失败";
  const notRun = skipGate
    ? "本次使用 --skip-gate，未跑 ci-fast；全量 CI/全量测试、独立 QA、freeze/apply、真实 P4、macOS 均未跑。"
    : "全量 CI/全量测试、独立 QA、freeze/apply、真实 P4（当前禁止）、macOS 均未跑。";

  const reportTemplate = await loadTemplate("agile-report.md", FALLBACK_REPORT);
  const acceptanceTemplate = await loadTemplate("agile-acceptance.md", FALLBACK_ACCEPTANCE);
  const filesTable = renderFilesTable(fileEntries);
  const scopeHint = firstFilesHint(fileEntries);
  const uiChanged = fileEntries.some((file) =>
    /^(src|src-tauri|public|assets)\//.test(file.path) || file.path === "index.html",
  );
  const commonVars = {
    ID: id,
    TITLE: title,
    DATE: startedAt,
    ROLE: role ?? "UNKNOWN",
    EVIDENCE_DIR: evidenceDirRel,
    FILES_TABLE: filesTable,
    GATE_TABLE: skipGate ? "| （--skip-gate） | — | — | — |" : gateTableFromReport(report, gate),
    GATE_STATUS: gateStatus,
    GATE_DURATION: formatDuration(gate.durationMs),
    NOT_RUN: notRun,
    SCOPE_HINT: scopeHint,
    NOT_COVERED: "全量 CI/全量测试、独立 QA、freeze/apply、真实 P4（当前禁止）、macOS。",
    START_HINT: uiChanged
      ? "启动：`pnpm dev:desktop`（或双击 `P4Deck-Dev.cmd`），窗口正常、无启动报错。"
      : "无需启动应用；在仓库根执行本次改动对应的命令（见 REPORT.md 的已跑步骤），确认退出码与输出符合预期。",
    MAIN_CHECKS: uiChanged
      ? [
          "- [ ] 打开与本次改动相关的页面，按改动点走一遍主流程。",
          "- [ ] 操作结果符合预期；刷新或切页后状态仍正确。",
        ].join("\n")
      : [
          "- [ ] 执行本次改动对应的命令/脚本，输出符合预期。",
          "- [ ] 打开本次证据目录，REPORT.md / ACCEPTANCE.md / hashes.json 内容正确、可读。",
        ].join("\n"),
    EDGE_CHECKS: uiChanged
      ? [
          "- [ ] 窄窗 / 150% 缩放 / 深浅主题下，改动区域不重叠、不裁切。",
          "- [ ] 空数据、加载中、失败态中与改动相关的分支不报错。",
          "- [ ] 涉及偏好/持久化时，重启应用后改动仍然生效。",
        ].join("\n")
      : [
          "- [ ] 改动不改变产品行为；如果改变，按对应页面/命令补验。",
          "- [ ] `git status` 复核没有未预期的额外文件变化。",
        ].join("\n"),
    ROLLBACK: "`git checkout -- <path>`（会丢弃未提交改动，先确认），或用 backup/ 下备份覆盖后重跑定向测试。",
  };

  await writeFile(path.join(evidenceDir, "REPORT.md"), render(reportTemplate, commonVars), "utf8");
  await writeFile(path.join(evidenceDir, "ACCEPTANCE.md"), render(acceptanceTemplate, commonVars), "utf8");
  await writeFile(
    path.join(evidenceDir, "hashes.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        id: `AGILE-${id}`,
        title,
        role,
        createdAt: startedAt,
        gitHead,
        gitDirty,
        gate: { status: gateStatus, exitCode: skipGate ? null : gate.code, durationMs: gate.durationMs },
        files: fileEntries,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  const gateLog = `${gate.stdout}${gate.stderr}`.trim();
  await writeFile(path.join(evidenceDir, "gate.log"), `${gateLog || "（无输出）"}\n`, "utf8");

  let todo = null;
  if (args.todo === true) {
    const added = await runProcess([
      "scripts/workflow/human-todos.mjs",
      "add",
      `验收 AGILE-${id}：${title}`,
      "--note",
      `敏捷通道证据：${evidenceDirRel}/ACCEPTANCE.md（约 5 分钟）`,
    ]);
    const match = added.stdout.match(/(T\d+)/);
    todo = match?.[1] ?? null;
  }

  const summary = {
    schemaVersion: 1,
    ok: skipGate || gate.code === 0,
    id: `AGILE-${id}`,
    title,
    role,
    evidenceDir: evidenceDirRel,
    report: `${evidenceDirRel}/REPORT.md`,
    acceptance: `${evidenceDirRel}/ACCEPTANCE.md`,
    gate: { status: gateStatus, exitCode: skipGate ? null : gate.code, durationMs: gate.durationMs },
    files: fileEntries.map((file) => ({ path: file.path, kind: file.kind, backup: file.backup })),
    todo,
  };

  if (json) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } else {
    process.stdout.write(`\n敏捷通道 ${summary.id}：${title}\n`);
    process.stdout.write(`  门禁：${gateStatus}（${formatDuration(gate.durationMs)}）\n`);
    process.stdout.write(`  证据：${evidenceDirRel}/\n`);
    process.stdout.write(`  验收：${evidenceDirRel}/ACCEPTANCE.md（约 5 分钟）\n`);
    process.stdout.write(`  文件：${fileEntries.length} 个；改动前备份：${fileEntries.filter((file) => file.backup).length} 个\n`);
    if (todo) process.stdout.write(`  人类待办：${todo}\n`);
    process.stdout.write("  下一步：把 ACCEPTANCE.md 交给用户；通过后需要写回状态时用 state.mjs accept <ID> --note \"依据\"\n");
  }
  return summary.ok ? 0 : 1;
}

try {
  process.exitCode = await main();
} catch (error) {
  process.stderr.write(`agile: ${error?.message ?? error}\n`);
  process.exitCode = 1;
}
