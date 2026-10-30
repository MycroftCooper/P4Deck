import {chromium} from '@playwright/test';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const out=new URL('./scroll-evidence/',import.meta.url);await mkdir(out,{recursive:true});
const r={checks:[],errors:[],blocked:[],hash:createHash('sha256').update(await readFile(new URL('../../app/styles/scrollbars.css',import.meta.url))).digest('hex')};
// Playwright otherwise hides native scrollbars in headless screenshots.
const browser=await chromium.launch({channel:'msedge',headless:true,ignoreDefaultArgs:['--hide-scrollbars']});
try{
 const context=await browser.newContext({viewport:{width:900,height:650},serviceWorkers:'block'});await context.route('**/*',route=>{if(new URL(route.request().url()).origin==='http://127.0.0.1:1437')return route.continue();r.blocked.push(route.request().url());return route.abort();});
 const page=await context.newPage();page.on('pageerror',e=>r.errors.push(String(e)));
 for(const theme of ['light','dark'])for(const kind of ['table','dialog','sidebar','preview','nested','virtual','dock']){
  await page.goto(`http://127.0.0.1:1437/scroll.html?kind=${kind}&theme=${theme}&sample=scroll`);await page.waitForTimeout(500);
  const selector=kind==='preview'?'.preview-text':kind==='virtual'?'.branch-mapping-list':kind==='nested'?'.inner':'.audit-scroll';const el=page.locator(selector).first();await el.waitFor();
  await page.screenshot({path:fileURLToPath(new URL(`${theme}-${kind}-idle.png`,out))});
  for(const axis of ['y','x']){
   await el.evaluate(n=>{n.scrollTop=0;n.scrollLeft=0;});
   const m=await el.evaluate(n=>({x:n.getBoundingClientRect().x,y:n.getBoundingClientRect().y,w:n.getBoundingClientRect().width,h:n.getBoundingClientRect().height,cw:n.clientWidth,ch:n.clientHeight,sw:n.scrollWidth,sh:n.scrollHeight}));
   if(axis==='x'?m.sw<=m.cw:m.sh<=m.ch){r.checks.push({theme,kind,axis,notScrollable:true});continue;}
   const start=axis==='y'?{x:m.x+m.w-7,y:m.y+15}:{x:m.x+15,y:m.y+m.h-7};
   await page.mouse.move(start.x,start.y);await page.waitForTimeout(180);
   if(kind==='table')await page.screenshot({path:fileURLToPath(new URL(`${theme}-${axis}-hover.png`,out))});
   await page.mouse.down();await page.waitForTimeout(180);if(kind==='table')await page.screenshot({path:fileURLToPath(new URL(`${theme}-${axis}-active.png`,out))});
   await page.mouse.move(axis==='x'?m.x+m.w+100:start.x,axis==='y'?m.y+m.h+100:start.y,{steps:12});await page.mouse.up();await page.waitForTimeout(100);
   const after=await el.evaluate(n=>({left:n.scrollLeft,top:n.scrollTop,maxX:n.scrollWidth-n.clientWidth,maxY:n.scrollHeight-n.clientHeight}));
   const outer=kind==='nested'?await page.locator('.outer').evaluate(n=>({left:n.scrollLeft,top:n.scrollTop})):null;
   r.checks.push({theme,kind,axis,after,outer,moved:axis==='x'?after.left>0:after.top>0});
  }
  if(kind==='dock'){
   const thumb=page.locator('.dv-scrollbar').first();const box=await thumb.boundingBox();
   const tabs=page.locator('.dv-tabs-container').first();const before=await tabs.evaluate(n=>n.scrollLeft);
   await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.waitForTimeout(200);await page.screenshot({path:fileURLToPath(new URL(`${theme}-dock-hover.png`,out))});
   await page.mouse.down();await page.waitForTimeout(180);await page.screenshot({path:fileURLToPath(new URL(`${theme}-dock-active.png`,out))});
   await page.mouse.move(25,box.y+box.height/2,{steps:15});await page.mouse.up();await page.waitForTimeout(200);
   const after=await tabs.evaluate(n=>n.scrollLeft);r.checks.push({theme,kind,custom:true,before,after,moved:after<before});
  }
 }
 await page.goto('http://127.0.0.1:1437/scroll.html?kind=table&theme=dark');await page.setViewportSize({width:390,height:600});await page.evaluate(()=>document.body.style.zoom='1.5');await page.waitForTimeout(200);await page.screenshot({path:fileURLToPath(new URL('dark-narrow-150.png',out))});
 await context.close();
}finally{await browser.close();await writeFile(new URL('results.json',out),JSON.stringify(r,null,2));}
console.log(JSON.stringify(r));if(r.errors.length||r.blocked.length||r.checks.some(c=>c.moved===false))process.exitCode=1;

