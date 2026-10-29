#!/usr/bin/env node
// 可视化看板：把 state.json（任务状态）+ 运行状态.json（谁在忙什么）+ metrics 合成一个看板。
//
// 用法:
//   node scripts/workflow/board.mjs                生成 ForAIDoc/PM/工作流/看板.html（双击可看）
//   node scripts/workflow/board.mjs --serve        本地实时服务 http://127.0.0.1:1421（每 4 秒自刷）
//   node scripts/workflow/board.mjs --json         打印快照 JSON
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

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
  partial: "部分实现",
  todo: "待实现",
  proposed: "待确认",
  done: "已完成",
};
const STAGE_ORDER = ["in-progress", "blocked", "implemented", "partial", "todo", "proposed", "done"];
const TYPE_LABELS = { bug: "Bug", feature: "需求", refactor: "重构" };

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
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

async function buildSnapshot() {
  const state = await readJson(STATE_FILE, undefined);
  if (!state) {
    process.stderr.write("缺少 state.json，先运行: node scripts/workflow/state.mjs import\n");
    process.exit(1);
  }
  const runtime = await readJson(RUNTIME_FILE, { agents: [], milestones: [], events: [] });
  const metrics = await readMetrics();

  const byStage = Object.fromEntries(STAGE_ORDER.map((stage) => [stage, 0]));
  const moduleMap = new Map();
  for (const pkg of state.packages) {
    byStage[pkg.stage ?? "proposed"] = (byStage[pkg.stage ?? "proposed"] ?? 0) + 1;
    if (pkg.archived) continue;
    const bucket = moduleMap.get(pkg.module) ?? 0;
    moduleMap.set(pkg.module, bucket + 1);
  }

  return {
    generatedAt: new Date().toISOString(),
    batch: state.batch,
    counts: { total: state.packages.length, byStage, modules: [...moduleMap.entries()].map(([name, total]) => ({ name, total })) },
    packages: state.packages.map((pkg) => ({
      id: pkg.id,
      type: pkg.type,
      owner: pkg.owner,
      priority: pkg.priority,
      stage: pkg.stage,
      module: pkg.module,
      evidence: pkg.evidence.length,
      note: pkg.note,
      archived: Boolean(pkg.archived),
    })),
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
.board { display: grid; grid-template-columns: repeat(7, minmax(200px, 1fr)); gap: 10px;
  overflow-x: auto; padding-bottom: 8px; margin-top: 10px; }
.col { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; min-height: 120px;
  display: flex; flex-direction: column; }
.col > h3 { margin: 0; padding: 8px 10px; font-size: 12px; border-bottom: 1px solid var(--line);
  display: flex; justify-content: space-between; color: var(--muted); font-weight: 600; }
.col .cards { padding: 8px; display: flex; flex-direction: column; gap: 6px; }
.card { border: 1px solid var(--line); border-radius: 6px; padding: 7px 8px; background: var(--bg); }
.card .id { font-weight: 600; font-size: 12px; display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.card .meta { margin-top: 3px; color: var(--muted); font-size: 11px; display: flex; gap: 8px; flex-wrap: wrap; }
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

  <h2>任务状态分布</h2>
  <div class="stats">
    <div class="bar" id="bar"></div>
    <div class="legend" id="legend"></div>
    <div id="gate"></div>
  </div>

  <h2>任务看板（共 <span id="total"></span> 个主工作包）</h2>
  <div class="toolbar">
    <input type="search" id="filter" placeholder="按 ID / 负责人 / 模块过滤，例如 FE、CL-01、Shelf">
    <span class="hint">卡片标题为模块与范围，鼠标悬停可看剩余步骤。状态以 state.json 为准。</span>
  </div>
  <div class="board" id="board"></div>

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

  function render(snapshot) {
    CURRENT = snapshot;
    document.getElementById("batchId").textContent = snapshot.batch.id;
    document.getElementById("batchGoal").textContent = snapshot.batch.goal;
    document.getElementById("stamp").textContent = fmt(snapshot.generatedAt);
    document.getElementById("liveMark").textContent = LIVE ? " · 实时（4s）" : "";
    renderAgents(snapshot.agents);
    renderMilestones(snapshot.milestones);
    renderStats(snapshot);
    renderBoard(snapshot, document.getElementById("filter").value);
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
    setInterval(function () {
      fetch("/api/snapshot", { cache: "no-store" })
        .then(function (response) { return response.json(); })
        .then(render)
        .catch(function () {});
    }, 4000);
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

function startServer(port) {
  const server = createServer(async (request, response) => {
    try {
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
