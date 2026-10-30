#!/usr/bin/env node
// QA desktop dev: 独立应用标识 + 共享 Cargo target（依赖复用）+ 独立前端端口。
//
//   node scripts/dev-desktop-qa.mjs
//
// 启动本地 p4d fixture，然后用 QA 配置 `tauri dev`。默认与普通桌面开发共用
// `src-tauri/target`（同一 dev profile，省下一整棵依赖图 ~5GB）：
//   - 切换 QA/普通 dev 只会重编应用 crate，不会重编依赖；
//   - 代价是两者**不能同时运行**（同一份 p4deck.exe 会被覆盖）。
// 确实需要同时跑时，用环境变量显式隔离：
//   $env:P4DECK_QA_TARGET_DIR = "src-tauri/target-qa"
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
        path.join(repoRoot, "src-tauri", "target"),
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
