// 客户端插件自测：用假 window/假 require 加载真实 bundle，再用 react-dom/server 渲染。
// 用法: node tools/dsh-p4deck-board/selftest-client.mjs
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { buildSnapshot } from "./lib/index.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE = path.resolve(HERE, "..", "..");
const requireFromRepo = createRequire(path.join(WORKSPACE, "package.json"));
const react = requireFromRepo("react");
const { renderToStaticMarkup } = requireFromRepo("react-dom/server");

const checks = [];
function check(name, ok, detail = "") {
  checks.push({ name, ok, detail });
  process.stdout.write(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}\n`);
}

// 1) 载入 bundle（模拟 dsh 的 ModuleLoader 与 require）
let loaded;
globalThis.window = {
  __ModuleLoader__: {
    load(config) {
      loaded = config;
    },
  },
};
const source = await readFile(path.join(HERE, "lib", "client.js"), "utf8");
new Function(source)();
check("bundle 注册到 ModuleLoader", Boolean(loaded && loaded.factory), loaded?.id);
check("包 id 正确", loaded?.id === "dsh-p4deck-board", loaded?.id);

const module = loaded.factory((name) => requireFromRepo(name));
check("导出 apply", typeof module.apply === "function");
check("导出 inject 含 sidebarRightTabs", Array.isArray(module.inject) && module.inject.includes("sidebarRightTabs"), module.inject?.join(","));

// 2) 假 ctx：收集注册
const tabTypes = [];
const slotRegistrations = [];
const commands = [];
const opened = [];
const ctx = {
  sidebarRightTabs: {
    register(definition) {
      tabTypes.push(definition);
      return () => {};
    },
  },
  sidebarRight: {
    commandTarget() {
      return undefined;
    },
    openTab(kind) {
      opened.push(kind);
    },
    openTabFromTarget(kind) {
      opened.push(kind);
    },
  },
  shortcuts: {
    register(definition) {
      commands.push(definition);
      return () => {};
    },
  },
  slots: {
    inject(_name, factory) {
      return factory();
    },
    register(declaration, component) {
      slotRegistrations.push({ declaration, component });
      return () => {};
    },
  },
  inject(names, factory) {
    return factory(ctx);
  },
  effect(fn) {
    return fn();
  },
};
module.apply(ctx);

check("注册了标签类型", tabTypes.length === 1, tabTypes[0]?.kind);
const tab = tabTypes[0] ?? {};
check("标签类型 kind/id", tab.kind === "p4deckBoard" && tab.id === "dsh-p4deck-board", `${tab.kind}/${tab.id}`);
check("标签类型有 guide 入口", Array.isArray(tab.guide) && tab.guide.length === 1, tab.guide?.[0]?.title?.());
check("guide 条目挂 commandId", tab.guide?.[0]?.commandId === "p4deck.board", tab.guide?.[0]?.commandId);
check("注册了命令 p4deck.board", commands.some((command) => command.id === "p4deck.board"));
const command = commands[0] ?? {};
const resolved = command.resolve?.({ target: undefined });
check("命令 resolve 返回 handled", resolved?.status === "handled", resolved?.status);
resolved?.run?.();
check("命令打开看板标签", opened.includes("p4deckBoard"), opened.join(","));
check("注册了主体插槽", slotRegistrations.some((entry) => entry.declaration.name === "sidebar.right.pane.tab" && entry.declaration.key === "dsh-p4deck-board"));
check("注册了标题插槽", slotRegistrations.some((entry) => entry.declaration.name === "sidebar.right.pane.tab.title"));

// 3) 用真实 react-dom 渲染纯视图
const snapshot = await buildSnapshot(WORKSPACE);
const html = renderToStaticMarkup(react.createElement(module.BoardView, { snapshot, status: "ready", error: null }));
check("渲染出标题", html.includes("工作流看板"));
check("渲染出主工作包计数", /共 \d+ 个主工作包/.test(html), "");
check("渲染出 Agent（LEAD/BE）", html.includes("LEAD") && html.includes("BE"));
check("渲染出里程碑", html.includes("CON06") || html.includes("批次里程碑"));
check("渲染出任务卡（CL-01/UI-07）", html.includes("CL-01") || html.includes("UI-07"));
check("渲染出人类待办", html.includes("人类待办") && html.includes("T01"));
check("渲染出已完成归档", html.includes("已完成归档"));
check("无数据时显示加载态", renderToStaticMarkup(react.createElement(module.BoardView, { snapshot: null, status: "loading", error: null })).includes("正在读取"));
check("出错时显示错误态", renderToStaticMarkup(react.createElement(module.BoardView, { snapshot: null, status: "error", error: "HTTP 503" })).includes("HTTP 503"));

const failed = checks.filter((entry) => !entry.ok);
process.stdout.write(`\n${checks.length - failed.length}/${checks.length} 通过\n`);
if (failed.length) process.exitCode = 1;
