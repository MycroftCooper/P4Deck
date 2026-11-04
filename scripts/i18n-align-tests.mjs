#!/usr/bin/env node
/**
 * Align the i18n module locale with English-rendering test suites.
 *
 * After the convergence, components translate through the module-level t()
 * rather than through a `t` messages prop. A test that renders the English UI
 * must therefore also move the module locale, otherwise assertions see Chinese.
 *
 * For each failing suite this script inserts `setLocale("en-US")` into the
 * existing beforeEach (or creates one), matching how the app sets the locale.
 *
 * Usage: node scripts/i18n-align-tests.mjs --write [files...]
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const WRITE = process.argv.includes("--write");
const files = process.argv.slice(2).filter((a) => !a.startsWith("--"));

for (const file of files) {
  const abs = path.join(ROOT, file);
  if (!fs.existsSync(abs)) {
    console.log(`MISSING ${file}`);
    continue;
  }
  let src = fs.readFileSync(abs, "utf8");
  if (/setLocale\("en-US"\)/.test(src) || /activateLocale\("en-US"\)/.test(src)) {
    console.log(`SKIP (already aligned) ${file}`);
    continue;
  }
  // Import the locale setter. Reuse an existing vitest import for naming.
  const depth = file.split("/").slice(1, -1).length;
  const i18nPath = "../".repeat(depth) + "shared/i18n";
  if (!/from "[^"]*shared\/i18n"/.test(src)) {
    // Insert after the last import line.
    const lines = src.split("\n");
    let lastImport = 0;
    for (let i = 0; i < lines.length; i++)
      if (/^import /.test(lines[i]) || /^\} from "/.test(lines[i]))
        lastImport = i;
    lines.splice(lastImport + 1, 0, `import { setLocale } from "${i18nPath}";`);
    src = lines.join("\n");
  } else {
    src = src.replace(
      /import \{([^}]*)\} from "([^"]*shared\/i18n)";/,
      (whole, names, mod) =>
        `import {${names.replace(/\s*$/, "")}, setLocale } from "${mod}";`,
    );
  }

  // Inject into the first beforeEach, else create one before the first it().
  const before = src.match(/beforeEach\(\(\) => \{\n/);
  if (before) {
    src = src.replace(
      /beforeEach\(\(\) => \{\n/,
      'beforeEach(() => {\n  // Components translate through the module-level locale.\n  setLocale("en-US");\n',
    );
  } else {
    const firstIt = src.search(/\n(it|test)\(/);
    const hook =
      '\n// Components translate through the module-level locale.\nbeforeEach(() => {\n  setLocale("en-US");\n});\n';
    if (firstIt === -1) {
      console.log(`NO ANCHOR ${file}`);
      continue;
    }
    src = src.slice(0, firstIt) + hook + src.slice(firstIt);
  }

  if (WRITE) fs.writeFileSync(abs, src);
  console.log(`${WRITE ? "PATCHED" : "PLAN"} ${file}`);
}
