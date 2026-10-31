// 依赖链（dependency chain）的纯计算：任务可以依赖其它任务，也可以依赖人类待办（T01…）。
//
// 设计约束：
// - 就绪状态是**派生**的，不写回 state.json。依赖完成后，下游任务在 queue/board/next
//   里自动变为"就绪"，不会伪造"已开工"的状态迁移。
// - 任务完成 = 已归档 / stage=done / verification.humanAccepted。
// - 人类待办完成 = human-todos.json 里 done=true；未完成即阻塞下游。
// - 未知依赖不算就绪；check 会报错。
export const HUMAN_DEP_PATTERN = /^T\d{2,}$/;

export function isHumanDep(id) {
  return HUMAN_DEP_PATTERN.test(String(id ?? "").toUpperCase());
}

export function isTaskSatisfied(pkg) {
  if (!pkg) return false;
  return Boolean(pkg.archived) || pkg.stage === "done" || pkg.verification?.humanAccepted === true;
}

export function packageIndex(packages = []) {
  return new Map(packages.filter((pkg) => pkg?.id).map((pkg) => [pkg.id, pkg]));
}

export function todoIndex(todos = { items: [] }) {
  return new Map((todos?.items ?? []).filter((item) => item?.id).map((item) => [String(item.id).toUpperCase(), item]));
}

/** 子任务的父任务 ID：兼容 parentId（P4Deck）与 parent（kits/子项表）。 */
export function parentIdOf(entry) {
  const raw = entry?.parentId ?? entry?.parent ?? null;
  return raw ? String(raw) : null;
}

export function childrenOf(id, entries = []) {
  const key = String(id ?? "").toUpperCase();
  return entries.filter((entry) => {
    const parentId = parentIdOf(entry);
    return parentId && parentId.toUpperCase() === key;
  });
}

export function buildChildrenMap(entries = []) {
  const map = new Map();
  for (const entry of entries) {
    const parentId = parentIdOf(entry);
    if (!parentId) continue;
    const key = parentId.toUpperCase();
    map.set(key, [...(map.get(key) ?? []), entry]);
  }
  return map;
}

/**
 * 完成度聚合：父任务在“自身已完成”或“所有子任务已完成”时视为完成。
 * 已完成的父任务不会因为后来新增子任务被降级（stored 优先），避免打回历史验收。
 *
 * @returns {Map<string, {satisfied: boolean, stored: boolean, derived: boolean, childrenTotal: number, childrenDone: number, cycle: boolean}>}
 */
export function completionMap(entries = []) {
  const byId = packageIndex(entries);
  const childMap = buildChildrenMap(entries);
  const memo = new Map();
  const visiting = new Set();
  const visit = (id) => {
    if (memo.has(id)) return memo.get(id);
    const entry = byId.get(id);
    if (!entry) return { satisfied: false, stored: false, derived: false, childrenTotal: 0, childrenDone: 0, cycle: false };
    if (visiting.has(id)) {
      return { satisfied: false, stored: false, derived: false, childrenTotal: 0, childrenDone: 0, cycle: true };
    }
    visiting.add(id);
    const children = childMap.get(String(id).toUpperCase()) ?? [];
    let childrenDone = 0;
    let allDone = true;
    let cycle = false;
    for (const child of children) {
      const result = visit(child.id);
      if (result.satisfied) childrenDone += 1;
      else allDone = false;
      if (result.cycle) cycle = true;
    }
    visiting.delete(id);
    const stored = isTaskSatisfied(entry);
    const satisfied = stored || (children.length > 0 && allDone && !cycle);
    const result = {
      satisfied,
      stored,
      derived: !stored && satisfied,
      childrenTotal: children.length,
      childrenDone,
      cycle,
    };
    memo.set(id, result);
    return result;
  };
  for (const entry of entries) visit(entry.id);
  return memo;
}

/**
 * @returns {{ready: boolean, satisfied: boolean, waiting: Array<{id: string, kind: "human"|"task"|"child"|"missing", state: string}>}}
 */
export function taskReadiness(pkg, packagesById = new Map(), todosById = new Map(), completion = new Map()) {
  const waiting = [];
  const satisfied = completion.get(pkg?.id)?.satisfied ?? isTaskSatisfied(pkg);
  if (!satisfied) {
    for (const raw of pkg?.deps ?? []) {
      const id = String(raw ?? "").trim();
      if (!id) continue;
      if (isHumanDep(id)) {
        const item = todosById.get(id.toUpperCase());
        if (!item) waiting.push({ id, kind: "missing", state: "missing" });
        else if (item.done !== true) waiting.push({ id, kind: "human", state: "open" });
        continue;
      }
      const target = packagesById.get(id);
      if (!target) waiting.push({ id, kind: "missing", state: "missing" });
      else if (!(completion.get(target.id)?.satisfied ?? isTaskSatisfied(target))) {
        waiting.push({ id, kind: "task", state: target.archived ? "archived" : (target.stage ?? "unknown") });
      }
    }
    for (const child of childrenOf(pkg?.id, [...packagesById.values()])) {
      if (!(completion.get(child.id)?.satisfied ?? isTaskSatisfied(child))) {
        waiting.push({ id: child.id, kind: "child", state: child.stage ?? "unknown" });
      }
    }
  }
  return { ready: waiting.length === 0, satisfied, waiting };
}

/** id → readiness for every entry (packages + subitems). */
export function readinessMap(entries = [], todos = { items: [] }) {
  const packagesById = packageIndex(entries);
  const todosById = todoIndex(todos);
  const completion = completionMap(entries);
  const result = new Map();
  for (const entry of entries) {
    if (entry?.id) result.set(entry.id, taskReadiness(entry, packagesById, todosById, completion));
  }
  return result;
}

/** Direct dependents that name `id` in their deps. */
export function dependentsOf(id, entries = []) {
  const key = String(id ?? "").toUpperCase();
  return entries.filter((entry) =>
    (entry?.deps ?? []).some((dep) => String(dep).toUpperCase() === key),
  );
}

/** Direct dependents that are not itself complete. */
export function openDependentsOf(id, entries = []) {
  return dependentsOf(id, entries).filter((entry) => !isTaskSatisfied(entry));
}

/** Dependency cycles among task deps (human deps cannot create cycles). */
export function findDependencyCycles(entries = []) {
  const byId = packageIndex(entries);
  const color = new Map(); // 0 = unvisited, 1 = visiting, 2 = done
  const stack = [];
  const cycles = [];
  const visit = (id) => {
    const state = color.get(id) ?? 0;
    if (state === 2) return;
    if (state === 1) {
      const at = stack.indexOf(id);
      cycles.push([...stack.slice(at), id]);
      return;
    }
    color.set(id, 1);
    stack.push(id);
    const pkg = byId.get(id);
    for (const dep of pkg?.deps ?? []) {
      if (isHumanDep(dep)) continue;
      if (byId.has(dep)) visit(dep);
    }
    stack.pop();
    color.set(id, 2);
  };
  for (const id of byId.keys()) visit(id);
  return cycles;
}

export function priorityRank(priority) {
  const text = String(priority ?? "").toUpperCase();
  const match = text.match(/P(\d)/);
  if (match) return Number(match[1]);
  if (text.includes("不执行")) return 99;
  return 50;
}

/** 父子关系环检测（child -> parent 链）。 */
export function findParentCycles(entries = []) {
  const byId = packageIndex(entries);
  const color = new Map();
  const stack = [];
  const cycles = [];
  const visit = (id) => {
    const marker = color.get(id) ?? 0;
    if (marker === 2) return;
    if (marker === 1) {
      const at = stack.indexOf(id);
      cycles.push([...stack.slice(at), id]);
      return;
    }
    color.set(id, 1);
    stack.push(id);
    const parentId = parentIdOf(byId.get(id));
    if (parentId && byId.has(parentId)) visit(parentId);
    stack.pop();
    color.set(id, 2);
  };
  for (const id of byId.keys()) visit(id);
  return cycles;
}

/** Ready, non-complete entries sorted by priority then id. */
export function sortReady(entries = [], readiness = new Map()) {
  return entries
    .filter((entry) => !(readiness.get(entry.id)?.satisfied ?? isTaskSatisfied(entry)) && readiness.get(entry.id)?.ready)
    .sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority) || String(a.id).localeCompare(String(b.id), "en"));
}
