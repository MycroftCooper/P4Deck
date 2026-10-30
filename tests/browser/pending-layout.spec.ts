import { expect, test } from "@playwright/test";

for (const width of [1280, 390]) {
  test(`pending descriptions truncate and mapped paths stay readable at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 844 });
    await page.addInitScript(() => {
      localStorage.setItem("p4deck.locale", "en-US");
      localStorage.setItem("p4deck.leftOpen", "false");
      localStorage.removeItem("p4deck.pending-filter.v1");
    });
    await page.goto("/#/files");
    await page.evaluate(async () => {
      const modulePath = "/src/infrastructure/backend/index.ts";
      const { backend } = await import(modulePath);
      const runtime = await backend.runtimeInfo();
      const files = ["Gameplay", "Editor"].map((folder) => ({
        depotPath: `//DM42.Beyond.Project/Development/Beyond_v2d0/Assets/${folder}/AreaCollectorZone.cs`,
        clientPath: `//${runtime.context.client}/Assets/${folder}/AreaCollectorZone.cs`,
        action: "edit",
        state: "openedEdit",
      }));
      backend.queryPendingChanges = async (query: {
        requestGeneration: number;
      }) => ({
        requestGeneration: query.requestGeneration,
        items: [
          {
            id: 11208940,
            description:
              "Terrain height sampling, creation/reimport and targeted Alias registration. ".repeat(
                30,
              ) +
              "\n" +
              "UnbrokenDescription".repeat(100),
            user: runtime.context.user,
            client: runtime.context.client,
            status: "pending",
            jobs: [],
            files,
            shelvedFiles: [],
          },
        ],
        hasMore: false,
        partial: false,
        stats: {
          scannedCount: 1,
          matchedCount: 1,
          truncatedBySafetyLimit: false,
        },
      });
    });
    await page
      .getByRole("navigation", { name: "Activity bar" })
      .getByRole("button", { name: /^Pending/ })
      .click();
    const header = page.locator('[data-pending-change="11208940"]');
    await expect(header).toBeVisible();
    const description = header.locator(".pending-description");
    await expect(description).toHaveCSS("text-overflow", "ellipsis");
    await expect(description).toHaveCSS("white-space", "nowrap");
    expect(
      await description.evaluate(
        (element) => element.scrollWidth > element.clientWidth,
      ),
    ).toBe(true);
    expect((await description.getAttribute("title"))!.length).toBeGreaterThan(
      1000,
    );
    const geometry = await header.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return {
        height: rect.height,
        inside: [...element.children].every((child) => {
          const box = child.getBoundingClientRect();
          return (
            box.left >= rect.left &&
            box.right <= rect.right &&
            box.bottom <= rect.bottom
          );
        }),
      };
    });
    expect(geometry.inside).toBe(true);
    expect(geometry.height).toBeLessThan(100);
    await header.click();
    const paths = page.locator(".pending-file-path");
    await expect(paths).toHaveText([
      "Assets/Editor/AreaCollectorZone.cs",
      "Assets/Gameplay/AreaCollectorZone.cs",
    ]);
    await expect(paths.first()).toHaveAttribute(
      "title",
      "Assets/Editor/AreaCollectorZone.cs",
    );
    const pathResize = page.getByRole("separator", {
      name: "Resize File path column",
      exact: true,
    });
    await pathResize.focus();
    await pathResize.press("Home");
    await expect(paths.first()).toHaveCSS("text-overflow", "ellipsis");
    expect(
      await paths
        .first()
        .evaluate((element) => element.scrollWidth > element.clientWidth),
    ).toBe(true);
    expect(
      await page.evaluate(() => document.querySelector("#root")!.scrollWidth),
    ).toBe(width);
    await page.screenshot({ path: testInfo.outputPath("pending-layout.png") });
  });
}
