#!/usr/bin/env node
// Build the Windows NSIS installer into a stamped delivery directory.
//
//   node scripts/package-desktop.mjs [--allow-dirty] [--offline-webview2]
//       [--skip-verify] [--unsigned]
//
// Defaults to the small WebView2 bootstrapper (~1.8MB, needs internet on the
// target machine). Pass --offline-webview2 for the ~215MB offline installer.
//
// When the local updater signing key exists (%USERPROFILE%\.p4deck\updater.key,
// or TAURI_SIGNING_PRIVATE_KEY_PATH), the build also produces the signed
// updater artifacts (.nsis.zip + .sig) used by scripts/publish-update.mjs.
// Pass --unsigned to force a build without updater artifacts.
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  assertBuildableTree,
  readJson,
  repoRoot,
  runNode,
  sha256File,
  tauriCliVersion,
} from "./lib.mjs";
import {
  planUpdaterArtifacts,
  resolveSigningMaterial,
} from "./publish-update.mjs";

const argv = process.argv.slice(2);
const allowDirty = argv.includes("--allow-dirty");
const offlineWebview2 = argv.includes("--offline-webview2");
const skipVerify = argv.includes("--skip-verify");
const forceUnsigned = argv.includes("--unsigned");

if (process.platform !== "win32") {
  console.error(
    "scripts/package-desktop.mjs currently builds Windows NSIS installers only.",
  );
  process.exit(2);
}

const version = readJson("package.json").version;
if (!skipVerify) runNode("scripts/validate-versions.mjs", []);

const { head, dirty } = assertBuildableTree({
  allowDirty,
  command: "scripts/package-desktop.mjs",
});

const buildArgs = ["build", "--bundles", "nsis", "--ci"];
if (offlineWebview2) {
  buildArgs.push("--config", "src-tauri/tauri.package.offline.conf.json");
}
const signing = forceUnsigned
  ? null
  : resolveSigningMaterial({ optional: true });
if (!signing) {
  // tauri.conf.json enables updater artifacts; without the signing key the build would fail,
  // so fall back to a plain installer and say so instead of silently shipping a broken update.
  buildArgs.push(
    "--config",
    JSON.stringify({ bundle: { createUpdaterArtifacts: false } }),
  );
}
const buildEnv = signing
  ? {
      ...process.env,
      TAURI_SIGNING_PRIVATE_KEY: signing.keyContent,
      TAURI_SIGNING_PRIVATE_KEY_PASSWORD: signing.password,
      TAURI_SIGNING_PRIVATE_KEY_PATH: signing.keyPath,
    }
  : process.env;

const startedAt = Date.now();
const buildResult = spawnSync(
  process.execPath,
  [
    path.join(repoRoot, "node_modules", "@tauri-apps", "cli", "tauri.js"),
    ...buildArgs,
  ],
  { cwd: repoRoot, stdio: "inherit", env: buildEnv },
);
if (buildResult.error) throw buildResult.error;
if (buildResult.status !== 0) {
  console.error(`tauri build exited with ${buildResult.status ?? 1}`);
  process.exit(buildResult.status ?? 1);
}

const bundleDirectory = path.join(
  repoRoot,
  "src-tauri",
  "target",
  "release",
  "bundle",
  "nsis",
);
if (!existsSync(bundleDirectory)) {
  console.error(
    `NSIS build finished but ${path.relative(repoRoot, bundleDirectory)} is missing.`,
  );
  process.exit(1);
}

const installers = readdirSync(bundleDirectory)
  .filter((file) => file.toLowerCase().endsWith(".exe"))
  .map((file) => {
    const filePath = path.join(bundleDirectory, file);
    return { file, filePath, stats: statSync(filePath) };
  })
  .filter((entry) => entry.stats.mtimeMs >= startedAt - 5000)
  .sort((left, right) => right.stats.mtimeMs - left.stats.mtimeMs);

if (installers.length === 0) {
  console.error("No freshly built NSIS installer found.");
  process.exit(1);
}
const installer = installers[0];
if (!installer.file.includes(version)) {
  console.error(
    `Installer name does not contain the expected version ${version}: ${installer.file}`,
  );
  process.exit(1);
}

const sha256 = await sha256File(installer.filePath);

let updaterArtifacts = null;
if (signing) {
  const bundleDirectory = path.join(
    repoRoot,
    "src-tauri",
    "target",
    "release",
    "bundle",
    "nsis",
  );
  const plan = planUpdaterArtifacts({
    bundleDir: bundleDirectory,
    version,
    newerThan: startedAt - 5000,
  });
  updaterArtifacts = {
    payload: plan.payload.name,
    payloadSizeBytes: plan.payload.stats.size,
    payloadSha256: await sha256File(plan.payload.filePath),
    signature: plan.signature.name,
    signatureSha256: await sha256File(plan.signature.filePath),
  };
}

const shortHead = head.slice(0, 7);
const deliveryName = `P4Deck-${version}-${shortHead}${offlineWebview2 ? "-offline" : ""}`;
const deliveryDirectory = path.join(
  repoRoot,
  "artifacts",
  "delivery",
  deliveryName,
);
mkdirSync(deliveryDirectory, { recursive: true });
copyFileSync(installer.filePath, path.join(deliveryDirectory, installer.file));

writeFileSync(
  path.join(deliveryDirectory, "SHA256SUMS.txt"),
  `${sha256.toUpperCase()}  ${installer.file}\n`,
);

const webview2Mode = offlineWebview2
  ? "offlineInstaller（内嵌离线安装器，无需联网）"
  : "downloadBootstrapper（安装时下载，需要联网）";

writeFileSync(
  path.join(deliveryDirectory, "使用说明.txt"),
  [
    `P4Deck ${version} Windows x64 安装包（本地交付候选）`,
    "",
    `构建来源：${head}${dirty ? "（工作树有未提交改动）" : ""}`,
    `WebView2 模式：${webview2Mode}`,
    "P4 CLI：不随包分发。应用优先使用显式配置、PATH 或 Perforce 标准安装位置；",
    "未找到时设置页提供 Perforce 官方下载入口和重新检测按钮。",
    "签名：未使用发布者代码签名证书，Windows 可能显示未知发布者。",
    signing
      ? "自动更新：本次构建含已签名的 updater 产物（.nsis.zip + .sig），可用 scripts/publish-update.mjs 发布。"
      : "自动更新：本次构建未包含 updater 产物（未找到签名密钥或使用了 --unsigned），不能发布自动升级。",
    `SHA-256：${sha256.toUpperCase()}`,
    "限制：干净设备上的安装/启动/卸载验收尚未完成，本包不能视为已通过异机验收。",
    "",
  ].join("\n"),
);

const info = {
  product: "P4Deck",
  kind: "nsis-installer",
  version,
  versionSource: "package.json",
  gitHead: head,
  gitDirty: dirty,
  builtAt: new Date().toISOString(),
  platform: `${process.platform}-${process.arch}`,
  node: process.version,
  tauriCli: tauriCliVersion(),
  command: `node scripts/package-desktop.mjs${allowDirty ? " --allow-dirty" : ""}${offlineWebview2 ? " --offline-webview2" : ""}${forceUnsigned ? " --unsigned" : ""}`,
  bundle: "nsis",
  webview2: offlineWebview2 ? "offlineInstaller" : "downloadBootstrapper",
  signing: {
    status: signing ? "updater-signed" : "unsigned",
    updaterArtifacts: Boolean(signing),
  },
  installer: {
    name: installer.file,
    sizeBytes: installer.stats.size,
    sha256,
  },
  updaterArtifacts,
  delivery: {
    directory: `artifacts/delivery/${deliveryName}`,
    files: [
      installer.file,
      "SHA256SUMS.txt",
      "使用说明.txt",
      "artifact-info.json",
    ],
  },
};
writeFileSync(
  path.join(deliveryDirectory, "artifact-info.json"),
  `${JSON.stringify(info, null, 2)}\n`,
);

process.stdout.write(`${JSON.stringify({ ok: true, ...info })}\n`);
