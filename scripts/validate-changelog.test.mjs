import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { validateChangelogHistory } from "./validate-changelog.mjs";

const release = (
  version,
  { zh = ["中文改动"], en = ["English change"], date } = {},
) => ({
  version,
  notes: { zh, en },
  ...(date === undefined ? {} : { date }),
});

describe("validateChangelogHistory", () => {
  it("accepts a newest-first bilingual history", () => {
    assert.deepEqual(
      validateChangelogHistory([
        release("0.1.12", { date: "2026-11-07" }),
        release("0.1.11", { date: "2026-11-04" }),
        release("0.1.10"),
      ]),
      [],
    );
  });

  it("reports a release that is missing a language", () => {
    const problems = validateChangelogHistory([
      release("0.1.12", { en: [] }),
      release("0.1.11"),
    ]);
    assert.ok(
      problems.some((problem) => problem.includes("en notes are empty")),
      problems.join("\n"),
    );
  });

  it("reports an untranslated English bullet", () => {
    const problems = validateChangelogHistory([
      release("0.1.12", { en: ["English change", "未翻译"] }),
    ]);
    assert.ok(
      problems.some((problem) =>
        problem.includes("English notes still contain Chinese"),
      ),
      problems.join("\n"),
    );
  });

  it("reports a Chinese section written entirely in English", () => {
    const problems = validateChangelogHistory([
      release("0.1.12", { zh: ["English only"] }),
    ]);
    assert.ok(
      problems.some((problem) =>
        problem.includes("Chinese notes contain no Chinese"),
      ),
      problems.join("\n"),
    );
  });

  it("reports out-of-order releases", () => {
    const problems = validateChangelogHistory([
      release("0.1.11"),
      release("0.1.12"),
    ]);
    assert.ok(
      problems.some((problem) => problem.includes("newest first")),
      problems.join("\n"),
    );
  });

  it("reports duplicate versions and malformed dates", () => {
    const problems = validateChangelogHistory([
      release("0.1.12", { date: "2026-13-40" }),
      release("0.1.12"),
    ]);
    assert.ok(
      problems.some((problem) => problem.includes("duplicate version")),
      problems.join("\n"),
    );
    assert.ok(
      problems.some((problem) => problem.includes("not a real day")),
      problems.join("\n"),
    );
  });

  it("requires an entry for the version being released", () => {
    const problems = validateChangelogHistory([release("0.1.11")], {
      version: "0.1.12",
    });
    assert.ok(
      problems.some((problem) =>
        problem.includes("no changelog entry for 0.1.12"),
      ),
      problems.join("\n"),
    );
  });

  it("passes for the repository's own changelog", async () => {
    const { CHANGELOG } = await import(
      new URL("../src/app/update/changelog.ts", import.meta.url).href
    );
    const { version } = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    );
    assert.deepEqual(validateChangelogHistory(CHANGELOG, { version }), []);
  });
});
