#!/usr/bin/env node
// 可视化看板：把 state.json（任务状态）+ 运行状态.json（谁在忙什么）+ metrics 合成一个看板。
//
// 用法:
//   node scripts/workflow/board.mjs                生成 ForAIDoc/PM/工作流/看板.html（双击可看）
//   node scripts/workflow/board.mjs --serve        本地实时服务 http://127.0.0.1:1421（每 4 秒自刷）
//   node scripts/workflow/board.mjs --json         打印快照 JSON
import { createServer } from "node:http";
import { existsSync, watch } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { readTodos, toggleTodo, TODOS_FILE } from "./human-todos.mjs";
const stripBom = (text) => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const WORKFLOW_DIR = path.join(ROOT, "ForAIDoc", "PM", "工作流");
const STATE_FILE = path.join(WORKFLOW_DIR, "state.json");
const RUNTIME_FILE = path.join(WORKFLOW_DIR, "运行状态.json");
const HTML_FILE = path.join(WORKFLOW_DIR, "看板.html");
const METRICS_FILE = path.join(ROOT, "artifacts", "workflow", "metrics.jsonl");

const STAGE_LABELS = {
  "in-progress": "进行中",
  blocked: "阻塞",
  implemented: "实现待验收",
  "awaiting_accept": "待人工验收",
  "awaiting_apply": "待应用",
  unverified: "未登记验收",
  partial: "部分实现",
  todo: "待实现",
  proposed: "待确认",
  done: "已完成",
};
const STAGE_ORDER = ["in-progress", "blocked", "awaiting_accept", "awaiting_apply", "unverified", "partial", "todo", "proposed", "done"];
const TYPE_LABELS = { bug: "Bug", feature: "需求", refactor: "重构" };

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(stripBom(await readFile(filePath, "utf8")));
  } catch {
    return fallback;
  }
}

async function readMetrics() {
  try {
    const text = await readFile(METRICS_FILE, "utf8");
    const rows = text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
    const tokens = rows.reduce((sum, row) => sum + (row.tokens ?? 0), 0);
    const readLines = rows.reduce((sum, row) => sum + (row.readLines ?? 0), 0);
    return { samples: rows.length, tokens, readLines, lastAt: rows.at(-1)?.at };
  } catch {
    return { samples: 0, tokens: 0, readLines: 0 };
  }
}


/** 把 stage=implemented 的包按验收事实拆成三个真实桶，避免"实现待验收"混装。 */
function packageStage(pkg) {
  const verification = pkg.verification ?? {};
  if (verification.humanAccepted === true) return "done";
  if (pkg.stage === "implemented") {
    if (verification.qaPassed === true && verification.applied === true) return "awaiting_accept";
    if (verification.qaPassed === true) return "awaiting_apply";
    return "unverified";
  }
  return pkg.stage ?? "proposed";
}

async function buildSnapshot() {
  const state = await readJson(STATE_FILE, undefined);
  if (!state) {
    process.stderr.write("缺少 state.json，先运行: node scripts/workflow/state.mjs import\n");
    process.exit(1);
  }
  const runtime = await readJson(RUNTIME_FILE, { agents: [], milestones: [], events: [] });
  const todos = await readTodos();
  const metrics = await readMetrics();

  const byStage = Object.fromEntries(STAGE_ORDER.map((stage) => [stage, 0]));
  const moduleMap = new Map();
  for (const pkg of state.packages) {
    const displayStage = packageStage(pkg);
    byStage[displayStage] = (byStage[displayStage] ?? 0) + 1;
    if (pkg.archived) continue;
    const bucket = moduleMap.get(pkg.module) ?? 0;
    moduleMap.set(pkg.module, bucket + 1);
  }

  return {
    generatedAt: new Date().toISOString(),
    batch: state.batch,
    counts: { total: state.packages.length, byStage, modules: [...moduleMap.entries()].map(([name, total]) => ({ name, total })) },
    packages: state.packages
      .filter((pkg) => !pkg.archived)
      .map((pkg) => ({
        id: pkg.id,
        type: pkg.type,
        owner: pkg.owner,
        priority: pkg.priority,
        stage: packageStage(pkg),
        rawStage: pkg.stage,
        module: pkg.module,
        evidence: pkg.evidence.length,
        note: pkg.note,
      })),
    archived: state.packages
      .filter((pkg) => pkg.archived)
      .map((pkg) => ({
        id: pkg.id,
        type: pkg.type,
        owner: pkg.owner,
        module: pkg.module,
        archivedAt: pkg.archivedAt,
        archiveReason: pkg.archiveReason,
        archiveEvidence: pkg.archiveEvidence,
        note: pkg.note,
      })),
    humanTodos: todos.items ?? [],
    agents: runtime.agents ?? [],
    milestones: state.batch?.slices ?? [],
    events: runtime.events ?? [],
    metrics,
    runtimeUpdatedAt: runtime.updatedAt,
  };
}

function renderHtml(snapshot, { live }) {
  const data = JSON.stringify(snapshot).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>P4Deck 工作流看板</title>
<style>
:root {
  color-scheme: light dark;
  --bg: #fbfbfa; --panel: #ffffff; --line: #e4e4e1; --text: #22221f; --muted: #6b6b64;
  --accent: #2f6f4f; --accent-soft: #e8f1ec;
  --warn: #8a5a00; --warn-soft: #fbf1dc; --danger: #9b2c2c; --danger-soft: #fbe9e9;
  --busy: #1f5f8b; --busy-soft: #e6f0f7; --idle: #6b6b64; --idle-soft: #efefec;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #161614; --panel: #1e1e1b; --line: #33332e; --text: #e8e8e2; --muted: #a0a099;
    --accent: #7fb596; --accent-soft: #22322a;
    --warn: #d8a752; --warn-soft: #332a17; --danger: #e08585; --danger-soft: #3a2020;
    --busy: #78b0d8; --busy-soft: #1b2b36; --idle: #9a9a92; --idle-soft: #262621;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text);
  font: 13px/1.45 "Segoe UI", "Microsoft YaHei", system-ui, sans-serif; }
.wrap { max-width: 1600px; margin: 0 auto; padding: 18px 20px 40px; }
header { display: flex; align-items: baseline; gap: 14px; flex-wrap: wrap;
  border-bottom: 1px solid var(--line); padding-bottom: 10px; }
h1 { font-size: 20px; margin: 0; letter-spacing: .2px; }
.batch { color: var(--muted); }
.batch b { color: var(--text); }
.stamp { margin-left: auto; color: var(--muted); font-size: 12px; }
h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .08em; color: var(--muted);
  margin: 22px 0 8px; font-weight: 600; }
.row { display: grid; gap: 10px; }
.agents { grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); }
.agent { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; }
.agent .top { display: flex; align-items: center; gap: 8px; }
.role { font-weight: 600; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--idle); flex: none; }
.dot.working { background: var(--busy); } .dot.waiting { background: var(--warn); }
.dot.blocked { background: var(--danger); } .dot.idle { background: var(--idle); }
.state { font-size: 11px; padding: 1px 7px; border-radius: 999px; background: var(--idle-soft); color: var(--muted); }
.state.working { background: var(--busy-soft); color: var(--busy); }
.state.waiting { background: var(--warn-soft); color: var(--warn); }
.state.blocked { background: var(--danger-soft); color: var(--danger); }
.agent .task { margin-top: 6px; font-weight: 600; }
.agent .detail { margin-top: 3px; color: var(--muted); font-size: 12px; }
.agent .since { margin-top: 6px; color: var(--muted); font-size: 11px; }
.milestones { display: flex; gap: 8px; flex-wrap: wrap; }
.ms { border: 1px solid var(--line); border-radius: 999px; padding: 5px 11px; background: var(--panel);
  display: flex; align-items: center; gap: 7px; font-size: 12px; cursor: default; }
.ms i { width: 7px; height: 7px; border-radius: 50%; background: var(--idle); display: inline-block; }
.ms.done i { background: var(--accent); } .ms.frozen i, .ms.qa_with_gap i, .ms.qa i { background: var(--busy); }
.ms.awaiting_apply i { background: var(--warn); } .ms.blocked i { background: var(--danger); }
.ms.in_progress i { background: var(--busy); } .ms.paused i { background: var(--idle); }
.ms small { color: var(--muted); }
.stats { display: flex; gap: 16px; flex-wrap: wrap; align-items: center; font-size: 12px; color: var(--muted); }
.bar { display: flex; height: 8px; width: 320px; border-radius: 999px; overflow: hidden; border: 1px solid var(--line); }
.bar span { display: block; height: 100%; }
.legend { display: flex; gap: 12px; flex-wrap: wrap; font-size: 11px; color: var(--muted); }
.legend i { width: 8px; height: 8px; border-radius: 2px; display: inline-block; margin-right: 4px; }
.toolbar { display: flex; gap: 10px; align-items: center; margin: 14px 0 0; }
input[type=search] { background: var(--panel); border: 1px solid var(--line); color: var(--text);
  border-radius: 6px; padding: 6px 10px; width: 260px; font: inherit; }
.hint { color: var(--muted); font-size: 11px; }
.board { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 10px;
  overflow-x: auto; padding-bottom: 8px; margin-top: 10px; }
.col { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; min-height: 120px;
  display: flex; flex-direction: column; }
.col > h3 { margin: 0; padding: 8px 10px; font-size: 12px; border-bottom: 1px solid var(--line);
  display: flex; justify-content: space-between; color: var(--muted); font-weight: 600; }
.col .cards { padding: 8px; display: flex; flex-direction: column; gap: 6px; }
.card { border: 1px solid var(--line); border-radius: 6px; padding: 7px 8px; background: var(--bg); }
.card .id { font-weight: 600; font-size: 12px; display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.card .meta { margin-top: 3px; color: var(--muted); font-size: 11px; display: flex; gap: 8px; flex-wrap: wrap; }
.todos { display: flex; flex-direction: column; gap: 6px; }
.todo { display: flex; align-items: baseline; gap: 9px; border: 1px solid var(--line); border-radius: 6px;
  padding: 7px 9px; background: var(--panel); cursor: pointer; }
.todo.done .todo-text { text-decoration: line-through; color: var(--muted); }
.todo-text { flex: 1 1 auto; }
.todo-meta { color: var(--muted); font-size: 11px; white-space: nowrap; }
.tag { font-size: 10px; padding: 0 5px; border-radius: 3px; border: 1px solid var(--line); color: var(--muted); }
.tag.bug { color: var(--danger); border-color: var(--danger); }
.tag.feature { color: var(--accent); border-color: var(--accent); }
.tag.p0 { color: var(--danger); border-color: var(--danger); }
.tag.p1 { color: var(--warn); border-color: var(--warn); }
.owner { white-space: nowrap; }
.empty { padding: 10px; color: var(--muted); font-size: 12px; }
footer { margin-top: 18px; color: var(--muted); font-size: 11px; border-top: 1px solid var(--line); padding-top: 10px; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>P4Deck 工作流看板</h1>
    <div class="batch">批次 <b id="batchId"></b> · <span id="batchGoal"></span></div>
    <div class="stamp">数据时间 <span id="stamp"></span><span id="liveMark"></span></div>
  </header>

  <h2>Agent 在忙什么</h2>
  <div class="row agents" id="agents"></div>

  <h2>批次里程碑</h2>
  <div class="milestones" id="milestones"></div>

  <h2>人类待办（只有你能勾）</h2>
  <div class="todos" id="todos"></div>

  <h2>任务状态分布</h2>
  <div class="stats">
    <div class="bar" id="bar"></div>
    <div class="legend" id="legend"></div>
    <div id="gate"></div>
  </div>

  <h2>任务看板（活跃 <span id="active"></span> · 总计 <span id="total"></span>）</h2>
  <div class="toolbar">
    <input type="search" id="filter" placeholder="按 ID / 负责人 / 模块过滤，例如 FE、CL-01、Shelf">
    <span class="hint">卡片标题为模块与范围，鼠标悬停可看剩余步骤。状态以 state.json 为准。</span>
  </div>
  <div class="board" id="board"></div>

  <h2>已完成归档（独立区域，不混在活跃看板）</h2>
  <div class="cards" id="archived"></div>

  <footer id="footer"></footer>
</div>
<script id="snapshot" type="application/json">${data}</script>
<script>
(function () {
  var LIVE = ${live ? "true" : "false"};
  var STAGE_ORDER = ${JSON.stringify(STAGE_ORDER)};
  var STAGE_LABELS = ${JSON.stringify(STAGE_LABELS)};
  var TYPE_LABELS = ${JSON.stringify(TYPE_LABELS)};
  var STAGE_COLOR = {
    "in-progress": "var(--busy)", blocked: "var(--danger)", implemented: "var(--accent)",
    "awaiting_accept": "var(--accent)", "awaiting_apply": "var(--warn)", unverified: "var(--muted)",
    partial: "var(--warn)", todo: "var(--idle)", proposed: "var(--idle)", done: "var(--muted)"
  };
  var AGENT_LABEL = { working: "工作中", waiting: "等待依赖", blocked: "阻塞", idle: "空闲" };
  var MS_LABEL = {
    done: "完成", frozen: "已冻结", qa_with_gap: "QA 有缺口", qa: "QA 中", todo: "待开始", awaiting_apply: "待应用",
    blocked: "阻塞", in_progress: "进行中", paused: "暂停"
  };
  var CURRENT = null;

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function fmt(iso) {
    if (!iso) return "—";
    var d = new Date(iso);
    return isNaN(d) ? iso : d.toLocaleString("zh-CN", { hour12: false });
  }

  function renderAgents(list) {
    var host = document.getElementById("agents");
    host.innerHTML = "";
    list.forEach(function (agent) {
      var card = el("div", "agent");
      var top = el("div", "top");
      top.appendChild(el("span", "dot " + (agent.status || "idle")));
      top.appendChild(el("span", "role", agent.role));
      top.appendChild(el("span", "state " + (agent.status || ""), AGENT_LABEL[agent.status] || agent.status));
      card.appendChild(top);
      card.appendChild(el("div", "task", agent.task || "—"));
      card.appendChild(el("div", "detail", agent.detail || ""));
      card.appendChild(el("div", "since", "自 " + fmt(agent.since)));
      host.appendChild(card);
    });
  }

  function renderMilestones(list) {
    var host = document.getElementById("milestones");
    host.innerHTML = "";
    list.forEach(function (ms) {
      var chip = el("div", "ms " + ms.status);
      chip.title = ms.note || "";
      chip.appendChild(el("i"));
      chip.appendChild(el("span", null, ms.label));
      chip.appendChild(el("small", null, MS_LABEL[ms.status] || ms.status));
      host.appendChild(chip);
    });
  }

  function renderStats(snapshot) {
    var bar = document.getElementById("bar");
    var legend = document.getElementById("legend");
    bar.innerHTML = ""; legend.innerHTML = "";
    var total = snapshot.counts.total || 1;
    STAGE_ORDER.forEach(function (stage) {
      var count = snapshot.counts.byStage[stage] || 0;
      if (!count) return;
      var seg = el("span");
      seg.style.width = (count / total * 100).toFixed(2) + "%";
      seg.style.background = STAGE_COLOR[stage];
      bar.appendChild(seg);
      var item = el("span");
      var swatch = el("i");
      swatch.style.background = STAGE_COLOR[stage];
      item.appendChild(swatch);
      item.appendChild(document.createTextNode(STAGE_LABELS[stage] + " " + count));
      legend.appendChild(item);
    });
    document.getElementById("total").textContent = snapshot.counts.total;
    var activeHost = document.getElementById("active");
    if (activeHost) activeHost.textContent = String(snapshot.packages.length);
    var gate = document.getElementById("gate");
    gate.textContent = "停机条件：" + (snapshot.batch.stopCondition || "—");
  }

  function renderBoard(snapshot, keyword) {
    var host = document.getElementById("board");
    host.innerHTML = "";
    var query = (keyword || "").trim().toLowerCase();
    STAGE_ORDER.forEach(function (stage) {
      var items = snapshot.packages.filter(function (pkg) {
        if (pkg.stage !== stage) return false;
        if (!query) return true;
        return [pkg.id, pkg.owner, pkg.module, pkg.note].join(" ").toLowerCase().indexOf(query) >= 0;
      });
      var col = el("div", "col");
      var head = el("h3");
      head.appendChild(el("span", null, STAGE_LABELS[stage]));
      head.appendChild(el("span", null, String(items.length)));
      col.appendChild(head);
      var cards = el("div", "cards");
      if (!items.length) cards.appendChild(el("div", "empty", "—"));
      items.forEach(function (pkg) {
        var card = el("div", "card");
        card.title = pkg.note || "";
        var id = el("div", "id");
        id.appendChild(document.createTextNode(pkg.id + (pkg.archived ? " †" : "")));
        if (pkg.type) id.appendChild(el("span", "tag " + pkg.type, TYPE_LABELS[pkg.type] || pkg.type));
        if (pkg.priority && /^P[01]$/.test(pkg.priority)) {
          id.appendChild(el("span", "tag " + pkg.priority.toLowerCase(), pkg.priority));
        }
        card.appendChild(id);
        var meta = el("div", "meta");
        meta.appendChild(el("span", "owner", pkg.owner || "—"));
        if (pkg.module) meta.appendChild(el("span", null, pkg.module));
        if (pkg.evidence) meta.appendChild(el("span", null, "证据 " + pkg.evidence));
        card.appendChild(meta);
        cards.appendChild(card);
      });
      col.appendChild(cards);
      host.appendChild(col);
    });
  }

  function todoLocal() {
    try { return JSON.parse(localStorage.getItem("p4deck-todos") || "{}"); } catch (error) { return {}; }
  }

  function renderTodos(snapshot) {
    var host = document.getElementById("todos");
    host.innerHTML = "";
    var items = snapshot.humanTodos || [];
    var hint = el("div", "hint", LIVE
      ? "勾选会写回 人类待办.json（只有用户能勾，Agent 不代勾）"
      : "静态模式：勾选只存这个浏览器；要持久化请用 --serve 或 DSH 面板");
    if (!items.length) {
      host.appendChild(el("div", "empty", "（暂无人类待办）"));
      return;
    }
    var local = LIVE ? {} : todoLocal();
    items.forEach(function (item) {
      var done = LIVE ? Boolean(item.done) : (Object.prototype.hasOwnProperty.call(local, item.id) ? Boolean(local[item.id]) : Boolean(item.done));
      var row = el("label", "todo" + (done ? " done" : ""));
      var box = document.createElement("input");
      box.type = "checkbox";
      box.checked = done;
      box.addEventListener("change", function () {
        if (LIVE) {
          fetch("/api/human-todos/toggle", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ id: item.id })
          }).then(function () { return fetch("/api/snapshot", { cache: "no-store" }); })
            .then(function (response) { return response.json(); })
            .then(render)
            .catch(function () {});
        } else {
          var map = todoLocal();
          map[item.id] = box.checked;
          try { localStorage.setItem("p4deck-todos", JSON.stringify(map)); } catch (error) {}
          row.className = "todo" + (box.checked ? " done" : "");
        }
      });
      row.appendChild(box);
      row.appendChild(el("span", "todo-text", item.text));
      row.appendChild(el("span", "todo-meta", item.id + (item.note ? " · " + item.note : "")));
      host.appendChild(row);
    });
    host.appendChild(hint);
  }

  function renderArchived(snapshot) {
    var host = document.getElementById("archived");
    host.innerHTML = "";
    var items = snapshot.archived || [];
    if (!items.length) {
      host.appendChild(el("div", "empty", "（暂无归档）"));
      return;
    }
    items.forEach(function (pkg) {
      var card = el("div", "card");
      card.title = pkg.note || "";
      var id = el("div", "id");
      id.appendChild(document.createTextNode(pkg.id));
      if (pkg.type) id.appendChild(el("span", "tag " + pkg.type, TYPE_LABELS[pkg.type] || pkg.type));
      card.appendChild(id);
      card.appendChild(el("div", "meta", "归档于 " + fmt(pkg.archivedAt) + " · " + (pkg.archiveReason || "历史迁移项")));
      if (pkg.archiveEvidence) card.appendChild(el("div", "meta", "证据 " + pkg.archiveEvidence));
      host.appendChild(card);
    });
  }

  function render(snapshot) {
    CURRENT = snapshot;
    document.getElementById("batchId").textContent = snapshot.batch.id;
    document.getElementById("batchGoal").textContent = snapshot.batch.goal;
    document.getElementById("stamp").textContent = fmt(snapshot.generatedAt);
    document.getElementById("liveMark").textContent = LIVE ? " · 实时（4s）" : "";
    renderAgents(snapshot.agents);
    renderMilestones(snapshot.milestones);
    renderTodos(snapshot);
    renderStats(snapshot);
    renderBoard(snapshot, document.getElementById("filter").value);
    renderArchived(snapshot);
    var m = snapshot.metrics || {};
    document.getElementById("footer").textContent =
      "来源：state.json（任务真值）· 运行状态.json（Agent/里程碑）· metrics.jsonl · 量测样本 " +
      (m.samples || 0) + " 条。状态由 LEAD 维护，任务改动走 state.json，不要直接改本页。";
  }

  document.getElementById("filter").addEventListener("input", function (event) {
    if (CURRENT) renderBoard(CURRENT, event.target.value);
  });

  render(JSON.parse(document.getElementById("snapshot").textContent));

  if (LIVE) {
    // 事件驱动：宿主 watch 三个数据文件，变了才推一条；不再轮询整份快照。
    var pollTimer;
    function refresh() {
      fetch("/api/snapshot", { cache: "no-store" })
        .then(function (response) { return response.json(); })
        .then(render)
        .catch(function () {});
    }
    function startPolling() {
      if (pollTimer) return;
      pollTimer = setInterval(function () {
        if (!document.hidden) refresh();
      }, 30000);
    }
    if (window.EventSource) {
      var source = new EventSource("/api/events");
      source.onmessage = function () { if (!document.hidden) refresh(); };
      source.onerror = function () { startPolling(); };
      document.addEventListener("visibilitychange", function () { if (!document.hidden) refresh(); });
    } else {
      startPolling();
    }
  }
})();
</script>
</body>
</html>
`;
}

async function writeStatic() {
  const snapshot = await buildSnapshot();
  await mkdir(WORKFLOW_DIR, { recursive: true });
  await writeFile(HTML_FILE, renderHtml(snapshot, { live: false }), "utf8");
  process.stdout.write(`已写入 ${path.relative(ROOT, HTML_FILE)}（双击可看）\n`);
}

function readBody(request) {
  return new Promise((resolve) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 64 * 1024) request.destroy();
    });
    request.on("end", () => resolve(body));
    request.on("error", () => resolve(""));
  });
}

function startServer(port) {
  const clients = new Set();
  let debounce;
  const broadcast = () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      for (const client of clients) {
        try {
          client.write("data: changed\n\n");
        } catch {
          clients.delete(client);
        }
      }
    }, 120);
  };
  for (const file of [STATE_FILE, RUNTIME_FILE, TODOS_FILE]) {
    if (!existsSync(file)) continue;
    try {
      const watcher = watch(file, { persistent: false }, broadcast);
      watcher.on("error", () => {});
    } catch {
      // 个别平台不允许 watch：忽略，前端有 30s 兜底轮询
    }
  }

  const server = createServer(async (request, response) => {
    try {
      if (request.url === "/api/events") {
        response.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-store",
          connection: "keep-alive",
        });
        response.write(": connected\n\n");
        clients.add(response);
        request.on("close", () => clients.delete(response));
        return;
      }
      if (request.method === "POST" && request.url === "/api/human-todos/toggle") {
        const raw = await readBody(request);
        let payload;
        try {
          payload = JSON.parse(raw || "{}");
        } catch {
          payload = {};
        }
        const result = await toggleTodo(payload.id);
        response.writeHead(result.ok ? 200 : 400, {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
        });
        response.end(JSON.stringify(result));
        return;
      }
      if (request.url === "/api/snapshot") {
        const snapshot = await buildSnapshot();
        response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        response.end(JSON.stringify(snapshot));
        return;
      }
      const snapshot = await buildSnapshot();
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      response.end(renderHtml(snapshot, { live: true }));
    } catch (error) {
      response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      response.end(String(error));
    }
  });
  server.listen(port, "127.0.0.1", () => {
    process.stdout.write(`看板服务: http://127.0.0.1:${port} （Ctrl+C 停止）\n`);
  });
}

const args = process.argv.slice(2);
if (args.includes("--json")) {
  process.stdout.write(`${JSON.stringify(await buildSnapshot(), null, 2)}\n`);
} else if (args.includes("--serve")) {
  const portIndex = args.indexOf("--port");
  const port = portIndex >= 0 ? Number(args[portIndex + 1]) : 1421;
  startServer(port);
} else {
  await writeStatic();
}
