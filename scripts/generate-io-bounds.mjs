#!/usr/bin/env node
// R9: keep the frontend operation bounds generated from the Rust source of truth
// (`src-tauri/src/p4/bounds.rs`).
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

// `WORKSPACE_<SUFFIX>_MS` -> `<suffix>` in camelCase, as the TS key. This table
// must cover exactly the `IoBound` variants; the variant cross-check below fails
// the build when the Rust enum and this table disagree in either direction, so a
// newly added family cannot silently stay out of the generated module.
const FAMILY_KEYS = {
  WORKSPACE_READ_MS: "workspaceRead",
  WORKSPACE_READ_LONG_MS: "workspaceReadLong",
  WORKSPACE_COMMAND_MS: "workspaceCommand",
  WORKSPACE_SYNC_MS: "workspaceSync",
  WORKSPACE_PREVIEW_MS: "workspacePreview",
  WORKSPACE_BOOTSTRAP_MS: "workspaceBootstrap",
  WORKSPACE_OTHER_MS: "workspaceOther",
};

// Rust variant name -> the constant it maps to. Checked against the parsed enum.
const BOUND_FAMILIES = {
  Read: "WORKSPACE_READ_MS",
  ReadLong: "WORKSPACE_READ_LONG_MS",
  Command: "WORKSPACE_COMMAND_MS",
  Sync: "WORKSPACE_SYNC_MS",
  Preview: "WORKSPACE_PREVIEW_MS",
  Bootstrap: "WORKSPACE_BOOTSTRAP_MS",
  Other: "WORKSPACE_OTHER_MS",
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
    return (values[name] = evaluate(raw[name], values, (token) =>
      resolveName(token, depth + 1),
    ));
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

/** Sums a Rust arithmetic expression of constants and integer literals. */
function evaluate(expression, constants, onSymbol) {
  const compact = expression
    .replace(/\/\/[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/[{}\s]/g, "");
  let total = 0;
  for (const term of compact.split("+")) {
    if (!term) continue;
    if (/^[0-9][0-9_]*$/.test(term)) {
      total += Number(term.replaceAll("_", ""));
      continue;
    }
    if (!/^[A-Z0-9_]+$/.test(term)) {
      fail(`unsupported expression term \`${term}\` in \`${expression}\``);
    }
    total += onSymbol(term);
  }
  return total;
}

/** Parses `pub enum IoBound { ... }` into its variant names. */
function parseIoBoundVariants(source) {
  const block = source.match(/pub enum IoBound \{[\s\S]*?\n\}/);
  if (!block) fail("missing `pub enum IoBound` in bounds.rs");
  const body = block[0]
    .replace(/\/\/[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  const variants = [
    ...body.matchAll(/(?:^|\n)\s*(?:#\[[^\]]*\]\s*)*([A-Z][A-Za-z0-9]*)\s*,/g),
  ].map((match) => match[1]);
  if (!variants.length) fail("could not read any `IoBound` variant");
  return variants;
}

/**
 * Cross-checks the Rust enum against the hand-written tables in this script. A
 * one-sided check would let a new family (or a renamed one) generate cleanly and
 * still never reach the UI, which is exactly the drift this generator exists to
 * prevent — so missing on either side is a failure.
 */
function checkFamilyTables(variants) {
  const declared = new Set(variants);
  const mapped = new Set(Object.keys(BOUND_FAMILIES));
  const unmapped = [...declared].filter((name) => !mapped.has(name));
  const stale = [...mapped].filter((name) => !declared.has(name));
  if (unmapped.length) {
    fail(
      `IoBound has variant(s) ${unmapped.join(", ")} that BOUND_FAMILIES/FAMILY_KEYS do not map; ` +
        "add them so the frontend receives the new family",
    );
  }
  if (stale.length) {
    fail(
      `BOUND_FAMILIES maps ${stale.join(", ")}, which no longer exist in IoBound; ` +
        "remove them",
    );
  }
  for (const [variant, constant] of Object.entries(BOUND_FAMILIES)) {
    if (!(constant in FAMILY_KEYS))
      fail(`${constant} is missing from FAMILY_KEYS`);
  }
  if (Object.keys(FAMILY_KEYS).length !== variants.length) {
    fail("FAMILY_KEYS and IoBound disagree on the number of families");
  }
}

function render(constants) {
  const families = Object.entries(FAMILY_KEYS)
    .map(([constant, key]) => `  ${key}: ${constants[constant]},`)
    .join("\n");
  return `${HEADER}

/** Interval of the UI operation watchdog. A tick only re-checks elapsed time. */
export const WATCHDOG_TICK_MS = ${constants.WATCHDOG_TICK_MS};

/**
 * Enforced limit per host command family, in milliseconds, measured from process
 * spawn until the child exits. The runner clamps every request to its family, so
 * this is both the host's backstop and the widest limit a caller may ask for.
 *
 * The UI watchdog derives its wait from this table:
 * \`family limit + IO_DEADLINE_HEADROOM_MS\`. That is a rule, so it is not
 * pre-computed here — a second table of summed values would be a second copy of
 * the same facts and would drift.
 */
export const WORKSPACE_BOUNDS_MS = {
${families}
} as const;

export type WorkspaceBound = keyof typeof WORKSPACE_BOUNDS_MS;

/** Inherited by every P4 process; no family may exceed it. Mirrors the host. */
export const P4_PROCESS_HARD_CAP_MS = ${constants.P4_PROCESS_HARD_CAP_MS};

/**
 * Slack the UI adds to a host limit for IPC and result reporting. The host does
 * not add it; it only sizes the late-result grace for unknown sync outcomes.
 */
export const IO_DEADLINE_HEADROOM_MS = ${constants.IO_DEADLINE_HEADROOM_MS};

/**
 * Grace the host must keep before declaring a timed-out \`sync\` safe to abandon.
 * Reserved: the runner currently kills the child immediately on timeout.
 */
export const SYNC_LATE_RESULT_GRACE_MS = ${constants.SYNC_LATE_RESULT_GRACE_MS};
`;
}

function main() {
  const source = readFileSync(rustPath, "utf8");
  const variants = parseIoBoundVariants(source);
  checkFamilyTables(variants);
  const constants = parseConstants(source);
  const expected = render(constants);
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
