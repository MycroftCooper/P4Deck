import {chromium} from '@playwright/test';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const output=new URL('./pending-evidence/',import.meta.url);await mkdir(output,{recursive:true});
const results={checks:[],errors:[],blocked:[],hashes:{}};
for(const name of ['components/PendingPage.tsx','pendingFilterState.ts'])results.hashes[name]=createHash('sha256').update(await readFile(new URL('../../features/changelists/'+name,import.meta.url))).digest('hex');
const browser=await chromium.launch({channel:'msedge',headless:true});
try{
 const context=await browser.newContext({viewport:{width:1100,height:800},serviceWorkers:'block'});
 await context.route('**/*',route=>{if(new URL(route.request().url()).origin==='http://127.0.0.1:1437')return route.continue();results.blocked.push(route.request().url());return route.abort();});
 const page=await context.newPage();page.on('pageerror',e=>results.errors.push(String(e)));
 const assert=(label,pass)=>{results.checks.push({label,pass});if(!pass)throw new Error(label);};
 await page.goto('http://127.0.0.1:1437/pending.html');
 const sort=page.getByRole('button',{name:'Toggle ascending/descending CL number'});await sort.waitFor();
 const ids=()=>page.locator('[data-pending-change]').evaluateAll(ns=>ns.map(n=>Number(n.dataset.pendingChange)));
 assert('descending-numeric',JSON.stringify(await ids())==='[0,100,10,2]');
 await page.locator('[data-pending-change="2"]').click();
 await sort.focus();await page.keyboard.press('Enter');
 assert('ascending-numeric',JSON.stringify(await ids())==='[0,2,10,100]');
 assert('selection-retained',await page.locator('.command-selected [data-pending-change="2"]').count()===1);
 assert('expanded-retained',await page.locator('[data-files="2"]').count()===1);
 await page.getByRole('button',{name:'Open CL menu 2',exact:true}).click();assert('menu-target',await page.evaluate(()=>window.pendingAudit.menu.copy===2));
 // Open source if the menu click toggled its header through bubbling.
 if(!await page.locator('[data-files="2"]').count())await page.locator('[data-pending-change="2"]').click();
 const dt=await page.evaluateHandle(()=>new DataTransfer());
 await page.locator('[data-files="2"] [draggable]').dispatchEvent('dragstart',{dataTransfer:dt});
 await sort.click();
 await page.getByRole('region',{name:'CL 10 drop target'}).dispatchEvent('drop',{dataTransfer:dt});
 assert('drag-target-after-sort',await page.evaluate(()=>window.pendingAudit.move.from===2&&window.pendingAudit.move.target===10&&window.pendingAudit.move.paths[0]==='//synthetic/file-2'));
 assert('sorting-no-reads',await page.evaluate(()=>window.pendingAudit.reads===0));
 await page.reload();await sort.waitFor();assert('reload-preference',JSON.stringify(await ids())==='[0,100,10,2]');
 await sort.click();await page.reload();await sort.waitFor();assert('ascending-reload-preference',JSON.stringify(await ids())==='[0,2,10,100]');
 for(const width of [1100,390]){await page.setViewportSize({width,height:700});await sort.scrollIntoViewIfNeeded();await page.screenshot({path:fileURLToPath(new URL('sort-'+width+'.png',output))});assert('button-visible-'+width,await sort.isVisible()&&await sort.getAttribute('aria-pressed')==='true');}
 await context.close();
}finally{await browser.close();await writeFile(new URL('results.json',output),JSON.stringify(results,null,2));}
console.log(JSON.stringify(results));if(results.errors.length||results.blocked.length)process.exitCode=1;
