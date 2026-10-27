import { expect, test } from "@playwright/test";

for (const width of [1280, 390]) {
  test(`cached Pending stays usable during startup verification, timeout and recovery at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 844 });
    await page.addInitScript(() => {
      localStorage.setItem("p4deck.locale", "en-US");
      localStorage.setItem("p4deck.leftOpen", "false");
      localStorage.setItem("p4deck.ui", JSON.stringify({ autoRefresh: false }));
    });
    await page.goto("/#/pending");
    await expect(page.locator('[data-pending-change="0"]')).toBeVisible();
    const rowCount = await page.locator("[data-pending-change]").count();
    await page.evaluate(async () => {
      const path = "/src/shared/cache/persistentStore.ts";
      const { flushPersisted } = await import(path);
      await flushPersisted();
    });

    // A new document must show the disk snapshot before the login IPC returns.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(/\/src\/app\/App\.tsx(?:\?|$)/, async (route) => {
      await gate;
      await route.continue();
    });
    await page.clock.install();
    await page.reload({ waitUntil: "commit" });
    try {
      await expect(page.locator(".startup-shell")).toBeVisible();
      await page.evaluate(async () => {
        const path = "/src/infrastructure/backend/index.ts";
        const { backend } = await import(path);
        const read = backend.queryPendingChanges.bind(backend);
        const testConnection = backend.testConnection.bind(backend);
        const state = {
          reads: 0,
          probes: 0,
          stalled: true,
          release: () => {},
        };
        backend.testConnection = async (context: any) => {
          state.probes++;
          if (state.stalled)
            await new Promise<void>((resolve) => {
              state.release = resolve;
            });
          return testConnection(context);
        };
        backend.queryPendingChanges = async (query: any) => {
          state.reads++;
          return read(query);
        };
        Object.assign(window, { connectionStartup: state });
      });
    } finally {
      release();
    }
    await expect(page.locator(".page-title-controls h1")).toHaveText("Pending");
    await expect(page.locator("[data-pending-change]")).toHaveCount(rowCount);
    await expect(page.locator(".pending-operation-state")).toContainText(
      "Checking connection and login",
    );
    await expect(
      page.getByRole("button", { name: "New CL", exact: true }),
    ).toBeDisabled();
    const filter = page.getByLabel("Filter pending changelists", {
      exact: true,
    });
    await filter.fill("no-matching-cached-cl");
    await expect(page.locator("[data-pending-change]")).toHaveCount(0);
    await filter.fill("");
    await expect(page.locator("[data-pending-change]")).toHaveCount(rowCount);
    expect(
      await page.evaluate(() => (window as any).connectionStartup.reads),
    ).toBe(0);

    await page.clock.fastForward(45_001);
    await expect(page.locator(".pending-page [role=alert]")).toContainText(
      "Showing the local cache",
    );
    await expect(page.locator("[data-pending-change]")).toHaveCount(rowCount);
    await expect(page.locator(".pending-operation-state .spin")).toHaveCount(0);
    expect(
      await page.evaluate(() => (window as any).connectionStartup.reads),
    ).toBe(0);
    await page.screenshot({
      path: testInfo.outputPath("cached-pending-connection-timeout.png"),
    });

    await page.evaluate(() => {
      (window as any).connectionStartup.stalled = false;
    });
    await page.getByRole("button", { name: "Retry connection" }).click();
    await expect(page.locator(".pending-page [role=alert]")).toHaveCount(0);
    await expect(page.locator("[data-pending-change]")).toHaveCount(rowCount);
    await expect(
      page.getByRole("button", { name: "New CL", exact: true }),
    ).toBeEnabled();
    expect(
      await page.evaluate(() => (window as any).connectionStartup.probes),
    ).toBe(2);
    // The old response cannot override the recovered connection.
    await page.evaluate(() => (window as any).connectionStartup.release());
    await expect(page.locator(".pending-page [role=alert]")).toHaveCount(0);
    await expect(page.locator(".pending-operation-state .spin")).toHaveCount(0);
    await page.screenshot({
      path: testInfo.outputPath("cached-pending-connection-recovered.png"),
    });
  });
}
