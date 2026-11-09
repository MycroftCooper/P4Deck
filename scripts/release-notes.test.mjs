import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildReleaseBody,
  manifestNotes,
  parseBilingualNotes,
  validateBilingualNotes,
} from "./release-notes.mjs";

const bilingual = [
  "# P4Deck 0.1.13",
  "",
  "## 中文",
  "",
  "新功能：",
  "- 同步现在显示真实文件数",
  "",
  "## English",
  "",
  "New:",
  "- Sync now reports real file counts",
  "",
].join("\n");

describe("parseBilingualNotes", () => {
  it("splits the title and both language sections", () => {
    const notes = parseBilingualNotes(bilingual);
    assert.equal(notes.title, "# P4Deck 0.1.13");
    assert.match(notes.zh, /同步现在显示真实文件数/);
    assert.match(notes.en, /Sync now reports real file counts/);
    // Section headings themselves are not part of the notes.
    assert.doesNotMatch(notes.zh, /## 中文/);
    assert.doesNotMatch(notes.en, /## English/);
  });

  it("accepts CRLF line endings and extra spacing", () => {
    const notes = parseBilingualNotes(
      "# P4Deck 0.1.13\r\n\r\n## 中文  \r\n- 中文条目\r\n\r\n## English\r\n- English item\r\n",
    );
    assert.equal(notes.zh, "- 中文条目");
    assert.equal(notes.en, "- English item");
  });

  it("stops a section at an unrelated heading", () => {
    const notes = parseBilingualNotes(
      "## 中文\n- 条目\n\n## 其它\n这一段不属于任何语言\n",
    );
    assert.equal(notes.zh, "- 条目");
    assert.equal(notes.en, null);
  });

  it("keeps legacy single-language files parseable", () => {
    const notes = parseBilingualNotes("P4Deck 0.1.11\n\n新功能：\n- 旧条目\n");
    assert.match(notes.zh, /旧条目/);
    assert.equal(notes.en, null);
  });
});

describe("validateBilingualNotes", () => {
  it("accepts a complete bilingual file", () => {
    assert.deepEqual(
      validateBilingualNotes(parseBilingualNotes(bilingual)),
      [],
    );
  });

  it("requires both sections", () => {
    const missingEnglish = parseBilingualNotes("## 中文\n- 只有中文\n");
    assert.ok(
      validateBilingualNotes(missingEnglish).some((problem) =>
        problem.includes("missing English section"),
      ),
    );
    const missingChinese = parseBilingualNotes("## English\n- English only\n");
    assert.ok(
      validateBilingualNotes(missingChinese).some((problem) =>
        problem.includes("missing Chinese section"),
      ),
    );
  });

  it("rejects an English section that still carries Chinese text", () => {
    const notes = {
      title: "P4Deck 0.1.13",
      zh: "## 中文\n- 中文条目",
      en: "- 未翻译的条目",
    };
    assert.ok(
      validateBilingualNotes(notes).some((problem) =>
        problem.includes("English section contains Chinese"),
      ),
    );
  });

  it("rejects a Chinese section without Chinese characters", () => {
    const notes = { zh: "Only English text", en: "English text" };
    assert.ok(
      validateBilingualNotes(notes).some((problem) =>
        problem.includes("Chinese section contains no Chinese"),
      ),
    );
  });

  it("flags the Windows codepage mojibake signature", () => {
    // Chinese folded to '?' by a legacy console: no CJK left, stray '?' remain.
    const notes = { zh: "???CL???????????", en: "English only" };
    assert.ok(
      validateBilingualNotes(notes).some((problem) =>
        problem.includes("mojibake"),
      ),
    );
  });
});

describe("buildReleaseBody", () => {
  it("puts Chinese first and folds English into a details block", () => {
    const body = buildReleaseBody(parseBilingualNotes(bilingual));
    assert.ok(body.startsWith("## 中文"));
    assert.ok(body.includes("同步现在显示真实文件数"));
    assert.ok(body.includes("<details>"));
    assert.ok(body.includes("<summary>English</summary>"));
    assert.ok(body.includes("Sync now reports real file counts"));
    assert.ok(body.trimEnd().endsWith("</details>"));
    // The English block never appears above the Chinese section.
    assert.ok(body.indexOf("## 中文") < body.indexOf("<details>"));
  });

  it("returns single-language notes unchanged", () => {
    const body = buildReleaseBody({ zh: "- 只有中文", en: null });
    assert.equal(body, "- 只有中文");
  });
});

describe("manifestNotes", () => {
  it("keeps the Chinese section for the update manifest", () => {
    assert.equal(
      manifestNotes({ zh: "中文说明", en: "English notes" }),
      "中文说明",
    );
  });

  it("falls back to English when a release has no Chinese section", () => {
    assert.equal(
      manifestNotes({ zh: "", en: "English notes" }),
      "English notes",
    );
  });
});
