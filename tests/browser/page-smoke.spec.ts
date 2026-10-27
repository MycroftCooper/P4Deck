import { expect, test } from "@playwright/test";
import { isMultiPage, pageIds, pageLabels } from "../../src/app/panels";

for (const width of [1280, 390]) {
  test(`all page types render and stay within the shell at ${width}px`, async ({
    page,
  }, testInfo) => {
    test.setTimeout(120_000);
    const failures: string[] = [];
    page.on("pageerror", (error) => failures.push(error.message));
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(() => {
      localStorage.setItem("p4deck.locale", "en-US");
      localStorage.setItem("p4deck.leftOpen", "false");
      localStorage.setItem("p4deck.ui", JSON.stringify({ autoRefresh: false }));
    });
    await page.goto("/#/files");
    const labels = pageLabels(false);
    for (const kind of pageIds) {
      await page.evaluate((kind) => {
        location.hash = `#/${kind}`;
      }, kind);
      const active = page.locator(
        '.dock-host .dv-content-container[role="tabpanel"]:visible',
      );
      await expect(active).toHaveCount(1);
      await expect(active).toHaveAccessibleName(new RegExp(`^${labels[kind]}`));
      await expect(active.locator(".dock-page > :last-child")).toBeVisible();
      await expect(active).not.toContainText("This tab could not be displayed");
      await expect(active).not.toContainText("Opening page…");
      if (isMultiPage(kind)) {
        const pageTitle = active.locator(".target-page-title");
        await expect(pageTitle).toHaveText(labels[kind]);
        await expect(pageTitle.locator("svg")).toBeVisible();
        await expect(pageTitle).toHaveCSS("font-size", "14px");
        await expect(
          active.locator(".target-controls > button").first(),
        ).toBeVisible();
      }
      if (kind === "pending") {
        const controls = active.locator(".page-title-controls");
        const pageTitle = controls.locator(".target-page-title");
        await expect(pageTitle).toHaveText(labels[kind]);
        await expect(pageTitle.locator("svg")).toBeVisible();
        await expect(pageTitle).toHaveCSS("font-size", "14px");
        await expect(controls).toHaveCSS("min-height", "44px");
        await expect(
          controls.getByRole("button", { name: "New CL", exact: true }),
        ).toBeVisible();
        await expect(
          active.locator(".pending-page > .section-title"),
        ).toHaveCount(0);
        await expect(
          active
            .locator(".pending-page")
            .getByRole("button", { name: "New CL", exact: true }),
        ).toHaveCount(0);
      }
      if (width === 390)
        await expect(page.locator(".activity-text").first()).toBeHidden();
      if (kind === "submitted") {
        const controls = active.locator(".page-title-controls");
        await expect(controls.locator("h1")).toHaveText(labels[kind]);
        await expect(
          controls.getByRole("button", { name: "Refresh", exact: true }),
        ).toBeVisible();
        await expect(active.locator(".page-header")).toHaveCount(0);
        await expect(
          active.getByRole("button", { name: "New CL", exact: true }),
        ).toHaveCount(0);
      }
      if (kind === "history") {
        await active
          .getByRole("textbox", { name: "Depot path" })
          .fill("//atlas/main/Source/render.ts");
        await active.getByRole("button", { name: "Show history" }).click();
        await expect(active.locator(".workspace-row").first()).toBeVisible();
      }
      if (kind === "diff" || kind === "revgraph") {
        const path = active.getByRole("textbox", {
          name: kind === "diff" ? "Diff 文件路径" : "Rev Graph 文件路径",
        });
        await path.fill("//atlas/main/Source/render.ts");
        await path.press("Enter");
        if (kind === "diff")
          await expect(active.locator(".diff-side-line").first()).toBeVisible();
        else
          await expect(
            active.locator('svg g[role="button"]').first(),
          ).toBeVisible();
      }
      await expect(active).not.toContainText("Loading…");
      const bounds = await page.evaluate(() => ({
        sidebarRight: document
          .querySelector(".resource-explorer")!
          .getBoundingClientRect().right,
        mainLeft: document.querySelector(".main-stage")!.getBoundingClientRect()
          .left,
      }));
      expect(
        bounds.mainLeft,
        `${kind} content is covered by the sidebar`,
      ).toBeGreaterThanOrEqual(bounds.sidebarRight);
      const overflow = await page.evaluate(
        () => document.querySelector("#root")!.scrollWidth - innerWidth,
      );
      expect(overflow, `${kind} shell overflow`).toBeLessThanOrEqual(1);
      const closeBackground = await page
        .locator('.dv-tab[aria-selected="true"] .dv-default-tab-action')
        .first()
        .evaluate((element) => getComputedStyle(element).backgroundColor);
      expect(
        closeBackground,
        `${kind} close action exposes the title beneath it`,
      ).not.toBe("rgba(0, 0, 0, 0)");
      await page.screenshot({ path: testInfo.outputPath(`${kind}.png`) });
    }
    expect(failures).toEqual([]);
  });
}
