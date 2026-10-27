import { expect, test } from "@playwright/test";

for (const width of [1280, 390]) {
  test(`pending refresh preserves the expanded view until replacement at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.addInitScript(() => {
      localStorage.setItem("p4deck.locale", "en-US");
      localStorage.setItem("p4deck.autoRefresh", "false");
      localStorage.setItem("p4deck.leftOpen", "false");
      localStorage.removeItem("p4deck.pending-filter.v1");
    });
    await page.goto("/#/files");
    await page.evaluate(async () => {
      const modulePath = "/src/infrastructure/backend/index.ts";
      const { backend } = await import(modulePath);
      const runtime = await backend.runtimeInfo();
      const state = { calls: 0, succeed: () => {}, fail: () => {} };
      backend.queryPendingChanges = async (query: {
        requestGeneration: number;
      }) => {
        state.calls++;
        const result = (description: string) => ({
          requestGeneration: query.requestGeneration,
          items: [
            {
              id: 202,
              description,
              user: runtime.context.user,
              client: runtime.context.client,
              status: "pending",
              jobs: [],
              files: [
                {
                  depotPath: "//depot/retained.txt",
                  action: "edit",
                  state: "openedEdit",
                },
              ],
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
        if (state.calls === 1) return result("Original visible change");
        return new Promise((resolve, reject) => {
          state.succeed = () => resolve(result("Updated visible change"));
          state.fail = () => reject(new Error("Refresh unavailable"));
        });
      };
      Object.assign(window, { refreshPreservation: state });
    });
    await page
      .getByRole("navigation", { name: "Activity bar" })
      .getByRole("button", { name: /^Pending/ })
      .click();
    const header = page.locator('[data-pending-change="202"]');
    await expect(header).toContainText("Original visible change");
    await header.click();
    const body = page.locator(".pending-body");
    await expect(body).toContainText("retained.txt");
    await page.evaluate(() =>
      window.dispatchEvent(
        new CustomEvent("p4deck:pending-refresh", {
          detail: { reason: "interval" },
        }),
      ),
    );
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as { refreshPreservation: { calls: number } })
              .refreshPreservation.calls,
        ),
      )
      .toBe(2);
    await expect(header).toContainText("Original visible change");
    await expect(body).toBeVisible();
    await expect(body).toContainText("retained.txt");
    await expect(page.locator(".pending-page")).not.toContainText("Loading…");
    await page.screenshot({
      path: test.info().outputPath("pending-during-refresh.png"),
    });
    await page.evaluate(() =>
      (
        window as unknown as { refreshPreservation: { succeed(): void } }
      ).refreshPreservation.succeed(),
    );
    await expect(header).toContainText("Updated visible change");
    await expect(body).toBeVisible();
    await page.evaluate(() =>
      window.dispatchEvent(
        new CustomEvent("p4deck:pending-refresh", {
          detail: { reason: "interval" },
        }),
      ),
    );
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as { refreshPreservation: { calls: number } })
              .refreshPreservation.calls,
        ),
      )
      .toBe(3);
    await page.evaluate(() =>
      (
        window as unknown as { refreshPreservation: { fail(): void } }
      ).refreshPreservation.fail(),
    );
    await expect(header).toContainText("Updated visible change");
    await expect(body).toBeVisible();
    await expect(page.locator(".pending-page")).toContainText(
      "Refresh unavailable",
    );
  });
}
