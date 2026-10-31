import { chromium } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
const output = new URL("./table-visual-evidence/", import.meta.url);
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: "msedge", headless: true });
const context = await browser.newContext({
  viewport: { width: 1429, height: 900 },
  serviceWorkers: "block",
});
const blocked = [],
  errors = [],
  checks = [];
await context.route("**/*", (route) => {
  const url = new URL(route.request().url());
  if (url.origin === "http://127.0.0.1:1437") return route.continue();
  blocked.push(url.origin);
  return route.abort();
});
const page = await context.newPage();
page.on("pageerror", (error) => errors.push(String(error)));
const capture = (name) =>
  page.screenshot({
    path: new URL(name + ".png", output).pathname.replace(/^\/([A-Z]:)/i, "$1"),
    fullPage: true,
  });
async function noOverlap(label) {
  await page.waitForTimeout(150);
  const result = await page
    .locator('.description-trace-results [role="row"][data-index]')
    .evaluateAll((nodes) => {
      const rows = nodes
        .map((node) => ({
          index: Number(node.dataset.index),
          top: node.getBoundingClientRect().top,
          bottom: node.getBoundingClientRect().bottom,
          height: node.getBoundingClientRect().height,
          natural: node.firstElementChild.getBoundingClientRect().height,
        }))
        .sort((a, b) => a.index - b.index);
      return {
        rows,
        overlap: rows.some(
          (row, index) => index && row.top < rows[index - 1].bottom - 1,
        ),
        clipped: rows.some((row) => Math.abs(row.height - row.natural) > 2),
      };
    });
  checks.push({ label, ...result });
  if (result.overlap || result.clipped || !result.rows.length)
    throw new Error(`${label}: invalid row geometry ${JSON.stringify(result)}`);
}
try {
  await page.goto("http://127.0.0.1:1437/?workflow-audit");
  if (await page.evaluate(() => "__TAURI_INTERNALS__" in window))
    throw new Error("Native bridge detected");
  await page.evaluate(async () =>
    (await import("/tests/qa/tableVisualFixture.tsx")).showTrace(),
  );
  await page.getByRole("dialog").waitFor();
  await noOverlap("wide collapsed");
  await capture("01-wide-collapsed");
  await page
    .getByRole("button", { name: "Expand description", exact: true })
    .first()
    .click();
  await noOverlap("wide expanded");
  await capture("02-wide-expanded");
  const grip = page
    .locator('.description-trace-results [role="separator"]')
    .nth(3);
  const box = await grip.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x - 100, box.y + box.height / 2, { steps: 12 });
  await page.mouse.up();
  await noOverlap("after drag narrower description");
  await capture("03-dragged");
  await page.setViewportSize({ width: 900, height: 735 });
  await noOverlap("narrow 900");
  await capture("04-narrow");
  await page.evaluate(() => (document.documentElement.style.zoom = "1.5"));
  await noOverlap("150 percent zoom");
  await capture("05-zoom150");
  await page.locator(".description-trace-results").evaluate((node) => {
    node.scrollTop = node.scrollHeight;
    node.scrollLeft = node.scrollWidth;
  });
  await noOverlap("bottom and right scroll");
  await capture("06-bottom-right");
  await page.evaluate(() => (document.documentElement.style.zoom = "1"));
  await page.setViewportSize({ width: 953, height: 600 });
  const cdp = await context.newCDPSession(page);
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 953,
    height: 600,
    deviceScaleFactor: 1.5,
    mobile: false,
  });
  await page.locator(".description-trace-results").evaluate((node) => {
    node.scrollTop = 0;
    node.scrollLeft = 0;
  });
  await noOverlap("150 percent DPI with reduced layout viewport");
  const dialogBounds = await page.getByRole("dialog").boundingBox();
  if (dialogBounds.y < 0 || dialogBounds.y + dialogBounds.height > 601)
    throw new Error("Scaled dialog outside layout viewport");
  await capture("09-dpi150-layout");
  await cdp.send("Emulation.clearDeviceMetricsOverride");
  await cdp.detach();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.evaluate(async () =>
    (await import("/tests/qa/tableVisualFixture.tsx")).showRepresentatives(),
  );
  await page.getByRole("heading", { name: "Shared native table" }).waitFor();
  const native = page.locator('[data-table-id="visual-native"]');
  const beforeNative = await native.locator("th").first().boundingBox();
  const nativeGrip = await native
    .locator('[role="separator"]')
    .first()
    .boundingBox();
  await page.mouse.move(nativeGrip.x + 4, nativeGrip.y + 10);
  await page.mouse.down();
  await page.mouse.move(nativeGrip.x + 44, nativeGrip.y + 10, { steps: 10 });
  await page.mouse.up();
  const afterNative = await native.locator("th").first().boundingBox();
  const delta = afterNative.width - beforeNative.width;
  checks.push({
    label: "native first drag 40px",
    before: beforeNative.width,
    after: afterNative.width,
    delta,
  });
  if (Math.abs(delta - 40) > 2)
    throw new Error(`Native first drag jumped: ${delta}`);
  await page
    .locator('.history-table [role="separator"]')
    .nth(3)
    .press("ArrowLeft");
  await page.locator(".history-description-toggle-slot button").first().click();
  await page.waitForTimeout(200);
  const history = await page.locator(".history-record").evaluateAll((nodes) =>
    nodes.slice(0, 3).map((node) => ({
      top: node.getBoundingClientRect().top,
      bottom: node.getBoundingClientRect().bottom,
    })),
  );
  checks.push({ label: "history expansion", rows: history });
  if (history[1].top < history[0].bottom - 1)
    throw new Error("History expanded rows overlap");
  await capture("07-shared-native-history");
  await page.evaluate(async () =>
    (await import("/tests/qa/tableVisualFixture.tsx")).showShelf(),
  );
  await page.locator(".diff-line code").first().waitFor();
  const shelf = page.locator(".shelf-file-scroll");
  if (
    (await shelf.locator('[role="separator"]').count()) !== 2 ||
    (await page.locator('.diff-scroll [role="separator"]').count())
  )
    throw new Error("Shelf resize scope incorrect");
  const previewBefore = await page
    .locator(".diff-line")
    .first()
    .evaluate((node) => getComputedStyle(node).gridTemplateColumns);
  await shelf.locator('[role="separator"]').first().press("ArrowRight");
  const previewAfter = await page
    .locator(".diff-line")
    .first()
    .evaluate((node) => getComputedStyle(node).gridTemplateColumns);
  if (previewBefore !== previewAfter)
    throw new Error("Shelf file width changed code columns");
  checks.push({
    label: "Shelf file columns isolated from preview",
    previewBefore,
    previewAfter,
  });
  await capture("08-shelf-file-preview-isolation");
  if (errors.length || blocked.length)
    throw new Error(JSON.stringify({ errors, blocked }));
  console.log(
    JSON.stringify({ passed: true, checks, errors, blocked }, null, 2),
  );
} finally {
  await writeFile(
    new URL("results.json", output),
    JSON.stringify({ checks, errors, blocked }, null, 2),
  );
  await browser.close();
}
