import { expect, it } from "vitest";
import { formatLocalTime } from "./localTime";

it.each(["zh-CN", "en-US"])(
  "formats local year/date/hour/minute in %s without an ISO or zone suffix",
  (locale) => {
    const value = "2026-01-02T12:34:56.789Z";
    const expected = new Intl.DateTimeFormat(locale, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(value));
    expect(formatLocalTime(value, locale)).toBe(expected);
    expect(formatLocalTime(Date.parse(value), locale)).toBe(expected);
    expect(formatLocalTime(value, locale)).not.toMatch(/T12:|\.789|UTC|GMT|Z$/);
  },
);
it("does not turn missing or invalid times into epoch/current-time placeholders", () => {
  for (const value of [undefined, null, "", " ", "invalid", NaN, Infinity])
    expect(formatLocalTime(value)).toBe("—");
  expect(formatLocalTime(0, "en-US")).not.toBe("—");
});
