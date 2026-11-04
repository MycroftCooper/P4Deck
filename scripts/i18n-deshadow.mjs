#!/usr/bin/env node
/**
 * Resolve `t` shadowing across the whole tree.
 *
 * The convergence codemod prepends `import { t } from ".../shared/i18n"`.
 * Components that bind their own `t` (a legacy messages prop/param) shadow it.
 * This pass switches those files to the aliased form and rewrites the
 * codemod-produced calls:
 *
 *   import { t } from "x"        ->  import { t as translate } from "x"
 *   t("ns.key")                  ->  translate("ns.key")
 *
 * Only namespaced keys are rewritten, so legacy `t.someField` access is safe.
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const WRITE = process.argv.includes("--write");

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}
const rel = (p) => path.relative(ROOT, p).replaceAll("\\", "/");

const IMPORT_T = /^import \{ t \} from "([^"]*shared\/i18n)";\n/;
/** A local binding named t that is not the catalog call: t.prop or a param. */
const LOCAL_T_USE = /(?<![.\w])t\.[a-zA-Z_]/;
const LOCAL_T_DECL = /(?:\bt\s*,\s*|\bt\s*:\s*)(?:Messages|typeof messages|\{)|:\s*\{\s*[^}]*\bt\b/;

const files = walk(path.join(ROOT, "src"))
  .filter((p) => /\.(ts|tsx)$/.test(p) && !/\.test\.(ts|tsx)$/.test(p))
  .map(rel);

let changed = 0;
for (const file of files) {
  const abs = path.join(ROOT, file);
  let src = fs.readFileSync(abs, "utf8");
  const m = src.match(IMPORT_T);
  if (!m) continue;
  const body = src.slice(m[0].length);
  // Shadowed when the file also reads t.<field> (the legacy dictionary) or
  // declares a t prop/parameter.
  if (!LOCAL_T_USE.test(body) && !LOCAL_T_DECL.test(body)) continue;

  let out = src.replace(IMPORT_T, `import { t as translate } from "${m[1]}";\n`);
  let n = 0;
  out = out.replace(/(?<![.\w])t\("((?:[a-zA-Z][\w]*)(?:\.[a-zA-Z][\w]*)+)"\)/g, (w) => {
    n++;
    return w.replace(/^t\(/, "translate(");
  });
  if (!n) continue;
  if (WRITE) fs.writeFileSync(abs, out);
  console.log(`${WRITE ? "PATCHED" : "PLAN"} ${file} (${n})`);
  changed++;
}
console.log(`files ${WRITE ? "patched" : "to patch"}: ${changed}`);
