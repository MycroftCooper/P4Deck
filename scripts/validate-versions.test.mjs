import assert from "node:assert/strict";
import test from "node:test";
import {
  compareVersions,
  parseCargoVersion,
  parseJsonVersion,
} from "./validate-versions.mjs";

test("parseJsonVersion reads a package/tauri style version", () => {
  assert.equal(parseJsonVersion('{"version": "0.1.2"}', "x.json"), "0.1.2");
});

test("parseJsonVersion rejects missing or blank versions", () => {
  assert.throws(() => parseJsonVersion("{}", "x.json"), /missing "version"/);
  assert.throws(
    () => parseJsonVersion('{"version": "  "}', "x.json"),
    /missing "version"/,
  );
});

test("parseCargoVersion only reads [package] and ignores dependency versions", () => {
  const source = [
    "[package]",
    'name = "p4deck"',
    'version = "0.1.0"',
    "",
    "[dependencies]",
    'serde = { version = "1" }',
    "",
    "[lib]",
    'name = "p4deck_lib"',
    "",
  ].join("\n");
  assert.equal(parseCargoVersion(source, "Cargo.toml"), "0.1.0");
});

test("parseCargoVersion fails closed without a package version", () => {
  assert.throws(
    () => parseCargoVersion('[package]\nname = "x"\n', "Cargo.toml"),
    /missing version/,
  );
});

test("compareVersions returns only divergent entries", () => {
  const entries = [
    { file: "package.json", version: "0.1.0" },
    { file: "tauri.conf.json", version: "0.1.0" },
    { file: "Cargo.toml", version: "0.1.1" },
  ];
  assert.deepEqual(compareVersions(entries), [
    { file: "Cargo.toml", version: "0.1.1" },
  ]);
  assert.deepEqual(compareVersions(entries.slice(0, 2)), []);
});
