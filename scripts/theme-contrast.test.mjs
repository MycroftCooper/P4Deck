import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const css = await readFile(
  new URL("../src/app/styles/tokens.css", import.meta.url),
  "utf8",
);
const startupHtml = await readFile(new URL("../index.html", import.meta.url), "utf8");
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

const darkSurfaces = [
  "bg", "panel", "panel-2", "panel-3", "hover", "selected", "accent-soft",
];

test("dark secondary and faint text remain readable on every workbench surface", () => {
  const tokens = parseThemes().dark;
  for (const foreground of ["text", "muted", "faint"]) {
    for (const background of darkSurfaces) {
      const ratio = contrast(tokens[foreground], tokens[background]);
      assert.ok(ratio >= 4.5, `${foreground} on ${background}: ${ratio.toFixed(2)}:1`);
    }
  }
});

test("dark disabled text stays distinguishable without disappearing", () => {
  const tokens = parseThemes().dark;
  const opacity = Number(css.match(/--disabled-opacity:\s*([\d.]+)/)[1]);
  assert.ok(opacity > 0 && opacity < 1);
  const blend = (foreground, background) => "#" + [0, 1, 2].map((index) => {
    const channel = (hex) => Number.parseInt(hex.slice(1 + index * 2, 3 + index * 2), 16);
    return Math.round(channel(foreground) * opacity + channel(background) * (1 - opacity))
      .toString(16).padStart(2, "0");
  }).join("");
  for (const background of darkSurfaces) {
    for (const foreground of ["text", "muted"]) {
      const ratio = contrast(blend(tokens[foreground], tokens[background]), tokens[background]);
      // Disabled controls are exempt from AA text contrast; keep a 3:1 usability floor.
      assert.ok(ratio >= 3, `disabled ${foreground} on ${background}: ${ratio.toFixed(2)}:1`);
      assert.ok(ratio < contrast(tokens[foreground], tokens[background]));
    }
  }
});

test("dark placeholders use readable text without browser opacity reduction", () => {
  assert.match(css, /input::placeholder,[\s\S]*?textarea::placeholder\s*\{\s*color: var\(--muted\);\s*opacity: 1;/);
});

test("startup body inherits the app theme in both system color schemes", () => {
  // The titlebar brand, workspace name and currentColor chevron inherit body.
  // A hardcoded startup body color overrides the color inherited from :root.
  const bodyRules = [...startupHtml.matchAll(/html,\s*body\s*\{([^}]+)\}/g)];
  assert.equal(bodyRules.length, 2, "cover default and system-dark startup rules");
  for (const [, declarations] of bodyRules) {
    assert.match(declarations, /color:\s*var\(--text,\s*#[0-9a-f]{6}\)/);
    assert.match(declarations, /background:\s*var\(--bg,\s*#[0-9a-f]{6}\)/);
  }
  for (const [theme, tokens] of Object.entries(parseThemes())) {
    for (const surface of ["panel-2", "hover"]) {
      assert.ok(contrast(tokens.text, tokens[surface]) >= 4.5, `${theme} titlebar on ${surface}`);
    }
  }
});

test("report representative dark text contrast before and after", () => {
  const tokens = parseThemes().dark;
  for (const [name, oldColor] of [["muted", "#9aaea2"], ["faint", "#75887d"]]) {
    for (const surface of ["panel", "selected"]) {
      console.log(`${name} on ${surface}: ${oldColor} ${contrast(oldColor, tokens[surface]).toFixed(2)}:1 -> ${tokens[name]} ${contrast(tokens[name], tokens[surface]).toFixed(2)}:1`);
    }
  }
});
