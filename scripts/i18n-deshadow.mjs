#!/usr/bin/env node
/**
 * Resolve `t` shadowing for files that receive a legacy `t` messages prop.
 *
 * These components destructure a `t` prop (the old flat dictionary) that
 * shadows the module-level `t` imported by the convergence codemod. Rather than
 * touching those legacy props, alias the import and call the alias:
 *
 *   import { t } from ".../shared/i18n"        ->  import { t as translate } ...
 *   t("key")  (the rewritten catalog keys)     ->  translate("key")
 *
 * Only keys produced by the codemod (namespaced, dot-separated) are rewritten;
 * a legacy `t.someField` access is left alone.
 *
 * Usage: node scripts/i18n-deshadow.mjs --write
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const WRITE = process.argv.includes("--write");

const files = [
  "src/features/files/components/FileWorkbench.tsx",
  "src/features/workspaces/WorkspacePage.tsx",
  "src/features/changelists/components/PendingPage.tsx",
  "src/features/files/components/ResourceExplorer.tsx",
  "src/features/changelists/components/SubmittedPage.tsx",
  "src/app/PageRenderer.tsx",
  "src/app/shell/AppControls.tsx",
];

for (const file of files) {
  const abs = path.join(ROOT, file);
  let src = fs.readFileSync(abs, "utf8");
  const importRe = /^import \{ t \} from "([^"]*shared\/i18n)";\n/;
  const m = src.match(importRe);
  if (!m) {
    console.log(`SKIP ${file}`);
    continue;
  }
  let out = src.replace(importRe, `import { t as translate } from "${m[1]}";\n`);
  // Rewrite only namespaced catalog keys, not legacy `t.field` access.
  const callRe = /\bt\("([a-zA-Z][\w]*\.)+[a-zA-Z][\w.]*"\)/g;
  let n = 0;
  out = out.replace(callRe, (whole) => {
    n++;
    return whole.replace(/^t\(/, "translate(");
  });

  if (WRITE) fs.writeFileSync(abs, out);
  console.log(`${WRITE ? "PATCHED" : "PLAN"} ${file} (${n} calls)`);
}
