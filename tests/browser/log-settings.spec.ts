import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
async function writeLog(page: Page) {
  await page.evaluate(async () => {
    const path = "/src/infrastructure/backend/index.ts";
    const { backend } = await import(path);
    await backend.runP4({
      operationId: crypto.randomUUID(),
      command: "info",
      args: [],
      source: "terminal",
      context: (await backend.runtimeInfo()).context,
      outputMode: "text",
      timeoutMs: 1000,
    });
  });
}
for (const width of [1280, 390]) {
  test(`session log settings delete and resume recording without overflow at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(() => {
      localStorage.setItem("p4deck.locale", "en-US");
      localStorage.setItem("p4deck.leftOpen", "false");
    });
    await page.goto("/#/settings");
    const card = page.locator(".log-settings-card");
    await card.scrollIntoViewIfNeeded();
    await expect(
      card.getByRole("heading", { name: "Logs", exact: true }),
    ).toBeVisible();
    await expect(
      card.getByRole("button", { name: "Open log folder" }),
    ).toBeDisabled();
    await expect(card).toContainText("previous files remain on disk");
    await writeLog(page);
    await page.goto("/#/p4log");
    await page
      .locator(".log-view")
      .first()
      .getByRole("button", { name: "Apply / refresh", exact: true })
      .click();
    await expect(page.locator(".log-view").first()).toContainText("p4 info");
    await expect(page.locator(".log-view").first()).toContainText(
      "Current session logs",
    );
    await page.goto("/#/settings");
    await card
      .getByRole("button", { name: "Delete all logs", exact: true })
      .click();
    const dialog = page.getByRole("dialog", { name: "Delete all logs?" });
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    expect(
      await page.evaluate(async () => {
        const path = "/src/infrastructure/backend/index.ts";
        return (await (await import(path)).backend.queryLogs({})).length;
      }),
    ).toBeGreaterThan(0);
    await card
      .getByRole("button", { name: "Delete all logs", exact: true })
      .click();
    await dialog
      .getByRole("button", { name: "Confirm deletion", exact: true })
      .click();
    await expect(dialog).toHaveCount(0);
    await expect(card.getByRole("status")).toHaveText(
      "Simulated logs cleared.",
    );
    await card.scrollIntoViewIfNeeded();
    expect(
      await page
        .locator(".settings-page")
        .evaluate((node) => node.scrollWidth - node.clientWidth),
    ).toBeLessThanOrEqual(1);
    const axe = await new AxeBuilder({ page })
      .include(".log-settings-card")
      .analyze();
    expect(axe.violations).toEqual([]);
    await card.screenshot({ path: testInfo.outputPath("log-settings.png") });
    await page.goto("/#/p4log");
    await expect(page.locator(".log-view").first()).toContainText(
      "No matching logs",
    );
    await writeLog(page);
    await page
      .locator(".log-view")
      .getByRole("button", { name: "Apply / refresh", exact: true })
      .first()
      .click();
    await expect(page.locator(".log-view").first()).toContainText("p4 info");
  });
}
