#!/usr/bin/env node
// QA desktop dev: 独立应用标识 + 独立 Cargo target（可与普通 dev 并行）+ 独立前端端口。
//
//   node scripts/dev-desktop-qa.mjs
//
// 启动本地 p4d fixture，然后用 QA 配置 `tauri dev`。默认使用独立
// `src-tauri/target-qa`，因此普通桌面开发（1422）和 QA 开发可以**同时运行**，
// 互不覆盖调试构建，也不会因为共用 Cargo target 锁而互相阻塞。
// 代价是多占约 5GB 依赖构建；`cache.mjs clean --target-qa` 可随时清。
// 想复用依赖而接受"不能同时跑"时，显式设置共享 target：
//   $env:P4DECK_QA_TARGET_DIR = "src-tauri/target"
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { repoRoot } from "./lib.mjs";

function runFixture(action) {
  const result =
    process.platform === "win32"
      ? spawnSync(
          "powershell",
          [
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            "scripts/p4d-fixture.ps1",
            action,
          ],
          { cwd: repoRoot, stdio: "inherit" },
        )
      : spawnSync("bash", ["scripts/p4d-fixture.sh", action], {
          cwd: repoRoot,
          stdio: "inherit",
        });
  return result.status ?? 1;
}

const startStatus = runFixture("start");
if (startStatus !== 0) {
  console.error("p4d fixture failed to start; QA desktop was not launched.");
  process.exit(startStatus);
}

const tauri = path.join(
  repoRoot,
  "node_modules",
  "@tauri-apps",
  "cli",
  "tauri.js",
);
const child = spawn(
  process.execPath,
  [tauri, "dev", "--config", "src-tauri/tauri.qa.conf.json"],
  {
    cwd: repoRoot,
    stdio: "inherit",
    env: {
      ...process.env,
      CARGO_TARGET_DIR:
        process.env.P4DECK_QA_TARGET_DIR ??
        path.join(repoRoot, "src-tauri", "target-qa"),
    },
  },
);

let stopping = false;
function stopFixture() {
  if (stopping) return;
  stopping = true;
  runFixture("stop");
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    child.kill(signal);
    stopFixture();
  });
}

child.on("error", (error) => {
  console.error(error instanceof Error ? error.message : error);
  stopFixture();
  process.exit(1);
});
child.on("exit", (code, signal) => {
  stopFixture();
  process.exit(signal ? 0 : (code ?? 1));
});
