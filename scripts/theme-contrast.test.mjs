import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const css = await readFile(
  new URL("../src/app/styles/tokens.css", import.meta.url),
  "utf8",
);
const luminance = (hex) => {
  const channels = hex
    .slice(1)
    .match(/../g)
    .map((value) => Number.parseInt(value, 16) / 255)
    .map((value) =>
      value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4,
    );
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
};
const contrast = (foreground, background) => {
  const values = [luminance(foreground), luminance(background)].sort(
    (a, b) => b - a,
  );
  return (values[0] + 0.05) / (values[1] + 0.05);
};
const parseThemes = () => {
  const result = { light: {}, dark: {} };
  for (const match of css.matchAll(
    /:root(?:\[data-theme="dark"\])?\s*\{([^}]+)\}/g,
  )) {
    const theme = match[0].includes("data-theme") ? "dark" : "light";
    for (const token of match[1].matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})/gi))
      result[theme][token[1]] = token[2];
  }
  return result;
};

test("light and dark semantic token pairs meet WCAG AA contrast", () => {
  for (const [theme, tokens] of Object.entries(parseThemes())) {
    for (const [foreground, background] of [
      ["text", "bg"],
      ["muted", "bg"],
      ["accent", "panel"],
      ["danger", "panel"],
      ["on-accent", "accent"],
    ]) {
      assert.match(
        tokens[foreground],
        /^#[0-9a-f]{6}$/i,
        `${theme}: --${foreground}`,
      );
      assert.match(
        tokens[background],
        /^#[0-9a-f]{6}$/i,
        `${theme}: --${background}`,
      );
      assert.ok(
        contrast(tokens[foreground], tokens[background]) >= 4.5,
        `${theme}: --${foreground} on --${background}`,
      );
    }
  }
});
