#!/usr/bin/env node
// 工作流量测：没有基线就没有真正的“优化”。
// 用法:
//   node scripts/workflow/measure.mjs record --batch <id> --role FE --event entry --files 3 --tokens 12000
//   node scripts/workflow/measure.mjs summary [--batch <id>]
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DIR = path.join(ROOT, "artifacts", "workflow");
const METRICS = path.join(DIR, "metrics.jsonl");

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (!argv[index].startsWith("--")) continue;
    const key = argv[index].slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      args[key] = next;
      index += 1;
    } else {
      args[key] = true;
    }
  }
  return args;
}

const [command, ...rest] = process.argv.slice(2);
const args = parseArgs(rest);

if (command === "record") {
  if (!args.batch || !args.role || !args.event) {
    process.stderr.write("用法: record --batch <id> --role <LEAD|FE|BE|QA> --event <entry|order|freeze|verify|apply|stop>\n");
    process.exit(2);
  }
  const entry = {
    at: new Date().toISOString(),
    batch: String(args.batch),
    role: String(args.role).toUpperCase(),
    event: String(args.event),
    files: args.files ? Number(args.files) : undefined,
    tokens: args.tokens ? Number(args.tokens) : undefined,
    rounds: args.rounds ? Number(args.rounds) : undefined,
    gateMs: args.gateMs ? Number(args.gateMs) : undefined,
    readLines: args.readLines ? Number(args.readLines) : undefined,
    note: args.note ? String(args.note) : undefined,
  };
  await mkdir(DIR, { recursive: true });
  await appendFile(METRICS, `${JSON.stringify(entry)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(entry)}\n`);
} else if (command === "summary") {
  let rows = [];
  try {
    const text = await readFile(METRICS, "utf8");
    rows = text
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    process.stdout.write("还没有量测数据。\n");
    process.exit(0);
  }
  if (args.batch) rows = rows.filter((row) => row.batch === args.batch);
  const byBatch = new Map();
  for (const row of rows) {
    const bucket = byBatch.get(row.batch) ?? { events: 0, tokens: 0, rounds: 0, gateMs: 0, readLines: 0 };
    bucket.events += 1;
    bucket.tokens += row.tokens ?? 0;
    bucket.rounds += row.rounds ?? 0;
    bucket.gateMs += row.gateMs ?? 0;
    bucket.readLines += row.readLines ?? 0;
    byBatch.set(row.batch, bucket);
  }
  const summary = [...byBatch.entries()].map(([batch, bucket]) => ({ batch, ...bucket }));
  process.stdout.write(`${JSON.stringify({ schemaVersion: 1, batches: summary, samples: rows.length }, null, 2)}\n`);
} else {
  process.stderr.write("用法: node scripts/workflow/measure.mjs <record|summary> ...\n");
  process.exit(2);
}
