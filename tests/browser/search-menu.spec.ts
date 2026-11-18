import { expect, test } from "@playwright/test";

// Search results gained a context menu; this pins what a unit test cannot see:
// the menu really opens on the row that was clicked, lists the row's actions and
// refuses the ones the payload cannot support instead of faking them.
test("search results offer a working context menu", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("p4deck.locale", "en-US");
    localStorage.setItem("p4deck.leftOpen", "false");
  });
  await page.goto("/#/search");
  const input = page.locator("#global-search-input");
  await expect(input).toBeVisible();
  await input.fill("atlas");
  await input.press("Enter");

  const rows = page.locator(".search-result-row");
  await expect(rows.first()).toBeVisible({ timeout: 20_000 });
  await expect(rows.first()).toHaveAttribute("data-menu-object", /^S0[12]$/);
  // The rows live in a virtual list whose transform keeps changing, so a pointer
  // click can never satisfy Playwright's stability check; dispatch the event the
  // pointer would raise, with the coordinates the menu positions itself from.
  const box = (await rows.first().boundingBox())!;
  await rows.first().dispatchEvent("contextmenu", {
    bubbles: true,
    cancelable: true,
    clientX: box.x + box.width / 2,
    clientY: box.y + box.height / 2,
  });

  const menu = page.locator(".p4-context-menu");
  await expect(menu).toBeVisible();
  const items = menu.getByRole("menuitem");
  expect(await items.count()).toBeGreaterThan(10);

  // The retired backlog never appears: the menu lists actions, not intentions.
  const labels = (await items.allTextContents()).join(" | ");
  expect(labels).not.toContain("More actions");
  expect(labels).not.toContain("not connected");

  // A depot-only result cannot be previewed locally, and says why instead of
  // silently doing nothing.
  const preview = menu.getByRole("menuitem", { name: /Preview file/ }).first();
  await expect(preview).toHaveAttribute("aria-disabled", "true");
  await expect(preview).toHaveAttribute("aria-description", /local file/i);
});
