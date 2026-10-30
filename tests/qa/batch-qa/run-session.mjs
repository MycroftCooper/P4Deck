import {createServer} from 'vite';
import {chromium} from '@playwright/test';
import {writeFile,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const out=new URL('./evidence/',import.meta.url);
const r={checks:[],errors:[],blocked:[],requests:[],identity:{config:'tests/qa/preview-audit/vite.config.mjs',host:'127.0.0.1',port:1437,pid:process.pid},cleanup:{}};
const assert=(name,pass,data)=>{r.checks.push({name,pass,data});if(!pass)throw Error(name);};
let server,browser;
try{
 const baseline=JSON.parse(await readFile(new URL('./evidence/baseline.json',import.meta.url)));
 const changed=[];for(const [p,h] of Object.entries(baseline.hashes)){if(p.endsWith('/vite.config.mjs'))continue;if(createHash('sha256').update(await readFile(p)).digest('hex')!==h)changed.push(p);}
 assert('frozen-source-unchanged',!changed.length,changed);
 server=await createServer({configFile:r.identity.config});await server.listen();
 r.identity.address=server.httpServer.address();
 browser=await chromium.launch({channel:'msedge',headless:true,ignoreDefaultArgs:['--hide-scrollbars']});
 const context=await browser.newContext({viewport:{width:1440,height:900},serviceWorkers:'block'});
 await context.route('**/*',route=>{const url=route.request().url();r.requests.push(url);if(new URL(url).origin==='http://127.0.0.1:1437')return route.continue();r.blocked.push(url);return route.abort();});
 const page=await context.newPage();page.on('pageerror',e=>r.errors.push(String(e)));
 const go=async p=>{await page.goto('http://127.0.0.1:1437/'+p);await page.waitForTimeout(350);assert('no-bridge:'+p,!(await page.evaluate(()=>('__TAURI_INTERNALS__' in window))));};
 const shot=async name=>page.screenshot({path:fileURLToPath(new URL(name+'.png',out))});
 if(!process.argv.includes('--remaining')){for(const width of [1440,390]){
  await page.setViewportSize({width,height:760});await go('batch.html');
  for(const text of [true,false]){
   if(!text)await page.getByRole('button',{name:'测试切换文字'}).click();
   assert('no-submit-toolbar:'+width+':'+text,await page.locator('.command-center').getByRole('button',{name:/提交 CL|Submit CL/}).count()===0);
   const nav=page.locator('.toolbar-navigation').getByRole('button',{name:/待提交/});await nav.scrollIntoViewIfNeeded();await nav.click();
   assert('pending-navigation:'+width+':'+text,await page.evaluate(()=>window.qaNavigation==='pending') && await page.locator('[data-page="pending"]').count()===1);
   for(const selector of ['.global-tools','.activity-scroll'])await page.locator(selector).evaluate(n=>n.scrollLeft=n.scrollWidth);
   assert('overflow-no-submit:'+width+':'+text,await page.locator('.command-center').getByRole('button',{name:/提交 CL|Submit CL/}).count()===0);
   await shot('toolbar-'+width+'-'+text);
  }
  assert('topbar-no-window-controls:'+width,await page.locator('.topbar button[aria-label*="关闭"],.topbar button[aria-label*="最小化"],.topbar button[aria-label*="最大化"]').count()===0);
 }
 await page.setViewportSize({width:950,height:700});await go('branch.html');await page.locator('[data-branch-index="0"]').waitFor();
 await page.evaluate(()=>document.getElementById('root').style.display='none');await page.waitForTimeout(200);await page.evaluate(()=>document.getElementById('root').style.display='');await page.waitForTimeout(300);
 const geo=()=>page.locator('.branch-mapping-window-row').evaluateAll(ns=>{const rows=ns.map(n=>({index:Number(n.dataset.index),top:n.getBoundingClientRect().top,bottom:n.firstElementChild.getBoundingClientRect().bottom})).sort((a,b)=>a.index-b.index);return {rows,overlap:rows.some((v,i)=>i&&v.top<rows[i-1].bottom-1)};});
 let g=await geo();assert('branch-hidden-restored',g.rows.length>0&&!g.overlap,g);
 await page.locator('.branch-mapping-list').evaluate(n=>n.scrollTop=n.scrollHeight);await page.waitForTimeout(300);g=await geo();assert('branch-last-row',g.rows.at(-1)?.index===95&&!g.overlap,g);await shot('branch-bottom');
 await go('?zero');await page.evaluate(()=>Object.assign(document.getElementById('root').style,{width:'100%',height:'100%',overflow:''}));await page.waitForTimeout(350);
 const lines=await page.locator('.preview-line').allTextContents();const preview=await page.locator('.preview-text').boundingBox();assert('json-zero-restored',preview?.height>0&&lines.length===9&&lines.some(t=>t.includes('中文')),lines);await shot('json-restored');
 }
 await go('gate.html');await page.getByRole('dialog').getByRole('button',{name:'退出应用'}).click();assert('gate-close-denied-retains',await page.getByRole('dialog').isVisible());await page.getByRole('button',{name:'去配置 P4'}).click();await page.getByRole('textbox').fill('synthetic retained');await page.getByRole('button',{name:'退出应用'}).click();assert('gate-settings-draft-retained',await page.getByRole('textbox').inputValue()==='synthetic retained');await shot('gate-settings');
 await go('pending.html');const sort=page.getByRole('button',{name:'Toggle ascending/descending CL number'});await page.locator('[data-pending-change="2"]').click();await sort.click();const ids=await page.locator('[data-pending-change]').evaluateAll(ns=>ns.map(n=>Number(n.dataset.pendingChange)));assert('pending-sort-default-selection',JSON.stringify(ids)==='[0,2,10,100]'&&await page.locator('.command-selected [data-pending-change="2"]').count()===1&&await page.evaluate(()=>window.pendingAudit.reads===0),ids);await shot('pending-selection');
 for(const theme of ['light','dark']){
  await go('scroll.html?kind=table&theme='+theme);const el=page.locator('.audit-scroll');const b=await el.boundingBox();
  for(const axis of ['x','y']){await el.evaluate(n=>{n.scrollTop=0;n.scrollLeft=0;});const x=axis==='x'?b.x+20:b.x+b.width-8,y=axis==='y'?b.y+20:b.y+b.height-8;await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(axis==='x'?b.x+b.width+100:x,axis==='y'?b.y+b.height+100:y,{steps:10});await page.mouse.up();const s=await el.evaluate(n=>({x:n.scrollLeft,y:n.scrollTop,maxX:n.scrollWidth-n.clientWidth,maxY:n.scrollHeight-n.clientHeight}));assert('scroll-drag:'+theme+':'+axis,s[axis]>0,s);}
  await shot('scroll-'+theme);
 }
 assert('no-runtime-errors',r.errors.length===0,r.errors);assert('no-external-requests',r.blocked.length===0,r.blocked);
 await context.close();
}catch(e){r.failure=String(e);process.exitCode=1;}
finally{if(browser){await browser.close();r.cleanup.browserClosed=true;}if(server){await server.close();r.cleanup.serverClosed=true;}await writeFile(new URL(process.argv.includes('--remaining')?'session-remaining.json':'session.json',out),JSON.stringify(r,null,2));console.log(JSON.stringify({checks:r.checks,errors:r.errors,failure:r.failure,cleanup:r.cleanup}));}
