import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const longClient = "fenganmeng_DM42.Beyond_Beyond_v1d6_project";
test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 844 });
  await page.addInitScript((client) => {
    localStorage.setItem("p4deck.locale", "en-US");
    if (localStorage.getItem("p4deck.ui") === null) {
      localStorage.setItem("p4deck.ui", JSON.stringify({ sidebarWidth: 240 }));
      localStorage.setItem("p4deck.leftOpen", "true");
    }
    localStorage.setItem(
      "p4deck.mockConnection",
      JSON.stringify({
        server: "ssl:p4.example.invalid:1666",
        user: "tester",
        client,
        cwd: "/workspace/atlas",
      }),
    );
  }, longClient);
  await page.goto("/#/files");
  await expect(page.locator(".tree-root")).toContainText(longClient);
});

async function dragToWidth(page: Page, width: number) {
  const sidebar = (await page.locator(".resource-explorer").boundingBox())!;
  const handle = (await page
    .getByRole("separator", { name: "Resize resource sidebar" })
    .boundingBox())!;
  const start = handle.x + handle.width / 2;
  const offset = sidebar.x + sidebar.width - start;
  await page.mouse.move(start, handle.y + 80);
  await page.mouse.down();
  await page.mouse.move(sidebar.x + width - offset, handle.y + 80, {
    steps: 8,
  });
  await page.mouse.up();
}

test("long names stay inside sidebar and the middle edge button reveals on hover and focus", async ({
  page,
}, testInfo) => {
  const sidebar = page.locator(".resource-explorer");
  await expect(sidebar).toHaveCSS("width", "240px");
  const bounds = await sidebar.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const tabs = [...element.querySelectorAll(".resource-tab button")].map(
      (tab) => tab.getBoundingClientRect(),
    );
    const toggle = element
      .querySelector(".resource-collapse")!
      .getBoundingClientRect();
    return {
      width: element.clientWidth,
      scroll: element.scrollWidth,
      tabsInside: tabs.every(
        (tab) => tab.left >= rect.left && tab.right < rect.right,
      ),
      equalTabs: Math.abs(tabs[0].width - tabs[1].width) < 1,
      middle:
        Math.abs(toggle.top + toggle.height / 2 - rect.top - rect.height / 2) <
        1,
    };
  });
  expect(bounds.scroll).toBe(bounds.width);
  expect(bounds.tabsInside).toBe(true);
  expect(bounds.equalTabs).toBe(true);
  expect(bounds.middle).toBe(true);
  const toggle = page.getByRole("button", {
    name: "Collapse resource sidebar",
  });
  await expect(toggle).toHaveCSS("width", "8px");
  await toggle.hover();
  await expect(toggle).toHaveCSS("width", "28px");
  await expect(toggle.locator("svg")).toHaveCSS("opacity", "1");
  await page.screenshot({ path: testInfo.outputPath("sidebar-hover.png") });
  await page.mouse.move(800, 100);
  await expect(toggle).toHaveCSS("width", "8px");
  await toggle.focus();
  await expect(toggle).toHaveCSS("width", "28px");
  const axe = await new AxeBuilder({ page })
    .include(".resource-explorer")
    .analyze();
  expect(axe.violations).toEqual([]);
});

test("dragged width persists and crossing the left threshold collapses without losing it", async ({
  page,
}) => {
  const sidebar = page.locator(".resource-explorer");
  await dragToWidth(page, 377);
  await expect(sidebar).toHaveCSS("width", "377px");
  await page.reload();
  await expect(sidebar).toHaveCSS("width", "377px");
  await page
    .getByRole("button", { name: /^Settings/ })
    .first()
    .click();
  await expect(page.getByLabel("Sidebar width", { exact: false })).toHaveValue(
    "377",
  );
  await dragToWidth(page, 80);
  await expect(sidebar).toHaveClass(/is-collapsed/);
  await expect(sidebar).toHaveCSS("width", "28px");
  await page.getByRole("button", { name: "Expand resource sidebar" }).click();
  await expect(sidebar).toHaveCSS("width", "377px");
  await dragToWidth(page, 150);
  await expect(sidebar).toHaveCSS("width", "200px");
  await dragToWidth(page, 900);
  await expect(sidebar).toHaveCSS("width", "600px");
});

test("separator supports keyboard resizing and Home collapse", async ({
  page,
}) => {
  const handle = page.getByRole("separator", {
    name: "Resize resource sidebar",
  });
  await handle.focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.locator(".resource-explorer")).toHaveCSS("width", "260px");
  await page.keyboard.press("Home");
  const toggle = page.getByRole("button", { name: "Expand resource sidebar" });
  await expect(toggle).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator(".resource-explorer")).toHaveCSS("width", "260px");
});

test("a captured drag can cross the collapse threshold in both directions and cancel cleanly", async ({
  page,
}) => {
  const sidebar = page.locator(".resource-explorer");
  const handle = page.getByRole("separator", {
    name: "Resize resource sidebar",
  });
  const rect = (await sidebar.boundingBox())!;
  const grip = (await handle.boundingBox())!;
  const start = grip.x + grip.width / 2;
  const offset = rect.x + rect.width - start;
  await page.mouse.move(start, grip.y + 80);
  await page.mouse.down();
  await page.mouse.move(rect.x + 60 - offset, grip.y + 80);
  await expect(sidebar).toHaveClass(/is-collapsed/);
  await page.mouse.move(rect.x + 320 - offset, grip.y + 80);
  await expect(sidebar).not.toHaveClass(/is-collapsed/);
  await expect(sidebar).toHaveCSS("width", "320px");
  await handle.dispatchEvent("pointercancel");
  await page.mouse.up();
  await expect(sidebar).toHaveCSS("width", "240px");
  await expect(handle).not.toHaveClass(/is-resizing/);
});

test("390px overlay can resize and collapse without page overflow", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const sidebar = page.locator(".resource-explorer");
  await dragToWidth(page, 300);
  await expect(sidebar).toHaveCSS("width", "300px");
  await dragToWidth(page, 900);
  await expect(sidebar).toHaveCSS("width", "346px");
  await dragToWidth(page, 60);
  await expect(sidebar).toHaveClass(/is-collapsed/);
  await page.getByRole("button", { name: "Expand resource sidebar" }).click();
  await expect(sidebar).toHaveCSS("width", "346px");
  expect(
    await page.evaluate(() => document.querySelector("#root")!.scrollWidth),
  ).toBe(390);
});
