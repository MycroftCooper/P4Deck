#!/usr/bin/env node
// 依赖链纯函数自测：不碰真实 state/工作树。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  dependentsOf,
  findDependencyCycles,
  isHumanDep,
  isTaskSatisfied,
  readinessMap,
  sortReady,
  taskReadiness,
  todoIndex,
} from "./deps.mjs";
import { chainImpact } from "./human-todos.mjs";

const pkg = (id, extra = {}) => ({
  id,
  stage: "todo",
  deps: [],
  archived: false,
  verification: { qaPassed: null, applied: null, humanAccepted: null },
  ...extra,
});
const todos = (items) => ({ schemaVersion: 1, items });

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const TODO_FIXTURE = `# fixture

共 **1** 项

## 唯一任务表

| ID | 类型 | 负责人 | 模块 / 范围 | 状态 | 优先级 | 证据路径 | 剩余步骤与验收标准 | 依赖 |
|---|---|---|---|---|---|---|---|---|
| PKG-01 | 功能需求 | FE | 测试：依赖人类待办 | 待实现 | P1 | — | x | T01 |
`;

function run() {
  assert.equal(isHumanDep("T04"), true);
  assert.equal(isHumanDep("PKG-01"), false);

  assert.equal(isTaskSatisfied(pkg("A", { stage: "done" })), true);
  assert.equal(isTaskSatisfied(pkg("A", { archived: true })), true);
  assert.equal(isTaskSatisfied(pkg("A", { verification: { humanAccepted: true } })), true);
  assert.equal(isTaskSatisfied(pkg("A")), false);

  const packages = [pkg("A", { stage: "done" }), pkg("B", { deps: ["A"] }), pkg("C", { deps: ["B", "T04"] })];
  const ready = readinessMap(packages, todos([{ id: "T04", done: false }]));
  assert.equal(ready.get("A").ready, true);
  assert.equal(ready.get("B").ready, true);
  assert.equal(ready.get("C").ready, false);
  assert.deepEqual(ready.get("C").waiting, [
    { id: "B", kind: "task", state: "todo" },
    { id: "T04", kind: "human", state: "open" },
  ]);

  const withDoneTodo = readinessMap(packages, todos([{ id: "T04", done: true }]));
  assert.equal(withDoneTodo.get("C").ready, false, "B 仍未完成");
  const withDoneB = readinessMap(
    packages.map((entry) => (entry.id === "B" ? { ...entry, stage: "done" } : entry)),
    todos([{ id: "T04", done: true }]),
  );
  assert.equal(withDoneB.get("C").ready, true);

  const missing = taskReadiness(pkg("X", { deps: ["T99", "NOPE-1"] }), new Map(), new Map());
  assert.equal(missing.ready, false);
  assert.deepEqual(missing.waiting.map((item) => item.kind), ["missing", "missing"]);

  const deps = [pkg("A"), pkg("B", { deps: ["A"] }), pkg("C", { deps: ["B"] }), pkg("H", { deps: ["T01"] })];
  assert.deepEqual(dependentsOf("A", deps).map((entry) => entry.id), ["B"]);
  assert.deepEqual(dependentsOf("t01", deps).map((entry) => entry.id), ["H"]);

  const cyclic = [pkg("A", { deps: ["B"] }), pkg("B", { deps: ["A"] })];
  assert.equal(findDependencyCycles(cyclic).length > 0, true);
  assert.equal(findDependencyCycles(deps).length, 0);

  assert.deepEqual(
    sortReady(
      [pkg("P2", { priority: "P2" }), pkg("P0", { priority: "P0" }), pkg("DONE", { stage: "done" })],
      readinessMap([pkg("P2"), pkg("P0"), pkg("DONE", { stage: "done" })], todos([])),
    ).map((entry) => entry.id),
    ["P0", "P2"],
  );

  const index = todoIndex(todos([{ id: "T01", done: false }]));
  assert.equal(index.get("T01").done, false);
}

async function runChainImpact() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "p4deck-deps-"));
  const stateFile = path.join(dir, "state.json");
  try {
    const state = {
      schemaVersion: 2,
      packages: [pkg("TASK-01", { deps: ["T04"] }), pkg("TASK-02", { deps: ["T04", "TASK-01"] })],
    };
    await writeFile(stateFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    const open = todos([{ id: "T04", done: false }]);
    const done = todos([{ id: "T04", done: true }]);
    const impact = await chainImpact("T04", { todos: done, beforeDone: false, stateFile });
    assert.deepEqual(impact.unlocked, ["TASK-01"]);
    assert.deepEqual(impact.blocked, []);
    const reblock = await chainImpact("T04", { todos: open, beforeDone: true, stateFile });
    assert.deepEqual(reblock.blocked, ["TASK-01"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function runImportWithHumanDep() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "p4deck-import-"));
  const todoFile = path.join(dir, "TODO.md");
  const stateFile = path.join(dir, "state.json");
  const todosFile = path.join(dir, "todos.json");
  const boardFile = path.join(dir, "board.md");
  try {
    await writeFile(todoFile, TODO_FIXTURE, "utf8");
    await writeFile(
      todosFile,
      `${JSON.stringify({ schemaVersion: 1, items: [{ id: "T01", text: "human step", done: false }] }, null, 2)}\n`,
      "utf8",
    );
    const result = spawnSync(process.execPath, [path.join(ROOT, "scripts", "workflow", "state.mjs"), "import"], {
      cwd: ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        P4DECK_TODO_DOC: todoFile,
        P4DECK_STATE: stateFile,
        P4DECK_TODOS: todosFile,
        P4DECK_BOARD: boardFile,
      },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const state = JSON.parse(await readFile(stateFile, "utf8"));
    assert.deepEqual(state.packages[0].deps, ["T01"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function runToggleUnblocks() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "p4deck-toggle-"));
  const stateFile = path.join(dir, "state.json");
  const todosFile = path.join(dir, "todos.json");
  try {
    await writeFile(
      stateFile,
      `${JSON.stringify(
        { schemaVersion: 2, packages: [pkg("TASK-01", { deps: ["T01"] })] },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await writeFile(
      todosFile,
      `${JSON.stringify(
        { schemaVersion: 1, items: [{ id: "T01", text: "human step", done: false, doneAt: null, note: "" }] },
        null,
        2,
      )}\n`,
      "utf8",
    );
    const result = spawnSync(
      process.execPath,
      [path.join(ROOT, "scripts", "workflow", "human-todos.mjs"), "toggle", "T01", "--no-board"],
      {
        cwd: ROOT,
        encoding: "utf8",
        env: { ...process.env, P4DECK_STATE: stateFile, P4DECK_TODOS: todosFile },
      },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /解锁下游任务：TASK-01/);
    assert.match(result.stdout, /已从看板阻塞链移除 T01/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function runParentChild() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "p4deck-parent-"));
  const stateFile = path.join(dir, "state.json");
  const todosFile = path.join(dir, "todos.json");
  const env = { ...process.env, P4DECK_STATE: stateFile, P4DECK_TODOS: todosFile };
  try {
    const parent = pkg("P-01", { stage: "todo" });
    const child = {
      ...pkg("C-01", { stage: "todo" }),
      parentId: "P-01",
    };
    await writeFile(
      stateFile,
      `${JSON.stringify({ schemaVersion: 2, packages: [parent], subitems: [child] }, null, 2)}\n`,
      "utf8",
    );
    await writeFile(todosFile, `${JSON.stringify(todos([]), null, 2)}\n`, "utf8");

    const blocked = spawnSync(
      process.execPath,
      [path.join(ROOT, "scripts", "workflow", "state.mjs"), "accept", "P-01", "--force", "--note", "父任务先验收"],
      { cwd: ROOT, encoding: "utf8", env },
    );
    assert.equal(blocked.status, 1);
    assert.match(blocked.stderr, /子任务未完成/);

    const accepted = spawnSync(
      process.execPath,
      [path.join(ROOT, "scripts", "workflow", "state.mjs"), "accept", "C-01", "--force", "--note", "子任务完成"],
      { cwd: ROOT, encoding: "utf8", env },
    );
    assert.equal(accepted.status, 0, accepted.stderr || accepted.stdout);
    assert.match(accepted.stdout, /父任务汇总完成：P-01/);
    const updated = JSON.parse(await readFile(stateFile, "utf8"));
    assert.equal(updated.subitems[0].stage, "done");
    assert.equal(updated.subitems[0].verification.humanAccepted, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

run();
await runChainImpact();
await runImportWithHumanDep();
await runToggleUnblocks();
await runParentChild();
process.stdout.write("deps selftest: ok\n");
