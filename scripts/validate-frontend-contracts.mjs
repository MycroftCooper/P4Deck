import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const read = (file) => readFile(new URL(`../${file}`, import.meta.url), "utf8");
const unique = (values) => [...new Set(values)].sort();
const difference = (left, right) =>
  left.filter((value) => !right.includes(value));
const ids = (source, pattern) =>
  unique([...source.matchAll(pattern)].map((match) => match[1]));
const assertSame = (label, expected, actual) => {
  const missing = difference(expected, actual);
  const extra = difference(actual, expected);
  if (missing.length || extra.length)
    throw new Error(
      `${label}\nmissing: ${missing.join(", ") || "none"}\nextra: ${extra.join(", ") || "none"}`,
    );
};
const walk = async (directory) =>
  (
    await Promise.all(
      (await readdir(directory, { withFileTypes: true })).map(async (entry) => {
        const target = path.join(directory, entry.name);
        return entry.isDirectory()
          ? walk(target)
          : entry.name.endsWith(".tsx")
            ? [target]
            : [];
      }),
    )
  ).flat();

const [catalog, rust, menuRegistry, design, ledger, actions] =
  await Promise.all([
    read("src/app/commands/catalog.ts"),
    read("src-tauri/src/lib.rs"),
    read("src/app/context-menu/catalog.ts"),
    read("ForAIDoc/Designer/右键菜单对象与菜单项总表.md"),
    read("ForAIDoc/Coder/右键菜单UI逐项验收台账.md"),
    read("ForAIDoc/Designer/统一Action刷新与通知.md"),
  ]);

const union = catalog.match(/export type AppCommandId =([\s\S]*?);/);
if (!union) throw new Error("AppCommandId union not found");
const commandIds = ids(union[1], /"([a-z]+\.[A-Za-z0-9]+)"/g);
const rustIds = ids(
  rust,
  /"((?:app|connection|view|workspace|changelist|file|swarm|operation|tools|refresh|panel)\.[A-Za-z0-9]+)"/g,
);
assertSame("TypeScript and Rust command IDs drifted", commandIds, rustIds);

const registryIds = ids(menuRegistry, /id:\s*"([FCVSWUT]\d{2}-\d{2})"/g);
const designIds = [];
for (const line of design.split("\n")) {
  if (!/^\| [FCVSWUT]\d{2} \|/.test(line)) continue;
  const cells = line.split("|").map((value) => value.trim());
  const object = cells[1];
  const count = [...cells[3].split("；"), ...cells[4].split("；")].filter(
    (value) => /^[☐☑]/u.test(value.trim()),
  ).length;
  for (let index = 1; index <= count; index += 1)
    designIds.push(`${object}-${String(index).padStart(2, "0")}`);
}
assertSame(
  "Designer inventory and TypeScript menu registry drifted",
  unique(designIds),
  registryIds,
);

const customIds = registryIds.filter(
  (id) => !id.startsWith("U07-") && !id.startsWith("U08-"),
);
const ledgerIds = ids(ledger, /^\| ([FCVSWUT]\d{2}-\d{2}) \|/gm);
assertSame("Menu registry and acceptance ledger drifted", customIds, ledgerIds);

const documentedCommands = commandIds.filter((id) =>
  actions.includes(`\`${id}\``),
);
assertSame(
  "Action documentation omits production commands",
  commandIds,
  documentedCommands,
);

const iconButtonFailures = [];
for (const file of await walk(
  fileURLToPath(new URL("../src", import.meta.url)),
)) {
  const source = await readFile(file, "utf8");
  for (const match of source.matchAll(/<button\b[\s\S]*?>/g)) {
    const tag = match[0];
    if (!/className="[^"]*(icon-button|workflow-dialog-close)[^"]*"/.test(tag))
      continue;
    if (!/aria-(label|labelledby)=/.test(tag))
      iconButtonFailures.push(
        `${path.relative(process.cwd(), file)}:${source.slice(0, match.index).split("\n").length}`,
      );
  }
}
if (iconButtonFailures.length)
  throw new Error(
    `Icon-only buttons without accessible names:\n${iconButtonFailures.join("\n")}`,
  );

process.stdout.write(
  `frontend contracts valid: ${commandIds.length} commands, ${registryIds.length} menu leaves, ${customIds.length} custom ledger items\n`,
);
