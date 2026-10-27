import { expect, test, type Page } from "@playwright/test";

const views = [
  {
    route: "submitted",
    domain: "submitted",
    method: "queryChangelists",
    root: ".submitted-page",
    row: ".cl-row",
    more: "Load more",
  },
  {
    route: "streamgraph",
    domain: "streamGraph",
    method: "queryStreamGraph",
    root: ".stream-graph-page",
    row: '[role="treeitem"]',
    more: "Load more streams",
  },
  {
    route: "branchmappings",
    domain: "branchMappings",
    method: "queryBranchMappings",
    root: ".branch-mappings-page",
    row: ".branch-mapping-window-row",
    more: "Load more",
  },
] as const;
type View = (typeof views)[number];

async function installBackend(page: Page, view: View, holdRefresh: boolean) {
  await page.evaluate(
    async ({ method, route, holdRefresh }) => {
      const modulePath = "/src/infrastructure/backend/index.ts";
      const { backend } = await import(modulePath);
      const runtime = await backend.runtimeInfo();
      const state = {
        calls: [] as Array<{ cursor?: string }>,
        release: (_fail = false) => {},
      };
      Object.assign(window, { pagedTest: state });
      const makePage = (query: any, label: string) => {
        const second = label === "cached-second";
        const common = {
          requestGeneration: query.requestGeneration,
          scope: {
            activeProfileId: runtime.activeProfileId,
            contextGeneration: runtime.contextGeneration,
            server: runtime.context.server,
            user: runtime.context.user,
            client: runtime.context.client,
          },
          hasMore: true,
          nextCursor: second ? "cursor-third" : "cursor-second",
          partial: false,
          truncated: false,
          operationIds: [query.operationId],
          simulated: false,
          stats: {
            scannedCount: 3,
            matchedCount: 3,
            returnedCount: 1,
            duplicateCount: 0,
            invalidRelationCount: 0,
            invalidRecordCount: 0,
            safetyLimit: 5000,
            hiddenReliableMergeCount: 0,
            truncatedBySafetyLimit: false,
          },
        };
        if (route === "submitted")
          return {
            ...common,
            items: [
              {
                id: second ? 102 : 103,
                description: label,
                user: runtime.context.user,
                client: runtime.context.client,
                status: "submitted",
                time: new Date().toISOString(),
                fileCount: 1,
                hasShelf: false,
                jobs: [],
                mergeClassification: "normal",
              },
            ],
          };
        if (route === "streamgraph")
          return {
            ...common,
            nodes: [
              {
                stream: `//streams/${label}`,
                name: label,
                flowOptions: {},
                kind: "mainline",
              },
            ],
            edges: [],
            roots: [`//streams/${label}`],
            orphans: [],
            cacheFreshness: "fresh",
          };
        return { ...common, items: [{ name: label, description: label }] };
      };
      backend[method] = async (query: any) => {
        state.calls.push({ cursor: query.cursor });
        if (holdRefresh) {
          await new Promise<void>((resolve, reject) => {
            state.release = (fail = false) =>
              fail ? reject(new Error("Refresh unavailable")) : resolve();
          });
          return makePage(query, "server-refreshed");
        }
        return makePage(query, query.cursor ? "cached-second" : "cached-first");
      };
    },
    { method: view.method, route: view.route, holdRefresh },
  );
}

async function visit(page: Page, view: View) {
  await page.evaluate((route) => {
    location.hash = `#/${route}`;
  }, view.route);
  await expect(page.locator(view.root)).toBeVisible();
}

for (const view of views) {
  test(`${view.route} restores all persisted pages before P4, without replaying the cursor`, async ({
    page,
  }) => {
    test.setTimeout(60_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.setViewportSize({ width: 1280, height: 844 });
    await page.addInitScript(() => {
      localStorage.setItem("p4deck.locale", "en-US");
      localStorage.setItem("p4deck.ui", JSON.stringify({ autoRefresh: false }));
    });
    await page.goto("/#/files");
    await expect(page.locator(".file-workbench h1")).toBeVisible();
    await installBackend(page, view, false);
    await visit(page, view);
    const panel = page.locator(view.root);
    await expect(
      panel.locator(view.row).filter({ hasText: "cached-first" }),
    ).toBeVisible();
    await panel.getByRole("button", { name: view.more, exact: true }).click();
    await expect(panel.locator(view.row)).toHaveCount(2);

    // Use the real IndexedDB store. Nothing is manually seeded after reload.
    const saved = await page.evaluate(async (domain) => {
      const path = "/src/shared/cache/persistentStore.ts";
      const { flushPersisted } = await import(path);
      await flushPersisted();
      return new Promise<any>((resolve, reject) => {
        const request = indexedDB.open("p4deck-cache");
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction("entries");
          const cursor = tx.objectStore("entries").openCursor();
          cursor.onsuccess = () => {
            const entry = cursor.result;
            if (!entry) {
              resolve(null);
              return;
            }
            const key = JSON.parse(String(entry.key));
            if (key[1] === domain) resolve(entry.value.data);
            else entry.continue();
          };
          tx.oncomplete = () => db.close();
        };
      });
    }, view.domain);
    expect(saved).toBeTruthy();
    expect(saved.nextCursor).toBeUndefined();
    expect(saved.hasMore).toBe(false);
    expect((saved.changes ?? saved.nodes ?? saved.items).length).toBe(2);

    await page.goto("/#/files");
    // A hash change alone keeps the JS heap; reload must destroy appCache.
    await page.reload();
    await expect(page.locator(".file-workbench h1")).toBeVisible();
    expect(
      await page.evaluate(() => (window as any).pagedTest),
    ).toBeUndefined();
    await installBackend(page, view, true);
    await visit(page, view);
    // The new server request remains unresolved while both cached pages render.
    await expect(panel.locator(view.row)).toHaveCount(2);
    await expect(panel).toContainText("cached-first");
    await expect(panel).toContainText("cached-second");
    await expect
      .poll(() => page.evaluate(() => (window as any).pagedTest.calls.length))
      .toBe(1);
    expect(await page.evaluate(() => (window as any).pagedTest.calls)).toEqual([
      {},
    ]);
    await expect(panel).not.toContainText(
      /expired|restarted from the first page/i,
    );

    // A failed background read must not discard the disk snapshot.
    await page.evaluate(() => (window as any).pagedTest.release(true));
    await expect(panel).toContainText("Refresh unavailable");
    await expect(panel.locator(view.row)).toHaveCount(2);
    await panel
      .getByRole("alert")
      .getByRole("button", { name: "Retry", exact: true })
      .click();
    await expect
      .poll(() => page.evaluate(() => (window as any).pagedTest.calls.length))
      .toBe(2);
    await page.evaluate(() => (window as any).pagedTest.release());
    await expect(panel.locator(view.row)).toHaveCount(1);
    await expect(panel).toContainText("server-refreshed");
    await expect(panel).not.toContainText("cached-second");
    await expect(panel).not.toContainText("Refresh unavailable");
    expect(errors).toEqual([]);
  });
}
