import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

async function prepare(page: Page) {
  await page.setViewportSize({ width: 1280, height: 844 });
  await page.addInitScript(() => {
    localStorage.setItem("p4deck.locale", "en-US");
    localStorage.setItem("p4deck.leftOpen", "true");
  });
  await page.goto("/#/files");
  await page.evaluate(async () => {
    const modulePath = "/src/infrastructure/backend/index.ts";
    const { backend } = await import(modulePath);
    const runtimeInfo = backend.runtimeInfo.bind(backend);
    backend.runtimeInfo = async () => {
      const runtime = await runtimeInfo();
      return {
        ...runtime,
        connection: { ...runtime.connection, state: "connected" },
      };
    };
    const calls: string[] = [];
    (window as unknown as { treeCalls: string[] }).treeCalls = calls;
    let localBrokenFailed = false;
    let statusBrokenFailed = false;
    const makeItems = (
      base: string,
      relative: string,
      local: boolean,
      localOnly: boolean,
    ) => {
      const make = (name: string, kind: "directory" | "file") => {
        const path = `${base}/${relative ? `${relative}/` : ""}${name}`;
        return {
          id: path,
          name,
          kind,
          absolutePath: local ? path : "",
          depotPath: local ? undefined : path,
          relativePath: `${relative}/${name}`,
          state: "controlled",
          hasChildren: kind === "directory",
        };
      };
      if (!relative)
        return [
          make("Assets", "directory"),
          make("Empty", "directory"),
          make("Broken", "directory"),
          ...Array.from({ length: 1000 }, (_, index) =>
            make(`file-${index}.txt`, "file"),
          ),
        ];
      if (relative === "Assets")
        return [make("Scripts", "directory"), make("Textures", "directory")];
      if (relative === "Assets/Scripts") return [make("Player.cs", "file")];
      if (relative === "Empty") return [];
      if (relative === "Broken") {
        if (localOnly && !localBrokenFailed) {
          localBrokenFailed = true;
          throw new Error("Directory permission denied");
        }
        if (!localOnly && !statusBrokenFailed) {
          statusBrokenFailed = true;
          throw new Error("Directory permission denied");
        }
      }
      return [make("Recovered.txt", "file")];
    };
    backend.listWorkspaceChildren = async (
      path?: string,
      _refresh?: boolean,
      _operationId?: string,
      localOnly = false,
    ) => {
      const runtime = await backend.runtimeInfo();
      const base = runtime.context.cwd.replace(/\\/g, "/").replace(/\/$/, "");
      const relative = path ? path.slice(base.length + 1) : "";
      calls.push(`workspace:${relative}`);
      return {
        items: makeItems(base, relative, true, localOnly),
        completeness: "complete",
        errors: [],
        operationIds: [],
        truncated: false,
        safetyLimit: 10000,
        cacheFreshness: "fresh",
      };
    };
    backend.listDepotChildren = async (path?: string) => {
      calls.push(`depot:${path || ""}`);
      if (!path)
        return [
          {
            id: "//depot",
            depotPath: "//depot",
            name: "depot",
            kind: "directory",
            hasChildren: true,
          },
        ];
      return makeItems("//depot", path.slice("//depot/".length), false, true);
    };
  });
  await page.getByRole("button", { name: /^Switch workspace:/ }).click();
  const menu = page.getByRole("dialog", {
    name: "Switch workspace",
    exact: true,
  });
  await menu.getByLabel("Search workspaces").fill("atlas-dev");
  await menu.locator(".workspace-switcher-item").click();
  await expect(
    page
      .locator(".resource-explorer")
      .getByRole("treeitem", { name: "Assets", exact: true }),
  ).toBeVisible();
}

for (const mode of ["workspace", "depot"] as const) {
  test(`${mode} expands arrows in place, preserves descendants and supports keyboard navigation`, async ({
    page,
  }, testInfo) => {
    await prepare(page);
    const sidebar = page.locator(".resource-explorer");
    if (mode === "depot") {
      await sidebar.getByRole("button", { name: "Depot", exact: true }).click();
      await sidebar
        .getByRole("button", { name: "Expand depot", exact: true })
        .click();
    }
    const assets = sidebar.getByRole("treeitem", {
      name: "Assets",
      exact: true,
    });
    await assets.dblclick();
    await expect(
      sidebar.getByRole("treeitem", { name: "Scripts", exact: true }),
    ).toHaveCount(0);
    await assets.getByRole("button", { name: "Expand Assets" }).click();
    const scripts = sidebar.getByRole("treeitem", {
      name: "Scripts",
      exact: true,
    });
    await expect(scripts).toHaveAttribute(
      "aria-level",
      mode === "workspace" ? "2" : "3",
    );
    await scripts.focus();
    await page.keyboard.press("ArrowRight");
    const player = sidebar.getByRole("treeitem", {
      name: "Player.cs",
      exact: true,
    });
    await expect(player).toHaveAttribute(
      "aria-level",
      mode === "workspace" ? "3" : "4",
    );
    await page.keyboard.press("ArrowRight");
    await expect(player).toBeFocused();
    await page.keyboard.press("ArrowLeft");
    await expect(scripts).toBeFocused();
    await assets.getByRole("button", { name: "Collapse Assets" }).click();
    await expect(player).toHaveCount(0);
    const before = await page.evaluate(
      () => (window as unknown as { treeCalls: string[] }).treeCalls.length,
    );
    await assets.getByRole("button", { name: "Expand Assets" }).click();
    await expect(player).toBeVisible();
    expect(
      await page.evaluate(
        () => (window as unknown as { treeCalls: string[] }).treeCalls.length,
      ),
    ).toBe(before);
    await sidebar
      .getByRole("textbox", { name: "Filter resource files" })
      .fill("Player");
    await expect(assets).toBeVisible();
    await expect(scripts).toBeVisible();
    await expect(player).toBeVisible();
    await expect(sidebar.getByRole("treeitem")).toHaveCount(
      mode === "workspace" ? 3 : 4,
    );
    await sidebar
      .getByRole("textbox", { name: "Filter resource files" })
      .fill("");
    expect(await sidebar.getByRole("treeitem").count()).toBeLessThan(50);
    const axe = await new AxeBuilder({ page })
      .include(".resource-explorer")
      .analyze();
    expect(axe.violations).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath(`${mode}-tree.png`) });
  });
}

test("branch errors retry independently, empty folders remain explicit and mode switching retains expansion", async ({
  page,
}) => {
  await prepare(page);
  const sidebar = page.locator(".resource-explorer");
  await sidebar
    .getByRole("button", { name: "Expand Empty", exact: true })
    .click();
  await expect(
    sidebar.getByRole("treeitem", { name: "empty", exact: true }),
  ).toContainText("Empty folder");
  await sidebar
    .getByRole("button", { name: "Expand Broken", exact: true })
    .click();
  await expect(
    sidebar.getByRole("treeitem", { name: /Directory permission denied/ }),
  ).toBeVisible();
  await sidebar.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(
    sidebar.getByRole("treeitem", { name: "Recovered.txt", exact: true }),
  ).toBeVisible();
  await sidebar.getByRole("button", { name: "Depot", exact: true }).click();
  await sidebar
    .getByRole("button", { name: "Expand depot", exact: true })
    .click();
  await sidebar.getByRole("button", { name: "Workspace", exact: true }).click();
  await expect(
    sidebar.getByRole("treeitem", { name: "Recovered.txt", exact: true }),
  ).toBeVisible();
  await sidebar
    .getByRole("button", { name: "Collapse atlas-dev-fm", exact: true })
    .click();
  await expect(sidebar.getByRole("treeitem")).toHaveCount(0);
  await sidebar
    .getByRole("button", { name: "Expand atlas-dev-fm", exact: true })
    .click();
  await expect(
    sidebar.getByRole("treeitem", { name: "Recovered.txt", exact: true }),
  ).toBeVisible();
});

test("workspace local and status reads start together, and local children render while status is pending", async ({
  page,
}) => {
  await prepare(page);
  await page.evaluate(async () => {
    const modulePath = "/src/infrastructure/backend/index.ts";
    const { backend } = await import(modulePath);
    const load = backend.listWorkspaceChildren.bind(backend);
    const state = {
      localFinished: false,
      statusStarted: false,
      fail: () => {},
    };
    (window as unknown as { localFirstTree: typeof state }).localFirstTree =
      state;
    let markStatusStarted!: () => void;
    const statusStarted = new Promise<void>((resolve) => {
      markStatusStarted = resolve;
    });
    backend.listWorkspaceChildren = async (
      path?: string,
      refresh?: boolean,
      operationId?: string,
      localOnly = false,
    ) => {
      if (localOnly && path?.endsWith("/Assets")) {
        // This only resolves once the status request has started. A serial
        // local-then-status implementation would deadlock here.
        await statusStarted;
      }
      if (path?.endsWith("/Assets")) {
        if (localOnly) {
          const result = await load(path, refresh, operationId, true);
          state.localFinished = true;
          return result;
        }
        state.statusStarted = true;
        markStatusStarted();
        await new Promise<void>((_resolve, reject) => {
          state.fail = () => reject(new Error("P4 status unavailable"));
        });
      }
      return load(path, refresh, operationId, localOnly);
    };
  });
  const sidebar = page.locator(".resource-explorer");
  await sidebar
    .getByRole("button", { name: "Expand Assets", exact: true })
    .click();
  await expect(
    sidebar.getByRole("treeitem", { name: "Scripts", exact: true }),
  ).toBeVisible();
  await expect(
    sidebar.getByRole("treeitem", { name: "Textures", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        {
          const state = (
            window as unknown as {
              localFirstTree: {
                localFinished: boolean;
                statusStarted: boolean;
              };
            }
          ).localFirstTree;
          return {
            localFinished: state.localFinished,
            statusStarted: state.statusStarted,
          };
        },
    ),
  ).toEqual({ localFinished: true, statusStarted: true });
  await expect(
    sidebar.getByRole("treeitem", { name: "loading", exact: true }),
  ).toHaveCount(0);
  await page.evaluate(() =>
    (
      window as unknown as { localFirstTree: { fail(): void } }
    ).localFirstTree.fail(),
  );
  await expect(
    sidebar.getByRole("treeitem", { name: "warning", exact: true }),
  ).toBeVisible();
  await expect(
    sidebar.getByRole("treeitem", { name: "Scripts", exact: true }),
  ).toBeVisible();
  await expect(
    sidebar.getByRole("treeitem", { name: "Textures", exact: true }),
  ).toBeVisible();
});

test("cached Depot folders render through a reload while their refresh is pending", async ({
  page,
}) => {
  await prepare(page);
  await page.evaluate(async () => {
    const modulePath = "/src/infrastructure/backend/index.ts";
    const { backend } = await import(modulePath);
    const runtime = await backend.runtimeInfo();
    await backend.saveConnection(runtime.context);
    backend.listDepotChildren = async (path?: string) => {
      if (!path || path === "//atlas/main")
        return [
          {
            id: "//atlas/main/Assets",
            name: "Assets",
            kind: "directory",
            depotPath: "//atlas/main/Assets",
            hasChildren: true,
          },
          {
            id: "//atlas/main/Config",
            name: "Config",
            kind: "directory",
            depotPath: "//atlas/main/Config",
            hasChildren: true,
          },
        ];
      if (path === "//atlas/main/Assets")
        return [
          {
            id: "//atlas/main/Assets/Scripts",
            name: "Scripts",
            kind: "directory",
            depotPath: "//atlas/main/Assets/Scripts",
            hasChildren: true,
          },
        ];
      return [];
    };
  });
  const sidebar = page.locator(".resource-explorer");
  await sidebar.getByRole("button", { name: "Depot", exact: true }).click();
  const rootToggle = sidebar.locator(".tree-root .tree-toggle");
  if ((await rootToggle.getAttribute("aria-expanded")) === "false")
    await rootToggle.click();
  const assets = sidebar.getByRole("treeitem", {
    name: "Assets",
    exact: true,
  });
  await expect(assets).toBeVisible();
  await assets.getByRole("button", { name: "Expand Assets" }).click();
  await expect(
    sidebar.getByRole("treeitem", { name: "Scripts", exact: true }),
  ).toBeVisible();
  await page.evaluate(async () => {
    const modulePath = "/src/shared/cache/persistentStore.ts";
    const { flushPersisted } = await import(modulePath);
    await flushPersisted();
  });

  await page.reload();
  await expect(
    page.locator(".resource-explorer").getByRole("treeitem").first(),
  ).toBeVisible();
  await page.evaluate(async () => {
    const modulePath = "/src/infrastructure/backend/index.ts";
    const { backend } = await import(modulePath);
    const resolvers: Array<() => void> = [];
    const state = {
      pending: () => resolvers.length,
      failAll: () => resolvers.splice(0).forEach((fail) => fail()),
    };
    (
      window as unknown as { pendingDepotRefresh: typeof state }
    ).pendingDepotRefresh = state;
    backend.listDepotChildren = async () =>
      new Promise((_resolve, reject) => {
        resolvers.push(() => reject(new Error("Depot refresh unavailable")));
      });
  });
  await sidebar.getByRole("button", { name: "Depot", exact: true }).click();
  const reloadedRootToggle = sidebar.locator(".tree-root .tree-toggle");
  if ((await reloadedRootToggle.getAttribute("aria-expanded")) === "false")
    await reloadedRootToggle.click();
  await expect(
    sidebar.getByRole("treeitem", { name: "Assets", exact: true }),
  ).toBeVisible();
  await sidebar
    .getByRole("treeitem", { name: "Assets", exact: true })
    .getByRole("button", { name: "Expand Assets" })
    .click();
  await expect(
    sidebar.getByRole("treeitem", { name: "Scripts", exact: true }),
  ).toBeVisible();
  await page.evaluate(async () => {
    const cachePath = "/src/shared/cache/appCache.ts";
    const { appCache } = await import(cachePath);
    void appCache.invalidateQueries({
      queryKey: ["depot-files"],
      refetchType: "all",
    });
  });
  await expect
    .poll(() =>
      page.evaluate(() =>
        (
          window as unknown as {
            pendingDepotRefresh: { pending(): number };
          }
        ).pendingDepotRefresh.pending(),
      ),
    )
    .toBeGreaterThan(0);
  await expect(
    sidebar.getByRole("treeitem", { name: "Assets", exact: true }),
  ).toBeVisible();
  await expect(
    sidebar.getByRole("treeitem", { name: "Scripts", exact: true }),
  ).toBeVisible();
  await expect(
    sidebar.getByRole("treeitem", { name: "loading", exact: true }),
  ).toHaveCount(0);
  await page.evaluate(() =>
    (
      window as unknown as { pendingDepotRefresh: { failAll(): void } }
    ).pendingDepotRefresh.failAll(),
  );
  await expect(
    sidebar.getByRole("treeitem", { name: "warning", exact: true }),
  ).toBeVisible();
  await expect(
    sidebar.getByRole("treeitem", { name: "Scripts", exact: true }),
  ).toBeVisible();
});

test("verifying an unsaved label preserves the automatically loaded workspace tree", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 844 });
  await page.addInitScript(() => {
    localStorage.setItem("p4deck.locale", "en-US");
    localStorage.setItem("p4deck.leftOpen", "true");
  });
  await page.goto("/#/settings");
  const sidebar = page.locator(".resource-explorer");
  await expect(sidebar.getByRole("treeitem").first()).toBeVisible();
  await expect(page.locator(".connection-root-resolved")).toBeVisible();
  await page
    .getByLabel("Connection name (optional)", { exact: true })
    .fill("Only a local label change");
  await page
    .getByRole("button", { name: "Verify these settings", exact: true })
    .click();
  await expect(sidebar.getByRole("treeitem").first()).toBeVisible();
  await expect(sidebar.getByRole("status")).toHaveCount(0);
  await expect(page.locator(".settings-unsaved-note")).toContainText(
    "verification remains valid",
  );
});

test("collapsing a loading folder cancels its request and late results cannot reopen it", async ({
  page,
}) => {
  await prepare(page);
  await page.evaluate(async () => {
    const modulePath = "/src/infrastructure/backend/index.ts";
    const { backend } = await import(modulePath);
    const list = backend.listWorkspaceChildren.bind(backend);
    const cancel = backend.cancelOperation.bind(backend);
    const state = window as unknown as {
      releaseTree: () => void;
      cancelledTree: string[];
    };
    state.cancelledTree = [];
    const blocked: (() => void)[] = [];
    let release = false;
    backend.listWorkspaceChildren = async (
      ...args: [string | undefined, boolean, string]
    ) => {
      if (!release && args[0]?.endsWith("/Assets")) {
        await new Promise<void>((resolve) => {
          blocked.push(resolve);
        });
      }
      return list(...args);
    };
    state.releaseTree = () => {
      release = true;
      for (const resolve of blocked.splice(0)) resolve();
    };
    backend.cancelOperation = async (id: string) => {
      state.cancelledTree.push(id);
      return cancel(id);
    };
  });
  const sidebar = page.locator(".resource-explorer");
  await sidebar
    .getByRole("button", { name: "Expand Assets", exact: true })
    .click();
  await expect(
    sidebar.getByRole("treeitem", { name: "loading", exact: true }),
  ).toBeVisible();
  await sidebar
    .getByRole("button", { name: "Collapse Assets", exact: true })
    .click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { cancelledTree: string[] }).cancelledTree
            .length,
      ),
    )
    .toBeGreaterThan(0);
  await page.evaluate(() =>
    (window as unknown as { releaseTree: () => void }).releaseTree(),
  );
  await expect(
    sidebar.getByRole("treeitem", { name: "Scripts", exact: true }),
  ).toHaveCount(0);
  await sidebar
    .getByRole("button", { name: "Expand Assets", exact: true })
    .click();
  await expect(
    sidebar.getByRole("treeitem", { name: "Scripts", exact: true }),
  ).toBeVisible();
});

test("the expanded workspace tree stays inside a narrow sidebar", async ({
  page,
}, testInfo) => {
  await prepare(page);
  await page.setViewportSize({ width: 390, height: 844 });
  const sidebar = page.locator(".resource-explorer");
  await sidebar
    .getByRole("button", { name: "Expand Assets", exact: true })
    .click();
  await sidebar
    .getByRole("button", { name: "Expand Scripts", exact: true })
    .click();
  await expect(
    sidebar.getByRole("treeitem", { name: "Player.cs", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => document.querySelector("#root")!.scrollWidth),
  ).toBe(390);
  await page.screenshot({ path: testInfo.outputPath("narrow-tree.png") });
});
