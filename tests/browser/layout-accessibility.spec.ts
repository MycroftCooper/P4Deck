import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

const assertNoPageOverflow = async (page: Page, label: string) => {
  const dimensions = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
    root: document.querySelector<HTMLElement>("#root")?.scrollWidth ?? 0,
  }));
  expect(dimensions, label).toEqual({
    viewport: 390,
    document: 390,
    body: 390,
    root: 390,
  });
};

const assertAxe = async (page: Page, label: string) => {
  // App/tab modules load lazily; audit the page after its content has mounted.
  if (await page.locator(".app-shell").count())
    await expect(page.locator(".route-view h1")).toBeVisible();
  // Dockview's bundled close target is nested inside its ARIA tab; exclude the
  // third-party tab chrome while continuing to scan every rendered panel.
  const result = await new AxeBuilder({ page }).exclude(".dv-tab").analyze();
  expect(
    result.violations.map(({ id, impact, nodes }) => ({
      id,
      impact,
      targets: nodes.map((node) => node.target.join(" ")),
    })),
    label,
  ).toEqual([]);
};

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("p4deck.locale", "en-US");
    localStorage.setItem("p4deck.leftOpen", "false");
    localStorage.setItem(
      "p4deck.pages",
      JSON.stringify(["files", "search", "pending", "settings"]),
    );
  });
});

test("390px shell, navigation, command palette, settings, search and pending stay operable", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await page.goto("/#/files");
  await expect(page.locator(".app-shell")).toBeVisible();
  await assertNoPageOverflow(page, "shell");
  await expect(
    page.getByRole("navigation", { name: "Activity bar" }),
  ).toBeVisible();
  const activityBar = page.getByRole("navigation", { name: "Activity bar" });
  await expect(
    activityBar.getByRole("button", { name: /^Terminal/ }),
  ).toHaveCount(0);
  await expect(
    activityBar.getByRole("button", { name: /^P4 Log/ }),
  ).toHaveCount(0);
  await expect(
    activityBar.getByRole("button", { name: /^Stream Graph/ }),
  ).toHaveCount(0);
  await expect(
    activityBar.getByRole("button", { name: /^Branch Mappings/ }),
  ).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "Terminal" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Log" })).toBeVisible();
  await page.getByRole("button", { name: "Expand resource sidebar" }).click();
  await expect(
    page.getByRole("button", { name: "Collapse resource sidebar" }),
  ).toBeVisible();
  await assertNoPageOverflow(page, "expanded resource sidebar");
  await page.getByRole("button", { name: "Collapse resource sidebar" }).click();

  await page.keyboard.press("Control+Shift+P");
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await expect(palette).toBeVisible();
  await expect(palette.getByRole("combobox")).toBeFocused();
  await assertNoPageOverflow(page, "command palette");
  await page.keyboard.press("End");
  await expect(palette.getByRole("combobox")).toHaveAttribute(
    "aria-activedescendant",
    /.+/,
  );
  await page.keyboard.press("Escape");
  await expect(palette).toBeHidden();

  await page.keyboard.press("Control+Shift+P");
  await palette.getByRole("combobox").fill("Connect / Switch Profile");
  await page.keyboard.press("Enter");
  await expect(page.locator(".route-view h1")).toHaveText("Settings");
  await expect(
    page.getByRole("heading", { name: "Saved connections" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Connection settings" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "P4 settings" }),
  ).toBeVisible();
  await expect(page.getByLabel("P4 working directory")).toHaveCount(0);
  await expect(page.locator(".connection-root-status")).toBeVisible();
  await expect(page.locator(".connection-action-feedback")).toBeVisible();
  await expect(page.getByText("Tab behavior")).toHaveCount(0);
  await assertNoPageOverflow(page, "Settings saved connections");
  const userField = page
    .locator(".connection-field")
    .filter({ has: page.getByLabel("User") });
  await userField.getByRole("button", { name: "Browse" }).click();
  const directory = page.getByRole("dialog", { name: "Browse server users" });
  await expect(directory).toBeVisible();
  await directory.getByRole("button", { name: "Search" }).click();
  await expect(directory.getByText(/Browser Mock simulated/)).toBeVisible();
  await assertNoPageOverflow(page, "Settings user directory");
  await directory.getByRole("button", { name: "Cancel" }).click();

  for (const destination of ["Search", "Pending"]) {
    await page
      .getByRole("button", { name: new RegExp(`^${destination}`) })
      .first()
      .click();
    await expect(page.locator(".route-view")).toContainText(destination);
    await assertNoPageOverflow(page, destination);
  }
  const pendingControl = page
    .locator(".pending-page :is(button,input)")
    .first();
  await expect(pendingControl).toBeVisible();
  await pendingControl.focus();
  await expect(pendingControl).toBeFocused();

  await page
    .getByRole("button", { name: /^Streams/ })
    .first()
    .click();
  await page.getByRole("button", { name: "Open Stream Graph" }).click();
  const graph = page.getByRole("tree", { name: "Directed stream forest" });
  await expect(graph).toBeVisible();
  await expect(page.getByText("Browser Mock simulated data")).toBeVisible();
  await assertNoPageOverflow(page, "Stream Graph");
  const firstStream = graph.getByRole("treeitem").first();
  await firstStream.focus();
  await expect(firstStream).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("complementary", { name: "Stream details" }),
  ).toBeVisible();
  await assertNoPageOverflow(page, "Stream Graph details");
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("complementary", { name: "Stream details" }),
  ).toBeHidden();
  await firstStream.click();
  await page.getByRole("button", { name: "Locate in Streams" }).click();
  await expect(page.locator(".route-view h1")).toHaveText("Streams");
  await expect(page.getByRole("textbox", { name: "Search list" })).toHaveValue(
    "//atlas/main",
  );
  await page.getByRole("button", { name: "Open Branch Mappings" }).click();
  await expect(
    page.getByRole("listbox", { name: "Branch Mappings" }),
  ).toBeVisible();
  await expect(page.getByText("Browser Mock simulated data")).toBeVisible();
  await assertNoPageOverflow(page, "Branch Mappings");

  await page.goto("/?panel=search");
  await expect(page.locator(".app-shell.detached-shell")).toBeVisible();
  await assertNoPageOverflow(page, "detached search panel");
  await page.goto("/?panel=streamgraph");
  await expect(page.locator(".app-shell.detached-shell")).toBeVisible();
  await expect(
    page.getByRole("tree", { name: "Directed stream forest" }),
  ).toBeVisible();
  await assertNoPageOverflow(page, "detached Stream Graph panel");
  await page.goto("/?panel=branchmappings");
  await expect(page.locator(".app-shell.detached-shell")).toBeVisible();
  await expect(
    page.getByRole("listbox", { name: "Branch Mappings" }),
  ).toBeVisible();
  await assertNoPageOverflow(page, "detached Branch Mappings panel");
});

test("representative app, palette, settings, search and pending surfaces pass axe", async ({
  page,
}) => {
  await page.goto("/#/files");
  await expect(page.locator(".app-shell")).toBeVisible();
  await assertAxe(page, "application shell");
  await page.keyboard.press("Control+Shift+P");
  await assertAxe(page, "command palette");
  await page.keyboard.press("Escape");
  for (const destination of ["Settings", "Search", "Pending"]) {
    await page
      .getByRole("button", { name: new RegExp(`^${destination}`) })
      .first()
      .click();
    await expect(page.locator(".route-view")).toContainText(destination);
    await assertAxe(page, destination);
  }
  const activityBar = page.getByRole("navigation", { name: "Activity bar" });
  await activityBar.getByRole("button", { name: /^Streams/ }).click();
  await expect(page.locator(".route-view h1")).toHaveText("Streams");
  await page.getByRole("button", { name: "Open Stream Graph" }).click();
  await expect(
    page.getByRole("tree", { name: "Directed stream forest" }),
  ).toBeVisible();
  await assertAxe(page, "Stream Graph");
  await activityBar.getByRole("button", { name: /^Streams/ }).click();
  await expect(page.locator(".route-view h1")).toHaveText("Streams");
  await page.getByRole("button", { name: "Open Branch Mappings" }).click();
  await expect(
    page.getByRole("listbox", { name: "Branch Mappings" }),
  ).toBeVisible();
  await assertAxe(page, "Branch Mappings");
});

test("Global Search exposes seven filters and navigates Stream and Shelf results at 390px", async ({
  page,
}) => {
  await page.goto("/#/search");
  const search = page.getByRole("textbox", { name: "Search query" });
  const categories = page.getByRole("group", { name: "Categories" });
  await expect(categories.getByRole("checkbox")).toHaveCount(7);
  await expect(
    categories.getByRole("checkbox", { name: "Streams" }),
  ).toBeChecked();
  await expect(
    categories.getByRole("checkbox", { name: "Shelves" }),
  ).toBeChecked();
  await assertNoPageOverflow(page, "seven-kind Global Search");

  await search.fill("Atlas Mainline");
  const streamResult = page.getByRole("button", { name: /Atlas Mainline/ });
  await expect(streamResult).toContainText("Path: //atlas/main");
  await streamResult.press("Enter");
  await expect(page.locator(".route-view h1")).toHaveText("Streams");
  await expect(page.getByRole("textbox", { name: "Search list" })).toHaveValue(
    "//atlas/main",
  );
  await expect(page.getByText("Located stream: //atlas/main")).toBeVisible();

  await page
    .getByRole("button", { name: /^Search/ })
    .first()
    .click();
  for (const name of [
    "Submitted",
    "Pending",
    "Workspace files",
    "Depot files",
    "Jobs",
    "Streams",
  ])
    await categories.getByRole("checkbox", { name }).uncheck();
  await search.fill("Render pipeline cache improvements");
  const shelfResult = page.getByRole("button", { name: /Shelf 31821/ });
  await expect(shelfResult).toContainText("Numbered CL: 31821");
  await expect(page.getByText(/Shelf deep search is bounded/)).toBeVisible();
  await expect(page.locator(".search-category-partial")).toContainText(
    "Browser Mock simulated shelf detail candidate limit reached",
  );
  await assertNoPageOverflow(page, "bounded Shelf search result");
  await assertAxe(page, "seven-kind Global Search results");
  await shelfResult.press("Enter");
  await expect(page.locator(".route-view h1")).toHaveText("Shelf CL 31821");
  await expect(page.locator(".shelf-detail-page")).toContainText(
    "Render pipeline cache improvements",
  );
  await assertNoPageOverflow(page, "Shelf detail opened from Global Search");

  await page
    .getByRole("button", { name: /^Search/ })
    .first()
    .click();
  await expect(search).toHaveValue("Render pipeline cache improvements");
});

test("Branch Mapping simulated create, edit, preview and delete stay safe and keyboard operable", async ({
  page,
}) => {
  await page.goto("/?panel=branchmappings");
  const list = page.getByRole("listbox", { name: "Branch Mappings" });
  await expect(list).toBeVisible();
  const seed = list.getByRole("option", { name: /atlas-release/ });
  await seed.focus();
  await expect(seed).toBeFocused();
  await page.keyboard.press("Enter");
  const detail = page.getByRole("complementary", {
    name: "Branch Mapping details",
  });
  await expect(detail).toContainText("atlas-release");
  await detail.getByRole("button", { name: "Run read-only preview" }).click();
  await expect(detail).toContainText("Browser Mock simulated impact preview");
  await expect(detail).toContainText("integrate -n only");
  await detail.getByRole("button", { name: "reverse" }).click();
  await detail.getByRole("button", { name: "Run read-only preview" }).click();
  await expect(detail.getByRole("button", { name: "reverse" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  await page.getByRole("button", { name: "Create", exact: true }).click();
  let dialog = page.getByRole("dialog", { name: "Create Branch Mapping" });
  await expect(dialog).toContainText("Browser Mock");
  const mappingName = `pw-map-${Date.now()}`;
  await dialog.getByLabel("Branch Mapping name").fill(mappingName);
  await dialog.getByLabel("View line 1 source").fill("//atlas/main/...");
  await dialog
    .getByLabel("View line 1 target")
    .fill(`//atlas/${mappingName}/...`);
  await dialog.getByRole("button", { name: "Preflight and review" }).click();
  await dialog.getByRole("button", { name: "Confirm save" }).click();
  await expect(dialog).toContainText("Verified by server");
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(detail).toContainText(mappingName);

  await detail.getByRole("button", { name: "Edit", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "Edit Branch Mapping" });
  await dialog
    .getByLabel("Description")
    .fill("updated in browser safety fixture");
  await dialog.getByRole("button", { name: "Preflight and review" }).click();
  await dialog.getByRole("button", { name: "Confirm save" }).click();
  await expect(dialog).toContainText("Verified by server");
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(detail).toContainText("updated in browser safety fixture");

  await detail.getByRole("button", { name: "Delete", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "Delete Branch Mapping" });
  await dialog.getByRole("button", { name: "Preflight and review" }).click();
  await dialog
    .getByLabel("I understand this permanently deletes the Branch Mapping")
    .check();
  await dialog
    .getByRole("button", { name: "Confirm permanent delete" })
    .click();
  await expect(dialog).toContainText("Verified by server");
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(list).toBeFocused();
  await expect(
    list.getByRole("option", { name: new RegExp(mappingName) }),
  ).toHaveCount(0);
  await assertNoPageOverflow(page, "Branch Mapping mutation workflow");
});

test("Files keeps ordinary lock controls without an administrator force entry", async ({
  page,
}) => {
  await page.goto("/#/files");
  const address = page.getByRole("textbox", { name: "Address" });
  await address.fill("//atlas/main/render.ts");
  await address.press("Enter");

  await expect(
    page.getByRole("button", { name: "Lock", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Unlock", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /administrator force unlock/i }),
  ).toHaveCount(0);
  await assertNoPageOverflow(page, "ordinary lock controls");
  await assertAxe(page, "ordinary lock controls");
});

test("dialog, context menu, and manual merge fixtures fit and pass axe", async ({
  page,
}) => {
  await page.goto("/?workflow-audit");
  await page.getByRole("button", { name: "create", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await assertNoPageOverflow(page, "workflow dialog");
  await assertAxe(page, "workflow dialog");
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "manual-merge", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "手工合并编辑器" }),
  ).toBeVisible();
  await assertNoPageOverflow(page, "manual merge");
  await assertAxe(page, "manual merge");

  await page.goto("/?menu-audit");
  await page
    .locator('[data-testid="menu-audit-F01"]')
    .click({ button: "right" });
  await expect(page.getByRole("menu")).toBeVisible();
  await assertNoPageOverflow(page, "context menu");
  await assertAxe(page, "context menu");
});
