import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

for (const theme of ["light", "dark"] as const) {
  test(`dropdown pickers follow the ${theme} app palette and keep keyboard selection`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.addInitScript((theme) => {
      localStorage.setItem("p4deck.theme", theme);
      localStorage.setItem("p4deck.locale", "en-US");
      localStorage.setItem("p4deck.leftOpen", "false");
      localStorage.setItem("p4deck.ui", JSON.stringify({ autoRefresh: false }));
    }, theme);
    await page.goto("/#/settings");
    await expect(page.locator(".settings-page")).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    expect(
      await page.evaluate(() => CSS.supports("appearance", "base-select")),
    ).toBe(true);
    const themeSelect = page.locator(".statusbar").getByRole("combobox", {
      name: "Theme",
      exact: true,
    });
    const palette = await themeSelect.evaluate((element) => {
      const probe = document.createElement("span");
      document.body.append(probe);
      const resolve = (token: string) => {
        probe.style.color = `var(${token})`;
        return getComputedStyle(probe).color;
      };
      const colors = {
        panel: resolve("--panel"),
        text: resolve("--text"),
        selected: resolve("--selected"),
        hover: resolve("--hover"),
        border: resolve("--border"),
      };
      probe.remove();
      const picker = getComputedStyle(element, "::picker(select)");
      return {
        ...colors,
        appearance: getComputedStyle(element).appearance,
        pickerBackground: picker.backgroundColor,
        pickerText: picker.color,
        pickerBorder: picker.borderTopColor,
      };
    });
    expect(palette.appearance).toBe("base-select");
    expect(palette.pickerBackground).toBe(palette.panel);
    expect(palette.pickerText).toBe(palette.text);
    expect(palette.pickerBorder).toBe(palette.border);
    await themeSelect.click();
    await expect(themeSelect).toHaveJSProperty("value", theme);
    await expect
      .poll(() => themeSelect.evaluate((element) => element.matches(":open")))
      .toBe(true);
    const other = themeSelect.locator(
      `option[value="${theme === "dark" ? "light" : "dark"}"]`,
    );
    await other.hover();
    await expect(other).toHaveCSS("background-color", palette.hover);
    const selected = themeSelect.locator("option:checked");
    await expect(selected).toHaveCSS("background-color", palette.selected);
    await page.screenshot({
      path: testInfo.outputPath(`theme-picker-${theme}.png`),
    });
    await page.keyboard.press("Escape");
    await expect(themeSelect).toHaveValue(theme);
    await themeSelect.focus();
    await themeSelect.press("Space");
    await expect
      .poll(() => themeSelect.evaluate((element) => element.matches(":open")))
      .toBe(true);
    await page.keyboard.press(theme === "dark" ? "Home" : "End");
    await page.keyboard.press("Enter");
    await expect(themeSelect).toHaveValue(theme === "dark" ? "system" : "dark");
    await themeSelect.selectOption(theme);
    // Settings fields use the same global picker without per-component changes.
    const settingsSelects = page.locator(
      ".settings-page select:not([disabled])",
    );
    expect(await settingsSelects.count()).toBeGreaterThan(3);
    for (const select of await settingsSelects.all()) {
      await expect(select).toHaveCSS("appearance", "base-select");
    }
    const first = settingsSelects.first();
    await first.click();
    await expect
      .poll(() => first.evaluate((element) => element.matches(":open")))
      .toBe(true);
    await page.screenshot({
      path: testInfo.outputPath(`settings-picker-${theme}.png`),
    });
    await page.keyboard.press("Escape");
    expect(
      await page.locator("#root").evaluate((element) => element.scrollWidth),
    ).toBe(1280);
    // Follow-system mode updates the palette of already mounted controls.
    await themeSelect.selectOption("system");
    await page.emulateMedia({ colorScheme: "dark" });
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(themeSelect.locator("option").first()).toHaveCSS(
      "color",
      "rgb(225, 234, 229)",
    );
    await page.emulateMedia({ colorScheme: "light" });
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await expect(themeSelect.locator("option").first()).toHaveCSS(
      "color",
      "rgb(35, 53, 45)",
    );
  });
}

// Static DOM fixture: no application imports, backend or P4 requests.
test("Submitted trigger content is centered with trailing arrows", async ({
  page,
}) => {
  await page.route("**/*", (route) => route.abort());
  await page.setContent(
    `<div class="submitted-filters"><div class="submitted-filter-field"><select><option>Ordinary submission</option></select></div><div class="submitted-saved-filters"><div class="submitted-preset-group"><select><option>My changes</option></select></div></div><details class="submitted-stream-picker"><summary><span>All streams</span><svg width="14" height="14"></svg></summary></details></div>`,
  );
  for (const name of ["tokens", "workbench", "dropdowns"]) {
    await page.addStyleTag({
      content: readFileSync(`src/app/styles/${name}.css`, "utf8"),
    });
  }
  for (const trigger of await page
    .locator("select, .submitted-stream-picker > summary")
    .all()) {
    await expect(trigger).toHaveCSS("height", "30px");
    await expect(trigger).toHaveCSS("align-items", "center");
    await expect(trigger).toHaveCSS("justify-content", "space-between");
  }
  await expect(page.locator(".submitted-stream-picker > summary")).toHaveCSS(
    "list-style-type",
    "none",
  );
});
