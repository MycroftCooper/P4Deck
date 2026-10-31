export const defaultAccent = "#15785b";
export const accentPresets = [
  { color: defaultAccent, zh: "绿色", en: "Green" },
  { color: "#2563eb", zh: "蓝色", en: "Blue" },
  { color: "#7c3aed", zh: "紫色", en: "Purple" },
  { color: "#be185d", zh: "玫红", en: "Rose" },
  { color: "#b45309", zh: "琥珀", en: "Amber" },
];
export function normalizeAccent(value: unknown): string | undefined {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value)
    ? value.toLowerCase()
    : undefined;
}
function rgb(hex: string) {
  return [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16));
}
function mix(color: string, target: string, amount: number) {
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
}
function luminance(color: string) {
  const values = rgb(color).map((value) => {
    const channel = value / 255;
    return channel <= 0.04045
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return values[0] * 0.2126 + values[1] * 0.7152 + values[2] * 0.0722;
}
export function contrast(a: string, b: string) {
  const x = luminance(a),
    y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
/** Surface/text targets used to contrast-check the accent (custom backgrounds). */
export interface AccentSurfaces {
  surface: string;
  text: string;
  backgrounds: readonly string[];
}
/** Preserve the chosen hue while adapting foreground contrast to each theme. */
export function accentTokens(
  input: string,
  dark: boolean,
  surfaces?: AccentSurfaces,
) {
  const seed = normalizeAccent(input) ?? defaultAccent;
  const surface = surfaces?.surface ?? (dark ? "#1b211e" : "#ffffff");
  const text = surfaces?.text ?? (dark ? "#edf3ef" : "#22312a");
  const backgrounds =
    surfaces?.backgrounds ??
    (dark
      ? ["#141917", "#171d1a", "#28332d"]
      : ["#f2f5f3", "#f6f8f7", "#edf1ef"]);
  const soft = mix(surface, seed, dark ? 0.18 : 0.09);
  const selected = mix(surface, seed, dark ? 0.22 : 0.12);
  let accent = seed;
  for (let step = 0; step <= 100; step++) {
    accent = mix(seed, dark ? "#ffffff" : "#000000", step / 100);
    if (
      [surface, soft, selected, ...backgrounds].every(
        (bg) => contrast(accent, bg) >= 4.5,
      )
    )
      break;
  }
  return {
    "--accent": accent,
    "--on-accent":
      contrast(accent, "#ffffff") >= contrast(accent, "#000000")
        ? "#ffffff"
        : "#000000",
    "--accent-soft": contrast(text, soft) >= 4.5 ? soft : surface,
    "--selected": contrast(text, selected) >= 4.5 ? selected : surface,
    "--hover": mix(surface, seed, dark ? 0.1 : 0.05),
  };
}
