import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

const assertNoPageOverflow = async (page: Page, label: string) => {
  const dimensions = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
    root: document.querySelector<HTMLElement>("#root")?.scrollWidth ?? 0,
  }));
  expect(dimensions, label).toEqual({
    viewport: 390,
    document: 390,
    body: 390,
    root: 390,
  });
};

const assertAxe = async (page: Page, label: string) => {
  // Dockview's bundled close target is nested inside its ARIA tab; exclude the
  // third-party tab chrome while continuing to scan every rendered panel.
  const result = await new AxeBuilder({ page }).exclude(".dv-tab").analyze();
  expect(
    result.violations.map(({ id, impact, nodes }) => ({
      id,
      impact,
      targets: nodes.map((node) => node.target.join(" ")),
    })),
    label,
  ).toEqual([]);
};

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("p4deck.locale", "en-US");
    localStorage.setItem("p4deck.leftOpen", "false");
    localStorage.setItem(
      "p4deck.pages",
      JSON.stringify(["files", "search", "pending", "settings"]),
    );
  });
});

test("390px shell, navigation, command palette, settings, search and pending stay operable", async ({
  page,
}) => {
  await page.goto("/#/files");
  await expect(page.locator(".app-shell")).toBeVisible();
  await assertNoPageOverflow(page, "shell");
  await expect(
    page.getByRole("navigation", { name: "Activity bar" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Expand resource sidebar" }).click();
  await expect(
    page.getByRole("button", { name: "Collapse resource sidebar" }),
  ).toBeVisible();
  await assertNoPageOverflow(page, "expanded resource sidebar");
  await page.getByRole("button", { name: "Collapse resource sidebar" }).click();

  await page.keyboard.press("Control+Shift+P");
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await expect(palette).toBeVisible();
  await expect(palette.getByRole("combobox")).toBeFocused();
  await assertNoPageOverflow(page, "command palette");
  await page.keyboard.press("End");
  await expect(palette.getByRole("combobox")).toHaveAttribute(
    "aria-activedescendant",
    /.+/,
  );
  await page.keyboard.press("Escape");
  await expect(palette).toBeHidden();

  for (const destination of ["Settings", "Search", "Pending"]) {
    await page
      .getByRole("button", { name: new RegExp(`^${destination}`) })
      .first()
      .click();
    await expect(page.locator(".route-view")).toContainText(destination);
    await assertNoPageOverflow(page, destination);
  }
  const pendingControl = page
    .locator(".pending-page :is(button,input)")
    .first();
  await expect(pendingControl).toBeVisible();
  await pendingControl.focus();
  await expect(pendingControl).toBeFocused();

  await page.goto("/?panel=search");
  await expect(page.locator(".app-shell.detached-shell")).toBeVisible();
  await assertNoPageOverflow(page, "detached search panel");
});

test("representative app, palette, settings, search and pending surfaces pass axe", async ({
  page,
}) => {
  await page.goto("/#/files");
  await expect(page.locator(".app-shell")).toBeVisible();
  await assertAxe(page, "application shell");
  await page.keyboard.press("Control+Shift+P");
  await assertAxe(page, "command palette");
  await page.keyboard.press("Escape");
  for (const destination of ["Settings", "Search", "Pending"]) {
    await page
      .getByRole("button", { name: new RegExp(`^${destination}`) })
      .first()
      .click();
    await expect(page.locator(".route-view")).toContainText(destination);
    await assertAxe(page, destination);
  }
});

test("dialog, context menu, and manual merge fixtures fit and pass axe", async ({
  page,
}) => {
  await page.goto("/?workflow-audit");
  await page.getByRole("button", { name: "create", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await assertNoPageOverflow(page, "workflow dialog");
  await assertAxe(page, "workflow dialog");
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "manual-merge", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "手工合并编辑器" }),
  ).toBeVisible();
  await assertNoPageOverflow(page, "manual merge");
  await assertAxe(page, "manual merge");

  await page.goto("/?menu-audit");
  await page
    .locator('[data-testid="menu-audit-F01"]')
    .click({ button: "right" });
  await expect(page.getByRole("menu")).toBeVisible();
  await assertNoPageOverflow(page, "context menu");
  await assertAxe(page, "context menu");
});
