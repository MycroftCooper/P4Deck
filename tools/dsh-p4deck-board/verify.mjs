// 重启后的 10 秒自检：自动找到 DSH 的监听端口，探测看板路由。
// 用法: node tools/dsh-p4deck-board/verify.mjs
import { execFileSync } from "node:child_process";
import http from "node:http";
import process from "node:process";

function pidsOf() {
  const text = execFileSync("tasklist", ["/FO", "CSV", "/NH"], { encoding: "utf8" });
  const pids = new Set();
  for (const line of text.split(/\r?\n/)) {
    if (!line.toLowerCase().includes("deepseek harness")) continue;
    const cells = line.split('","');
    const pid = cells[1]?.replace(/"/g, "").trim();
    if (pid && /^\d+$/.test(pid)) pids.add(pid);
  }
  return pids;
}

function listeningPorts(pids) {
  const text = execFileSync("netstat", ["-ano"], { encoding: "utf8" });
  const ports = new Set();
  for (const line of text.split(/\r?\n/)) {
    if (!line.includes("LISTENING")) continue;
    const cells = line.trim().split(/\s+/);
    const local = cells[1];
    const pid = cells.at(-1);
    if (!pids.has(pid)) continue;
    const port = Number(local.split(":").at(-1));
    if (port > 0) ports.add(port);
  }
  return [...ports].sort((a, b) => a - b);
}

function probe(port, path) {
  return new Promise((resolve) => {
    const request = http.get({ host: "127.0.0.1", port, path, timeout: 2000 }, (response) => {
      let body = "";
      response.on("data", (chunk) => {
        if (body.length < 4096) body += chunk;
      });
      response.on("end", () => resolve({ status: response.statusCode, body }));
      response.resume();
    });
    request.on("timeout", () => {
      request.destroy();
      resolve({ status: "TIMEOUT", body: "" });
    });
    request.on("error", (error) => resolve({ status: error.code ?? "ERR", body: "" }));
  });
}

const pids = pidsOf();
if (!pids.size) {
  console.log("没有找到 DeepSeek Harness 进程（应用没在运行）");
  process.exit(1);
}
const ports = listeningPorts(pids);
console.log(`DSH 进程: ${[...pids].join(", ")} | 监听端口: ${ports.join(", ") || "(无)"}`);

let ok = false;
for (const port of ports) {
  const page = await probe(port, "/p4deck-board");
  const api = await probe(port, "/p4deck-board/api/snapshot");
  const html = Number(page.status) === 200;
  const json = Number(api.status) === 200;
  const newButtons = html && page.body.includes("验收完成");
  const hasScope = json && api.body.includes('"scope"');
  console.log(
    `  :${port}  /p4deck-board=${page.status}  /api/snapshot=${api.status}  验收按钮=${newButtons ? "有" : "无"}  功能名=${hasScope ? "有" : "无"}`,
  );
  if (html && json) {
    ok = true;
    console.log(`\n看板入口: http://127.0.0.1:${port}/p4deck-board`);
    if (!newButtons || !hasScope) {
      console.log("  提示：路由通了但跑的还是旧插件代码；重启 DSH 后才会出现「验收完成/取消」按钮和功能名。");
    }
  }
}

if (!ok) {
  console.log(`
未就绪。判定规则：
  - 两个都 404 → 宿主插件没加载（确认真的重启过：进程启动时间要变）
  - page=200 但 api=404 → 跑的还是旧代码（前缀路由 bug），需要重启到最新代码
  - page=200 且 api=500/503 → 路由通了但读数据失败，看返回内容`);
  process.exit(1);
}
