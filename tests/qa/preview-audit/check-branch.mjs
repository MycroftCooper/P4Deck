import { chromium } from "@playwright/test";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
const output = new URL("./branch-evidence/", import.meta.url);
await mkdir(output, { recursive: true });
const results = { checks: [], errors: [], blocked: [], hashes: {} };
for (const [name, url] of [["baseline", new URL("./branch-baseline.txt", import.meta.url)], ["current", new URL("../../features/browsers/components/BranchMappingsPage.tsx", import.meta.url)]]) results.hashes[name] = createHash("sha256").update(await readFile(url)).digest("hex");
const browser = await chromium.launch({ channel: "msedge", headless: true });
try {
  for (const baseline of [true, false]) {
    const prefix = baseline ? "before" : "after";
    const context = await browser.newContext({ viewport: { width: 1599, height: 999 }, serviceWorkers: "block" });
    await context.route("**/*", route => {
      if (new URL(route.request().url()).origin === "http://127.0.0.1:1437") return route.continue();
      results.blocked.push(route.request().url()); return route.abort();
    });
    const page = await context.newPage();
    page.on("pageerror", error => results.errors.push(String(error)));
    await page.goto(`http://127.0.0.1:1437/branch.html${baseline ? '?baseline' : ''}`);
    await page.locator('[data-branch-index="0"]').waitFor();
    if (await page.evaluate(() => "__TAURI_INTERNALS__" in window)) throw new Error("Native bridge forbidden");
    async function check(label, screenshot = false) {
      await page.waitForTimeout(220);
      const geometry = await page.locator('.branch-mapping-window-row').evaluateAll(nodes => {
        const rows = nodes.map(node => {
          const outer = node.getBoundingClientRect(), inner = node.firstElementChild.getBoundingClientRect();
          return { index: Number(node.dataset.index), top: outer.top, bottom: outer.bottom, height: outer.height, contentBottom: inner.bottom };
        }).sort((a,b) => a.index-b.index);
        return { rows, overlap: rows.some((r,i) => i && r.top < rows[i-1].contentBottom - 1), overflow: rows.some(r => r.contentBottom > r.bottom + 1) };
      });
      results.checks.push({ label: `${prefix}-${label}`, ...geometry });
      if (screenshot || geometry.overlap || geometry.overflow) await page.screenshot({ path: fileURLToPath(new URL(`${prefix}-${label}.png`, output)) });
    }
    await check('wide-top', true);
    for (const fraction of [.45, 1]) {
      await page.locator('.branch-mapping-list').evaluate((node, fraction) => { node.scrollTop = (node.scrollHeight-node.clientHeight)*fraction; }, fraction);
      await check(fraction === 1 ? 'wide-bottom' : 'wide-middle', true);
    }
    for (const [width, height] of [[900,735],[600,600],[1599,999]]) {
      await page.setViewportSize({ width, height });
      await page.locator('.branch-mapping-list').evaluate(node => { node.scrollTop = node.scrollHeight*.4; });
      await check(`resize-${width}`, true);
      if (width === 600) {
        // The narrow layout intentionally scrolls the page instead of the list.
        await page.locator('.branch-mappings-page').evaluate(node => { node.scrollTop = node.scrollHeight; });
        await check('narrow-page-bottom', true);
        await page.locator('.branch-mappings-page').evaluate(node => { node.scrollTop = 0; });
      }
    }
    await page.evaluate(() => { document.getElementById('root').style.display = 'none'; });
    await page.waitForTimeout(300);
    await page.setViewportSize({ width: 950, height: 700 });
    await page.evaluate(() => { document.getElementById('root').style.display = ''; });
    await check('hidden-restored', true);
    // Bring the still-mounted leading overscan row into the visible viewport.
    // A stale tiny height otherwise hides behind the scroll container's top edge.
    await page.locator('.branch-mapping-list').evaluate(node => {
      const row = node.querySelector('.branch-mapping-window-row');
      node.scrollTop = Math.max(0, Number(row.style.transform.match(/translateY\(([-\d.]+)px\)/)[1]) - 30);
    });
    await check('hidden-restored-exposed', true);
    await page.evaluate(() => { document.body.style.zoom = '1.5'; });
    await check('zoom150', true);
    await page.evaluate(() => { document.body.style.zoom = ''; });
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width:1066, height:666, deviceScaleFactor:1.5, mobile:false });
    await check('dpi150', true);
    await page.locator('.branch-mapping-list').evaluate(node => { node.scrollTop = node.scrollHeight; });
    await check('dpi150-bottom', true);
    await context.close();
  }
} finally {
  await browser.close();
  await writeFile(new URL('results.json', output), JSON.stringify(results, null, 2));
}
console.log(JSON.stringify({ checks: results.checks.map(({label,overlap,overflow,rows}) => ({label,overlap,overflow,count:rows.length,first:rows[0]?.index,last:rows.at(-1)?.index})), errors:results.errors, blocked:results.blocked }));
if (results.errors.length || results.blocked.length || results.checks.some(c => c.label.startsWith('after') && (c.overlap || c.overflow || !c.rows.length))) process.exitCode = 1;
