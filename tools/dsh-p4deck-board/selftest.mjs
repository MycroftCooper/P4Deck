// 插件自测：用假 ctx / 假 req-res 跑通路由与快照，不需要 dsh 运行时。
// 用法: node tools/dsh-p4deck-board/selftest.mjs
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { apply, buildSnapshot } from "./lib/index.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE = path.resolve(HERE, "..", "..");

const checks = [];
function check(name, ok, detail = "") {
  checks.push({ name, ok, detail });
  process.stdout.write(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}\n`);
}

function fakeResponse() {
  return {
    statusCode: undefined,
    headers: undefined,
    body: undefined,
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      this.headers = headers;
    },
    end(body) {
      this.body = body;
    },
    write(chunk) {
      this.body = (this.body ?? "") + chunk;
    },
  };
}

async function call(handler, { method = "GET", url }) {
  const res = fakeResponse();
  await handler({ method, url }, res);
  return res;
}

function postJson(handler, url, payload) {
  const request = new EventEmitter();
  request.method = "POST";
  request.url = url;
  const response = fakeResponse();
  handler(request, response);
  request.emit("data", JSON.stringify(payload));
  request.emit("end");
  return new Promise((resolve) => setTimeout(() => resolve(response), 80));
}

// 1) 快照
const snapshot = await buildSnapshot(WORKSPACE);
check("快照含主工作包", snapshot.counts.total >= 52, String(snapshot.counts.total));
check("快照含 Agent 活动", snapshot.agents.length > 0, `${snapshot.agents.length} 个角色`);
check("快照含里程碑", snapshot.milestones.length > 0, `${snapshot.milestones.length} 条`);
check("状态分布含进行中", typeof snapshot.counts.byStage["in-progress"] === "number");

// 2) 注册
const routes = [];
const ctx = {
  webServer: {
    register(route) {
      routes.push(route);
      return () => {
        const index = routes.indexOf(route);
        if (index >= 0) routes.splice(index, 1);
      };
    },
  },
  effect(fn) {
    return fn();
  },
};
apply(ctx, { workspace: WORKSPACE });
check("注册 prefix 路由", routes.some((route) => route.kind === "prefix" && route.path === "/p4deck-board"));
check("注册 exact 路由", routes.some((route) => route.kind === "exact" && route.path === "/p4deck-board"));

const handler = routes.find((route) => route.kind === "prefix").handler;

// 3) 页面
const page = await call(handler, { url: "/p4deck-board/" });
check("页面 200", page.statusCode === 200, String(page.statusCode));
check("页面是 HTML", String(page.headers?.["content-type"]).includes("text/html"));
check("页面含看板标题", String(page.body).includes("Agent 在忙什么"));
check("页面含验收/取消按钮", String(page.body).includes("验收完成") && String(page.body).includes("取消"));

// 4) API
const api = await call(handler, { url: "/p4deck-board/api/snapshot" });
const payload = JSON.parse(api.body);
check("API 200", api.statusCode === 200);
check("API 返回 total 与快照一致", payload.counts.total === snapshot.counts.total, `${payload.counts.total}/${snapshot.counts.total}`);
check("API 不缓存", api.headers?.["cache-control"] === "no-store");
check("快照含人类待办", Array.isArray(payload.humanTodos) && payload.humanTodos.length > 0, `${payload.humanTodos?.length} 条`);
check(
  "归档与活跃分开",
  (payload.archived || []).length === snapshot.archived.length &&
    snapshot.archived.length >= 2 &&
    payload.packages.every((pkg) => !pkg.archived),
  `${payload.archived?.length}/${snapshot.archived.length}`,
);
check(
  "快照带功能名（不只是编号）",
  payload.packages.length > 0 && payload.packages.every((pkg) => typeof pkg.scope === "string" && pkg.scope.length > 0),
  payload.packages[0]?.scope,
);

// 4a) SSE：事件流路由（不再轮询）
const eventRequest = new EventEmitter();
eventRequest.method = "GET";
eventRequest.url = "/p4deck-board/api/events";
const eventResponse = fakeResponse();
await handler(eventRequest, eventResponse);
check("SSE 路由 200", eventResponse.statusCode === 200, String(eventResponse.statusCode));
check("SSE content-type", String(eventResponse.headers?.["content-type"]).includes("text/event-stream"));
check("SSE 首帧 connected", String(eventResponse.body ?? "").includes("connected"));

// 4b) 人类待办勾选：POST 写回 JSON（临时工作区，不动仓库）
const tempRoot = await mkdtemp(path.join(os.tmpdir(), "p4deck-toggle-"));
try {
  const flowDir = path.join(tempRoot, "ForAIDoc", "PM", "工作流");
  await mkdir(flowDir, { recursive: true });
  const todoFile = path.join(flowDir, "人类待办.json");
  await writeFile(todoFile, JSON.stringify({ schemaVersion: 1, items: [{ id: "T01", text: "x", done: false }] }), "utf8");
  const tempRoutes = [];
  apply(
    {
      webServer: {
        register(route) {
          tempRoutes.push(route);
          return () => {};
        },
      },
      effect(fn) {
        return fn();
      },
    },
    { workspace: tempRoot },
  );
  const tempHandler = tempRoutes.find((route) => route.kind === "prefix").handler;
  const request = new EventEmitter();
  request.method = "POST";
  request.url = "/p4deck-board/api/human-todos/toggle";
  const response = fakeResponse();
  tempHandler(request, response);
  request.emit("data", JSON.stringify({ id: "T01" }));
  request.emit("end");
  await new Promise((resolve) => setTimeout(resolve, 80));
  const after = JSON.parse(await readFile(todoFile, "utf8"));
  check("POST 勾选返回 200", response.statusCode === 200, String(response.statusCode));
  check("勾选写回 JSON", after.items[0].done === true);
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}

// 4c) 看板按钮：验收/取消直接写 state.json（临时工作区，不动仓库）
const stateRoot = await mkdtemp(path.join(os.tmpdir(), "p4deck-action-"));
try {
  const flowDir = path.join(stateRoot, "ForAIDoc", "PM", "工作流");
  await mkdir(flowDir, { recursive: true });
  const stateFile = path.join(flowDir, "state.json");
  const stateDoc = {
    schemaVersion: 2,
    updatedAt: new Date().toISOString(),
    batch: {
      id: "T",
      goal: "g",
      stopCondition: "s",
      slices: [{ id: "S", label: "S", status: "todo", owner: "BE", exit: "x" }],
    },
    counts: { main: 2, archived: 0, total: 2, subitems: 0, slices: 1 },
    packages: [
      {
        id: "T-01",
        type: "feature",
        owner: "FE",
        module: "m",
        scope: "模块：待验收功能",
        stage: "implemented",
        statusRaw: "已实现待验收",
        priority: "P1",
        evidence: [],
        note: "n",
        deps: [],
        archived: false,
        migrated: true,
        verification: { qaPassed: null, applied: null, humanAccepted: null },
      },
      {
        id: "T-02",
        type: "feature",
        owner: "FE",
        module: "m",
        scope: "模块：要取消功能",
        stage: "partial",
        statusRaw: "部分实现",
        priority: "P1",
        evidence: [],
        note: "n",
        deps: [],
        archived: false,
        migrated: true,
        verification: { qaPassed: null, applied: null, humanAccepted: null },
      },
    ],
    subitems: [],
  };
  await writeFile(stateFile, JSON.stringify(stateDoc, null, 2), "utf8");
  const tempRoutes = [];
  apply(
    {
      webServer: {
        register(route) {
          tempRoutes.push(route);
          return () => {};
        },
      },
      effect(fn) {
        return fn();
      },
    },
    { workspace: stateRoot },
  );
  const tempHandler = tempRoutes.find((route) => route.kind === "prefix").handler;
  const acceptRes = await postJson(tempHandler, "/p4deck-board/api/packages/accept", { id: "T-01" });
  const accepted = JSON.parse(await readFile(stateFile, "utf8"));
  const acceptedPkg = accepted.packages.find((pkg) => pkg.id === "T-01");
  check("POST 验收返回 200", acceptRes.statusCode === 200, String(acceptRes.statusCode));
  check("验收写回 state（stage=done + humanAccepted）", acceptedPkg.stage === "done" && acceptedPkg.verification.humanAccepted === true);
  check("无 QA/Apply 时标记 force 补登", acceptedPkg.verification.humanAcceptedForced === true);
  check("验收后 counts 仍正确", accepted.counts.main === 2 && accepted.counts.archived === 0, `${accepted.counts.main}/${accepted.counts.archived}`);

  const cancelRes = await postJson(tempHandler, "/p4deck-board/api/packages/cancel", { id: "T-02" });
  const canceled = JSON.parse(await readFile(stateFile, "utf8"));
  const canceledPkg = canceled.packages.find((pkg) => pkg.id === "T-02");
  check("POST 取消返回 200", cancelRes.statusCode === 200, String(cancelRes.statusCode));
  check("取消归档且不算验收", canceledPkg.archived === true && canceledPkg.verification.canceled === true && canceledPkg.verification.humanAccepted !== true);
  check("取消后 counts 更新", canceled.counts.main === 1 && canceled.counts.archived === 1, `${canceled.counts.main}/${canceled.counts.archived}`);

  const afterSnapshot = JSON.parse((await call(tempHandler, { url: "/p4deck-board/api/snapshot" })).body);
  check("取消项离开活跃看板", afterSnapshot.packages.every((pkg) => pkg.id !== "T-02") && afterSnapshot.archived.some((pkg) => pkg.id === "T-02"));
} finally {
  await rm(stateRoot, { recursive: true, force: true });
}

// 5) 边界
const post = await call(handler, { method: "POST", url: "/p4deck-board/" });
check("非 GET 返回 405", post.statusCode === 405, String(post.statusCode));
const missing = await call(handler, { url: "/p4deck-board/nope" });
check("未知子路径 404", missing.statusCode === 404, String(missing.statusCode));

// 6) 失败路径：workspace 无效时要 503 而不是崩溃
const broken = applyBroken();
async function applyBroken() {
  const localRoutes = [];
  apply(
    {
      webServer: {
        register(route) {
          localRoutes.push(route);
          return () => {};
        },
      },
      effect(fn) {
        return fn();
      },
    },
    { workspace: path.join(WORKSPACE, "does-not-exist") },
  );
  return localRoutes.find((route) => route.kind === "prefix").handler;
}
const brokenRes = await call(await broken, { url: "/p4deck-board/api/snapshot" });
check("缺 state.json 时 503", brokenRes.statusCode === 503, String(brokenRes.statusCode));

const failed = checks.filter((entry) => !entry.ok);
process.stdout.write(`\n${checks.length - failed.length}/${checks.length} 通过\n`);
if (failed.length) process.exitCode = 1;
