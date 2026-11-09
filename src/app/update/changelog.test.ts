import { describe, expect, it } from "vitest";
import {
  CHANGELOG,
  releasesNewestFirst,
  type ChangelogRelease,
} from "./changelog";

const versions = (releases: readonly ChangelogRelease[]) =>
  releases.map((release) => release.version);

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
      { version: "0.1.9", notes: [] },
      { version: "0.2.0", notes: [] },
      { version: "0.1.12", notes: [] },
      { version: "0.1.10", notes: [] },
    ];
    expect(versions(releasesNewestFirst(shuffled))).toEqual([
      "0.2.0",
      "0.1.12",
      "0.1.10",
      "0.1.9",
    ]);
  });

  it("keeps a non-empty note list for every published version", () => {
    for (const release of CHANGELOG) {
      expect(release.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(release.notes.length).toBeGreaterThan(0);
      expect(release.notes.every((note) => note.trim().length > 0)).toBe(true);
    }
  });
});
