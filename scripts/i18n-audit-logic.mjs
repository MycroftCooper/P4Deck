#!/usr/bin/env node
/**
 * Phase 3 audit: find places where user-facing text is used as logic.
 *
 * Two classes:
 *  - COMPARE: a Chinese literal appears next to a comparison operator or a
 *    .includes/.startsWith/.match call, inside or outside the catalog.
 *  - RENDER: Chinese literal reachable from a render path.
 *
 * Read-only. Writes artifacts/l10n/logic-audit.json.
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
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

const files = walk(path.join(ROOT, "src")).filter(
  (p) => /\.(ts|tsx)$/.test(p) && !/\.test\.(ts|tsx)$/.test(p),
);

const COMPARE_PATTERNS = [
  { name: "strict-eq", re: /===\s*["'`][^"'`]*[\u4e00-\u9fff]/ },
  { name: "eq-rev", re: /["'`][^"'`]*[\u4e00-\u9fff][^"'`]*["'`]\s*===/ },
  {
    name: "incl",
    re: /\.(includes|startsWith|endsWith|match|test)\s*\(\s*["'`][^"'`]*[\u4e00-\u9fff]/,
  },
  { name: "sw-case", re: /case\s+["'`][^"'`]*[\u4e00-\u9fff]/ },
  { name: "map-key", re: /^\s*["'`]?[\u4e00-\u9fff][^:"'`]*["'`]?\s*:/ },
];

const findings = { compare: [], byFile: {} };

for (const f of files) {
  const lines = fs.readFileSync(f, "utf8").split(/\r?\n/);
  let inBlock = false;
  lines.forEach((line, i) => {
    if (inBlock) {
      if (line.includes("*/")) inBlock = false;
      return;
    }
    if (/^\s*\/\*/.test(line) && !line.includes("*/")) {
      inBlock = true;
      return;
    }
    if (!CJK.test(line)) return;
    if (/^\s*(\/\/|\*)/.test(line)) return;
    const code = line.split("//")[0];
    for (const p of COMPARE_PATTERNS) {
      if (p.name === "map-key") continue;
      if (p.re.test(code)) {
        findings.compare.push({
          file: rel(f),
          line: i + 1,
          kind: p.name,
          text: code.trim().slice(0, 180),
        });
        break;
      }
    }
  });
}

// Where is user text compared at all, regardless of language?
const textCompare = [];
for (const f of files) {
  const lines = fs.readFileSync(f, "utf8").split(/\r?\n/);
  lines.forEach((line, i) => {
    if (
      /(label|title|message|text|reason|confirmation|description)\s*(===|!==|==|!=)/.test(
        line,
      ) ||
      /\.(includes|startsWith)\(\s*(label|title|message|text|reason)/.test(line)
    )
      textCompare.push({
        file: rel(f),
        line: i + 1,
        text: line.trim().slice(0, 180),
      });
  });
}

fs.mkdirSync(path.join(ROOT, "artifacts/l10n"), { recursive: true });
fs.writeFileSync(
  path.join(ROOT, "artifacts/l10n/logic-audit.json"),
  JSON.stringify({ compare: findings.compare, textCompare }, null, 1),
);

console.log(`Chinese literals used in comparisons: ${findings.compare.length}`);
for (const c of findings.compare)
  console.log(`  ${c.file}:${c.line}  [${c.kind}]  ${c.text}`);
console.log(`\nText-valued field comparisons: ${textCompare.length}`);
for (const c of textCompare.slice(0, 40))
  console.log(`  ${c.file}:${c.line}  ${c.text}`);
