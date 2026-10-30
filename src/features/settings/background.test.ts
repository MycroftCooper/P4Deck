import { expect, it } from "vitest";
import { accentTokens, contrast } from "./accent";
import {
  backgroundAccentSurfaces,
  backgroundPresets,
  backgroundTokens,
  backgroundVariableNames,
  defaultBackgroundTone,
  normalizeBackgroundTone,
} from "./background";

const rgbChannels = (hex: string) =>
  [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16));
const channelDistance = (a: string, b: string) =>
  Math.max(
    ...rgbChannels(a).map((value, index) =>
      Math.abs(value - rgbChannels(b)[index]),
    ),
  );

const chromeSurfaces = ["--chrome", "--chrome-2", "--chrome-command"] as const;

it("normalizes literal background tones and treats empty/invalid as the theme default", () => {
  expect(defaultBackgroundTone).toBe("");
  expect(normalizeBackgroundTone("#ABCDEF")).toBe("#abcdef");
  for (const value of [
    undefined,
    null,
    12,
    "red",
    "#abc",
    "#12345678",
    " #123456",
    "url(x)",
    "",
  ])
    expect(normalizeBackgroundTone(value)).toBeUndefined();
});

it("returns null when the theme default applies so no inline override is left", () => {
  expect(backgroundTokens(undefined, false)).toBeNull();
  expect(backgroundTokens("", true)).toBeNull();
  expect(backgroundTokens("not-a-color", false)).toBeNull();
});

it("derives readable surfaces for presets and arbitrary colors in both themes", () => {
  const seeds = [
    ...backgroundPresets.map((preset) => preset.tone),
    "#ffffff",
    "#000000",
    "#ff0000",
    "#00ff00",
    "#0000ff",
    "#7f7f7f",
  ];
  for (const seed of seeds) {
    for (const dark of [false, true]) {
      const tokens = backgroundTokens(seed, dark)!;
      expect(Object.keys(tokens).sort()).toEqual(
        [...backgroundVariableNames].sort(),
      );
      for (const value of Object.values(tokens))
        expect(value).toMatch(/^#[0-9a-f]{6}$/);
      expect(contrast(tokens["--text"], tokens["--bg"])).toBeGreaterThanOrEqual(
        7,
      );
      for (const surface of [
        "--bg",
        ...chromeSurfaces,
        "--panel",
        "--panel-2",
        "--panel-3",
      ] as const) {
        expect(
          contrast(tokens["--text"], tokens[surface]),
        ).toBeGreaterThanOrEqual(4.5);
        expect(
          contrast(tokens["--muted"], tokens[surface]),
        ).toBeGreaterThanOrEqual(4.5);
        expect(
          contrast(tokens["--faint"], tokens[surface]),
        ).toBeGreaterThanOrEqual(4.5);
      }
      const accent = accentTokens(
        "#15785b",
        dark,
        backgroundAccentSurfaces(tokens),
      );
      for (const surface of [
        "--bg",
        ...chromeSurfaces,
        "--panel",
        "--panel-2",
        "--panel-3",
      ])
        expect(
          contrast(accent["--accent"], tokens[surface]),
        ).toBeGreaterThanOrEqual(4.5);
      expect(
        contrast(accent["--accent"], accent["--selected"]),
      ).toBeGreaterThanOrEqual(4.5);
      expect(
        contrast(accent["--accent"], accent["--hover"]),
      ).toBeGreaterThanOrEqual(4.5);
    }
  }
});

it("keeps each theme's light/dark character and yields different tones", () => {
  const dark = backgroundTokens("#2b3442", true)!;
  const light = backgroundTokens("#2b3442", false)!;
  expect(dark["--bg"]).not.toBe(light["--bg"]);
  // Dark theme surfaces stay closer to black; light theme surfaces to white.
  expect(contrast("#ffffff", dark["--bg"])).toBeGreaterThan(
    contrast("#000000", dark["--bg"]),
  );
  expect(contrast("#000000", light["--bg"])).toBeGreaterThan(
    contrast("#ffffff", light["--bg"]),
  );
  // The chosen hue survives: the tint is not identical to the theme default.
  expect(dark["--bg"]).not.toBe("#141917");
  expect(light["--bg"]).not.toBe("#f2f5f3");
});

it("derives a visible 3-level chrome ladder in both themes", () => {
  for (const seed of [
    backgroundPresets[0].tone,
    backgroundPresets[1].tone,
    "#413729",
    "#ffffff",
    "#000000",
  ]) {
    for (const dark of [false, true]) {
      const tokens = backgroundTokens(seed, dark)!;
      const ladder = [
        "--bg",
        "--chrome-command",
        "--chrome",
        "--chrome-2",
      ] as const;
      // Every adjacent layer is visibly distinct (same hue, small step).
      for (let index = 0; index < ladder.length - 1; index++) {
        expect(tokens[ladder[index]]).not.toBe(tokens[ladder[index + 1]]);
        expect(
          channelDistance(tokens[ladder[index]], tokens[ladder[index + 1]]),
        ).toBeGreaterThanOrEqual(3);
      }
      // Dark theme: the frame is lighter than the canvas. Light theme: darker.
      const blackContrast = (color: string) => contrast("#000000", color);
      if (dark) {
        expect(blackContrast(tokens["--chrome"])).toBeGreaterThan(
          blackContrast(tokens["--bg"]),
        );
        expect(blackContrast(tokens["--chrome-2"])).toBeGreaterThan(
          blackContrast(tokens["--chrome"]),
        );
      } else {
        expect(blackContrast(tokens["--chrome"])).toBeLessThan(
          blackContrast(tokens["--bg"]),
        );
        expect(blackContrast(tokens["--chrome-2"])).toBeLessThan(
          blackContrast(tokens["--chrome"]),
        );
      }
    }
  }
});
