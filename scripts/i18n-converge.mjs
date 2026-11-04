#!/usr/bin/env node
/**
 * Localization convergence codemod.
 *
 * Finds bilingual patterns that already carry both languages inline and lifts
 * them into the shared catalog, replacing the call site with t("key"):
 *
 *   zh ? "中文" : "English"        ->  t("ns.key")
 *   (a, b) => (zh ? a : b) + tr("中","English")  ->  t("ns.key")
 *   { zh: "中文", en: "English" }  ->  property pairs are reported, not rewritten
 *
 * Behavior:
 *   --dry-run (default)  report only, never writes
 *   --write              apply edits and append keys to the catalogs
 *   --only <glob>        restrict to matching files
 *
 * Keys are derived from a namespaced file scope plus a slug of the English
 * text, so re-running is stable and produces no duplicate keys.
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const args = process.argv.slice(2);
const WRITE = args.includes("--write");
const onlyIdx = args.indexOf("--only");
const ONLY = onlyIdx >= 0 ? args[onlyIdx + 1] : null;

const CATALOG_ZH = path.join(ROOT, "src/shared/i18n/catalog.zh.ts");
const CATALOG_EN = path.join(ROOT, "src/shared/i18n/catalog.en.ts");

const CJK = /[\u4e00-\u9fff]/;

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}
const rel = (p) => path.relative(ROOT, p).replaceAll("\\", "/");

/** File path -> catalog namespace. */
function namespaceFor(file) {
  const m = file.match(/^src\/(app|features|shared)\/([^/]+)/);
  if (!m) return "common";
  const scope = m[2];
  const map = {
    "context-menu": "contextMenu",
    commands: "commands",
    shell: "shell",
    docking: "docking",
    update: "update",
    notifications: "notify",
    changelists: "pending",
    browsers: "browse",
    files: "files",
    settings: "settings",
    tools: "tools",
    workspaces: "workspaces",
    search: "search",
    swarm: "swarm",
    companySubmit: "companySubmit",
    actions: "actions",
    lib: "common",
  };
  return map[scope] ?? (scope.replace(/[^a-zA-Z]/g, "") || "common");
}

/** Stable slug from the English text, so re-runs produce the same key. */
function slugOf(english) {
  const cleaned = english
    // Collapse whitespace first: JSX often wraps long text across lines, which
    // would otherwise leak into the key as separate segments.
    .replace(/\s+/g, " ")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ".")
    .replace(/^\.+|\.+$/g, "");
  return cleaned.split(".").filter(Boolean).slice(0, 5).join(".") || "text";
}

// ---------------------------------------------------------------- extraction

/** Unescape a JS string literal body captured between matching quotes. */
function unescape(body) {
  return body
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/\\"/g, '"')
    .replace(/\\'/g, "'")
    .replace(/\\\\/g, "\\");
}

/** Escape text for a single-quoted-inside-double-quoted TS string. */
function esc(text) {
  return text.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

const STR = `("(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*')`;
const CJK_OR_ASCII_STR = `("(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*')`;

/**
 * zh ? "中文" : "English"  (optionally wrapped in parens).
 *
 * Deliberately restricted to a single line: the ternary body may not contain a
 * newline. Multi-line ternaries are left untouched and reported instead, so the
 * codemod can never swallow neighbouring JSX as a "string literal".
 */
const TERNARY_RE = new RegExp(
  `(?<![\\w$.])zh\\s*\\?\\s*${CJK_OR_ASCII_STR}[ \\t]*:[ \\t]*${CJK_OR_ASCII_STR}`,
  "g",
);

/**
 * Prettier-wrapped ternary, e.g.
 *   zh
 *     ? "中文"
 *     : "English"
 * Captured separately because the single-line pattern must not span newlines.
 */
const TERNARY_WRAPPED_RE = new RegExp(
  `(?<![\\w$.])zh\\s*\\n\\s*\\?\\s*${CJK_OR_ASCII_STR}\\s*\\n\\s*:\\s*${CJK_OR_ASCII_STR}`,
  "g",
);

/** tr("中文", "English") — any local helper name already defined in the file. */
const TR_CALL_RE = new RegExp(
  `\\btr\\s*\\(\\s*${CJK_OR_ASCII_STR}\\s*,\\s*${CJK_OR_ASCII_STR}\\s*\\)`,
  "g",
);

/** { zh: "中文", en: "English" } property pairs. */
const PAIR_RE = new RegExp(
  `\\{\\s*zh\\s*:\\s*${CJK_OR_ASCII_STR}\\s*,\\s*en\\s*:\\s*${CJK_OR_ASCII_STR}\\s*\\}`,
  "g",
);

/** Multi-line bilingual ternaries: reported, never auto-rewritten. */
const MULTILINE_TERNARY_RE = /\bzh\s*\?\s*\n/;

function stripQuotes(lit) {
  return unescape(lit.slice(1, -1));
}

const results = [];
const keys = new Map(); // key -> { zh, en }

function keyFor(ns, zhText, enText) {
  const slug = slugOf(enText || zhText);
  let key = `${ns}.${slug}`;
  let suffix = 2;
  // A key must never be reused for different text: the catalogs are curated by
  // hand and a silent overwrite changes an existing translation.
  for (;;) {
    const existing = keys.get(key);
    if (!existing) return key;
    if (existing.zh === zhText && existing.en === enText) return key;
    key = `${ns}.${slug}.${suffix++}`;
  }
}

function processFile(file) {
  const abs = path.join(ROOT, file);
  const src = fs.readFileSync(abs, "utf8");
  const ns = namespaceFor(file);
  let out = src;
  let edits = 0;

  const replaceLit = (pattern, pick) => {
    out = out.replace(pattern, (whole, ...rest) => {
      const [zhLit, enLit] = pick(rest);
      if (!zhLit || !enLit) return whole;
      const zhText = stripQuotes(zhLit);
      const enText = stripQuotes(enLit);
      // Only converge genuinely bilingual pairs where one side is Chinese.
      if (!CJK.test(zhText) || CJK.test(enText)) return whole;
      const key = keyFor(ns, zhText, enText);
      if (!keys.has(key)) keys.set(key, { zh: zhText, en: enText });
      edits++;
      return `t("${key}")`;
    });
  };

  replaceLit(TERNARY_RE, (r) => [r[0], r[1]]);
  replaceLit(TERNARY_WRAPPED_RE, (r) => [r[0], r[1]]);
  replaceLit(TR_CALL_RE, (r) => [r[0], r[1]]);
  // Property pairs are reported but left alone: they are data models.
  const pairs = [...src.matchAll(PAIR_RE)];

  if (edits) results.push({ file, ns, edits, out, pairs: pairs.length });
  else if (pairs.length) results.push({ file, ns, edits: 0, out: src, pairs: pairs.length });
  return out;
}

// ------------------------------------------------------------------- run

/** Compact line-level before/after for human review of a dry run. */
function previewDiff(before, after) {
  const b = before.split("\n");
  const a = after.split("\n");
  const out = [];
  // Same line count is not guaranteed once an import is prepended; diff by
  // common-suffix alignment so substitutions stay paired instead of cascading.
  let bi = 0;
  let ai = 0;
  while (bi < b.length || ai < a.length) {
    if (b[bi] === a[ai]) {
      bi++;
      ai++;
      continue;
    }
    if (a[ai + 1] === b[bi]) {
      out.push(`+ ${a[ai].trim().slice(0, 160)}`);
      ai++;
    } else if (b[bi + 1] === a[ai]) {
      out.push(`- ${b[bi].trim().slice(0, 160)}`);
      bi++;
    } else {
      if (b[bi] !== undefined) out.push(`- ${b[bi].trim().slice(0, 160)}`);
      if (a[ai] !== undefined) out.push(`+ ${a[ai].trim().slice(0, 160)}`);
      bi++;
      ai++;
    }
    if (out.length > 400) {
      out.push("… (truncated)");
      break;
    }
  }
  return out;
}

let files = walk(path.join(ROOT, "src")).filter(
  (p) => /\.(ts|tsx)$/.test(p) && !/\.test\.(ts|tsx)$/.test(p),
).map(rel);
if (ONLY) files = files.filter((f) => f.includes(ONLY));

for (const f of files) processFile(f);

const totalEdits = results.reduce((a, r) => a + r.edits, 0);
const touched = results.filter((r) => r.edits > 0);

console.log(`${WRITE ? "APPLYING" : "DRY RUN"} — ${touched.length} files, ${totalEdits} replacements, ${keys.size} new keys`);
for (const r of touched.sort((a, b) => b.edits - a.edits))
  console.log(`  ${String(r.edits).padStart(3)}  ${r.file}`);
const pairOnly = results.filter((r) => r.edits === 0 && r.pairs);
if (pairOnly.length) {
  console.log(`\nProperty-pair sites needing manual handling (${pairOnly.length} files):`);
  for (const r of pairOnly) console.log(`  ${r.pairs}x  ${r.file}`);
}

if (!WRITE) {
  fs.mkdirSync(path.join(ROOT, "artifacts/l10n"), { recursive: true });
  fs.writeFileSync(
    path.join(ROOT, "artifacts/l10n/codemod-plan.json"),
    JSON.stringify(
      {
        // Applied text per file, so the plan can be reviewed before writing.
        files: touched.map((r) => ({
          file: r.file,
          edits: r.edits,
          preview: previewDiff(fs.readFileSync(path.join(ROOT, r.file), "utf8"), r.out),
        })),
        keys: keys.size,
      },
      null,
      1,
    ),
  );
  console.log("\nPlan written to artifacts/l10n/codemod-plan.json");
  process.exit(0);
}

// ------------------------------------------------------- apply + catalog

if (WRITE) {
  // Append new keys to both catalogs, grouped at the end under a marker.
  const append = (catalogPath, pick) => {
    let text = fs.readFileSync(catalogPath, "utf8");
    const marker = "  // ---- codemod-converged ------------------------------------------------";
    // Merge with keys already converged by a previous run, otherwise the
    // block is replaced and earlier keys are lost.
    const existing = new Map();
    const blockRe = /  \/\/ ---- codemod-converged[^\n]*\n([\s\S]*?)(?=\n\} as const|\n\};)/;
    const prev = text.match(blockRe);
    if (prev)
      for (const m of prev[1].matchAll(/^  "([^"]+)": "((?:[^"\\]|\\.)*)",$/gm))
        existing.set(m[1], m[2].replace(/\\"/g, '"').replace(/\\\\/g, "\\"));
    for (const [k, v] of keys) {
      // Never shadow a curated key that already exists outside the block.
      if (!existing.has(k) && new RegExp(`^  "${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}":`, "m").test(text.replace(blockRe, ""))) {
        throw new Error(
          `key "${k}" already exists in ${path.basename(catalogPath)} with different text; ` +
            `refusing to overwrite a curated translation`,
        );
      }
      existing.set(k, pick(v));
    }

    const lines = [...existing.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `  "${k}": "${esc(v)}",`)
      .join("\n");
    const block = `${marker}\n${lines}\n`;

    if (prev) text = text.replace(blockRe, block.trimEnd() + "\n");
    else {
      // Insert before whichever closing form this catalog uses:
      //   `} as const satisfies Catalog;`   (catalog.zh.ts)
      //   `};`                              (catalog.en.ts)
      const closingPatterns = [/(\n\} as const satisfies Catalog;)/, /(\n\};)/];
      let inserted = false;
      for (const pattern of closingPatterns) {
        if (!pattern.test(text)) continue;
        text = text.replace(pattern, `\n${block}$1`);
        inserted = true;
        break;
      }
      if (!inserted)
        throw new Error(`could not find a closing brace in ${catalogPath}`);
    }
    fs.writeFileSync(catalogPath, text);
  };
  append(CATALOG_ZH, (v) => v.zh);
  append(CATALOG_EN, (v) => v.en);

  for (const r of touched) {
    let out = r.out;
    // Only skip when an actual `t` binding is already imported; importing
    // `messages` from the same module does not provide one.
    const alreadyImportsT =
      /import\s*\{[^}]*\bt\b[^}]*\}\s*from\s*"[^"]*shared\/i18n"/.test(out);
    if (!alreadyImportsT) {
      // Count directories below src/ (the file has "src/" prefix, so subtract
      // both the "src" segment and the filename segment).
      const dirs = r.file.split("/").slice(1, -1); // e.g. ["app","commands"]
      const up = "../".repeat(dirs.length) + "shared/i18n";
      out = `import { t } from "${up}";\n` + out;
    }
    fs.writeFileSync(path.join(ROOT, r.file), out);
  }
  console.log(`\nApplied to ${touched.length} files; added ${keys.size} keys to both catalogs.`);
}
