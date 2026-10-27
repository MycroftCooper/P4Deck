import { expect, test } from "@playwright/test";

for (const width of [1280, 390]) {
  test(`pending cards stay separate when expanded and scrolled at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 844 });
    await page.addInitScript(() => {
      localStorage.setItem("p4deck.locale", "en-US");
      localStorage.setItem("p4deck.leftOpen", "false");
      localStorage.setItem("p4deck.autoRefresh", "false");
      localStorage.removeItem("p4deck.pending-filter.v1");
    });
    await page.goto("/#/files");
    await page.evaluate(async () => {
      const modulePath = "/src/infrastructure/backend/index.ts";
      const { backend } = await import(modulePath);
      const runtime = await backend.runtimeInfo();
      const makeChange = (id: number, count: number, shelfCount = 0) => {
        const files = (length: number) =>
          Array.from({ length }, (_, index) => ({
            depotPath: `//depot/Assets/${id}/material-${index}.mat`,
            clientPath: `//${runtime.context.client}/Assets/${id}/material-${index}.mat`,
            action: "edit",
            state: "openedEdit",
          }));
        return {
          id,
          description: id ? `Change ${id}` : "",
          user: runtime.context.user,
          client: runtime.context.client,
          status: "pending",
          jobs: [],
          files: files(count),
          shelvedFiles: files(shelfCount),
        };
      };
      backend.queryPendingChanges = async (query: {
        requestGeneration: number;
      }) => ({
        requestGeneration: query.requestGeneration,
        defaultChange: makeChange(0, 33),
        items: Array.from({ length: 40 }, (_, index) =>
          makeChange(200 - index, index === 0 ? 13 : 3, index === 0 ? 12 : 0),
        ),
        hasMore: false,
        partial: false,
        stats: {
          scannedCount: 41,
          matchedCount: 41,
          truncatedBySafetyLimit: false,
        },
      });
    });
    await page
      .getByRole("navigation", { name: "Activity bar" })
      .getByRole("button", { name: /^Pending/ })
      .click();

    const header = (id: number) =>
      page.locator(`[data-pending-change="${id}"]`);
    const toggle = (id: number) => header(id).locator("strong").click();
    const card = (id: number) => header(id).locator("..");
    const expectSeparated = async (first: number, second: number) => {
      await expect
        .poll(async () => {
          const a = await card(first).boundingBox();
          const b = await card(second).boundingBox();
          return a && b ? b.y - (a.y + a.height) : -1;
        })
        .toBeGreaterThanOrEqual(0);
    };

    await expect(header(0)).toBeVisible();
    const expansionGap = await header(0).evaluate(async (element) => {
      element.click();
      // Read the committed layout before ResizeObserver's asynchronous delivery.
      await Promise.resolve();
      const first = element.closest(".pending-card")!.getBoundingClientRect();
      const second = document
        .querySelector('[data-pending-change="200"]')!
        .closest(".pending-card")!
        .getBoundingClientRect();
      return second.top - first.bottom;
    });
    expect(expansionGap).toBeGreaterThanOrEqual(0);
    await expect(card(0).getByRole("grid")).toBeVisible();
    await expectSeparated(0, 200);
    await toggle(200);
    await expect(card(200).getByRole("grid")).toHaveCount(2);
    await expectSeparated(0, 200);
    await expectSeparated(200, 199);

    const files = card(0).getByRole("grid").locator(".pending-file-scroll");
    await files.evaluate(
      (element) => (element.scrollTop = element.scrollHeight),
    );
    await expect(files.getByRole("row").last()).toContainText(
      "material-32.mat",
    );
    await expectSeparated(0, 200);

    await toggle(0);
    await expectSeparated(0, 200);
    await header(200).scrollIntoViewIfNeeded();
    await card(200)
      .getByRole("button", { name: "展开/折叠搁置文件 / Toggle shelved files" })
      .click();
    await expect(card(200).getByRole("grid")).toHaveCount(1);
    await expectSeparated(200, 199);
    await toggle(200);
    await expectSeparated(200, 199);
    await toggle(0);
    await expectSeparated(0, 200);

    const list = page.getByTestId("pending-change-virtual-list");
    await list.evaluate((element) => (element.scrollTop = 900));
    await toggle(0);
    await expect(header(0)).toBeVisible();
    await expect(header(0).locator("../..")).toHaveCSS("position", "sticky");
    await expect(page.locator(".pending-change-virtual-row")).not.toHaveCount(
      41,
    );
    await page.screenshot({
      path: testInfo.outputPath("pending-expansion.png"),
    });
  });
}
