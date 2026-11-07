import { contrast } from "./accent";

/** Preset background tones. Each tone is a seed adapted to the active theme. */
export const backgroundPresets = [
  { tone: "#2c3a33", zh: "settings.pine", en: "settings.pine" },
  { tone: "#2b3442", zh: "settings.slate.blue", en: "settings.slate.blue" },
  { tone: "#3a3138", zh: "settings.plum.grey", en: "settings.plum.grey" },
  { tone: "#413729", zh: "settings.warm.sand", en: "settings.warm.sand" },
  { tone: "#26323a", zh: "settings.mist.teal", en: "settings.mist.teal" },
] as const;

/** Empty string means "follow the theme background" (the default). */
export const defaultBackgroundTone = "";

const hexPattern = /^#[0-9a-f]{6}$/i;

export function normalizeBackgroundTone(value: unknown): string | undefined {
  return typeof value === "string" && hexPattern.test(value)
    ? value.toLowerCase()
    : undefined;
}

/** The inline CSS variables owned by a custom background. */
export const backgroundVariableNames = [
  "--bg",
  "--chrome",
  "--chrome-2",
  "--chrome-command",
  "--panel",
  "--panel-2",
  "--panel-3",
  "--border",
  "--text",
  "--muted",
  "--faint",
] as const;

const rgb = (hex: string) =>
  [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16));

const mix = (color: string, target: string, amount: number) => {
  const other = rgb(target);
  return (
    "#" +
    rgb(color)
      .map((value, index) =>
        Math.round(value + (other[index] - value) * amount)
          .toString(16)
          .padStart(2, "0"),
      )
      .join("")
  );
};

const themeBase = (dark: boolean) => (dark ? "#141917" : "#f2f5f3");
const themeText = (dark: boolean) => (dark ? "#edf3ef" : "#22312a");
/** Keep body text comfortably readable on the tinted background. */
const minBackgroundTextContrast = 7;

/**
 * Blend the chosen tone into the theme base, backing off brightness until the
 * theme text stays readable. The hue survives; the theme keeps its light/dark
 * character, so accents, status colors, menus and dialogs stay coherent.
 */
function themedBackground(seed: string, dark: boolean): string {
  const base = themeBase(dark);
  const text = themeText(dark);
  const desired = dark ? 0.42 : 0.18;
  for (let step = 0; step <= 12; step++) {
    const amount = desired * (1 - step / 12);
    const candidate = mix(base, seed, amount);
    if (contrast(text, candidate) >= minBackgroundTextContrast)
      return candidate;
  }
  return base;
}

/**
 * Secondary text fades toward the panel but never below readable contrast on
 * any derived surface (body, panel, panel-2, panel-3).
 */
function readableSecondary(
  text: string,
  panel: string,
  surfaces: readonly string[],
  desired: number,
  minContrast = 4.5,
): string {
  for (let step = 0; step <= 10; step++) {
    const amount = desired * (1 - step / 10);
    const candidate = mix(text, panel, amount);
    if (
      surfaces.every((surface) => contrast(candidate, surface) >= minContrast)
    )
      return candidate;
  }
  return text;
}

/**
 * CSS variables for a custom background, or `null` when the theme default
 * applies. Text/panel/border variables are derived so contrast survives both
 * the dark and the light theme; semantic status colors are not touched.
 *
 * Chrome ladder (same hue as the canvas, 2–6% apart): the window frame is
 * pushed away from the canvas so it reads as part of the same family — lighter
 * in the dark theme, darker in the light theme. `--chrome` is the frame
 * (titlebar/toolbar/status/sidebar/tab strip), `--chrome-2` the raised chrome
 * (inactive visible tabs) and `--chrome-command` the command toolbar.
 */
export function backgroundTokens(
  input: string | undefined,
  dark: boolean,
): Record<string, string> | null {
  const seed = normalizeBackgroundTone(input);
  if (!seed) return null;
  const bg = themedBackground(seed, dark);
  const text = themeText(dark);
  const chrome = mix(bg, dark ? "#ffffff" : "#000000", dark ? 0.055 : 0.05);
  const chrome2 = mix(bg, dark ? "#ffffff" : "#000000", dark ? 0.11 : 0.1);
  const chromeCommand = mix(
    bg,
    dark ? "#ffffff" : "#000000",
    dark ? 0.025 : 0.025,
  );
  const panel = mix(bg, "#ffffff", dark ? 0.07 : 0.82);
  const panel2 = mix(bg, "#ffffff", dark ? 0.03 : 0.5);
  const panel3 = mix(bg, dark ? "#ffffff" : "#000000", dark ? 0.13 : 0.03);
  const border = mix(bg, dark ? "#ffffff" : "#000000", dark ? 0.2 : 0.14);
  const surfaces = [bg, chromeCommand, chrome, chrome2, panel, panel2, panel3];
  // Muted keeps headroom above the 4.5 floor so faint still reads as the
  // quieter of the two while every surface stays readable.
  const muted = readableSecondary(text, panel, surfaces, dark ? 0.24 : 0.22, 5);
  const faint = readableSecondary(muted, panel, surfaces, dark ? 0.4 : 0.35);
  return {
    "--bg": bg,
    "--chrome": chrome,
    "--chrome-2": chrome2,
    "--chrome-command": chromeCommand,
    "--panel": panel,
    "--panel-2": panel2,
    "--panel-3": panel3,
    "--border": border,
    "--text": text,
    "--muted": muted,
    "--faint": faint,
  };
}

/** Accent/selection surfaces derived from the same custom background. */
export function backgroundAccentSurfaces(tokens: Record<string, string>) {
  return {
    surface: tokens["--panel"],
    text: tokens["--text"],
    backgrounds: [
      tokens["--bg"],
      tokens["--chrome"],
      tokens["--chrome-2"],
      tokens["--chrome-command"],
      tokens["--panel"],
      tokens["--panel-2"],
      tokens["--panel-3"],
    ],
  };
}
