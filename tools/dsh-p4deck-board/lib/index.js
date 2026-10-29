// P4Deck 工作流看板 —— dsh 宿主插件（同源只读路由，不碰 P4、不写原树）
//
// 路由：
//   GET /p4deck-board            → 302 到 /p4deck-board/
//   GET /p4deck-board/           → 看板页面（每 5 秒拉一次快照）
//   GET /p4deck-board/api/snapshot → JSON 快照（state.json + 运行状态.json + metrics）
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export const name = "p4deck-board";
export const inject = ["webServer"];

const ROUTE = "/p4deck-board";
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
const MS_LABEL = {
  done: "完成",
  frozen: "已冻结",
  qa_with_gap: "QA 有缺口",
  qa: "QA 中",
  todo: "待开始",
  awaiting_apply: "待应用",
  blocked: "阻塞",
  in_progress: "进行中",
  paused: "暂停",
};
const AGENT_LABEL = { working: "工作中", waiting: "等待依赖", blocked: "阻塞", idle: "空闲" };

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

async function readMetrics(workspace) {
  try {
    const text = await readFile(path.join(workspace, "artifacts", "workflow", "metrics.jsonl"), "utf8");
    const rows = text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
    return {
      samples: rows.length,
      tokens: rows.reduce((sum, row) => sum + (row.tokens ?? 0), 0),
      readLines: rows.reduce((sum, row) => sum + (row.readLines ?? 0), 0),
    };
  } catch {
    return { samples: 0, tokens: 0, readLines: 0 };
  }
}

/** 组合看板快照。state.json 是任务真值，运行状态.json 提供 Agent/里程碑。 */
export async function buildSnapshot(workspace) {
  const workflowDir = path.join(workspace, "ForAIDoc", "PM", "工作流");
  const state = await readJson(path.join(workflowDir, "state.json"), undefined);
  if (!state) throw new Error(`找不到 ${path.join(workflowDir, "state.json")}`);
  const runtime = await readJson(path.join(workflowDir, "运行状态.json"), { agents: [], milestones: [], events: [] });
  const todos = await readJson(path.join(workflowDir, "人类待办.json"), { items: [] });
  const metrics = await readMetrics(workspace);

  const byStage = Object.fromEntries(STAGE_ORDER.map((stage) => [stage, 0]));
  const modules = new Map();
  for (const pkg of state.packages) {
    const stage = pkg.stage ?? "proposed";
    byStage[stage] = (byStage[stage] ?? 0) + 1;
    if (!pkg.archived) modules.set(pkg.module, (modules.get(pkg.module) ?? 0) + 1);
  }

  return {
    generatedAt: new Date().toISOString(),
    batch: state.batch,
    counts: { total: state.packages.length, byStage, modules: [...modules.entries()].map(([mod, total]) => ({ name: mod, total })) },
    packages: state.packages
      .filter((pkg) => !pkg.archived)
      .map((pkg) => ({
        id: pkg.id,
        type: pkg.type,
        owner: pkg.owner,
        priority: pkg.priority,
        stage: pkg.stage,
        module: pkg.module,
        evidence: (pkg.evidence ?? []).length,
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

function pageHtml() {
  const meta = JSON.stringify({ stageLabels: STAGE_LABELS, stageOrder: STAGE_ORDER, msLabel: MS_LABEL, agentLabel: AGENT_LABEL });
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>P4Deck 工作流看板</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{color-scheme:light dark;--bg:#fbfbfa;--panel:#fff;--line:#e4e4e1;--text:#22221f;--muted:#6b6b64;
--accent:#2f6f4f;--warn:#8a5a00;--danger:#9b2c2c;--busy:#1f5f8b;--idle:#6b6b64}
@media(prefers-color-scheme:dark){:root{--bg:#161614;--panel:#1e1e1b;--line:#33332e;--text:#e8e8e2;--muted:#a0a099;
--accent:#7fb596;--warn:#d8a752;--danger:#e08585;--busy:#78b0d8;--idle:#9a9a92}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);
font:13px/1.45 "Segoe UI","Microsoft YaHei",system-ui,sans-serif}
.wrap{max-width:1500px;margin:0 auto;padding:18px 20px 40px}
header{display:flex;align-items:baseline;gap:14px;flex-wrap:wrap;border-bottom:1px solid var(--line);padding-bottom:10px}
h1{font-size:20px;margin:0}.muted{color:var(--muted)}.stamp{margin-left:auto;font-size:12px;color:var(--muted)}
h2{font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin:20px 0 8px}
.agents{display:grid;gap:10px;grid-template-columns:repeat(auto-fit,minmax(240px,1fr))}
.agent{border:1px solid var(--line);border-radius:8px;padding:10px 12px;background:var(--panel)}
.agent .top{display:flex;gap:8px;align-items:center}
.dot{width:8px;height:8px;border-radius:50%;background:var(--idle)}
.dot.working{background:var(--busy)}.dot.waiting{background:var(--warn)}.dot.blocked{background:var(--danger)}
.role{font-weight:600}.badge{font-size:11px;color:var(--muted);border:1px solid var(--line);border-radius:999px;padding:1px 7px}
.task{margin-top:6px;font-weight:600}.detail{margin-top:3px;color:var(--muted);font-size:12px}
.ms{display:flex;gap:8px;flex-wrap:wrap}
.chip{border:1px solid var(--line);border-radius:999px;padding:5px 11px;background:var(--panel);font-size:12px}
.chip i{width:7px;height:7px;border-radius:50%;display:inline-block;margin-right:6px;background:var(--idle)}
.chip.done i{background:var(--accent)}.chip.frozen i,.chip.qa_with_gap i,.chip.in_progress i,.chip.qa i{background:var(--busy)}
.chip.awaiting_apply i{background:var(--warn)}.chip.blocked i{background:var(--danger)}
.board{display:grid;grid-template-columns:repeat(7,minmax(190px,1fr));gap:10px;overflow-x:auto}
.col{background:var(--panel);border:1px solid var(--line);border-radius:8px;min-height:100px}
.col h3{margin:0;padding:8px 10px;font-size:12px;color:var(--muted);border-bottom:1px solid var(--line);
display:flex;justify-content:space-between}
.cards{padding:8px;display:flex;flex-direction:column;gap:6px}
.todos{display:flex;flex-direction:column;gap:6px}
.todo{display:flex;align-items:baseline;gap:8px;border:1px solid var(--line);border-radius:6px;padding:7px 9px;background:var(--panel);cursor:pointer}
.todo.done .todo-text{text-decoration:line-through;color:var(--muted)}
.todo-text{flex:1 1 auto}.todo-meta{color:var(--muted);font-size:11px;white-space:nowrap}
.card{border:1px solid var(--line);border-radius:6px;padding:7px 8px;background:var(--bg)}
.card .id{font-weight:600;font-size:12px}.card .meta{margin-top:3px;color:var(--muted);font-size:11px}
.tag{font-size:10px;border:1px solid var(--line);border-radius:3px;padding:0 5px;margin-left:6px;color:var(--muted)}
.tag.bug{color:var(--danger);border-color:var(--danger)}.tag.feature{color:var(--accent);border-color:var(--accent)}
footer{margin-top:18px;border-top:1px solid var(--line);padding-top:10px;color:var(--muted);font-size:11px}
</style></head><body><div class="wrap">
<header><h1>P4Deck 工作流看板</h1>
<div class="muted">批次 <b id="batch"></b></div>
<div class="stamp">数据时间 <span id="stamp"></span></div></header>
<h2>Agent 在忙什么</h2><div class="agents" id="agents"></div>
<h2>批次里程碑</h2><div class="ms" id="milestones"></div>
<h2>人类待办（只有你能勾）</h2><div class="todos" id="todos"></div>
<h2>任务看板（活跃 <span id="active"></span> · 总计 <span id="total"></span>）</h2><div class="board" id="board"></div>
<h2>已完成归档（独立区域）</h2><div class="cards" id="archived"></div>
<footer id="footer"></footer></div>
<script>
var META=${meta};
function el(t,c,x){var n=document.createElement(t);if(c)n.className=c;if(x!==undefined)n.textContent=x;return n;}
function fmt(s){if(!s)return "—";var d=new Date(s);return isNaN(d)?s:d.toLocaleString("zh-CN",{hour12:false});}
function renderTodos(s){
 var host=document.getElementById("todos");host.innerHTML="";
 var items=s.humanTodos||[];
 if(!items.length){host.appendChild(el("div","empty","（暂无人类待办）"));return;}
 items.forEach(function(t){var row=el("label","todo"+(t.done?" done":""));
  var box=document.createElement("input");box.type="checkbox";box.checked=!!t.done;
  box.addEventListener("change",function(){
   fetch("${ROUTE}/api/human-todos/toggle",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({id:t.id})})
    .then(function(){return fetch("${ROUTE}/api/snapshot",{cache:"no-store"});})
    .then(function(r){return r.json();}).then(render).catch(function(){});
  });
  row.appendChild(box);row.appendChild(el("span","todo-text",t.text));
  row.appendChild(el("span","todo-meta",t.id+(t.note?" · "+t.note:"")));host.appendChild(row);});
 var hint=el("div","hint","勾选会写回 人类待办.json（只有用户能勾）");host.appendChild(hint);
}
function renderArchived(s){
 var host=document.getElementById("archived");host.innerHTML="";
 var items=s.archived||[];
 if(!items.length){host.appendChild(el("div","empty","（暂无归档）"));return;}
 items.forEach(function(p){var c=el("div","card");c.title=p.note||"";
  var id=el("div","id");id.appendChild(document.createTextNode(p.id));
  if(p.type){id.appendChild(el("span","tag "+p.type,p.type));}c.appendChild(id);
  c.appendChild(el("div","meta","归档于 "+fmt(p.archivedAt)+" · "+(p.archiveReason||"历史迁移项")));
  host.appendChild(c);});
}
function render(s){
 document.getElementById("batch").textContent=s.batch.id;
 document.getElementById("stamp").textContent=fmt(s.generatedAt);
 document.getElementById("total").textContent=s.counts.total;
 document.getElementById("active").textContent=String((s.packages||[]).length);
 renderTodos(s);
 var a=document.getElementById("agents");a.innerHTML="";
 s.agents.forEach(function(g){var c=el("div","agent");var top=el("div","top");
  top.appendChild(el("span","dot "+(g.status||"idle")));top.appendChild(el("span","role",g.role));
  top.appendChild(el("span","badge",META.agentLabel[g.status]||g.status));c.appendChild(top);
  c.appendChild(el("div","task",g.task||"—"));c.appendChild(el("div","detail",g.detail||""));a.appendChild(c);});
 var m=document.getElementById("milestones");m.innerHTML="";
 s.milestones.forEach(function(x){var c=el("div","chip "+x.status);c.title=x.note||"";
  c.appendChild(el("i"));c.appendChild(document.createTextNode(x.label+" · "+(META.msLabel[x.status]||x.status)));m.appendChild(c);});
 var b=document.getElementById("board");b.innerHTML="";
 META.stageOrder.forEach(function(stage){var items=s.packages.filter(function(p){return p.stage===stage;});
  var col=el("div","col");var h=el("h3");h.appendChild(el("span",null,META.stageLabels[stage]));
  h.appendChild(el("span",null,String(items.length)));col.appendChild(h);
  var cards=el("div","cards");
  items.forEach(function(p){var c=el("div","card");c.title=p.note||"";
   var id=el("div","id");id.appendChild(document.createTextNode(p.id));
   if(p.type){id.appendChild(el("span","tag "+p.type,p.type));}c.appendChild(id);
   c.appendChild(el("div","meta",(p.owner||"—")+" · "+(p.priority||"")+" · 证据 "+(p.evidence||0)));cards.appendChild(c);});
  col.appendChild(cards);b.appendChild(col);});
 renderArchived(s);
 document.getElementById("footer").textContent="来源：state.json（真值）· 运行状态.json · 人类待办.json；每 5 秒自动刷新。";
}
function tick(){fetch("${ROUTE}/api/snapshot",{cache:"no-store"}).then(function(r){return r.json();}).then(render)
 .catch(function(e){document.getElementById("footer").textContent="读取失败: "+e;});}
tick();setInterval(tick,5000);
</script></body></html>`;
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(body);
}

function makeHandler(workspace) {
  return async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === `${ROUTE}/api/human-todos/toggle`) {
      if (req.method !== "POST") {
        res.writeHead(405, { allow: "POST" });
        res.end();
        return;
      }
      let raw = "";
      req.on("data", (chunk) => {
        raw += chunk;
        if (raw.length > 64 * 1024) req.destroy();
      });
      req.on("end", async () => {
        try {
          const payload = JSON.parse(raw || "{}");
          const result = await toggleTodoFile(workspace, payload.id);
          sendJson(res, result.ok ? 200 : 400, result);
        } catch (error) {
          sendJson(res, 400, { ok: false, reason: String(error?.message ?? error) });
        }
      });
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { allow: "GET, HEAD" });
      res.end();
      return;
    }
    if (url.pathname === `${ROUTE}/api/snapshot`) {
      try {
        sendJson(res, 200, await buildSnapshot(workspace));
      } catch (error) {
        sendJson(res, 503, { error: String(error?.message ?? error) });
      }
      return;
    }
    if (url.pathname === `${ROUTE}/` || url.pathname === ROUTE) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(pageHtml());
      return;
    }
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("not found");
  };
}

/** 只有用户能勾选：面板 POST 回来时直接写 人类待办.json。 */
async function toggleTodoFile(workspace, id) {
  const file = path.join(workspace, "ForAIDoc", "PM", "工作流", "人类待办.json");
  const doc = await readJson(file, { items: [] });
  const item = (doc.items ?? []).find((entry) => entry.id.toUpperCase() === String(id ?? "").toUpperCase());
  if (!item) return { ok: false, reason: `没有待办 ${id}` };
  item.done = !item.done;
  item.doneAt = item.done ? new Date().toISOString() : null;
  doc.updatedAt = new Date().toISOString();
  await writeFile(file, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
  return { ok: true, item };
}

/** cordis 宿主插件入口。 */
export function apply(ctx, config = {}) {
  const workspace = config.workspace ?? "D:\\GitCode\\P4Deck";
  const handler = makeHandler(workspace);
  ctx.effect(() => {
    const disposePage = ctx.webServer.register({ kind: "prefix", path: `${ROUTE}/`, handler });
    const disposeExact = ctx.webServer.register({ kind: "exact", path: ROUTE, handler });
    return () => {
      disposeExact();
      disposePage();
    };
  });
}
