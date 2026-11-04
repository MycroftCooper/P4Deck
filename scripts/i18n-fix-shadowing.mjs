#!/usr/bin/env node
/**
 * Follow-up pass for the convergence codemod: resolve `t` shadowing.
 *
 * The codemod prepends `import { t } from ".../shared/i18n"`. Components that
 * already bind their own `t` (a messages object received as a prop or
 * parameter) shadow that import, which TS reports as "not callable" or
 * "cannot find name t".
 *
 * Fix: switch such files to the hook form.
 *   import { t } from ".../shared/i18n"   ->   import { useT } from "..."
 *   inside the component body               ->   const t = useT();
 *
 * Usage: node scripts/i18n-fix-shadowing.mjs <file> [<file>...] [--write]
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const WRITE = process.argv.includes("--write");
const files = process.argv.slice(2).filter((a) => !a.startsWith("--"));

const IMPORT_T = /^import \{ t \} from "([^"]*shared\/i18n)";\n/;

/**
 * Find the index just after a function/component signature's opening `{`,
 * i.e. the place to inject hook calls at the top of the body.
 */
function injectPoint(src, startIdx) {
  let depth = 0;
  for (let i = startIdx; i < src.length; i++) {
    const c = src[i];
    if (c === "(" || c === "{" || c === "[") depth++;
    else if (c === ")" || c === "}" || c === "]") {
      depth--;
      if (depth === 0) {
        // Signature closed; find the body brace.
        const body = src.indexOf("{", i);
        if (body === -1) return -1;
        return body + 1;
      }
    }
  }
  return -1;
}

for (const file of files) {
  const abs = path.join(ROOT, file);
  let src = fs.readFileSync(abs, "utf8");
  const m = src.match(IMPORT_T);
  if (!m) {
    console.log(`SKIP ${file} (no codemod t-import)`);
    continue;
  }
  const modPath = m[1];
  let out = src.replace(IMPORT_T, `import { useT } from "${modPath}";\n`);

  // Inject `const t = useT();` at the top of every function that calls t(.
  // Hook rules require the top of a component body; the codemod only rewrites
  // render paths, so these are component functions.
  let injected = 0;
  const fnRe = /\bfunction\s+([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\(/g;
  let fm;
  const points = [];
  while ((fm = fnRe.exec(out))) {
    const bodyStart = injectPoint(out, fm.index + fm[0].length - 1);
    if (bodyStart === -1) continue;
    points.push({ name: fm[1], bodyStart });
  }
  // Also arrow components assigned to a capitalized const.
  const arrowRe = /\bconst\s+([A-Z][\w$]*)\s*=\s*(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*\{/g;
  let am;
  while ((am = arrowRe.exec(out))) {
    points.push({ name: am[1], bodyStart: am.index + am[0].length });
  }

  // Insert from the end so earlier offsets stay valid.
  points.sort((a, b) => b.bodyStart - a.bodyStart);
  for (const p of points) {
    const bodyEnd = out.indexOf("\n};", p.bodyStart);
    const bodyText = out.slice(p.bodyStart, bodyEnd === -1 ? undefined : bodyEnd);
    if (!/\bt\(/.test(bodyText)) continue;
    const indent = "  ";
    out =
      out.slice(0, p.bodyStart) +
      `\n${indent}const t = useT();` +
      out.slice(p.bodyStart);
    injected++;
  }

  if (WRITE) fs.writeFileSync(abs, out);
  console.log(`${WRITE ? "PATCHED" : "PLAN"} ${file} (injections: ${injected})`);
}
