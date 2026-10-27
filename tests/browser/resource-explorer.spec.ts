import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 844 });
  await page.addInitScript(() => {
    localStorage.setItem("p4deck.locale", "en-US");
    localStorage.setItem("p4deck.leftOpen", "true");
  });
  await page.goto("/#/files");
});

test("Depot sidebar renders its queried children and filters them", async ({
  page,
}) => {
  const sidebar = page.locator(".resource-explorer");
  await sidebar.getByRole("button", { name: "Depot", exact: true }).click();
  await expect(sidebar.getByRole("treeitem").first()).toBeVisible();
  await expect(sidebar.getByRole("treeitem").first()).toContainText(/./);
  await sidebar
    .getByRole("textbox", { name: "Filter resource files" })
    .fill("no-such-file-123456789");
  await expect(sidebar.getByRole("status")).toHaveText(
    "No matches in expanded folders",
  );
  await expect(sidebar.getByRole("treeitem")).toHaveCount(0);
});

test("startup automatically verifies the active workspace without opening settings", async ({
  page,
}) => {
  const sidebar = page.locator(".resource-explorer");
  await expect(sidebar.getByRole("treeitem").first()).toBeVisible();
  await expect(
    sidebar.getByRole("button", { name: "Connection settings" }),
  ).toHaveCount(0);
});

test("verified workspace shows loading, then files, and survives collapse and reopen", async ({
  page,
}) => {
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
    const list = backend.listWorkspaceChildren.bind(backend);
    backend.listWorkspaceChildren = async (...args: unknown[]) => {
      await new Promise((resolve) => setTimeout(resolve, 900));
      return list(...args);
    };
  });
  await page.getByRole("button", { name: /^Switch workspace:/ }).click();
  const menu = page.getByRole("dialog", {
    name: "Switch workspace",
    exact: true,
  });
  await menu.getByLabel("Search workspaces").fill("atlas-dev");
  await menu.locator(".workspace-switcher-item").click();
  const sidebar = page.locator(".resource-explorer");
  await expect(sidebar.getByRole("status")).toHaveText("Loading files…");
  await expect(sidebar.getByRole("treeitem").first()).toBeVisible();
  const name = await sidebar
    .getByRole("treeitem")
    .first()
    .getAttribute("aria-label");
  await sidebar
    .getByRole("button", { name: "Collapse resource sidebar" })
    .click();
  await sidebar
    .getByRole("button", { name: "Expand resource sidebar" })
    .click();
  await expect(sidebar.getByRole("treeitem").first()).toHaveAttribute(
    "aria-label",
    name!,
  );
});

test("Depot errors can retry and empty directories display an explicit empty state", async ({
  page,
}) => {
  await page.evaluate(async () => {
    const modulePath = "/src/infrastructure/backend/index.ts";
    const { backend } = await import(modulePath);
    let failed = false;
    backend.listDepotChildren = async () => {
      if (!failed) {
        failed = true;
        throw new Error("Depot permission denied");
      }
      return [];
    };
  });
  const sidebar = page.locator(".resource-explorer");
  await sidebar.getByRole("button", { name: "Depot", exact: true }).click();
  await expect(sidebar.getByRole("alert")).toContainText(
    "Depot permission denied",
  );
  await sidebar.getByRole("button", { name: "Retry" }).click();
  await expect(sidebar.getByRole("status")).toHaveText("This folder is empty");
});
