// The publish path must never send a release with an empty body: an empty body
// leaves the in-app update prompt blank, and fixing it afterwards means editing an
// already published release. These tests pin the notes resolution rules.
import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveReleaseNotes } from "./publish-update.mjs";

const DEFAULT_FILE = "/repo/ForAIDoc/PM/releases/v0.1.16.md";

test("inline --notes wins over every file", () => {
  const result = resolveReleaseNotes({
    notes: "  手写说明  ",
    notesFile: "/repo/custom.md",
    defaultNotesFile: DEFAULT_FILE,
    readText: () => "file contents",
    exists: () => true,
  });
  assert.deepEqual(result, { text: "手写说明", path: undefined });
});

test("an explicit --notes-file is read", () => {
  const result = resolveReleaseNotes({
    notes: undefined,
    notesFile: "/repo/custom.md",
    defaultNotesFile: DEFAULT_FILE,
    readText: (file) => {
      assert.equal(file, "/repo/custom.md");
      return "# P4Deck 0.1.16\n\n## 中文\n- 甲\n";
    },
    exists: () => false,
  });
  assert.equal(result.path, "/repo/custom.md");
  assert.match(result.text, /## 中文/);
});

test("the committed notes file is used when no flag is given", () => {
  const result = resolveReleaseNotes({
    notes: undefined,
    notesFile: undefined,
    defaultNotesFile: DEFAULT_FILE,
    readText: () => "# P4Deck 0.1.16",
    exists: (file) => file === DEFAULT_FILE,
  });
  assert.equal(result.path, DEFAULT_FILE);
  assert.equal(result.text, "# P4Deck 0.1.16");
});

test("no notes at all is an error, not a silent empty release", () => {
  assert.throws(
    () =>
      resolveReleaseNotes({
        notes: undefined,
        notesFile: undefined,
        defaultNotesFile: DEFAULT_FILE,
        readText: () => "",
        exists: () => false,
      }),
    /no release notes/,
  );
});

test("a blank --notes does not count as notes", () => {
  assert.throws(
    () =>
      resolveReleaseNotes({
        notes: "   \n ",
        notesFile: undefined,
        defaultNotesFile: DEFAULT_FILE,
        readText: () => "",
        exists: () => false,
      }),
    /no release notes/,
  );
});

test("an existing but empty notes file is rejected", () => {
  assert.throws(
    () =>
      resolveReleaseNotes({
        notes: undefined,
        notesFile: "/repo/empty.md",
        defaultNotesFile: DEFAULT_FILE,
        readText: () => "  \n",
        exists: () => true,
      }),
    /is empty/,
  );
});
