// @vitest-environment jsdom
import { act } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { dialogButton, dialogHarness } from "../../app/dialogs/testHarness";
import { setLocale } from "../../shared/i18n";
import { ChangelogDialog } from "./ChangelogDialog";

/**
 * Deliberately mis-ordered fixtures: the dialog must delegate the ordering to
 * `releasesNewestFirst` instead of trusting the source order. Every release
 * carries both languages so the locale choice can be asserted.
 */
const data = vi.hoisted(() => ({
  calls: [] as unknown[],
  releases: [
    {
      version: "0.1.7",
      notes: { zh: ["首个版本"], en: ["first release"] },
    },
    {
      version: "0.1.12",
      date: "2026-11-07",
      notes: { zh: ["最新改动"], en: ["newest change"] },
    },
    {
      version: "0.1.11",
      date: "2026-11-04",
      notes: { zh: ["中间改动"], en: ["middle change"] },
    },
  ],
}));

vi.mock("../../app/update/changelog", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../app/update/changelog")>();
  return {
    ...actual,
    CHANGELOG: data.releases,
    releasesNewestFirst: (releases = data.releases) => {
      data.calls.push(releases);
      return actual.releasesNewestFirst(releases);
    },
  };
});

const h = dialogHarness();
const close = vi.fn();

const bulletTexts = () =>
  [...document.querySelectorAll("dialog .changelog-release li")].map(
    (note) => note.textContent,
  );

beforeEach(() => {
  setLocale("en-US");
  close.mockReset();
  data.calls.length = 0;
});

it("lists every release newest first with notes and only known dates", async () => {
  await h.render(<ChangelogDialog zh={false} onClose={close} />);
  // Ordered through the data module, not by the fixture array's order.
  expect(data.calls).toHaveLength(1);
  expect(document.querySelector("dialog h2")?.textContent).toBe("Changelog");
  const headings = [
    ...document.querySelectorAll<HTMLElement>("dialog .changelog-release h3"),
  ].map((heading) => heading.textContent ?? "");
  const position = (version: string) =>
    headings.findIndex((text) => text.startsWith(`v${version}`));
  expect(position("0.1.12")).toBeGreaterThanOrEqual(0);
  expect(position("0.1.12")).toBeLessThan(position("0.1.11"));
  expect(position("0.1.11")).toBeLessThan(position("0.1.7"));
  // Dates appear only for releases that carry one.
  expect(
    [...document.querySelectorAll("dialog time")].map((time) =>
      time.getAttribute("datetime"),
    ),
  ).toEqual(["2026-11-07", "2026-11-04"]);
  expect(bulletTexts()).toEqual([
    "newest change",
    "middle change",
    "first release",
  ]);
});

it("renders the Chinese changelog when the application locale is Chinese", async () => {
  setLocale("zh-CN");
  await h.render(<ChangelogDialog zh onClose={close} />);
  expect(document.querySelector("dialog h2")?.textContent).toBe("更新日志");
  expect(bulletTexts()).toEqual(["最新改动", "中间改动", "首个版本"]);
});

it("closes from the footer button", async () => {
  await h.render(<ChangelogDialog zh={false} onClose={close} />);
  await act(async () => dialogButton("Close").click());
  expect(close).toHaveBeenCalledOnce();
});
