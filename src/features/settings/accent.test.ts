import { expect, it } from "vitest";
import {
  accentPresets,
  accentTokens,
  contrast,
  defaultAccent,
  normalizeAccent,
} from "./accent";

it("accepts only literal six-digit colors", () => {
  expect(normalizeAccent("#ABCDEF")).toBe("#abcdef");
  for (const value of [
    null,
    12,
    "red",
    "#abc",
    "#12345678",
    "url(x)",
    " #123456",
  ])
    expect(normalizeAccent(value)).toBeUndefined();
});
it("keeps arbitrary colors readable in both themes without overriding semantic tokens", () => {
  for (const color of [
    ...accentPresets.map((p) => p.color),
    "#ffffff",
    "#000000",
    "#ffff00",
    "#00ffff",
    "#ff00ff",
  ]) {
    for (const dark of [false, true]) {
      const tokens = accentTokens(color, dark);
      const surface = dark ? "#1b211e" : "#ffffff";
      expect(contrast(tokens["--accent"], surface)).toBeGreaterThanOrEqual(4.5);
      expect(
        contrast(tokens["--accent"], tokens["--selected"]),
      ).toBeGreaterThanOrEqual(4.5);
      expect(
        contrast(tokens["--accent"], tokens["--on-accent"]),
      ).toBeGreaterThanOrEqual(4.5);
      expect(Object.keys(tokens).sort()).toEqual(
        [
          "--accent",
          "--accent-soft",
          "--hover",
          "--on-accent",
          "--selected",
        ].sort(),
      );
    }
  }
  expect(accentTokens("invalid", false)).toEqual(
    accentTokens(defaultAccent, false),
  );
});
