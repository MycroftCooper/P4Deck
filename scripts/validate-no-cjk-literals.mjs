#!/usr/bin/env node
/**
 * CI gate: no user-facing Chinese literals outside the catalogs.
 *
 * Every user-facing string must live in src/shared/i18n/catalog.zh.ts and be
 * addressed through t()/tFor(). This gate keeps the migration from regressing:
 * a new hardcoded Chinese string fails the build with its exact location.
 *
 * Allowed (with reason):
 *  - the catalogs themselves
 *  - comments and JSDoc
 *  - test files and fixtures
 *  - lines carrying an explicit `i18n-exempt` marker (justify in a comment)
 *  - Chinese that is data, not UI copy: P4 paths, fixture values in non-test
 *    source, and locale-detection lists
 *
 * Usage: node scripts/validate-no-cjk-literals.mjs [--json]
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const JSON_OUT = process.argv.includes("--json");
const CJK = /[\u4e00-\u9fff]/;

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules") continue;
      walk(p, out);
    } else out.push(p);
  }
  return out;
}
const rel = (p) => path.relative(ROOT, p).replaceAll("\\", "/");

/** Files exempt by role. */
const EXEMPT_FILES = [
  "src/shared/i18n/catalog.zh.ts",
  "src/shared/i18n/catalog.en.ts",
  "src/shared/i18n/i18n.test.ts",
  // Browser-demo fixtures: Chinese sheet names and cell values ARE the data
  // being previewed (CSV/XLSX rendering), not UI copy.
  "src/infrastructure/backend/mockBackend.ts",
  // Developer-facing migration inventory (adapters/stage/state per action).
  // Its resource/confirmation fields are notes for maintainers; nothing here
  // is rendered, and the module is only read by tests.
  "src/features/actions/registry.ts",
];

/**
 * Lookup indexes where the Chinese text is a KEY, not rendered copy:
 *  - labels.ts          maps a Chinese menu label to a catalog key
 *  - context-menu/catalog.ts  the menu inventory; its `label` fields are always
 *                             passed through menuLabel() before render
 */
const KEY_INDEX_FILES = [
  "src/app/context-menu/labels.ts",
  "src/app/context-menu/catalog.ts",
  // 中文菜单标签 -> CommandId lookup, read as `fileMenuCommands[label]`.
  "src/app/context-menu/fileMenuCommands.ts",
];

const violations = [];

/** Every label registered in the context-menu inventory. */
let menuLabelCache;
function contextMenuLabels() {
  if (menuLabelCache) return menuLabelCache;
  const p = path.join(ROOT, "src/app/context-menu/catalog.ts");
  const src = fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
  menuLabelCache = new Set(
    [...src.matchAll(/label:\s*\n?\s*"([^"]+)"/g)].map((m) => m[1]),
  );
  return menuLabelCache;
}

for (const abs of walk(path.join(ROOT, "src"))) {
  const file = rel(abs);
  if (!/\.(ts|tsx)$/.test(file)) continue;
  if (/\.test\.(ts|tsx)$/.test(file)) continue;
  if (EXEMPT_FILES.includes(file)) continue;

  const keyIndexOnly = KEY_INDEX_FILES.includes(file);
  // Labels registered in the menu inventory: a `bindings` object is keyed by
  // these labels (buildMenu looks up bindings[entry.label]), and every label is
  // rendered through menuLabel(), so the Chinese here is a key, not copy.
  const menuLabels = contextMenuLabels();

  const lines = fs.readFileSync(abs, "utf8").split(/\r?\n/);
  let inBlockComment = false;
  lines.forEach((line, i) => {
    if (inBlockComment) {
      if (line.includes("*/")) inBlockComment = false;
      return;
    }
    if (/^\s*\/\*/.test(line) && !line.includes("*/")) {
      inBlockComment = true;
      return;
    }
    if (!CJK.test(line)) return;
    const trimmed = line.trim();
    // Comments are not UI copy.
    if (/^(\/\/|\*)/.test(trimmed)) return;
    // Explicitly accepted exceptions.
    if (/i18n-exempt/.test(line)) return;
    // Ignore a trailing line comment only; keep the code part checked.
    const code = line.split("//")[0];
    if (!CJK.test(code)) return;
    // A menu-binding key: `中文标签: action(...)` / `copy(...)` / a literal /
    // a nested object / a conditional. Any of these is keyed by the inventory
    // label and rendered through menuLabel().
    const binding = code.match(
      /^\s*(?:"([^"]+)"|([\w\u4e00-\u9fff]+))\s*:\s*(?:action|copy|swarmMenuAction|hidden|[\w$.]+\s*\?|\{)/,
    );
    if (binding) {
      const label = (binding[1] ?? binding[2]).trim();
      if (menuLabels.has(label)) return;
    }
    // Membership access on an inventory label: bindings["中文"], merged["中文…"],
    // and label lists such as for (const label of ["刷新", ...]).
    for (const m of code.matchAll(/"([^"]+)"/g)) {
      if (CJK.test(m[1]) && menuLabels.has(m[1])) return;
    }
    // In a key index the Chinese sits on the left of a `key: "catalog.key"`
    // pair; only the mapped value is what renders. Flag object values only.
    if (keyIndexOnly) {
      // labels.ts:  中文键: "contextMenu.key",
      const isIndexEntry =
        /^\s*(?:"[^"]+"|[\w\u4e00-\u9fff ]+)\s*:\s*"[^"]*"\s*,?\s*$/.test(code);
      const valueHasCjk = /:\s*"(?:[^"\\]|\\.)*[\u4e00-\u9fff]/.test(code);
      if (isIndexEntry && !valueHasCjk) return;
      // catalog.ts:  label: "中文" / title: "中文"  (always routed through menuLabel)
      if (/^\s*(label|title):\s*"(?:[^"\\]|\\.)*[\u4e00-\u9fff]/.test(code))
        return;
      if (
        /^\s*"?(label|title)"?\s*:\s*"(?:[^"\\]|\\.)*[\u4e00-\u9fff]/.test(code)
      )
        return;
    }
    violations.push({ file, line: i + 1, text: trimmed.slice(0, 160) });
  });
}

if (JSON_OUT) {
  const outPath = path.join(ROOT, "artifacts/l10n/violations.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(
    outPath,
    JSON.stringify({ count: violations.length, violations }, null, 1),
  );
  console.log(`wrote ${outPath} (${violations.length} violations)`);
  process.exit(violations.length ? 1 : 0);
}

if (violations.length) {
  console.error(
    `\n✗ ${violations.length} hardcoded Chinese literal(s) found outside the catalog.\n` +
      `  Move the text into src/shared/i18n/catalog.zh.ts and call t("key").\n` +
      `  If the value is genuinely not UI copy, append an "i18n-exempt" comment.\n`,
  );
  for (const v of violations)
    console.error(`  ${v.file}:${v.line}\n      ${v.text}`);
  process.exit(1);
}

console.log("✓ no hardcoded Chinese literals outside the catalog");
