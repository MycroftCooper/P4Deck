import { chromium } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const output = new URL('./json-evidence/', import.meta.url);
await mkdir(output, {recursive:true});
const results = {checks:[],errors:[],blocked:[],hashes:{}};
for (const [name,path] of Object.entries({current:'../../features/browsers/components/FilePreviewPage.tsx',currentCss:'../../app/styles/preview.css',baseline:'./preview-baseline.txt',baselineCss:'./preview-baseline.css'})) results.hashes[name]=createHash('sha256').update(await readFile(new URL(path,import.meta.url))).digest('hex');
const browser=await chromium.launch({channel:'msedge',headless:true});
try {
 const context=await browser.newContext({viewport:{width:900,height:650},serviceWorkers:'block'});
 await context.route('**/*',route=>{if(new URL(route.request().url()).origin==='http://127.0.0.1:1437')return route.continue();results.blocked.push(route.request().url());return route.abort();});
 const page=await context.newPage(); page.on('pageerror',e=>results.errors.push(String(e)));
 async function check(label,screenshot=false) {
  await page.waitForTimeout(200);
  const state=await page.evaluate(()=>{const el=document.querySelector('.preview-text');const rect=el?.getBoundingClientRect();const rows=[...document.querySelectorAll('.preview-line')];return {height:rect?.height??0,lines:rows.map(r=>({number:r.querySelector('span').textContent,text:r.querySelector('code').textContent,top:r.getBoundingClientRect().top,bottom:r.getBoundingClientRect().bottom})),top:rect?.top,bottom:rect?.bottom,alert:document.querySelector('[role=alert]')?.textContent,status:document.querySelector('[role=status]')?.textContent,bridge:'__TAURI_INTERNALS__' in window};});
  results.checks.push({label,...state});
  if(screenshot)await page.screenshot({path:fileURLToPath(new URL(label+'.png',output))});
  return state;
 }
 for (const baseline of [true,false]) {
  const prefix=baseline?'before':'after';
  await page.goto('http://127.0.0.1:1437/'+(baseline?'?baseline':''));
  await page.waitForTimeout(400); await check(prefix+'-normal',true);
  if(baseline)continue;
  for(const [width,height] of [[390,320],[1200,750]]) {
   await page.setViewportSize({width,height});
   await page.locator('.preview-text').evaluate(n=>{n.scrollTop=n.scrollHeight;});
   await check('after-resize-'+width,true);
  }
  await page.evaluate(()=>document.getElementById('root').style.display='none');
  await page.waitForTimeout(200);
  await page.setViewportSize({width:600,height:450});
  await page.evaluate(()=>document.getElementById('root').style.display='');
  await check('after-restored',true);
  await page.goto('http://127.0.0.1:1437/?zero'); await page.waitForTimeout(400);
  await page.evaluate(()=>Object.assign(document.getElementById('root').style,{width:'100%',height:'100%',overflow:''}));
  await check('after-zero-restored',true);
 }
 for(const sample of ['empty','error','invalid','long']){
  await page.goto('http://127.0.0.1:1437/?sample='+sample);await page.waitForTimeout(400);await check('after-'+sample,true);
  if(sample==='error') {await page.getByRole('button',{name:'刷新',exact:true}).click();await check('after-error-recovery',true);}
  if(sample==='long') {await page.locator('.preview-text').evaluate(n=>{n.scrollLeft=n.scrollWidth;});await check('after-long-end',true);}
 }
 await context.close();
}finally{await browser.close();await writeFile(new URL('results.json',output),JSON.stringify(results,null,2));}
const failures=results.checks.filter(c=>c.label.startsWith('after')&&(c.bridge||(['after-empty','after-error'].includes(c.label)?(c.label==='after-empty'?!c.status?.includes('文件为空'):!c.alert?.includes('Synthetic')):c.height<=0||!c.lines.length)));
for(const c of results.checks.filter(c=>/^after-(normal|resize|restored|zero|error-recovery)/.test(c.label)))if(c.lines.length!==9||!c.lines.some(l=>l.number==='9'&&l.text==='}'))failures.push(c);
const expected = ['{','  "name": "fixture",','  "enabled": true,','  "items": [','    1,','    2','  ],','  "label": "中文 🚀"','}'];
for(const c of results.checks.filter(c=>/^after-(normal|resize|restored|zero|error-recovery)/.test(c.label))) {
 if(JSON.stringify(c.lines.map(l=>l.text))!==JSON.stringify(expected)) failures.push(c);
 const last=c.lines.at(-1);
 if(last.top<c.top||last.bottom>c.bottom+1)failures.push(c);
}
console.log(JSON.stringify({checks:results.checks.map(c=>({label:c.label,height:c.height,lines:c.lines.length,status:c.status,alert:c.alert})),errors:results.errors,blocked:results.blocked,failures:failures.map(c=>c.label)}));
if(failures.length||results.errors.length||results.blocked.length)process.exitCode=1;
