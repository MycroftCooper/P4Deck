import { expect, test } from "@playwright/test";

test("persisted pages stay visible without P4 reads during connection verification", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.addInitScript(() => {
    localStorage.setItem("p4deck.locale", "en-US");
    localStorage.setItem("p4deck.leftOpen", "false");
    localStorage.setItem("p4deck.ui", JSON.stringify({ autoRefresh: false }));
  });

  // Warm the real IndexedDB snapshots; no cache is injected manually.
  await page.goto("/#/submitted");
  await expect(page.locator(".submitted-page")).toContainText(
    "Fix render pipeline cache invalidation",
  );
  await page.evaluate(() => (location.hash = "#/workspaces"));
  await expect(page.locator(".workspaces-page")).toContainText("atlas-dev-fm");
  await page.evaluate(() => (location.hash = "#/streams"));
  await expect(page.locator(".workspaces-page")).toContainText("//atlas/main");
  await page.evaluate(() => (location.hash = "#/streamgraph"));
  await expect(page.locator(".stream-graph-page")).toContainText("Atlas Main");
  await page.evaluate(() => (location.hash = "#/branchmappings"));
  await expect(page.locator(".branch-mappings-page")).toContainText(
    "atlas-release",
  );
  await page.evaluate(async () => {
    const path = "/src/shared/cache/persistentStore.ts";
    const { flushPersisted } = await import(path);
    await flushPersisted();
  });

  let releaseApp!: () => void;
  const appGate = new Promise<void>((resolve) => {
    releaseApp = resolve;
  });
  await page.route(/\/src\/app\/App\.tsx(?:\?|$)/, async (route) => {
    await appGate;
    await route.continue();
  });
  await page.clock.install();
  await page.reload({ waitUntil: "commit" });
  try {
    await expect(page.locator(".startup-shell")).toBeVisible();
    await page.evaluate(async () => {
      const path = "/src/infrastructure/backend/index.ts";
      const { backend } = await import(path);
      const originalTest = backend.testConnection.bind(backend);
      const state = {
        probes: 0,
        reads: [] as string[],
        release: () => {},
      };
      backend.testConnection = async (context: any) => {
        state.probes++;
        await new Promise<void>((resolve) => {
          state.release = resolve;
        });
        return originalTest(context);
      };
      for (const method of [
        "queryChangelists",
        "listUserWorkspaces",
        "listStreams",
        "queryStreamGraph",
        "queryBranchMappings",
      ] as const) {
        const original = backend[method].bind(backend) as (
          ...args: any[]
        ) => Promise<unknown>;
        backend[method] = (async (...args: any[]) => {
          state.reads.push(method);
          return original(...args);
        }) as typeof backend[typeof method];
      }
      Object.assign(window, { cacheFirstStartup: state });
    });
  } finally {
    releaseApp();
  }

  await page.evaluate(() => (location.hash = "#/submitted"));
  await expect(page.locator(".submitted-page")).toContainText(
    "Fix render pipeline cache invalidation",
  );
  await page.evaluate(() => (location.hash = "#/workspaces"));
  await expect(page.locator(".workspaces-page")).toContainText("atlas-dev-fm");
  await page.evaluate(() => (location.hash = "#/streams"));
  await expect(page.locator(".workspaces-page")).toContainText("//atlas/main");
  await page.evaluate(() => (location.hash = "#/streamgraph"));
  await expect(page.locator(".stream-graph-page")).toContainText("Atlas Main");
  await page.evaluate(() => (location.hash = "#/branchmappings"));
  await expect(page.locator(".branch-mappings-page")).toContainText(
    "atlas-release",
  );

  await expect(
    page.locator(".workspace-empty:visible", {
      hasText: "Checking connection and login automatically…",
    }),
  ).toHaveCount(0);
  expect(
    await page.evaluate(
      () => (window as any).cacheFirstStartup.reads as string[],
    ),
  ).toEqual([]);

  await page.evaluate(() => (window as any).cacheFirstStartup.release());
});
