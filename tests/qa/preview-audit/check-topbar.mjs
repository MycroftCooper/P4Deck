import { chromium } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
const output = new URL('./topbar-evidence/', import.meta.url);
await mkdir(output, { recursive:true });
const browser = await chromium.launch({ channel:'msedge', headless:true });
const results = { checks:[], errors:[], blocked:[] };
try {
  for (const [width,height,scale] of [[1440,870,1],[900,670,1],[390,670,1],[1066,636,1.5]]) {
    const context = await browser.newContext({ viewport:{ width,height }, deviceScaleFactor:scale, serviceWorkers:'block' });
    await context.route('**/*', route => { if(new URL(route.request().url()).origin === 'http://127.0.0.1:1437') return route.continue(); results.blocked.push(route.request().url()); return route.abort(); });
    const page = await context.newPage(); page.on('pageerror',error => results.errors.push(String(error)));
    await page.goto('http://127.0.0.1:1437/topbar.html'); await page.locator('.connection').waitFor();
    const geometry = await page.evaluate(() => {
      const header = document.querySelector('.topbar').getBoundingClientRect(), button=document.querySelector('.connection').getBoundingClientRect(), main=document.querySelector('main').getBoundingClientRect();
      return { headerHeight:header.height, buttonWidth:button.width, within:button.left >= header.left && button.right <= header.right + 1, contentHeight:main.height, duplicate:!!document.querySelector('.window-controls,[data-tauri-drag-region],.titlebar-reserved'), bridge:'__TAURI_INTERNALS__' in window };
    });
    await page.locator('.connection').click(); geometry.settingsUsable = await page.evaluate(() => document.body.dataset.settingsOpened === 'true');
    results.checks.push({width,height,scale,...geometry});
    await page.screenshot({path:fileURLToPath(new URL(`${width}-${scale}.png`,output))}); await context.close();
  }
} finally { await browser.close(); await writeFile(new URL('results.json',output),JSON.stringify(results,null,2)); }
console.log(JSON.stringify(results));
if(results.errors.length || results.blocked.length || results.checks.some(item => !item.within || item.duplicate || item.bridge || !item.settingsUsable || item.contentHeight <= 0 || item.headerHeight !== 44)) process.exitCode=1;
