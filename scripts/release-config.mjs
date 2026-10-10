import { mkdir, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";

const CHANNELS = new Set(["stable", "beta", "alpha", "nightly"]);
const PLATFORMS = new Set(["windows", "darwin", "linux"]);
const ARCHITECTURES = new Set(["x86_64", "aarch64"]);
const SECRET_KEYS = new Set([
  "TAURI_SIGNING_PRIVATE_KEY",
  "TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
]);

export class ReleaseConfigError extends Error {
  constructor(code, field) {
    super(`${field}: ${code}`);
    this.name = "ReleaseConfigError";
    this.code = code;
    this.field = field;
  }
}

function required(env, name) {
  const value = env[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new ReleaseConfigError("missing", name);
  }
  return value.trim();
}

function rejectPlaceholder(value, name) {
  if (/placeholder|replace[-_ ]?me|example|changeme|dummy/i.test(value)) {
    throw new ReleaseConfigError("placeholder_not_allowed", name);
  }
}

export function validateReleaseEnvironment(env) {
  if (env.P4DECK_RELEASE_MODE !== "1") {
    throw new ReleaseConfigError("must_equal_1", "P4DECK_RELEASE_MODE");
  }

  const endpointText = required(env, "P4DECK_UPDATER_ENDPOINT");
  let endpoint;
  try {
    endpoint = new URL(endpointText);
  } catch {
    throw new ReleaseConfigError("invalid_url", "P4DECK_UPDATER_ENDPOINT");
  }
  if (endpoint.protocol !== "https:") {
    throw new ReleaseConfigError("https_required", "P4DECK_UPDATER_ENDPOINT");
  }
  if (endpoint.username || endpoint.password || endpoint.hash) {
    throw new ReleaseConfigError(
      "credentials_or_fragment_forbidden",
      "P4DECK_UPDATER_ENDPOINT",
    );
  }
  if (
    /^(?:localhost|127(?:\.\d{1,3}){3}|\[?::1\]?)$/i.test(endpoint.hostname) ||
    /\.(?:invalid|example|test)$/i.test(endpoint.hostname)
  ) {
    throw new ReleaseConfigError(
      "non_production_host_forbidden",
      "P4DECK_UPDATER_ENDPOINT",
    );
  }
  rejectPlaceholder(endpoint.hostname, "P4DECK_UPDATER_ENDPOINT");
  for (const token of ["{{target}}", "{{arch}}", "{{current_version}}"]) {
    if (!endpointText.includes(token)) {
      throw new ReleaseConfigError(
        `missing_token_${token}`,
        "P4DECK_UPDATER_ENDPOINT",
      );
    }
  }

  const publicKey = required(env, "TAURI_UPDATER_PUBLIC_KEY");
  rejectPlaceholder(publicKey, "TAURI_UPDATER_PUBLIC_KEY");
  if (
    publicKey.length < 40 ||
    publicKey.length > 2048 ||
    !/^[A-Za-z0-9+/=\r\n]+$/.test(publicKey)
  ) {
    throw new ReleaseConfigError(
      "invalid_public_key",
      "TAURI_UPDATER_PUBLIC_KEY",
    );
  }

  const privateKey = required(env, "TAURI_SIGNING_PRIVATE_KEY");
  rejectPlaceholder(privateKey, "TAURI_SIGNING_PRIVATE_KEY");
  if (privateKey.length < 32) {
    throw new ReleaseConfigError("invalid_secret", "TAURI_SIGNING_PRIVATE_KEY");
  }
  const privateKeyPassword = required(
    env,
    "TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
  );
  rejectPlaceholder(privateKeyPassword, "TAURI_SIGNING_PRIVATE_KEY_PASSWORD");
  if (privateKeyPassword.length < 12) {
    throw new ReleaseConfigError(
      "invalid_secret",
      "TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
    );
  }

  const channel = required(env, "P4DECK_RELEASE_CHANNEL");
  if (!CHANNELS.has(channel)) {
    throw new ReleaseConfigError("unsupported", "P4DECK_RELEASE_CHANNEL");
  }
  const version = required(env, "P4DECK_RELEASE_VERSION");
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new ReleaseConfigError("invalid_semver", "P4DECK_RELEASE_VERSION");
  }
  const platform = required(env, "P4DECK_RELEASE_PLATFORM");
  if (!PLATFORMS.has(platform)) {
    throw new ReleaseConfigError("unsupported", "P4DECK_RELEASE_PLATFORM");
  }
  const arch = required(env, "P4DECK_RELEASE_ARCH");
  if (!ARCHITECTURES.has(arch)) {
    throw new ReleaseConfigError("unsupported", "P4DECK_RELEASE_ARCH");
  }

  return {
    endpoint: endpointText,
    publicKey,
    channel,
    version,
    platform,
    arch,
  };
}

export function buildTauriReleaseOverlay(config) {
  return {
    version: config.version,
    bundle: { createUpdaterArtifacts: true },
    plugins: {
      updater: {
        endpoints: [config.endpoint],
        pubkey: config.publicKey,
        windows: { installMode: "passive" },
      },
    },
  };
}

export function redactReleaseText(value, env) {
  let result = String(value);
  for (const key of SECRET_KEYS) {
    const secret = env[key];
    if (typeof secret === "string" && secret.length > 0) {
      result = result.split(secret).join("[REDACTED]");
    }
  }
  return result;
}

async function main() {
  const action = process.argv[2] ?? "validate";
  try {
    const config = validateReleaseEnvironment(process.env);
    if (action === "prepare") {
      const output = path.resolve(
        "src-tauri",
        "tauri.release.generated.conf.json",
      );
      await mkdir(path.dirname(output), { recursive: true });
      await writeFile(
        output,
        `${JSON.stringify(buildTauriReleaseOverlay(config), null, 2)}\n`,
        {
          mode: 0o600,
        },
      );
      process.stdout.write(
        `${JSON.stringify({ ok: true, action, output, ...config, publicKey: "[PUBLIC KEY OMITTED]" })}\n`,
      );
      return;
    }
    if (action !== "validate") {
      throw new ReleaseConfigError("unsupported_action", "command");
    }
    process.stdout.write(
      `${JSON.stringify({ ok: true, action, channel: config.channel, version: config.version, platform: config.platform, arch: config.arch })}\n`,
    );
  } catch (error) {
    const safeMessage = redactReleaseText(
      error instanceof Error ? error.message : error,
      process.env,
    );
    process.stderr.write(
      `${JSON.stringify({ ok: false, error: safeMessage })}\n`,
    );
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
