#!/usr/bin/env node
// R9: keep the frontend operation/watchdog bounds generated from the Rust source
// of truth (`src-tauri/src/p4/bounds.rs`).
//
// `npm run test:web` runs this with `--check` before vitest, so a constant that
// drifts between the host and the UI fails the build instead of silently making
// the watchdog disagree with the runner again.
//
// Usage:
//   node scripts/generate-io-bounds.mjs           # rewrite the generated file
//   node scripts/generate-io-bounds.mjs --check   # exit 1 if it is out of date
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const rustPath = join(root, "src-tauri/src/p4/bounds.rs");
const outPath = join(root, "src/shared/operationBounds.generated.ts");

// Plain u64 constants, in the order they are rendered into the TS module.
const CONSTANTS = [
  "WORKSPACE_READ_MS",
  "WORKSPACE_READ_LONG_MS",
  "WORKSPACE_COMMAND_MS",
  "WORKSPACE_SYNC_MS",
  "WORKSPACE_PREVIEW_MS",
  "WORKSPACE_BOOTSTRAP_MS",
  "WORKSPACE_OTHER_MS",
  "P4_PROCESS_HARD_CAP_MS",
  "IO_DEADLINE_HEADROOM_MS",
  "SYNC_LATE_RESULT_GRACE_MS",
  "WATCHDOG_TICK_MS",
];

const WATCHDOG_KINDS = ["Sync", "GetLatest", "GetRevision", "Refresh", "Other"];

// `WORKSPACE_<SUFFIX>_MS` -> `<suffix>` in camelCase, as the TS key.
const FAMILY_KEYS = {
  WORKSPACE_READ_MS: "workspaceRead",
  WORKSPACE_READ_LONG_MS: "workspaceReadLong",
  WORKSPACE_COMMAND_MS: "workspaceCommand",
  WORKSPACE_SYNC_MS: "workspaceSync",
  WORKSPACE_PREVIEW_MS: "workspacePreview",
  WORKSPACE_BOOTSTRAP_MS: "workspaceBootstrap",
  WORKSPACE_OTHER_MS: "workspaceOther",
};

const HEADER = `// R9 shared I/O bound source of truth, generated from src-tauri/src/p4/bounds.rs.
// Do not hand-edit: run \`node scripts/generate-io-bounds.mjs\` after changing that
// file. \`npm run test:web\` runs the same script with --check and fails when the
// host and the UI drift apart.`;

function fail(message) {
  console.error(`generate-io-bounds: ${message}`);
  process.exit(1);
}

/** Reads every `pub const NAME: u64 = <expression>;` and evaluates it. */
function parseConstants(source) {
  const raw = {};
  for (const match of source.matchAll(
    /pub const ([A-Z0-9_]+): u64 = ([^;]+);/g,
  )) {
    raw[match[1]] = match[2].trim();
  }
  const values = {};
  const resolveName = (name, depth = 0) => {
    if (name in values) return values[name];
    if (!(name in raw)) fail(`unknown constant ${name}`);
    if (depth > 8) fail(`constant cycle at ${name}`);
    let total = 0;
    for (const term of raw[name].split("+")) {
      const token = term.trim();
      if (/^[0-9][0-9_]*$/.test(token)) {
        total += Number(token.replaceAll("_", ""));
        continue;
      }
      if (!/^[A-Z0-9_]+$/.test(token)) {
        fail(`unsupported expression for ${name}: ${raw[name]}`);
      }
      total += resolveName(token, depth + 1);
    }
    return (values[name] = total);
  };
  for (const name of CONSTANTS) {
    if (!(name in raw)) fail(`missing \`pub const ${name}: u64\` in bounds.rs`);
    resolveName(name);
  }
  if (values.P4_PROCESS_HARD_CAP_MS < values.WORKSPACE_COMMAND_MS) {
    fail("P4_PROCESS_HARD_CAP_MS must cover every command family");
  }
  return values;
}

/** Reads `impl WatchdogKind { ... match self { Self::A | Self::B => EXPR, ... } }`. */
function parseWatchdogLimits(source, constants) {
  const block = source.match(/impl WatchdogKind \{[\s\S]*?\n\}/);
  if (!block) fail("missing `impl WatchdogKind` in bounds.rs");
  // Comments carry the word `Self::...`, so strip them before matching arms.
  // Arm bodies are separated with "," (not ";"), so match up to the next arm or
  // the closing brace of the `match`.
  const body = block[0]
    .replace(/\/\/[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  // Each arm ends at a comma. Bodies are either one expression or a `{ ... }`
  // block, and a bare expression never contains a comma, so this is unambiguous.
  const armPattern =
    /((?:Self::[A-Za-z]+\s*\|\s*)*Self::[A-Za-z]+)\s*=>\s*(\{[^}]*\}|[^,{]*)/g;
  const byKind = new Map();
  for (const match of body.matchAll(armPattern)) {
    const value = evaluate(`${match[2] ?? ""} ${match[3] ?? ""}`, constants);
    for (const part of match[1].split("|")) {
      byKind.set(part.trim().replace("Self::", ""), value);
    }
  }
  const limits = {};
  for (const kind of WATCHDOG_KINDS) {
    if (!byKind.has(kind)) fail(`missing WatchdogKind::${kind} arm`);
    limits[kind] = byKind.get(kind);
  }
  return limits;
}

function evaluate(expression, constants) {
  // Drop the comments an arm may carry and normalize so a multi-line arm
  // `{ WORKSPACE_X_MS + WORKSPACE_Y_MS }` reads like its one-line form.
  const compact = expression
    .replace(/\/\/[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/[{}\s]/g, "");
  let total = 0;
  for (const term of compact.split("+")) {
    const token = term.trim();
    if (!token) continue;
    if (/^[0-9][0-9_]*$/.test(token)) {
      total += Number(token.replaceAll("_", ""));
      continue;
    }
    if (!(token in constants))
      fail(`unknown constant ${token} in watchdog limit`);
    total += constants[token];
  }
  return total;
}

function render(constants, watchdog) {
  const families = Object.entries(FAMILY_KEYS)
    .map(([constant, key]) => `  ${key}: ${constants[constant]},`)
    .join("\n");
  const watch = WATCHDOG_KINDS.map((kind) => {
    const key = kind[0].toLowerCase() + kind.slice(1);
    return `  ${key}: ${watchdog[kind]},`;
  }).join("\n");
  return `${HEADER}

/** Interval of the UI operation watchdog. A tick only re-checks elapsed time. */
export const WATCHDOG_TICK_MS = ${constants.WATCHDOG_TICK_MS};

/**
 * Enforced limit per host command family, in milliseconds, measured from process
 * spawn until the child exits. The runner clamps every request to its family, so
 * this is both the host's backstop and the widest limit a caller may ask for.
 */
export const WORKSPACE_BOUNDS_MS = {
${families}
} as const;

export type WorkspaceBound = keyof typeof WORKSPACE_BOUNDS_MS;

/** Inherited by every P4 process; no family may exceed it. */
export const P4_PROCESS_HARD_CAP_MS = ${constants.P4_PROCESS_HARD_CAP_MS};

/**
 * How long the UI waits for one toolbar operation family before it treats the
 * result as unknown: the host limit plus IO_DEADLINE_HEADROOM_MS, so a command
 * that times out on the host still reports its own failure first.
 */
export const WORKSPACE_WATCHDOG_MS = {
${watch}
} as const;

export type WorkspaceWatchdogKind = keyof typeof WORKSPACE_WATCHDOG_MS;

/**
 * Slack the UI adds to a host limit for IPC and result reporting. The host does
 * not add it; it only sizes the late-result grace for unknown sync outcomes.
 */
export const IO_DEADLINE_HEADROOM_MS = ${constants.IO_DEADLINE_HEADROOM_MS};

/** Late-host grace after the UI stopped waiting for an unknown \`sync\`. */
export const SYNC_LATE_RESULT_GRACE_MS = ${constants.SYNC_LATE_RESULT_GRACE_MS};

export function workspaceBoundMs(bound: WorkspaceBound): number {
  return WORKSPACE_BOUNDS_MS[bound];
}

export function watchdogLimitMs(kind: WorkspaceWatchdogKind): number {
  return WORKSPACE_WATCHDOG_MS[kind];
}
`;
}

function main() {
  const source = readFileSync(rustPath, "utf8");
  const constants = parseConstants(source);
  const watchdog = parseWatchdogLimits(source, constants);
  const expected = render(constants, watchdog);
  let current;
  try {
    current = readFileSync(outPath, "utf8");
  } catch {
    current = undefined;
  }
  if (process.argv.includes("--check")) {
    if (current !== expected) {
      fail(
        `${outPath} is out of date with src-tauri/src/p4/bounds.rs; run \`node scripts/generate-io-bounds.mjs\``,
      );
    }
    console.log("generate-io-bounds: up to date");
    return;
  }
  if (current === expected) {
    console.log(`generate-io-bounds: unchanged ${outPath}`);
    return;
  }
  writeFileSync(outPath, expected);
  console.log(`generate-io-bounds: wrote ${outPath}`);
}

main();
