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
check("batch-qa 优先于 src → QA", owner("src/test/batch-qa/e2e/fixture.tsx").role === "QA");
check("tests/browser → QA", owner("tests/browser/a.spec.ts").role === "QA");
check("ForAIDoc → LEAD", owner("ForAIDoc/PM/工作流/state.json").role === "LEAD");
check("根文件 → LEAD", owner("package.json").role === "LEAD");
check("artifacts 忽略", owner("artifacts/evidence/x.json").ignored === true);
check("未知路径 未映射", owner("somewhere/else.txt").role === undefined && owner("somewhere/else.txt").ignored === false);

const mixed = checkFiles(ownership, ["src/a.ts", "src-tauri/b.rs", "ForAIDoc/x.md"], "FE");
check("FE 越界被抓到", mixed.violations.length === 2, mixed.violations.map((v) => v.file).join(","));
const clean = checkFiles(ownership, ["src/a.ts", "src/test/batch-qa/x.tsx"], "FE");
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

const failed = checks.filter((entry) => !entry.ok);
process.stdout.write(`\n${checks.length - failed.length}/${checks.length} 通过\n`);
if (failed.length) process.exitCode = 1;
