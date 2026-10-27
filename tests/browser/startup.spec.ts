import { expect, test, type Page } from "@playwright/test";

test("entry script failure offers recovery before React loads", async ({
  page,
}) => {
  await page.route(/\/src\/main\.tsx(?:\?|$)/, (route) => route.abort());
  await page.goto("/");
  const recovery = page.locator(".startup-recovery");
  await expect(recovery).toBeVisible();
  await expect(recovery).toContainText("P4Deck 启动失败");
  await page.unroute(/\/src\/main\.tsx(?:\?|$)/);
  await recovery.getByRole("button", { name: "重新加载" }).click();
  await expect(page.locator(".app-shell")).toBeVisible();
  await expect(recovery).toBeHidden();
});

test("application module failure offers recovery instead of an empty root", async ({
  page,
}) => {
  await page.route(/\/src\/app\/App\.tsx(?:\?|$)/, (route) => route.abort());
  await page.goto("/");
  const recovery = page.locator(".startup-recovery");
  await expect(recovery).toBeVisible();
  await expect(recovery).toContainText("P4Deck 启动失败");
  await page.unroute(/\/src\/app\/App\.tsx(?:\?|$)/);
  await recovery.getByRole("button", { name: "重新加载" }).click();
  await expect(page.locator(".app-shell")).toBeVisible();
  await expect(recovery).toBeHidden();
});

test("slow startup offers retry and still finishes when loading resumes", async ({
  page,
}) => {
  await page.clock.install();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(/\/src\/app\/App\.tsx(?:\?|$)/, async (route) => {
    await gate;
    await route.continue();
  });
  try {
    await page.goto("/", { waitUntil: "commit" });
    await expect(page.locator(".startup-shell")).toBeVisible();
    await page.clock.runFor(10001);
    await expect(page.locator(".startup-recovery")).toContainText(
      "启动时间较长",
    );
    await expect(page.locator(".startup-recovery")).toBeVisible();
  } finally {
    release();
  }
  await expect(page.locator(".app-shell")).toBeVisible();
  await expect(page.locator(".startup-recovery")).toBeHidden();
});

test("a fresh launch without a hash opens Files instead of the last restored tab", async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem("p4deck.locale", "en-US");
    localStorage.setItem("p4deck.leftOpen", "false");
  });
  await page.goto("/");
  await expect(page.locator(".file-workbench h1")).toBeVisible();
  await expect(page).toHaveURL(/#\/files$/);
});

test("retains navigation clicked before the tab workspace finishes loading", async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem("p4deck.locale", "en-US");
    localStorage.setItem("p4deck.leftOpen", "false");
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(/\/src\/app\/DockWorkspace\.tsx(?:\?|$)/, async (route) => {
    await gate;
    await route.continue();
  });
  try {
    await page.goto("/#/files", { waitUntil: "commit" });
    await page
      .getByRole("navigation", { name: "Activity bar" })
      .getByRole("button", { name: /^Pending/ })
      .click();
  } finally {
    release();
  }
  await expect(page.locator(".page-title-controls h1")).toHaveText("Pending");
  await expect(
    page.getByRole("tab", { name: "Pending", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
});

async function delayedStartup(page: Page, fail = false) {
  await page.setViewportSize({ width: 1280, height: 844 });
  await page.addInitScript(() => {
    localStorage.setItem("p4deck.locale", "en-US");
    localStorage.setItem("p4deck.leftOpen", "true");
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(/\/src\/app\/App\.tsx(?:\?|$)/, async (route) => {
    await gate;
    await route.continue();
  });
  await page.goto("/#/files", { waitUntil: "commit" });
  await expect(page.locator(".startup-shell")).toBeVisible();
  await expect(page.locator(".startup-shell")).toContainText("P4Deck");
  await page.evaluate(async (fail) => {
    const path = "/src/infrastructure/backend/index.ts";
    const { backend } = await import(path);
    const runtime = await backend.runtimeInfo();
    const state = window as unknown as {
      startupReads: number;
      startupProbes: number;
      startupLogins: number;
      startupLocalReads: number;
      startupOtherReads: number;
      releaseStartupLogin(): void;
      releaseStartupProbe(): void;
    };
    state.startupReads = 0;
    state.startupProbes = 0;
    state.startupLogins = 0;
    state.startupLocalReads = 0;
    state.startupOtherReads = 0;
    for (const key of [
      "listStreams",
      "listUserWorkspaces",
      "queryBranchMappings",
    ] as const) {
      const read = backend[key].bind(backend);
      backend[key] = (...args: any[]) => {
        state.startupOtherReads++;
        return (read as (...args: any[]) => any)(...args);
      };
    }
    const connected = {
      ...runtime.connection,
      state: "connected",
      recovery: "none",
    };
    backend.testConnection = async () => {
      state.startupProbes++;
      if (fail && state.startupProbes === 1)
        return {
          ...connected,
          state: "networkError",
          errorCode: "networkError",
          recovery: "retry",
        };
      await new Promise<void>((resolve) => {
        state.releaseStartupProbe = resolve;
      });
      return connected;
    };
    backend.queryLoginStatus = async () => {
      state.startupLogins++;
      await new Promise<void>((resolve) => {
        state.releaseStartupLogin = resolve;
      });
      return connected;
    };
    for (const key of ["listWorkspaceChildren", "listDepotChildren"] as const) {
      const list = backend[key].bind(backend);
      backend[key] = (...args: unknown[]) => {
        if (key === "listWorkspaceChildren" && args[3] === true)
          state.startupLocalReads++;
        else state.startupReads++;
        return list(...args);
      };
    }
  }, fail);
  release();
  await expect(page.locator(".resource-explorer")).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => (window as any).startupProbes))
    .toBeGreaterThan(0);
}

test("shows the window and local tree before verification, then loads P4 status and Depot in the background", async ({
  page,
}, testInfo) => {
  await delayedStartup(page);
  const sidebar = page.locator(".resource-explorer");
  await expect(sidebar.getByRole("status")).toContainText(
    "Checking connection and login automatically",
  );
  await expect(sidebar.getByRole("treeitem").first()).toBeVisible();
  expect(
    await page.evaluate(() => (window as any).startupLocalReads),
  ).toBeGreaterThan(0);
  expect(await page.evaluate(() => (window as any).startupReads)).toBe(0);
  await sidebar.getByRole("button", { name: "Depot", exact: true }).click();
  expect(await page.evaluate(() => (window as any).startupReads)).toBe(0);
  await page.evaluate(() => (window as any).releaseStartupProbe());
  await expect
    .poll(() => page.evaluate(() => (window as any).startupLogins))
    .toBe(1);
  expect(await page.evaluate(() => (window as any).startupReads)).toBe(0);
  await page.evaluate(() => (window as any).releaseStartupLogin());
  await expect(sidebar.getByRole("treeitem").first()).toBeVisible();
  await sidebar.getByRole("button", { name: "Workspace", exact: true }).click();
  await expect(sidebar.getByRole("treeitem").first()).toBeVisible();
  expect(await page.evaluate(() => (window as any).startupProbes)).toBe(1);
  await page.screenshot({ path: testInfo.outputPath("automatic-startup.png") });
});

test("failed startup has actionable feedback and automatically recovers when online", async ({
  page,
}) => {
  await delayedStartup(page, true);
  const sidebar = page.locator(".resource-explorer");
  await expect(sidebar.getByRole("status")).toContainText(
    "Check the server address",
  );
  await expect(sidebar.getByRole("treeitem").first()).toBeVisible();
  expect(await page.evaluate(() => (window as any).startupReads)).toBe(0);
  await expect(
    sidebar.getByRole("button", { name: "Connection settings" }),
  ).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect
    .poll(() => page.evaluate(() => (window as any).startupProbes))
    .toBe(2);
  await page.evaluate(() => (window as any).releaseStartupProbe());
  await expect
    .poll(() => page.evaluate(() => (window as any).startupLogins))
    .toBe(1);
  await page.evaluate(() => (window as any).releaseStartupLogin());
  await expect(sidebar.getByRole("treeitem").first()).toBeVisible();
});

test("reopening the app automatically reloads workspace and Depot", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 844 });
  await page.addInitScript(() => {
    localStorage.setItem("p4deck.locale", "en-US");
    localStorage.setItem("p4deck.leftOpen", "true");
  });
  await page.goto("/#/files");
  const sidebar = page.locator(".resource-explorer");
  await expect(sidebar.getByRole("treeitem").first()).toBeVisible();
  await page.reload();
  await expect(sidebar.getByRole("treeitem").first()).toBeVisible();
  await sidebar.getByRole("button", { name: "Depot", exact: true }).click();
  await expect(sidebar.getByRole("treeitem").first()).toBeVisible();
  await page.goto("/#/settings");
  await expect(page.locator(".connection-status-card")).toContainText(
    "Connected and authenticated",
  );
});

test("restored background tabs do not query until activated", async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem(
      "p4deck.pages",
      JSON.stringify(["files", "streams", "workspaces", "branchmappings"]),
    );
  });
  await delayedStartup(page);
  await page.evaluate(() => (window as any).releaseStartupProbe());
  await expect
    .poll(() => page.evaluate(() => (window as any).startupLogins))
    .toBe(1);
  await page.evaluate(() => (window as any).releaseStartupLogin());
  await expect(page.locator(".file-workbench")).toBeVisible();
  expect(await page.evaluate(() => (window as any).startupOtherReads)).toBe(0);
  await page
    .locator(".dv-tab")
    .filter({ hasText: /^Streams$/ })
    .click();
  await expect
    .poll(() => page.evaluate(() => (window as any).startupOtherReads))
    .toBeGreaterThan(0);
});
