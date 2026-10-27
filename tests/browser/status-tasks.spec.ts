import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

for (const width of [1280, 390]) {
  test(`P4 status exposes active commands and cancellation at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.addInitScript(() => {
      localStorage.setItem("p4deck.locale", "en-US");
      localStorage.setItem("p4deck.leftOpen", "false");
      localStorage.setItem("p4deck.autoRefresh", "false");
    });
    await page.goto("/#/files");
    const status = page.locator(".p4-status");
    await expect(status).toBeEnabled();
    await status.click();
    const list = page.getByRole("dialog", { name: "P4 tasks" });
    await expect(list).toContainText("P4 idle");
    await expect(list.locator(".task-row")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Cancel all P4 tasks", exact: true }),
    ).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(list).toBeHidden();
    await expect(
      page
        .getByRole("toolbar", { name: "Object actions" })
        .getByRole("button", { name: "Cancel", exact: true }),
    ).toHaveCount(0);
    await page.clock.install({ time: new Date("2026-10-20T08:00:00Z") });
    await page.clock.pauseAt(new Date("2026-10-20T08:00:01Z"));
    await page.evaluate(async () => {
      const modulePath = "/src/infrastructure/backend/index.ts";
      const { backend } = await import(modulePath);
      const context = (await backend.runtimeInfo()).context;
      const requests = ["info", "opened"].map((command) =>
        backend.runP4({
          operationId: `status-test-${command}`,
          command,
          args: [],
          context,
          source: "terminal",
          outputMode: "text",
        }),
      );
      Object.assign(window, { statusTaskResults: Promise.all(requests) });
    });
    await page.clock.runFor(100);
    await expect(status).toBeEnabled();
    await status.click();
    await expect(list).toBeVisible();
    await expect(list.locator(".task-row")).toHaveCount(2);
    await expect(list).toContainText("p4 info");
    await expect(list).toContainText("p4 opened");
    await expect(list.locator(".task-cancel")).toHaveCount(2);
    await expect(
      list.locator('.task-cancel svg[fill="currentColor"]'),
    ).toHaveCount(2);
    await expect(
      list.getByRole("button", { name: "Cancel all P4 tasks", exact: true }),
    ).toBeVisible();
    const rect = await list.boundingBox();
    expect(rect!.x).toBeGreaterThanOrEqual(0);
    expect(rect!.x + rect!.width).toBeLessThanOrEqual(width);
    expect(
      await page.evaluate(() => document.querySelector("#root")!.scrollWidth),
    ).toBe(width);
    await page.screenshot({ path: test.info().outputPath("status-tasks.png") });
    await list
      .getByRole("button", {
        name: "Cancel task: p4 opened (status-test-opened)",
        exact: true,
      })
      .click();
    await expect(
      list.getByRole("button", {
        name: "Cancel task: p4 opened (status-test-opened)",
        exact: true,
      }),
    ).toBeDisabled();
    await page
      .getByRole("button", { name: "Cancel all P4 tasks", exact: true })
      .click();
    await page.clock.runFor(200);
    await expect(list).toBeVisible();
    await expect(list).toContainText("P4 idle");
    await expect(list.locator(".task-row")).toHaveCount(0);
    await expect(status).toBeEnabled();
    await expect(
      page.getByRole("button", { name: "Cancel all P4 tasks", exact: true }),
    ).toHaveCount(0);
    expect(
      await page.evaluate(async () =>
        (
          await (
            window as unknown as {
              statusTaskResults: Promise<{ exitCode: number }[]>;
            }
          ).statusTaskResults
        ).map((result) => result.exitCode),
      ),
    ).toEqual([-1, -1]);
    await page.clock.resume();
    const axe = await new AxeBuilder({ page }).include(".statusbar").analyze();
    expect(axe.violations).toEqual([]);
  });
}
