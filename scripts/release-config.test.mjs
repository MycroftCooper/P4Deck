import assert from "node:assert/strict";
import test from "node:test";
import {
  buildTauriReleaseOverlay,
  redactReleaseText,
  validateReleaseEnvironment,
} from "./release-config.mjs";

const valid = () => ({
  P4DECK_RELEASE_MODE: "1",
  P4DECK_UPDATER_ENDPOINT:
    "https://updates.p4deck.dev/stable/{{target}}/{{arch}}/{{current_version}}",
  TAURI_UPDATER_PUBLIC_KEY: "A".repeat(64),
  TAURI_SIGNING_PRIVATE_KEY: "private-".repeat(8),
  TAURI_SIGNING_PRIVATE_KEY_PASSWORD: "secret-password",
  P4DECK_RELEASE_CHANNEL: "stable",
  P4DECK_RELEASE_VERSION: "0.1.0",
  P4DECK_RELEASE_PLATFORM: "windows",
  P4DECK_RELEASE_ARCH: "x86_64",
});

test("valid release environment produces an updater-only public overlay", () => {
  const env = valid();
  const config = validateReleaseEnvironment(env);
  const overlay = buildTauriReleaseOverlay(config);
  assert.equal(overlay.version, "0.1.0");
  assert.deepEqual(overlay.plugins.updater.endpoints, [
    env.P4DECK_UPDATER_ENDPOINT,
  ]);
  assert.equal(
    JSON.stringify(overlay).includes(env.TAURI_SIGNING_PRIVATE_KEY),
    false,
  );
  assert.equal(
    JSON.stringify(overlay).includes(env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD),
    false,
  );
});

for (const field of [
  "TAURI_SIGNING_PRIVATE_KEY",
  "TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
  "TAURI_UPDATER_PUBLIC_KEY",
  "P4DECK_UPDATER_ENDPOINT",
  "P4DECK_RELEASE_CHANNEL",
  "P4DECK_RELEASE_VERSION",
  "P4DECK_RELEASE_PLATFORM",
  "P4DECK_RELEASE_ARCH",
]) {
  test(`missing ${field} fails closed`, () => {
    const env = valid();
    delete env[field];
    assert.throws(() => validateReleaseEnvironment(env), { field });
  });
}

test("invalid release mode, endpoint, key, channel, version, platform and arch fail closed", () => {
  const invalidCases = [
    ["P4DECK_RELEASE_MODE", "0"],
    [
      "P4DECK_UPDATER_ENDPOINT",
      "http://updates.test/{{target}}/{{arch}}/{{current_version}}",
    ],
    [
      "P4DECK_UPDATER_ENDPOINT",
      "https://user:pass@updates.test/{{target}}/{{arch}}/{{current_version}}",
    ],
    [
      "P4DECK_UPDATER_ENDPOINT",
      "https://updates.invalid/{{target}}/{{arch}}/{{current_version}}",
    ],
    ["P4DECK_UPDATER_ENDPOINT", "https://updates.test/release"],
    ["TAURI_UPDATER_PUBLIC_KEY", "placeholder"],
    ["TAURI_SIGNING_PRIVATE_KEY", "short"],
    ["TAURI_SIGNING_PRIVATE_KEY_PASSWORD", "short"],
    ["P4DECK_RELEASE_CHANNEL", "production"],
    ["P4DECK_RELEASE_VERSION", "latest"],
    ["P4DECK_RELEASE_PLATFORM", "android"],
    ["P4DECK_RELEASE_ARCH", "x86"],
  ];
  for (const [field, value] of invalidCases) {
    assert.throws(
      () => validateReleaseEnvironment({ ...valid(), [field]: value }),
      `${field} should fail`,
    );
  }
});

test("secret values are redacted from diagnostics", () => {
  const env = valid();
  const input = `failed ${env.TAURI_SIGNING_PRIVATE_KEY} and ${env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD}`;
  const output = redactReleaseText(input, env);
  assert.equal(output.includes(env.TAURI_SIGNING_PRIVATE_KEY), false);
  assert.equal(output.includes(env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD), false);
  assert.match(output, /\[REDACTED\]/);
});
