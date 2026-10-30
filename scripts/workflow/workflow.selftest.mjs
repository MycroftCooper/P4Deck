// 工作流工具自测：写域解析 / 回执识别 / 任务单投递。不依赖 dsh、不写仓库。
// 用法: node scripts/workflow/workflow.selftest.mjs
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { checkFiles, loadOwnership, resolveOwner } from "./ownership.mjs";
import { classify, matchSlice, pathsOf, shaOf } from "./evidence.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const checks = [];
function check(name, ok, detail = "") {
  checks.push({ name, ok, detail });
  process.stdout.write(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}\n`);
}

const ownership = await loadOwnership();
const owner = (file) => resolveOwner(ownership, file);

check("src → FE", owner("src/app/App.tsx").role === "FE");
check("src-tauri → BE", owner("src-tauri/src/lib.rs").role === "BE");
check("batch-qa 优先于 src → QA", owner("tests/qa/batch-qa/e2e/fixture.tsx").role === "QA");
check("tests/browser → QA", owner("tests/browser/a.spec.ts").role === "QA");
check("ForAIDoc → LEAD", owner("ForAIDoc/PM/工作流/state.json").role === "LEAD");
check("根文件 → LEAD", owner("package.json").role === "LEAD");
check("artifacts 忽略", owner("artifacts/evidence/x.json").ignored === true);
check("未知路径 未映射", owner("somewhere/else.txt").role === undefined && owner("somewhere/else.txt").ignored === false);

const mixed = checkFiles(ownership, ["src/a.ts", "src-tauri/b.rs", "ForAIDoc/x.md"], "FE");
check("FE 越界被抓到", mixed.violations.length === 2, mixed.violations.map((v) => v.file).join(","));
const clean = checkFiles(ownership, ["src/a.ts", "tests/qa/batch-qa/x.tsx"], "FE");
check("FE 自己的范围放行", clean.violations.length === 1, "batch-qa 属于 QA，应记 1 条越界");

check("classify qa", classify({ noninteractiveQA: "passed" }) === "qa");
check("classify apply(originalApplied)", classify({ originalApplied: true }) === "apply");
check("classify apply(complete+mode)", classify({ complete: true, mode: "apply" }) === "apply");
check("classify manifest", classify({ manifestSha256: "X", files: [{ path: "a" }] }) === "manifest");
check("classify 未知", classify({ hello: 1 }) === undefined);
check("shaOf 兼容大写", shaOf({ manifestSHA256: "ABC" }) === "ABC");
check("shaOf 兼容 manifest 字符串", shaOf({ manifest: "DEF" }) === "DEF");
check("pathsOf(written)", pathsOf({ written: ["src/a.ts", "src/b.ts"] }).size === 2);
check("pathsOf(files[].path)", pathsOf({ files: [{ path: "src/c.ts" }] }).has("src/c.ts"));

const slices = [
  { id: "CON06" },
  { id: "S1A" },
  { id: "S2b" },
];
check("matchSlice 精确", matchSlice(slices, "CON06")?.id === "CON06");
check("matchSlice 大小写", matchSlice(slices, "s2b")?.id === "S2b");
check("matchSlice 前缀", matchSlice(slices, "S2b-NOOP-01")?.id === "S2b");
check("matchSlice 无匹配", matchSlice(slices, "ZZZ") === undefined);

const ticket = spawnSync(process.execPath, [path.join(HERE, "state.mjs"), "task", "CL-01", "--for", "FE", "--json"], {
  cwd: ROOT,
  encoding: "utf8",
});
let parsed;
try {
  parsed = JSON.parse(ticket.stdout);
} catch {
  parsed = undefined;
}
check("task --for FE 输出 JSON", Boolean(parsed), String(ticket.status));
check("任务单带写域", String(parsed?.writeScope ?? "").includes("src/"), parsed?.writeScope);
check("任务单带门禁", Array.isArray(parsed?.gates) && parsed.gates.length > 0);
check("任务单带预算", String(parsed?.budget ?? "").includes("12"));

// 人类待办：CLI 用临时文件，不碰仓库
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
const todoDir = await mkdtemp(path.join(os.tmpdir(), "p4deck-todos-"));
const todoFile = path.join(todoDir, "人类待办.json");
const runTodos = (argv) =>
  spawnSync(process.execPath, [path.join(HERE, "human-todos.mjs"), ...argv], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, P4DECK_TODOS: todoFile },
  });
const addedTodo = runTodos(["add", "测试待办"]);
check("人类待办 add", addedTodo.status === 0 && addedTodo.stdout.includes("T01"), addedTodo.stdout.trim());
const toggledTodo = runTodos(["toggle", "T01"]);
check("人类待办 toggle", toggledTodo.status === 0 && toggledTodo.stdout.includes("已完成"), toggledTodo.stdout.trim());
const listedTodos = JSON.parse(runTodos(["list", "--json"]).stdout);
check("人类待办落盘", listedTodos.items?.[0]?.done === true);
await rm(todoDir, { recursive: true, force: true });

// 归档门禁：未人验不得归档
const archiveGate = spawnSync(process.execPath, [path.join(HERE, "state.mjs"), "archive", "CL-01", "--note", "测试"], {
  cwd: ROOT,
  encoding: "utf8",
});
check("归档门禁拒绝未人验", archiveGate.status === 1 && String(archiveGate.stderr).includes("humanAccepted"), String(archiveGate.status));

// 状态工具新增能力：队列 / compact 看板 / 告警截断 / baseline / 文档轮转 dry-run
const queueOut = spawnSync(process.execPath, [path.join(HERE, "state.mjs"), "queue", "--for", "FE", "--json"], {
  cwd: ROOT,
  encoding: "utf8",
});
let queueJson;
try {
  queueJson = JSON.parse(queueOut.stdout);
} catch {}
check("queue --for FE 输出", Boolean(queueJson) && queueJson.role === "FE" && queueJson.count > 0, String(queueJson?.count));

const compactOut = spawnSync(process.execPath, [path.join(HERE, "state.mjs"), "board", "--compact"], {
  cwd: ROOT,
  encoding: "utf8",
});
const compactLines = compactOut.stdout.trim().split(/\r?\n/);
check("board --compact 有批次行", compactLines[0]?.startsWith("批次 "), compactLines[0]);
const stateOnDisk = JSON.parse(await readFile(path.join(ROOT, "ForAIDoc", "PM", "工作流", "state.json"), "utf8"));
const activeOnDisk = stateOnDisk.packages.filter((pkg) => !pkg.archived).length;
check("board --compact 只列活跃任务", compactLines.length === 1 + activeOnDisk, `${compactLines.length}/${1 + activeOnDisk}`);

const checkOut = spawnSync(process.execPath, [path.join(HERE, "state.mjs"), "check"], { cwd: ROOT, encoding: "utf8" });
const checkJson = JSON.parse(checkOut.stdout.slice(checkOut.stdout.indexOf("{")));
check("check 告警截断", Array.isArray(checkJson.warnings) && checkJson.warnings.length <= 5 && checkJson.warningCount > 5, `${checkJson.warnings?.length}/${checkJson.warningCount}`);

// 目录结构迁移（src/test/ → tests/qa/、artifacts 清理）后，台账证据路径必须仍然可达。
const verboseOut = spawnSync(process.execPath, [path.join(HERE, "state.mjs"), "check", "--verbose"], {
  cwd: ROOT,
  encoding: "utf8",
});
check("台账没有失效证据路径", !verboseOut.stdout.includes("证据路径不存在"));

const baselineFile = path.join(os.tmpdir(), `p4deck-baseline-${Date.now()}.json`);
const runBaseline = (argv) =>
  spawnSync(process.execPath, [path.join(HERE, "baseline.mjs"), ...argv], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, P4DECK_BASELINE: baselineFile },
  });
check("baseline start", runBaseline(["start"]).status === 0);
const changedNow = JSON.parse(runBaseline(["changed", "--json"]).stdout);
check("baseline 立即对比为 0", changedNow.count === 0, String(changedNow.count));
await rm(baselineFile, { force: true });

const archiveDry = spawnSync(process.execPath, [path.join(HERE, "archive.mjs"), "--keep", "2"], {
  cwd: ROOT,
  encoding: "utf8",
});
let archiveReport;
try {
  archiveReport = JSON.parse(archiveDry.stdout.slice(archiveDry.stdout.indexOf("{")));
} catch {}
const archiveNoop = archiveDry.stdout.includes("无需轮转");
check(
  "archive 默认 dry-run（或有内容时只预览）",
  archiveDry.status === 0 && (archiveReport?.dryRun === true || archiveNoop),
  archiveNoop ? "noop" : String(archiveReport?.move),
);

// TODO 叙事轮转后，台账结构必须仍然可 import（52/7/11）
const todoDry = spawnSync(process.execPath, [path.join(HERE, "archive.mjs"), "--todo"], { cwd: ROOT, encoding: "utf8" });
let todoReport;
try {
  todoReport = JSON.parse(todoDry.stdout.slice(todoDry.stdout.indexOf("{")));
} catch {}
check("TODO 轮转默认 dry-run", todoDry.status === 0 && todoReport?.dryRun === true, String(todoReport?.movedSections));
check(
  "状态库结构可读（不再锁死包数，TODO 台账会增长）",
  Number.isInteger(checkJson.checked) && checkJson.checked >= 50 && checkJson.slices >= 6 && checkJson.subitems >= 10,
  `${checkJson.checked}/${checkJson.slices}/${checkJson.subitems}`,
);

// 编码守卫：PowerShell 的 Set-Content 会写 BOM，JSON/YAML 因此解析失败（真实踩过）。
import { readdir, readFile } from "node:fs/promises";
async function walkFiles(dir, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walkFiles(full, out);
    else out.push(full);
  }
  return out;
}
const guardedDirs = ["tools/dsh-p4deck-board", "scripts/workflow", "ForAIDoc/PM/工作流"];
const bomFiles = [];
for (const dir of guardedDirs) {
  for (const file of await walkFiles(path.join(ROOT, dir))) {
    const head = await readFile(file);
    if (head.length >= 3 && head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) {
      bomFiles.push(path.relative(ROOT, file));
    }
  }
}
check("工作流文件无 BOM", bomFiles.length === 0, bomFiles.join(","));
for (const jsonFile of ["tools/dsh-p4deck-board/package.json", "package.json", "ForAIDoc/PM/工作流/state.json"]) {
  let ok = true;
  try {
    JSON.parse(await readFile(path.join(ROOT, jsonFile), "utf8"));
  } catch {
    ok = false;
  }
  check(`JSON 可解析: ${jsonFile}`, ok);
}

// 人工验收命令：dry-run 不落盘；没有 --note 必须拒绝。
const acceptDry = spawnSync(
  process.execPath,
  [path.join(HERE, "state.mjs"), "accept", "CL-04", "--force", "--note", "selftest", "--dry"],
  { cwd: ROOT, encoding: "utf8" },
);
check(
  "accept --dry 输出计划不落盘",
  acceptDry.status === 0 && acceptDry.stdout.includes('"dryRun": true'),
  acceptDry.stderr.trim(),
);
const acceptNoNote = spawnSync(process.execPath, [path.join(HERE, "state.mjs"), "accept", "CL-04", "--force"], {
  cwd: ROOT,
  encoding: "utf8",
});
check("accept 必须给 --note", acceptNoNote.status === 2, String(acceptNoNote.status));

// 发布脚本：默认 dry-run；版本不一致必须拒绝。
const packageVersion = JSON.parse(await readFile(path.join(ROOT, "package.json"), "utf8")).version;
const releaseDry = spawnSync(
  process.execPath,
  [path.join(HERE, "release.mjs"), "--version", packageVersion, "--skip-gate", "--allow-dirty"],
  { cwd: ROOT, encoding: "utf8" },
);
check(
  "release 默认 dry-run 输出计划",
  releaseDry.status === 0 && releaseDry.stdout.includes('"dryRun": true'),
  releaseDry.stderr.trim(),
);
const releaseBad = spawnSync(
  process.execPath,
  [path.join(HERE, "release.mjs"), "--version", "0.0.0", "--skip-gate", "--allow-dirty"],
  { cwd: ROOT, encoding: "utf8" },
);
check("release 拒绝版本不一致", releaseBad.status === 1, String(releaseBad.status));

// 看板必须把"实现待验收"拆成证据齐/待应用/未登记三个桶。
const boardRun = spawnSync(process.execPath, [path.join(HERE, "board.mjs")], { cwd: ROOT, encoding: "utf8" });
const boardHtml = (await import("node:fs")).readFileSync(
  path.join(ROOT, "ForAIDoc", "PM", "工作流", "看板.html"),
  "utf8",
);
check(
  "看板拆分验收桶",
  boardRun.status === 0 && boardHtml.includes("待人工验收") && boardHtml.includes("未登记验收"),
  "缺少验收桶标签",
);

const failed = checks.filter((entry) => !entry.ok);
process.stdout.write(`\n${checks.length - failed.length}/${checks.length} 通过\n`);
if (failed.length) process.exitCode = 1;
