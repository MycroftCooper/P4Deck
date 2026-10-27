import { expect, test } from "@playwright/test";

test("Pending searches and sorts its complete cache without a P4 request", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1280, height: 844 });
  await page.addInitScript(() => {
    localStorage.setItem("p4deck.locale", "en-US");
    localStorage.setItem("p4deck.ui", JSON.stringify({ autoRefresh: false }));
    localStorage.removeItem("p4deck.pending-filter.v1");
  });
  await page.goto("/#/files");
  await expect(page.locator(".file-workbench h1")).toBeVisible();
  await page.evaluate(async () => {
    const path = "/src/infrastructure/backend/index.ts";
    const { backend } = await import(path);
    const runtime = await backend.runtimeInfo();
    const calls: any[] = [];
    Object.assign(window, { pendingCacheReads: calls });
    backend.queryPendingChanges = async (query: any) => {
      calls.push(query);
      const next = !!query.cursor;
      return {
        requestGeneration: query.requestGeneration,
        items: [
          {
            id: next ? 200 : 100,
            description: next ? "Second cached CL" : "Terrain changes",
            user: runtime.context.user,
            client: runtime.context.client,
            status: "pending",
            jobs: ["JOB-HIDDEN"],
            shelvedFiles: [],
            files: [
              {
                depotPath: next
                  ? "//depot/Assets/Water.mat"
                  : "//depot/Assets/Grass.mat",
                action: "edit",
              },
            ],
          },
        ],
        hasMore: !next,
        nextCursor: next ? undefined : "page-2",
        partial: false,
        stats: {
          scannedCount: 2,
          matchedCount: 2,
          truncatedBySafetyLimit: false,
        },
      };
    };
  });
  await page
    .getByRole("navigation", { name: "Activity bar" })
    .getByRole("button", { name: /^Pending/ })
    .click();
  await expect(page.locator("[data-pending-change]")).toHaveCount(2);
  expect(
    await page.evaluate(() => (window as any).pendingCacheReads.length),
  ).toBe(2);
  const search = page.getByLabel("Filter pending changelists", { exact: true });
  for (const [term, id] of [
    ["Terrain", 100],
    ["Water.mat", 200],
    ["200", 200],
  ] as const) {
    await search.fill(term);
    await expect(page.locator("[data-pending-change]")).toHaveCount(1);
    await expect(page.locator(`[data-pending-change="${id}"]`)).toBeVisible();
  }
  await search.fill("JOB-HIDDEN");
  await expect(page.locator("[data-pending-change]")).toHaveCount(0);
  await search.fill("");
  await expect(page.locator("[data-pending-change]")).toHaveCount(2);
  await search.pressSequentially("Grass.mat", { delay: 50 });
  await expect(page.locator('[data-pending-change="100"]')).toBeVisible();
  await search.press("Backspace");
  await search.fill("");
  await page.getByLabel("Pending sort", { exact: true }).selectOption("oldest");
  await expect(page.locator("[data-pending-change]").first()).toHaveAttribute(
    "data-pending-change",
    "100",
  );
  await page.waitForTimeout(400);
  expect(
    await page.evaluate(() => (window as any).pendingCacheReads.length),
  ).toBe(2);
  expect(
    await page.evaluate(() =>
      (window as any).pendingCacheReads.every(
        (request: any) => request.keyword === "" && request.sort === "newest",
      ),
    ),
  ).toBe(true);
  await expect(
    page.getByText("Current user · My workspace", { exact: true }),
  ).toHaveCount(0);

  // Closing the tab destroys its component; the snapshot must survive it.
  await page
    .locator(".dv-tab")
    .filter({ hasText: /^Pending$/ })
    .locator(".dv-default-tab-action")
    .click();
  await page
    .getByRole("navigation", { name: "Activity bar" })
    .getByRole("button", { name: /^Pending/ })
    .click();
  await expect(page.locator("[data-pending-change]")).toHaveCount(2);
  expect(
    await page.evaluate(() => (window as any).pendingCacheReads.length),
  ).toBe(2);

  // A new document must hydrate the durable snapshot without another server read.
  await page.evaluate(async () => {
    const path = "/src/shared/cache/persistentStore.ts";
    const { flushPersisted } = await import(path);
    await flushPersisted();
  });
  await page.goto("/#/files");
  await page.reload();
  await expect(page.locator(".file-workbench h1")).toBeVisible();
  await page.evaluate(async () => {
    const path = "/src/infrastructure/backend/index.ts";
    const { backend } = await import(path);
    Object.assign(window, { cachedReopenReads: 0 });
    backend.queryPendingChanges = async () => {
      (window as any).cachedReopenReads++;
      throw new Error("Server deliberately unavailable");
    };
  });
  await page
    .getByRole("navigation", { name: "Activity bar" })
    .getByRole("button", { name: /^Pending/ })
    .click();
  await expect(page.locator('[data-pending-change="200"]')).toContainText(
    "Second cached CL",
  );
  await expect(page.locator("[data-pending-change]")).toHaveCount(2);
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => (window as any).cachedReopenReads)).toBe(0);

  await page.evaluate(() =>
    window.dispatchEvent(
      new CustomEvent("p4deck:pending-refresh", {
        detail: { reason: "manual" },
      }),
    ),
  );
  await expect(page.locator(".pending-page [role=alert]")).toContainText(
    "Server deliberately unavailable",
  );
  await expect(page.locator("[data-pending-change]")).toHaveCount(2);
  await page
    .getByLabel("Filter pending changelists", { exact: true })
    .fill("Water.mat");
  await expect(page.locator('[data-pending-change="200"]')).toBeVisible();
  await expect(page.locator("[data-pending-change]")).toHaveCount(1);
  expect(await page.evaluate(() => (window as any).cachedReopenReads)).toBe(1);
});
