#!/usr/bin/env node
// The IPC surface is assembled by hand: a Tauri command only works when the
// same name appears in Rust (`#[tauri::command]` + `generate_handler!`) and in
// the frontend `invoke("<name>")` calls, and the shared `Backend` contract must
// keep `tauriBackend` and `mockBackend` in step. Nothing in TypeScript links
// those spellings, so a rename on either side compiles, type-checks and passes
// the test suite until a user happens to trigger the broken command.
//
// This validator closes that gap with static extraction only (no Rust build):
//   1. Rust commands are registered in `generate_handler!` exactly once.
//   2. Every `invoke("<name>")` in src/ and tests/ names a registered command.
//   3. Every `tauriBackend` member maps to a registered command.
//   4. `Backend`, `tauriBackend` and `mockBackend` expose identical members.
//   5. An object payload's keys match the command's Rust parameter names, after
//      the command's `rename_all` case convention, and required parameters are
//      present.
//   6. Events are a second namespace: every `listen("<name>")` is emitted by
//      Rust, and every `emit("<name>")` is consumed by the frontend.
//
// Run by `pnpm validate:ipc-surface` and by `node scripts/ci-runner.mjs quick`.
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const relative = (file) =>
  path.relative(repoRoot, file).split(path.sep).join("/");
const unique = (values) => [...new Set(values)].sort();
const difference = (left, right) =>
  left.filter((value) => !right.includes(value));
const lineOf = (source, index) => source.slice(0, index).split("\n").length;

// Tauri's `#[command]` defaults to `rename_all = "camelCase"`, so a Rust
// `operation_id` is sent from JS as `operationId`. Mirrors serde's rename rule.
const toCamelCase = (name) =>
  name.replace(/_([a-z0-9])/g, (_, char) => char.toUpperCase());

// Comments are blanked (newlines kept) before scanning so a commented-out
// command in either language is never mistaken for an error.
export function stripComments(source, { line = true } = {}) {
  const withoutBlocks = source.replace(/\/\*[\s\S]*?\*\//g, (match) =>
    match.replace(/[^\n]/g, " "),
  );
  return line ? withoutBlocks.replace(/\/\/[^\n]*/g, "") : withoutBlocks;
}

// Rust names come from `fn` declarations, not from call sites: this keeps the
// `#[tauri::command]` attribute check attached to the declaration it belongs to.
// Attributes with arguments (`#[tauri::command(async)]`,
// `#[tauri::command(rename_all = "snake_case")]`) are commands too, and a run of
// preceding `#[...]` lines (including multi-line `#[cfg(...)]` blocks) must not
// detach the attribute from its declaration. `close_guard.rs`'s
// `ui07_every_business_command_has_host_admission` splits on the literal
// `#[tauri::command]`, so it shares this blind spot; keep the two in step.
export const rustFunctions = (source) => {
  const text = stripComments(source);
  // Attributes are read from the ORIGINAL source: a multi-line `#[cfg(...)]`
  // continues on lines that do not start with `#[`, and stripping shortens
  // those lines so a stripped-text offset no longer indexes the original.
  // Line numbers are preserved by both passes, so the line index is the join.
  const originalLines = source.split("\n");
  return [
    ...text.matchAll(
      /^(\s*(?:pub(?:\(crate\))?\s+)?(?:const\s+)?(?:async\s+)?fn\s+)([a-z0-9_]+)\s*[<(:(]/gmu,
    ),
  ].map((match) => {
    const line = lineOf(text, match.index);
    const attributes = attributesPreceding(
      originalLines.slice(0, line - 1).join("\n"),
    );
    return {
      name: match[2],
      attributed: isCommandAttribute(attributes),
      // Per `#[command(rename_all = ...)]`, the JS-side case convention. The
      // default is camelCase, so a snake_case Rust parameter is expected as
      // `snakeCase` on the wire unless the command opts out.
      snakeCase: /rename_all\s*=\s*"snake_case"/.test(attributes),
      params: rustParameters(text, match.index + match[0].length - 1),
      required: rustRequiredParameters(text, match.index + match[0].length - 1),
      line,
    };
  });
};

// Parameter names of a command, taken from its declaration list. Injected
// extractors (`State`, `AppHandle`, `WebviewWindow`, `Admission`) are not part
// of the JS payload and are excluded.
export function rustParameters(text, openParenIndex) {
  const start = text.indexOf("(", openParenIndex);
  if (start === -1) return [];
  let depth = 0;
  let end = -1;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (char === "(") depth += 1;
    else if (char === ")") {
      depth -= 1;
      if (depth === 0) {
        end = index;
        break;
      }
    }
  }
  if (end === -1) return [];
  const list = text.slice(start + 1, end);
  return list
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const match =
        /^(?:mut\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*:\s*([\s\S]+)$/.exec(part);
      return match
        ? { name: match[1], type: match[2].replace(/\s+/g, "") }
        : null;
    })
    .filter(Boolean)
    .filter((param) => !INJECTED.has(param.name) && !isInjectedType(param.type))
    .map((param) => param.name);
}

// `Option<T>` parameters may be omitted entirely from the JS payload section, and
// `#[serde(default)]` applies inside a struct, not to a bare command argument.
export function rustRequiredParameters(text, openParenIndex) {
  const start = text.indexOf("(", openParenIndex);
  if (start === -1) return [];
  let depth = 0;
  let end = -1;
  for (let index = start; index < text.length; index += 1) {
    if (text[index] === "(") depth += 1;
    else if (text[index] === ")") {
      depth -= 1;
      if (depth === 0) {
        end = index;
        break;
      }
    }
  }
  if (end === -1) return [];
  return text
    .slice(start + 1, end)
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const match =
        /^(?:mut\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*:\s*([\s\S]+)$/.exec(part);
      return match
        ? { name: match[1], type: match[2].replace(/\s+/g, "") }
        : null;
    })
    .filter(Boolean)
    .filter((param) => !INJECTED.has(param.name) && !isInjectedType(param.type))
    .filter((param) => !/^Option</.test(param.type))
    .map((param) => param.name);
}

// Extractor parameters are supplied by Tauri, never by the caller.
const INJECTED = new Set(["state", "app", "window", "webview"]);
const isInjectedType = (type) =>
  /(?:^|::)(?:State|AppHandle|WebviewWindow|Window|Webview|Manager|Admission)$/.test(
    type.replace(/<[\s\S]*?>$/, ""),
  );

// Walks backwards over the contiguous run of attribute lines immediately above
// a declaration and returns them. Blank lines inside a multi-line attribute are
// kept; the run ends at the first line that is neither an attribute line, an
// attribute continuation, nor a comment.
function attributesPreceding(prefix) {
  // `prefix` ends just before the declaration, with no trailing newline, so
  // every line it does contain is a candidate. The walk goes backwards, which
  // means a multi-line attribute is met tail-first: a line ending in `]` that
  // does not open an attribute is the tail of one, and the run continues until
  // the matching `#[` is seen.
  const lines = prefix.split("\n").reverse();
  const collected = [];
  let inAttribute = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (line === "") continue;
    const opens = line.startsWith("#[");
    const closes = line.endsWith("]");
    if (opens || closes || inAttribute) {
      // A `]`-terminated line above the declaration is an attribute's tail, and
      // the run continues up until the `#[` that opened it.
      collected.push(line);
      inAttribute = !closes;
      continue;
    }
    if (line.startsWith("//")) continue;
    break;
  }
  return collected.reverse().join("\n");
}

const isCommandAttribute = (attributes) =>
  /#\[\s*(?:tauri\s*::\s*)?command\b(?:\s*\([\s\S]*?\))?\s*\]/.test(attributes);

export const rustRegisteredCommands = (source) => {
  const match = /generate_handler!\s*\[([\s\S]*?)\]/.exec(
    stripComments(source),
  );
  if (!match)
    throw new Error("src-tauri/src/lib.rs: generate_handler! not found");
  const entries = match[1]
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) =>
      entry
        .split("::")
        .pop()
        .replace(/[<(].*$/, "")
        .trim(),
    );
  const counts = new Map();
  for (const entry of entries) counts.set(entry, (counts.get(entry) ?? 0) + 1);
  // An empty list would make every frontend call fail with 120 misleading
  // messages and no hint about the real cause.
  if (entries.length === 0)
    throw new Error("src-tauri/src/lib.rs: generate_handler! is empty");
  return {
    entries: unique(entries),
    duplicates: [...counts].filter(([, count]) => count > 1),
  };
};

// Splits the invoke(...) argument list on top-level commas. Strings and
// brackets are respected so a comma inside either does not split.
export function splitArguments(text) {
  const parts = [];
  let current = "";
  let depth = 0;
  let quote = null;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      current += char;
      if (char === "\\") {
        current += text[index + 1] ?? "";
        index += 1;
      } else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      current += char;
      continue;
    }
    if ("([{".includes(char)) depth += 1;
    else if (")]}".includes(char)) depth -= 1;
    if (char === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

// Top-level keys of an object literal payload (`{ a, b: c }` -> a, b). Shorthand
// properties count, so `{ request }` still reports `request`.
export function payloadKeys(source) {
  const text = source.trim();
  if (!text.startsWith("{") || !text.endsWith("}")) return null;
  const inner = text.slice(1, -1);
  const keys = [];
  let depth = 0;
  let quote = null;
  let start = 0;
  const push = (segment) => {
    const part = segment.trim();
    if (!part) return;
    const spread = /^\.\.\./.test(part);
    if (spread) return; // Spread keys are unknowable statically.
    const match = /^([A-Za-z_$][A-Za-z0-9_$]*)\s*(?::|$)/.exec(part);
    if (match) keys.push(match[1]);
  };
  for (let index = 0; index < inner.length; index += 1) {
    const char = inner[index];
    if (quote) {
      if (char === "\\") index += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if ("([{".includes(char)) depth += 1;
    else if (")]}".includes(char)) depth -= 1;
    else if (char === "," && depth === 0) {
      push(inner.slice(start, index));
      start = index + 1;
    }
  }
  push(inner.slice(start));
  return keys;
}

// Returns the literal target of each `invoke` call and the dynamic ones callers
// should convert to literals so this validator can see them.
//
// The type argument is skipped by balancing brackets, but every ambiguous
// token must fail *closed*: a call this function cannot read is reported as
// dynamic, never dropped. Dropping it would let an unchecked target through,
// which is exactly the failure the validator exists to prevent.
export function invokeCalls(source) {
  const text = stripComments(source, { line: false });
  const literals = [];
  const dynamic = [];
  const report = (from) => {
    const end = text.indexOf("\n", from);
    dynamic.push({
      text: text.slice(from, end === -1 ? undefined : end).trim(),
      line: lineOf(text, from),
    });
  };

  for (const match of text.matchAll(/\binvoke\b/g)) {
    let index = match.index + "invoke".length;
    const skipBlanks = () => {
      while (index < text.length && /\s/.test(text[index])) index += 1;
    };
    skipBlanks();
    if (text[index] === "<") {
      let depth = 0;
      let closed = false;
      for (; index < text.length; index += 1) {
        const char = text[index];
        // `=>` is one token, not a closer: counting its `>` would leave depth
        // permanently positive and silently swallow the rest of the call.
        if (char === "=" && text[index + 1] === ">") {
          index += 1;
          continue;
        }
        if (char === "<") depth += 1;
        else if (char === ">") {
          depth -= 1;
          if (depth <= 0) {
            closed = true;
            index += 1;
            break;
          }
        }
      }
      if (!closed) {
        report(match.index);
        continue;
      }
    }
    skipBlanks();
    if (text[index] !== "(") continue;
    index += 1;
    skipBlanks();
    if (text[index] === '"') {
      const end = text.indexOf('"', index + 1);
      if (end !== -1)
        literals.push({
          name: text.slice(index + 1, end),
          line: lineOf(text, match.index),
          payload: payloadOf(text, end + 1),
        });
      else report(match.index);
    } else if (text[index] !== undefined) report(match.index);
  }
  return { literals, dynamic };
}

// Reads the payload argument that follows the command name at `from`, and
// returns its top-level keys, or null when the call passes no object payload.
function payloadOf(text, from) {
  const skip = (index) => {
    while (index < text.length && /\s/.test(text[index])) index += 1;
    return index;
  };
  let index = skip(from);
  if (text[index] !== ",") return null; // e.g. `invoke("x")`
  index = skip(index + 1);
  // A bare identifier payload (`invoke("close_guard_report", payload)`) is the
  // whole argument, so there are no keys to compare: return null rather than an
  // empty list, which would claim the command takes no arguments.
  if (text[index] !== "{") return null;
  let depth = 0;
  let quote = null;
  const start = index;
  for (; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (char === "\\") index += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if ("([{".includes(char)) depth += 1;
    else if (")]}".includes(char)) {
      depth -= 1;
      if (depth === 0) return payloadKeys(text.slice(start, index + 1));
    }
  }
  return null;
}

// Members of an object literal exported as `<exportHeader>`, one per line.
export function exportedObjectMembers(source, exportHeader) {
  const start = source.indexOf(exportHeader);
  if (start === -1)
    throw new Error(`object literal "${exportHeader}" not found`);
  const text = source.slice(start + exportHeader.length);
  return unique(
    [...text.matchAll(/^ {2}([A-Za-z][A-Za-z0-9]*)\s*[:(]/gm)].map(
      (match) => match[1],
    ),
  );
}

// Members of `export interface Backend { ... }`, including those declared with
// a generic method signature (`members<T>(`).
export function interfaceMembers(source, header) {
  const start = source.indexOf(header);
  if (start === -1) throw new Error(`interface "${header}" not found`);
  const end = source.indexOf("\n}", start);
  return unique(
    [
      ...source
        .slice(start + header.length, end)
        .matchAll(/^ {2}([A-Za-z][A-Za-z0-9]*)\s*(?:\(|\?:|:)/gm),
    ].map((match) => match[1]),
  );
}

// Event names are a separate namespace from commands: `listen("<name>")` cannot
// be type-checked against the Rust `emit("<name>")` literal, so renaming one
// side compiles and silently kills the subscription.
//
// Tauri's `listen` is a bare import; DOM's `window.addEventListener(...)` and
// test-local `const listen = ...` helpers share the spelling but are a different
// channel, so only an unqualified `listen(` counts as an IPC receiver.
export function listenedEvents(source) {
  // A file that never imports Tauri's `listen` cannot own an IPC subscription;
  // its `listen(` text is a DOM helper or a test-local shim.
  const importsTauriListen =
    /import\s*\{[^}]*\blisten\b[^}]*\}\s*from\s*"@tauri-apps\/api\/event"/.test(
      source,
    );
  if (!importsTauriListen) return [];
  return [
    ...stripComments(source, { line: false }).matchAll(
      /(?<![\w$.])listen(?:<[\s\S]*?>)?\(\s*"([^"]+)"/g,
    ),
  ].map((match) => ({ name: match[1], line: lineOf(source, match.index) }));
}

// Tauri's `emit` takes (event, payload) and `emit_to`/`emit_filter` take
// (target, event, payload), so the event string is the second argument there.
// This runs over both trees: a window can emit to another window without any
// Rust involvement (`emitTo("main", "panel-open-request", ...)`), and that
// topic is just as reachable from the receiver side.
export function emittedEvents(source) {
  const text = stripComments(source, { line: false });
  const events = [];
  // `emit` is a method on AppHandle (`app.emit(...)`); `emitTo`/`emitFilter`
  // are imported functions called bare (`emitTo("main", ...)`). Accept both.
  for (const match of text.matchAll(
    /(?:(?<![\w$])|\.)\b(emit|emit_to|emit_filter|emitTo|emitFilter)\s*\(/g,
  )) {
    const positional = /_/.test(match[1]) || /To|Filter/.test(match[1]) ? 2 : 1;
    const open = match.index + match[0].length - 1;
    let depth = 0;
    let end = -1;
    for (let index = open; index < text.length; index += 1) {
      if (text[index] === "(") depth += 1;
      else if (text[index] === ")") {
        depth -= 1;
        if (depth === 0) {
          end = index;
          break;
        }
      }
    }
    if (end === -1) continue;
    const parts = splitArguments(text.slice(open + 1, end));
    const literal = parts[positional - 1];
    if (!literal) continue;
    const event = /^"([^"]*)"$/.exec(literal.trim());
    if (event)
      events.push({ name: event[1], line: lineOf(source, match.index) });
  }
  return events;
}

// `mockBackend` is an object literal whose members are async methods. Only the
// top-level indent is considered, so parameter and local names inside a method
// body are never collected. Synchronous arrow members are accepted too.
export function mockBackendMembers(source) {
  const start = source.indexOf("export const mockBackend");
  if (start === -1) throw new Error('object literal "mockBackend" not found');
  const end = source.indexOf("\n};", start);
  // Without the sentinel the scan would silently run on into the rest of the
  // module, so a missing terminator is an error rather than a shorter range.
  if (end === -1)
    throw new Error('object literal "mockBackend" is unterminated');
  const text = source.slice(start, end);
  return unique(
    [
      ...text.matchAll(/^ {2}(?:async\s+)?([A-Za-z][A-Za-z0-9]*)\s*\(/gm),
      ...text.matchAll(
        /^ {2}([A-Za-z][A-Za-z0-9]*)\s*:\s*(?:async\s*)?(?:\(|function\b|[A-Za-z_$][A-Za-z0-9_$]*\s*=>)/gm,
      ),
    ].map((match) => match[1]),
  );
}

async function walk(directory, predicate) {
  // A missing root is normal for a scratch tree (and for `tests/` in a partial
  // checkout); a missing file that should exist is caught by `read` throwing.
  const entries = await readdir(directory, { withFileTypes: true }).catch(
    () => [],
  );
  const found = await Promise.all(
    entries.map(async (entry) => {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) return walk(target, predicate);
      return predicate(target) ? [target] : [];
    }),
  );
  return found.flat();
}

export async function collectProblems(root = repoRoot) {
  const read = (file) => readFile(path.join(root, file), "utf8");
  const relativeTo = (file) =>
    path.relative(root, file).split(path.sep).join("/");
  const problems = [];

  const rustFiles = await walk(path.join(root, "src-tauri/src"), (file) =>
    file.endsWith(".rs"),
  );
  const rustSources = await Promise.all(
    rustFiles.map(async (file) => [
      relativeTo(file),
      await readFile(file, "utf8"),
    ]),
  );
  const declared = new Map();
  const commands = new Map();
  for (const [file, source] of rustSources)
    for (const fn of rustFunctions(source))
      if (fn.attributed) {
        declared.set(fn.name, `${file}:${fn.line}`);
        commands.set(fn.name, fn);
      }

  const { entries: registered, duplicates } = rustRegisteredCommands(
    await read("src-tauri/src/lib.rs"),
  );
  const declaredNames = unique([...declared.keys()]);
  for (const [name, count] of duplicates)
    problems.push(`generate_handler! lists "${name}" ${count} times`);
  for (const name of difference(registered, declaredNames))
    problems.push(
      `generate_handler! registers "${name}", but no #[tauri::command] fn declares it`,
    );
  for (const name of difference(declaredNames, registered))
    problems.push(
      `${declared.get(name)} declares #[tauri::command] "${name}", but generate_handler! omits it`,
    );

  // First-party call sites only: `tests/fixtures` vendors third-party Tauri
  // harness scripts that drive the plugin bridge with non-literal targets.
  const skipFixture = (file) => relativeTo(file).startsWith("tests/fixtures/");
  const frontendFiles = (
    await Promise.all(
      ["src", "tests"].map((dir) =>
        walk(
          path.join(root, dir),
          (file) => /\.[jt]sx?$/.test(file) && !skipFixture(file),
        ),
      ),
    )
  ).flat();
  const invokeTargets = new Set();
  const checkPayload = (where, line, name, payload) => {
    const command = commands.get(name);
    // Only object-literal payloads against a known command are comparable:
    // passing a whole request as one struct is the shape check (c).
    if (!command || !payload) return;
    const wanted = new Set(
      command.params.map((param) =>
        command.snakeCase ? param : toCamelCase(param),
      ),
    );
    for (const key of payload)
      if (!wanted.has(key))
        problems.push(
          `${where}:${line} sends "${key}" to "${name}", but its Rust parameters are ${JSON.stringify(
            command.params,
          )}`,
        );
    const sent = new Set(payload);
    for (const param of command.required) {
      const key = command.snakeCase ? param : toCamelCase(param);
      if (!sent.has(key))
        problems.push(
          `${where}:${line} calls "${name}" without "${key}", which the Rust command requires`,
        );
    }
  };
  // `tauriBackend.ts` is the one file whose mapping is the contract surface, so
  // it is scanned again below with a clearer message; skip it here to avoid
  // reporting the same call line twice.
  const tauriBackendPath = "src/infrastructure/backend/tauriBackend.ts";
  for (const file of frontendFiles) {
    if (relativeTo(file) === tauriBackendPath) continue;
    const source = await readFile(file, "utf8");
    const { literals, dynamic } = invokeCalls(source);
    for (const { name, line, payload } of literals) {
      invokeTargets.add(name);
      if (!registered.includes(name))
        problems.push(
          `${relativeTo(file)}:${line} invokes "${name}", which no Tauri command provides`,
        );
      else checkPayload(relativeTo(file), line, name, payload);
    }
    for (const { text, line } of dynamic)
      problems.push(
        `${relativeTo(file)}:${line} does not use a string literal for ${text}`,
      );
  }

  const tauriBackend = await read(tauriBackendPath);
  for (const { name, line, payload } of invokeCalls(tauriBackend).literals) {
    invokeTargets.add(name);
    if (!registered.includes(name))
      problems.push(
        `tauriBackend.ts:${line} maps to "${name}", which no Tauri command provides`,
      );
    else checkPayload("tauriBackend.ts", line, name, payload);
  }

  // Events are their own namespace: check both directions so a rename on either
  // side is reported. A topic can be produced by Rust or by another window
  // (`emitTo("main", "panel-open-request", ...)`), so emitters come from both.
  const emitted = new Map();
  for (const [file, source] of rustSources)
    for (const { name, line } of emittedEvents(source))
      emitted.set(name, `${file}:${line}`);
  for (const file of frontendFiles) {
    const source = await readFile(file, "utf8");
    for (const { name, line } of emittedEvents(source))
      emitted.set(name, `${relativeTo(file)}:${line}`);
  }
  const listened = new Set();
  for (const file of frontendFiles) {
    const source = await readFile(file, "utf8");
    for (const { name, line } of listenedEvents(source)) {
      listened.add(name);
      if (!emitted.has(name))
        problems.push(
          `${relativeTo(file)}:${line} listens for "${name}", which nothing emits`,
        );
    }
  }
  for (const [name, where] of [...emitted].sort())
    if (!listened.has(name))
      problems.push(`${where} emits "${name}", which no frontend listens for`);

  const contract = interfaceMembers(
    await read("src/infrastructure/backend/contract.ts"),
    "export interface Backend {",
  );
  const tauriMembers = exportedObjectMembers(
    tauriBackend,
    "export const tauriBackend: Backend = {",
  );
  const mockMembers = mockBackendMembers(
    await read("src/infrastructure/backend/mockBackend.ts"),
  );
  for (const name of difference(contract, tauriMembers))
    problems.push(`Backend.${name} is missing from tauriBackend.ts`);
  for (const name of difference(tauriMembers, contract))
    problems.push(`tauriBackend.${name} is not part of the Backend contract`);
  for (const name of difference(contract, mockMembers))
    problems.push(`Backend.${name} is missing from mockBackend.ts`);
  for (const name of difference(mockMembers, contract))
    problems.push(`mockBackend.${name} is not part of the Backend contract`);

  return { problems, registered, invokeTargets, contract };
}

async function main() {
  // An explicit root lets tests run the invariants against a scratch tree, so a
  // regression can be proven to fail instead of merely trusted to.
  const root = process.argv[2] ? path.resolve(process.argv[2]) : repoRoot;
  const { problems, registered, invokeTargets, contract } =
    await collectProblems(root);
  if (problems.length)
    throw new Error(
      `IPC surface drifted:\n${problems.map((line) => `  - ${line}`).join("\n")}`,
    );
  process.stdout.write(
    `IPC surface valid: ${registered.length} registered commands, ${invokeTargets.size} distinct invoke targets, ${contract.length} Backend members (tauri/mock aligned)\n`,
  );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main();
}
