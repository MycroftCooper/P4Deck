import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  collectProblems,
  emittedEvents,
  invokeCalls,
  listenedEvents,
  mockBackendMembers,
  payloadKeys,
  rustFunctions,
  rustRegisteredCommands,
  splitArguments,
} from "./validate-ipc-surface.mjs";

const RUST = [
  "use tauri::State;",
  "",
  "#[tauri::command]",
  "pub async fn alpha(state: State<'_, S>) -> Result<(), String> { Ok(()) }",
  "",
  "#[tauri::command]",
  "#[allow(clippy::too_many_arguments)]",
  "pub(crate) fn beta(guard: State<'_, G>) -> u32 { 1 }",
  "",
  "fn helper() -> u32 { 2 }",
  "",
].join("\n");

test("rustFunctions only treats an attributed declaration as a command", () => {
  const functions = rustFunctions(RUST);
  assert.deepEqual(
    functions.map(({ name, attributed }) => [name, attributed]),
    [
      ["alpha", true],
      ["beta", true],
      ["helper", false],
    ],
  );
});

test("rustFunctions keeps fn declarations out of commented-out code", () => {
  const functions = rustFunctions("// pub fn ghost() {}\nfn real() {}\n");
  assert.deepEqual(
    functions.map(({ name }) => name),
    ["real"],
  );
});

test("rustRegisteredCommands strips module paths and reports duplicates", () => {
  const lib = [
    "tauri::generate_handler![",
    "  commands::alpha,",
    "  close_guard::beta,",
    "  commands::alpha,",
    "]$",
  ].join("\n");
  const { entries, duplicates } = rustRegisteredCommands(lib);
  assert.deepEqual(entries, ["alpha", "beta"]);
  assert.deepEqual(duplicates, [["alpha", 2]]);
});

test("rustFunctions recognises attributes that carry arguments", () => {
  const cases = [
    "#[tauri::command]\npub fn plain() {}",
    "#[tauri::command(async)]\npub fn async_opt() {}",
    '#[tauri::command(rename_all = "snake_case")]\npub fn renamed() {}',
    '#[tauri::command(rename = "x")]\npub fn renamed_fn() {}',
  ];
  for (const source of cases)
    assert.equal(rustFunctions(source)[0].attributed, true, source);
});

test("rustFunctions keeps attribution across multi-line cfg attributes", () => {
  const source = [
    "#[tauri::command]",
    '#[cfg(all(feature = "desktop",',
    '         not(target_os = "ios")))]',
    "pub fn gated() {}",
  ].join("\n");
  assert.equal(rustFunctions(source)[0].attributed, true);
});

test("rustRegisteredCommands fails closed without a handler list", () => {
  assert.throws(
    () => rustRegisteredCommands("fn main() {}"),
    /generate_handler!/,
  );
});

test("rustRegisteredCommands fails closed on an empty handler list", () => {
  assert.throws(
    () => rustRegisteredCommands("tauri::generate_handler![\n  \n]"),
    /empty/,
  );
});

test("invokeCalls reads literals through generic arguments", () => {
  const source = [
    'invoke("plain")',
    'invoke<{ accepted: boolean }>("typed")',
    "invoke<",
    "  | import('./a').Receipt",
    "  | null",
    '>("union", { scope })',
  ].join("\n");
  assert.deepEqual(
    invokeCalls(source).literals.map(({ name }) => name),
    ["plain", "typed", "union"],
  );
});

test("invokeCalls does not mistake an arrow type's '>' for a closer", () => {
  // Regression: counting the `>` of `=>` left depth open and dropped every
  // following call without reporting it.
  const source = [
    'const a = invoke<() => void>("f_arrow");',
    'const b = invoke<Map<string, { n: number }>>("f_nested");',
    'const c = invoke<() => Map<K, V>>("f_ret");',
    'const d = invoke("f_plain");',
  ].join("\n");
  const { literals, dynamic } = invokeCalls(source);
  assert.deepEqual(
    literals.map(({ name }) => name),
    ["f_arrow", "f_nested", "f_ret", "f_plain"],
  );
  assert.deepEqual(dynamic, []);
});

test("invokeCalls reports an unreadable generic as dynamic, not silence", () => {
  const { literals, dynamic } = invokeCalls('invoke<Unbalanced("x")');
  assert.deepEqual(literals, []);
  assert.equal(dynamic.length, 1);
});

test("invokeCalls reports dynamic targets instead of guessing", () => {
  const { literals, dynamic } = invokeCalls(
    'invoke(`plugin:${name}`)\ninvoke("keep")',
  );
  assert.deepEqual(
    literals.map(({ name }) => name),
    ["keep"],
  );
  assert.equal(dynamic.length, 1);
});

test("invokeCalls carries the line of each call", () => {
  const { literals } = invokeCalls('\n\ninvoke("third")');
  assert.deepEqual(literals, [{ name: "third", line: 3, payload: null }]);
});

test("mockBackendMembers reads top-level members only", () => {
  const source = [
    "export const mockBackend: Backend = {",
    "  async first(request) {",
    "    const nested = {",
    "      inner: (value) => value,",
    "    };",
    "    return nested;",
    "  },",
    "  arrow: async () => ({ ok: true }),",
    "};",
    "",
    "export function other() {}",
  ].join("\n");
  assert.deepEqual(mockBackendMembers(source), ["arrow", "first"]);
});

test("mockBackendMembers fails closed without its terminator", () => {
  assert.throws(
    () =>
      mockBackendMembers(
        "export const mockBackend: Backend = {\n  async a() {}",
      ),
    /unterminated/,
  );
});

// End-to-end over a scratch tree: the real validator must flag an invoke whose
// command does not exist, which is the defect this script was written for.
test("collectProblems reports a frontend invoke with no Rust command", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ipc-surface-"));
  const files = {
    "src-tauri/src/lib.rs": [
      "#[tauri::command]",
      "pub fn alpha() {}",
      "",
      "pub fn build() {",
      "    tauri::generate_handler![ipc::commands::alpha]",
      "}",
    ].join("\n"),
    "src-tauri/src/ipc/commands.rs": "#[tauri::command]\npub fn alpha() {}\n",
    "src/infrastructure/backend/contract.ts": [
      "export interface Backend {",
      "  alpha(): Promise<void>;",
      "}",
    ].join("\n"),
    "src/infrastructure/backend/tauriBackend.ts": [
      "export const tauriBackend: Backend = {",
      '  alpha: () => invoke("alpha"),',
      "};",
    ].join("\n"),
    "src/infrastructure/backend/mockBackend.ts": [
      "export const mockBackend: Backend = {",
      "  async alpha() {},",
      "};",
    ].join("\n"),
    "src/app/ghost.ts": 'invoke("shell_recovery_connected");',
  };
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), content);
  }
  try {
    const clean = await collectProblems(root);
    assert.deepEqual(
      clean.problems.map((problem) => problem.replace(/:\d+ /, " ")),
      [
        'src/app/ghost.ts invokes "shell_recovery_connected", which no Tauri command provides',
      ],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("splitArguments ignores commas inside strings and brackets", () => {
  assert.deepEqual(splitArguments('"cmd", { a: f(x, y), b }'), [
    '"cmd"',
    "{ a: f(x, y), b }",
  ]);
  assert.deepEqual(splitArguments('"cmd", { a: "x,y" }'), [
    '"cmd"',
    '{ a: "x,y" }',
  ]);
});

test("payloadKeys reads shorthand and drops spread", () => {
  assert.deepEqual(payloadKeys("{ request }"), ["request"]);
  assert.deepEqual(payloadKeys("{ path, refresh, sheetIndex: s, ...rest }"), [
    "path",
    "refresh",
    "sheetIndex",
  ]);
  assert.deepEqual(payloadKeys("{}"), []);
  assert.equal(payloadKeys("request"), null);
});

test("invokeCalls captures the object payload keys", () => {
  const { literals } = invokeCalls(
    'invoke("list_workspace_children", { path, operationId })',
  );
  assert.deepEqual(literals[0].payload, ["path", "operationId"]);
});

test("invokeCalls leaves a whole-argument payload as null", () => {
  // `invoke("close_guard_report", payload)` passes the request object through,
  // so there are no keys to compare and an empty list would be a false claim.
  assert.equal(
    invokeCalls('invoke("close_guard_report", payload)').literals[0].payload,
    null,
  );
});

test("listenedEvents requires a Tauri listen import", () => {
  const ipc =
    'import { listen } from "@tauri-apps/api/event";\n' +
    'listen<{ a: string }>("operation-event", handler);';
  assert.deepEqual(
    listenedEvents(ipc).map(({ name }) => name),
    ["operation-event"],
  );
  // A DOM helper or test-local shim sharing the name is not an IPC receiver.
  const local =
    'const listen = (n: string) => window.addEventListener(n, f);\nlisten("p4deck:pending-refresh")';
  assert.deepEqual(listenedEvents(local), []);
});

test("emittedEvents reads both the method and the imported forms", () => {
  const source = [
    'let _ = app.emit("logs-cleared", ());',
    'void emitTo("main", "panel-open-request", { page });',
    'app.emit_to("main", "panel-returned", page);',
  ].join("\n");
  assert.deepEqual(
    emittedEvents(source).map(({ name }) => name),
    ["logs-cleared", "panel-open-request", "panel-returned"],
  );
});
