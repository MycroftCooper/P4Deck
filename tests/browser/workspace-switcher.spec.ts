import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const longClient = "testclient_DM42.Beyond_Beyond_v1d6_project";

for (const width of [1280, 390]) {
  test(`workspace dropdown displays long names and switches in place at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.addInitScript((client) => {
      localStorage.setItem("p4deck.locale", "en-US");
      localStorage.setItem("p4deck.leftOpen", "false");
      localStorage.setItem(
        "p4deck.mockConnection",
        JSON.stringify({
          server: "ssl:p4.example.invalid:1666",
          user: "tester",
          client,
          cwd: "/workspace/atlas",
        }),
      );
    }, longClient);
    await page.goto("/#/files");
    const trigger = page.getByRole("button", {
      name: `Switch workspace: ${longClient}`,
      exact: true,
    });
    await expect(trigger).toBeVisible();
    if (width === 1280) {
      const label = page.locator(".connection-client");
      expect(
        await label.evaluate(
          (element) => element.scrollWidth <= element.clientWidth,
        ),
      ).toBe(true);
    }
    await trigger.click();
    const menu = page.getByRole("dialog", {
      name: "Switch workspace",
      exact: true,
    });
    await expect(menu).toBeVisible();
    await expect(menu.getByLabel("Search workspaces")).toBeFocused();
    const current = menu.locator('[aria-current="true"]');
    await expect(current).toContainText(longClient);
    const dimensions = await menu.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return {
        left: rect.left,
        right: rect.right,
        scroll: element.scrollWidth,
        width: element.clientWidth,
      };
    });
    expect(dimensions.left).toBeGreaterThanOrEqual(0);
    expect(dimensions.right).toBeLessThanOrEqual(width);
    expect(dimensions.scroll).toBe(dimensions.width);
    const axe = await new AxeBuilder({ page })
      .include(".connection-picker")
      .analyze();
    expect(axe.violations).toEqual([]);
    await page.screenshot({
      path: `test-results/workspace-switcher-${width}.png`,
    });
    await menu.getByRole("button", { name: "Refresh workspaces" }).click();
    await expect(menu).toBeVisible();
    await expect(menu.locator(".workspace-switcher-item")).toHaveCount(4);
    await menu.getByLabel("Search workspaces").fill("atlas-dev");
    await expect(menu.locator(".workspace-switcher-item")).toHaveCount(1);
    await page.keyboard.press("ArrowDown");
    await expect(menu.locator(".workspace-switcher-item")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(menu).toBeHidden();
    await expect(
      page.getByRole("button", {
        name: "Switch workspace: atlas-dev-fm",
        exact: true,
      }),
    ).toBeVisible();
    await expect(page.locator(".connection")).toBeFocused();
    await expect(page).toHaveURL(/#\/files$/);
    expect(
      await page.evaluate(() => document.querySelector("#root")!.scrollWidth),
    ).toBe(width);
  });
}
