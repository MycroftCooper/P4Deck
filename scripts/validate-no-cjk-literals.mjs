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
  // Development-only UI harness, lazily imported behind import.meta.env.DEV so
  // it is not in the production bundle. Its copy targets the developer running
  // the audit, not a user; translating it buys nothing and adds maintenance.
  "src/app/context-menu/MenuAuditPage.tsx",
  // Bundled release notes: the same Chinese text that is published in each
  // update manifest and shown verbatim by the in-app changelog. It is
  // historical release data (not translatable UI copy); localizing it would
  // fork the published record from what users see in the updater.
  "src/app/update/changelog.ts",
];

/**
 * Known remaining hardcoded Chinese: exact "file:line" positions accepted as a
 * baseline so the gate can block NEW violations while the tail is ground down.
 *
 * Every entry is a user-visible string still awaiting translation. Remove an
 * entry when you translate it; adding one requires a reason, because each line
 * here is a real gap in the localization. Regenerate with
 * `node scripts/validate-no-cjk-literals.mjs --json` and read violations.json.
 *
 * Keep this list shrinking. It is a schedule, not a permission.
 */
const BASELINE = new Set([
  "src/app/App.tsx:521",
  "src/app/DockWorkspace.tsx:37",
  "src/app/DockWorkspace.tsx:38",
  "src/app/DockWorkspace.tsx:47",
  "src/app/DockWorkspace.tsx:49",
  "src/app/commands/keymapPersistence.ts:186",
  "src/app/commands/keymapPersistence.ts:187",
  "src/app/context-menu/ColumnResizer.tsx:19",
  "src/app/context-menu/ColumnResizer.tsx:20",
  "src/app/context-menu/FullTextSelection.tsx:64",
  "src/app/context-menu/FullTextSelection.tsx:65",
  "src/app/context-menu/FullTextSelection.tsx:73",
  "src/app/context-menu/copyMenu.ts:33",
  "src/app/context-menu/labels.ts:400",
  "src/app/shell/StatusBar.tsx:264",
  "src/features/browsers/components/DiffView.tsx:392",
  "src/features/browsers/components/DiffView.tsx:483",
  "src/features/browsers/components/StreamGraphPage.tsx:592",
  "src/features/changelists/components/ChangelistFormDialog.tsx:110",
  "src/features/changelists/components/ChangelistPage.tsx:433",
  "src/features/changelists/components/ChangelistPage.tsx:476",
  "src/features/changelists/components/IntegrationTraceDialog.tsx:301",
  "src/features/changelists/components/RevisionFileList.tsx:223",
  "src/features/changelists/components/SelectedFilesSubmitDialog.tsx:228",
  "src/features/changelists/components/SubmittedPage.tsx:751",
  "src/features/changelists/components/UnshelveDialog.tsx:620",
  "src/features/changelists/moveOptimism.ts:238",
  "src/features/companySubmit/CompanySubmitDialog.tsx:22",
  "src/features/files/components/FileWorkbench.tsx:354",
  "src/features/files/components/SyncDialog.tsx:468",
  "src/features/search/SearchPage.tsx:769",
  "src/features/search/SearchPage.tsx:770",
  "src/features/settings/ConnectionSpecCreateDialog.tsx:322",
  "src/features/settings/ConnectionSpecCreateDialog.tsx:596",
  "src/features/settings/LogSettingsCard.tsx:68",
  "src/features/settings/SettingsPage.tsx:499",
  "src/features/settings/UpdateSettingsCard.tsx:101",
  "src/features/tools/components/OperationJournalView.tsx:299",
  "src/features/workspaces/WorkspaceSwitcher.tsx:150",
]);

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
    // Explicitly accepted exceptions. A statement can be split over lines and
    // the formatter decides where the literal lands, so a marker on the line
    // immediately above this one also counts.
    if (/i18n-exempt/.test(line)) return;
    if (i > 0 && /i18n-exempt/.test(lines[i - 1])) return;
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
    const position = `${file}:${i + 1}`;
    const kind = BASELINE.has(position) ? "baseline" : "new";
    violations.push({ file, line: i + 1, text: trimmed.slice(0, 160), kind });
  });
}

const fresh = violations.filter((v) => v.kind === "new");
const known = violations.length - fresh.length;

if (JSON_OUT) {
  const outPath = path.join(ROOT, "artifacts/l10n/violations.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(
    outPath,
    JSON.stringify(
      { count: violations.length, fresh: fresh.length, violations },
      null,
      1,
    ),
  );
  console.log(
    `wrote ${outPath} (${violations.length} violations, ${fresh.length} new)`,
  );
  process.exit(fresh.length ? 1 : 0);
}

if (fresh.length) {
  console.error(
    `\n✗ ${fresh.length} NEW hardcoded Chinese literal(s) outside the catalog.\n` +
      `  Move the text into src/shared/i18n/catalog.zh.ts and call t("key").\n` +
      `  If the value is genuinely not UI copy, append an "i18n-exempt" comment.\n`,
  );
  for (const v of fresh)
    console.error(`  ${v.file}:${v.line}\n      ${v.text}`);
  process.exit(1);
}

if (known) {
  console.log(
    `✓ no NEW hardcoded Chinese outside the catalog ` +
      `(${known} known literals recorded in the baseline)`,
  );
} else {
  console.log("✓ no hardcoded Chinese literals outside the catalog");
}
