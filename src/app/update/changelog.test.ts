import { describe, expect, it } from "vitest";
import {
  CHANGELOG,
  notesFor,
  releasesNewestFirst,
  type ChangelogRelease,
} from "./changelog";

const versions = (releases: readonly ChangelogRelease[]) =>
  releases.map((release) => release.version);

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
const emptyNotes = { zh: [], en: [] };

describe("changelog history", () => {
  it("lists releases from the newest version to the oldest", () => {
    expect(versions(releasesNewestFirst())).toEqual(
      versions(CHANGELOG)
        .slice()
        .sort((left, right) => {
          const a = left.split(".").map(Number);
          const b = right.split(".").map(Number);
          return b[0] - a[0] || b[1] - a[1] || b[2] - a[2];
        }),
    );
    expect(versions(releasesNewestFirst())[0]).toBe("0.1.12");
  });

  it("sorts a mis-ordered source array by semantic version, not by text", () => {
    const shuffled: ChangelogRelease[] = [
      { version: "0.1.9", notes: emptyNotes },
      { version: "0.2.0", notes: emptyNotes },
      { version: "0.1.12", notes: emptyNotes },
      { version: "0.1.10", notes: emptyNotes },
    ];
    expect(versions(releasesNewestFirst(shuffled))).toEqual([
      "0.2.0",
      "0.1.12",
      "0.1.10",
      "0.1.9",
    ]);
  });

  it("keeps a non-empty note list in both languages for every release", () => {
    for (const release of CHANGELOG) {
      expect(release.version).toMatch(/^\d+\.\d+\.\d+$/);
      for (const bullets of [release.notes.zh, release.notes.en]) {
        expect(bullets.length).toBeGreaterThan(0);
        expect(bullets.every((note) => note.trim().length > 0)).toBe(true);
      }
    }
  });

  it("writes Chinese bullets in Chinese and English bullets without Chinese", () => {
    for (const release of CHANGELOG) {
      expect(release.notes.zh.some((note) => CJK.test(note))).toBe(true);
      const translated = release.notes.en.filter((note) => CJK.test(note));
      expect(translated, `${release.version} untranslated bullets`).toEqual([]);
    }
  });

  it("keeps dates as valid ISO calendar days, newest release first", () => {
    let previous = Number.POSITIVE_INFINITY;
    for (const release of releasesNewestFirst()) {
      if (release.date === undefined) continue;
      expect(release.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      const parsed = Date.parse(`${release.date}T00:00:00Z`);
      expect(Number.isNaN(parsed)).toBe(false);
      // Dates must not move forward as versions get older.
      expect(parsed).toBeLessThanOrEqual(previous);
      previous = parsed;
    }
  });

  it("serves the bullets for the requested locale", () => {
    const release = CHANGELOG[0];
    expect(notesFor(release, "zh-CN")).toEqual(release.notes.zh);
    expect(notesFor(release, "en-US")).toEqual(release.notes.en);
    // An unknown locale is treated as English rather than Chinese.
    expect(notesFor(release, "fr-FR")).toEqual(release.notes.en);
  });

  it("falls back to the other language instead of rendering an empty list", () => {
    const onlyChinese: ChangelogRelease = {
      version: "9.9.9",
      notes: { zh: ["只有中文"], en: [] },
    };
    expect(notesFor(onlyChinese, "en-US")).toEqual(["只有中文"]);
    const onlyEnglish: ChangelogRelease = {
      version: "9.9.8",
      notes: { zh: [], en: ["English only"] },
    };
    expect(notesFor(onlyEnglish, "zh-CN")).toEqual(["English only"]);
  });
});
