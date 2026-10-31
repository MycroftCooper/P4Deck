#!/usr/bin/env node
// 人类待办：给用户勾选的清单。Agent 只读/建议，不代勾。
//
// 用法:
//   node scripts/workflow/human-todos.mjs                列表
//   node scripts/workflow/human-todos.mjs add "标题" [--note "说明"]
//   node scripts/workflow/human-todos.mjs toggle T01
//   node scripts/workflow/human-todos.mjs done T01 | undone T01
//   node scripts/workflow/human-todos.mjs remove T02
//   node scripts/workflow/human-todos.mjs --json
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { completionMap, dependentsOf, isTaskSatisfied, readinessMap } from "./deps.mjs";
const stripBom = (text) => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const TODOS_FILE = process.env.P4DECK_TODOS ?? path.join(ROOT, "ForAIDoc", "PM", "工作流", "人类待办.json");
const STATE_FILE = process.env.P4DECK_STATE ?? path.join(ROOT, "ForAIDoc", "PM", "工作流", "state.json");

export async function readTodos(file = TODOS_FILE) {
  try {
    return JSON.parse(stripBom(await readFile(file, "utf8")));
  } catch {
    return { schemaVersion: 1, updatedAt: new Date().toISOString(), items: [] };
  }
}

export async function writeTodos(doc, file = TODOS_FILE) {
  doc.updatedAt = new Date().toISOString();
  await writeFile(file, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
  return doc;
}

export function nextId(items) {
  const used = new Set(items.map((item) => item.id));
  for (let index = 1; index < 1000; index += 1) {
    const id = `T${String(index).padStart(2, "0")}`;
    if (!used.has(id)) return id;
  }
  throw new Error("待办 id 用尽");
}

export async function toggleTodo(id, file = TODOS_FILE, force) {
  const doc = await readTodos(file);
  const item = doc.items.find((entry) => entry.id.toUpperCase() === String(id).toUpperCase());
  if (!item) return { ok: false, reason: `没有待办 ${id}` };
  const target = typeof force === "boolean" ? force : !item.done;
  item.done = target;
  item.doneAt = target ? new Date().toISOString() : null;
  await writeTodos(doc, file);
  return { ok: true, item };
}

/** 依赖链影响：这个人类待办完成/取消后，哪些下游任务解锁/重新阻塞。 */
export async function chainImpact(todoId, { todos, beforeDone, stateFile = STATE_FILE } = {}) {
  let state;
  try {
    state = JSON.parse(stripBom(await readFile(stateFile, "utf8")));
  } catch {
    return { unlocked: [], blocked: [] };
  }
  const packages = state.packages ?? [];
  const entries = [...packages, ...(state.subitems ?? [])];
  const completion = completionMap(entries);
  const dependents = dependentsOf(todoId, entries).filter(
    (pkg) => !pkg.archived && !(completion.get(pkg.id)?.satisfied ?? isTaskSatisfied(pkg)),
  );
  if (!dependents.length) return { unlocked: [], blocked: [] };
  const currentTodos = todos ?? (await readTodos());
  const beforeTodos = {
    ...currentTodos,
    items: (currentTodos.items ?? []).map((item) =>
      item.id.toUpperCase() === String(todoId).toUpperCase() ? { ...item, done: beforeDone } : item,
    ),
  };
  const before = readinessMap(entries, beforeTodos);
  const after = readinessMap(entries, currentTodos);
  const unlocked = dependents.filter((pkg) => !before.get(pkg.id)?.ready && after.get(pkg.id)?.ready).map((pkg) => pkg.id);
  const blocked = dependents.filter((pkg) => before.get(pkg.id)?.ready && !after.get(pkg.id)?.ready).map((pkg) => pkg.id);
  return { unlocked, blocked };
}

/** 勾选后刷新静态看板（失败不影响勾选本身）。 */
export function refreshBoards() {
  for (const [script, args] of [
    ["state.mjs", ["board"]],
    ["board.mjs", []],
  ]) {
    const result = spawnSync(process.execPath, [path.join("scripts", "workflow", script), ...args], {
      cwd: ROOT,
      encoding: "utf8",
    });
    if (result.status !== 0) return false;
  }
  return true;
}

function argsParse(argv) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--note") {
      args.note = String(argv[index + 1] ?? "");
      index += 1;
    } else if (token === "--json") {
      args.json = true;
    } else if (token === "--all") {
      args.all = true;
    } else if (token === "--no-board") {
      args.noBoard = true;
    } else if (!token.startsWith("--")) {
      args._.push(token);
    }
  }
  return args;
}

async function main() {
const [command = "list", ...rest] = process.argv.slice(2);
const args = argsParse(rest);
const doc = await readTodos();

if (command === "list" || command === "--json" || args.json) {
  if (args.json || command === "--json") {
    process.stdout.write(`${JSON.stringify(doc, null, 2)}\n`);
  } else {
    const items = args.all ? doc.items : doc.items.filter((item) => !item.done);
    const hidden = doc.items.length - items.length;
    if (!items.length) process.stdout.write("（没有未完成的人类待办）\n");
    for (const item of items) {
      process.stdout.write(`${item.done ? "[x]" : "[ ]"} ${item.id}  ${item.text}${item.note ? `  — ${item.note}` : ""}\n`);
    }
    if (hidden > 0) process.stdout.write(`（已勾选 ${hidden} 项，已从阻塞链移除；用 --all 查看）\n`);
  }
} else if (command === "add") {
  const text = args._.join(" ").trim();
  if (!text) {
    process.stderr.write('用法: human-todos.mjs add "标题" [--note "说明"]\n');
    process.exit(2);
  }
  const id = nextId(doc.items);
  const item = {
    id,
    text,
    done: false,
    createdAt: new Date().toISOString(),
    doneAt: null,
    note: args.note ?? "",
  };
  doc.items.push(item);
  await writeTodos(doc);
  process.stdout.write(`已添加 ${id}: ${text}\n`);
} else if (command === "toggle" || command === "done" || command === "undone") {
  const id = args._[0];
  if (!id) {
    process.stderr.write("用法: human-todos.mjs toggle <ID>\n");
    process.exit(2);
  }
  const force = command === "done" ? true : command === "undone" ? false : undefined;
  const result = await toggleTodo(id, TODOS_FILE, force);
  if (!result.ok) {
    process.stderr.write(`${result.reason}\n`);
    process.exit(1);
  }
  process.stdout.write(`${result.item.done ? "已完成" : "已取消"} ${result.item.id}: ${result.item.text}\n`);
  const afterDoc = await readTodos();
  const impact = await chainImpact(result.item.id, { todos: afterDoc, beforeDone: !result.item.done });
  if (impact.unlocked.length) process.stdout.write(`解锁下游任务：${impact.unlocked.join("、")}\n`);
  if (impact.blocked.length) process.stdout.write(`重新阻塞下游任务：${impact.blocked.join("、")}\n`);
  if (result.item.done) process.stdout.write(`已从看板阻塞链移除 ${result.item.id}（记录保留用于审计）\n`);
  if (!args.noBoard && refreshBoards()) process.stdout.write("看板已刷新。\n");
} else if (command === "remove") {
  const id = String(args._[0] ?? "").toUpperCase();
  const before = doc.items.length;
  doc.items = doc.items.filter((item) => item.id.toUpperCase() !== id);
  if (doc.items.length === before) {
    process.stderr.write(`没有待办 ${id}\n`);
    process.exit(1);
  }
  await writeTodos(doc);
  process.stdout.write(`已删除 ${id}\n`);
} else {
  process.stderr.write("用法: human-todos.mjs <list|add|toggle|done|undone|remove> ...\n");
  process.exit(2);
}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
