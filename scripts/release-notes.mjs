#!/usr/bin/env node
// Bilingual release notes: one file, two languages, one GitHub release page.
//
// File format (UTF-8):
//
//   # P4Deck 0.1.13
//
//   ## 中文
//   - ...
//
//   ## English
//   - ...
//
// `parseBilingualNotes` splits the sections, `validateBilingualNotes` lists the
// problems that must be fixed before publishing, and `buildReleaseBody` renders
// the GitHub release body: Chinese first, English folded into a <details> block
// so both audiences read their own language without scrolling past the other.
// `manifestNotes` keeps the Chinese section for latest.json, which feeds the
// in-app update prompt (the app is Chinese-first; the in-app changelog carries
// both languages separately in src/app/update/changelog.ts).
//
// A legacy single-language file still parses (English section null) so old
// notes keep working; publishing enforces the bilingual sections.
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
const ZH_HEADING = /^##\s*(?:中文|Chinese)\s*[:：]?\s*$/i;
const EN_HEADING = /^##\s*(?:English|英文)\s*[:：]?\s*$/i;
const ANY_H2 = /^##\s+/;

export function hasCjk(text) {
  return CJK.test(String(text ?? ""));
}

/**
 * Split a bilingual notes file into its title and language sections.
 * `en` is `null` when the file only has a Chinese section, which keeps older
 * single-language notes parseable.
 */
export function parseBilingualNotes(text) {
  const buckets = { title: [], zh: [], en: [] };
  let current = "title";
  let sawZhHeading = false;
  let sawEnglishHeading = false;
  for (const line of String(text ?? "")
    .replace(/\r\n?/g, "\n")
    .split("\n")) {
    if (ZH_HEADING.test(line)) {
      current = "zh";
      sawZhHeading = true;
      continue;
    }
    if (EN_HEADING.test(line)) {
      current = "en";
      sawEnglishHeading = true;
      continue;
    }
    // An unrelated heading ends the current section instead of leaking its
    // text into the language we are about to publish.
    if (ANY_H2.test(line)) {
      current = "other";
      continue;
    }
    if (current !== "other") buckets[current].push(line);
  }
  if (!sawZhHeading && !sawEnglishHeading) {
    // Legacy heading-less notes (the pre-bilingual format) are one language;
    // keep them parseable instead of folding the text into the title.
    return { title: "", zh: String(text ?? "").trim(), en: null };
  }
  return {
    title: buckets.title.join("\n").trim(),
    zh: buckets.zh.join("\n").trim(),
    en: sawEnglishHeading ? buckets.en.join("\n").trim() : null,
  };
}

/**
 * Everything that must be fixed before a notes file can be published. Returns
 * human-readable problems (empty array = valid).
 */
export function validateBilingualNotes(notes) {
  const problems = [];
  if (!notes || typeof notes !== "object") {
    return ["release notes could not be parsed"];
  }
  const zh = String(notes.zh ?? "").trim();
  const en = String(notes.en ?? "").trim();
  if (!zh) {
    problems.push(
      "missing Chinese section: add `## 中文` followed by the Chinese notes",
    );
  }
  if (!en) {
    problems.push(
      "missing English section: add `## English` followed by the English notes",
    );
  }
  if (zh && !hasCjk(zh)) {
    problems.push(
      "the Chinese section contains no Chinese characters; check that it is not the English text",
    );
  }
  if (en && hasCjk(en)) {
    problems.push(
      "the English section contains Chinese characters; translate those bullets",
    );
  }
  // A mojibake section has ASCII `?` where CJK characters should be and no CJK
  // left at all; genuine Chinese notes always keep some CJK characters.
  const asciiQuestions = (zh.match(/\?/g) ?? []).length;
  if (zh && asciiQuestions > 0 && !hasCjk(zh)) {
    problems.push(
      `the Chinese section has ${asciiQuestions} ASCII '?' and no Chinese characters — this is the Windows codepage mojibake signature; write the file as UTF-8`,
    );
  }
  return problems;
}

/** GitHub release body: Chinese first, English in a collapsible block. */
export function buildReleaseBody({ zh, en }) {
  const chinese = String(zh ?? "").trim();
  const english = String(en ?? "").trim();
  if (!english) return chinese;
  return [
    "## 中文",
    "",
    chinese,
    "",
    "<details>",
    "<summary>English</summary>",
    "",
    english,
    "",
    "</details>",
  ].join("\n");
}

/**
 * The `notes` string of latest.json. Chinese keeps the in-app update prompt
 * unchanged; English is the fallback when a release is English-only.
 */
export function manifestNotes({ zh, en }) {
  return String(zh ?? "").trim() || String(en ?? "").trim();
}
