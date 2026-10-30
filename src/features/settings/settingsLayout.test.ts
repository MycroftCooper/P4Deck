import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** UI-14 layout/regression guard: the settings page fills the panel and degrades. */
const css = readFileSync(
  new URL("../../app/styles/settings.css", import.meta.url),
  "utf8",
);
describe("settings layout css (UI-14)", () => {
  it("removes the fixed 960px cap and stacks sections in one full-width column", () => {
    expect(css).not.toMatch(/max-width:\s*960px/);
    expect(css).toMatch(/\.settings-content\s*\{[^}]*display:\s*grid/s);
    expect(css).toMatch(
      /\.settings-content\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/s,
    );
    expect(css).not.toMatch(/\.settings-content\s*\{[^}]*auto-fit/s);
  });
  it("pins a narrow navigation column beside the content", () => {
    expect(css).toMatch(
      /\.settings-layout\s*\{[^}]*grid-template-columns:\s*168px\s+minmax\(0,\s*1fr\)/s,
    );
    expect(css).toMatch(/\.settings-nav\s*\{[^}]*position:\s*sticky/s);
    expect(css).toMatch(
      /\.settings-section--wide\s*\{[^}]*grid-column:\s*1\s*\/\s*-1/s,
    );
  });
  it("degrades the navigation to horizontal chips on narrow containers", () => {
    expect(css).toMatch(/@container\s*\(max-width:\s*860px\)/);
    expect(css).toMatch(
      /@container\s*\(max-width:\s*860px\)\s*\{[\s\S]*?\.settings-nav\s*\{[^}]*flex-direction:\s*row/s,
    );
    expect(css).toMatch(/\.settings-nav-item\s*\{[^}]*white-space:\s*nowrap/s);
  });
  it("hides collapsed section bodies and caps form field width", () => {
    expect(css).toMatch(
      /\.settings-section-body\[hidden\]\s*\{[^}]*display:\s*none/s,
    );
    expect(css).toMatch(
      /\.settings-section-toggle[^}]*aria-expanded|\.settings-section-toggle\s*\{/s,
    );
    expect(css).toMatch(
      /\.settings-content \.settings-grid input[\s\S]*?max-width:\s*480px/s,
    );
  });
});
