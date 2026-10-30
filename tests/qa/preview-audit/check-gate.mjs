import {chromium} from '@playwright/test';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const output=new URL('./gate-evidence/',import.meta.url);await mkdir(output,{recursive:true});
const results={checks:[],errors:[],blocked:[],hash:createHash('sha256').update(await readFile(new URL('../../features/settings/ConnectionSetupGate.tsx',import.meta.url))).digest('hex')};
const browser=await chromium.launch({channel:'msedge',headless:true});
try{
 const context=await browser.newContext({viewport:{width:1100,height:720},serviceWorkers:'block'});
 await context.route('**/*',route=>{if(new URL(route.request().url()).origin==='http://127.0.0.1:1437')return route.continue();results.blocked.push(route.request().url());return route.abort();});
 const page=await context.newPage();page.on('pageerror',e=>results.errors.push(String(e)));
 const assert=(label,pass)=>{results.checks.push({label,pass});if(!pass)throw new Error(label);};
 const work=()=>page.getByTestId('work').count();
 for(const width of [1100,390]){
  await page.setViewportSize({width,height:width===390?400:720});await page.goto('http://127.0.0.1:1437/gate.html');
  const dialog=page.getByRole('dialog');await dialog.waitFor();
  assert('initial-focus-'+width,await page.getByRole('button',{name:'去配置 P4'}).evaluate(n=>n===document.activeElement));
  await page.keyboard.press('Escape');await page.mouse.click(2,2);
  assert('no-bypass-'+width,await dialog.isVisible()&&!(await work()));
  await page.keyboard.press('Tab');assert('focus-contained-'+width,await dialog.evaluate(n=>n.contains(document.activeElement)));
  const rect=await dialog.boundingBox();assert('dialog-within-'+width,rect.x>=0&&rect.x+rect.width<=width&&rect.y>=0&&rect.y+rect.height<= (width===390?400:720));
  await page.screenshot({path:fileURLToPath(new URL('prompt-'+width+'.png',output))});
  await dialog.getByRole('button',{name:'退出应用'}).click();assert('denied-close-retains-'+width,await dialog.isVisible());
  await page.getByRole('button',{name:'去配置 P4'}).click();
  await page.getByRole('textbox').fill('retain synthetic draft');await page.getByRole('button',{name:'退出应用'}).click();
  assert('draft-retained-'+width,await page.getByRole('textbox').inputValue()==='retain synthetic draft');
  await page.getByRole('button',{name:'获取 CLI（模拟）'}).click();assert('cli-boundary-'+width,await page.evaluate(()=>window.gateAudit.cli===1));
  await page.getByRole('button',{name:'模拟验证失败'}).click();await page.waitForTimeout(250);
  assert('validation-failure-blocked-'+width,!(await work()));
  await page.screenshot({path:fileURLToPath(new URL('settings-'+width+'.png',output))});
  await page.getByRole('button',{name:'模拟验证成功'}).click();await page.getByTestId('work').waitFor();assert('success-releases-'+width,!!(await work()));
 }
 for(const mode of ['loading','offline','error']){
  await page.goto('http://127.0.0.1:1437/gate.html?mode='+mode);await page.waitForTimeout(250);
  if(mode==='loading')assert('loading-no-prompt',await page.getByRole('dialog').count()===0&&!(await work())&&await page.evaluate(()=>window.gateAudit.calls===0));
  if(mode==='offline')assert('persisted-offline-releases',!!(await work()));
  if(mode==='error'){
   // The prompt is intentionally modal; enter settings to reach retry behind it.
   await page.getByRole('button',{name:'去配置 P4'}).click();
   await page.getByRole('button',{name:'重新加载配置'}).click();await page.waitForTimeout(250);
   assert('load-error-retry',await page.getByText('Synthetic profile load failure',{exact:false}).count()===0&&!(await work()));
  }
 }
 await context.close();
}finally{await browser.close();await writeFile(new URL('results.json',output),JSON.stringify(results,null,2));}
console.log(JSON.stringify(results));if(results.errors.length||results.blocked.length)process.exitCode=1;
