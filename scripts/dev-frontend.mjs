#!/usr/bin/env node
// Start the Vite dev server for the desktop window. Invoked by `tauri dev`
// through `build.beforeDevCommand`, so it avoids depending on the caller shell
// having `pnpm` available (Windows execution policy blocks pnpm.ps1).
import { spawn } from "node:child_process";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const argv = process.argv.slice(2);

function option(name, fallback) {
  const index = argv.indexOf(name);
  return index === -1 ? fallback : argv[index + 1];
}

const port = option("--port", "1422");
const mode = option("--mode", "desktop");
const vite = path.join(repoRoot, "node_modules", "vite", "bin", "vite.js");

const child = spawn(
  process.execPath,
  [
    vite,
    "dev",
    "--mode",
    mode,
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--strictPort",
  ],
  { cwd: repoRoot, stdio: "inherit" },
);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}

child.on("error", (error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
child.on("exit", (code, signal) => process.exit(signal ? 0 : (code ?? 1)));
