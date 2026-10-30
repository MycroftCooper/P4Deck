// QA-B01: read source bytes only; no application imports, server or backend.
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const repo = fileURLToPath(new URL('../../../', import.meta.url));
const read = p => readFile(path.join(repo,p));
const hash = async p => createHash('sha256').update(await read(p)).digest('hex');
const audit = 'tests/qa/preview-audit/';
const specs = [
 ['branch','hashes.current','src/features/browsers/components/BranchMappingsPage.tsx'],
 ['json','hashes.current','src/features/browsers/components/FilePreviewPage.tsx'],
 ['json','hashes.currentCss','src/app/styles/preview.css'],
 ['gate','hash','src/features/settings/ConnectionSetupGate.tsx'],
 ['pending','hashes.components/PendingPage.tsx','src/features/changelists/components/PendingPage.tsx'],
 ['pending','hashes.pendingFilterState.ts','src/features/changelists/pendingFilterState.ts'],
 ['scroll','hash','src/app/styles/scrollbars.css'],
];
const comparisons=[];
for (const [suite,key,source] of specs) {
 const evidence=audit+suite+'-evidence/results.json';
 const j=JSON.parse(await read(evidence));
 const old=key.startsWith('hashes.')?j.hashes[key.slice(7)]:j[key];
 const current=await hash(source);
 comparisons.push({suite,source,evidence,recorded:old,current,match:old===current});
}
const inventory = new Set(specs.map(s=>s[2]));
for (const dir of ['src/app/shell','src/app/closeGuard','src/app/context-menu','src/app/styles']) {
 for(const entry of await readdir(path.join(repo,dir),{withFileTypes:true}))
  if(entry.isFile() && !entry.name.includes('.test.')) inventory.add(dir+'/'+entry.name);
}
for(const p of ['src/app/panels.ts','src/app/pageIcons.ts','src/app/commands/actionCatalog.ts','src/app/dialogs/useCommandDialogs.tsx','src/features/changelists/components/SubmitDialog.tsx','src/features/changelists/pendingQueries.ts','src/features/settings/connectionWizard.ts','src/features/browsers/branchMappingModel.ts','src/infrastructure/backend/tauriBackend.ts','src-tauri/src/close_guard.rs','src-tauri/src/app/close_policy.rs',audit+'vite.config.mjs']) inventory.add(p);
for(const entry of await readdir(path.join(repo,audit),{withFileTypes:true})) if(entry.isFile()) inventory.add(audit+entry.name);
const hashes={};for(const p of [...inventory].sort()) hashes[p]=await hash(p);
const command=(await read('src/app/shell/CommandBar.tsx')).toString();
const checks=[
 {label:'toolbar group excludes submit',pass:!command.slice(command.indexOf('const groups:'),command.indexOf('interface Props')).includes('submit')},
 {label:'command submit dispatch retained',pass:/id === "submit"/.test(command)},
 {label:'Pending submit dispatch retained',pass:(await read('src/features/changelists/components/PendingPage.tsx')).toString().includes('"submit"')},
 {label:'preflight and confirmation adapters retained',pass:false},
];
const dialogs=(await read('src/app/dialogs/useCommandDialogs.tsx')).toString();
checks[3].pass=['backend.preflightSubmit','backend.confirmSubmit'].every(v=>dialogs.includes(v));
const result={at:new Date().toISOString(),kind:'static-only; not runtime acceptance',comparisons,checks,hashes,missing:['TopBar historical results have no source hash','Historical results do not hash complete transitive dependencies','CommandBar/ActivityBar and submit dialog are not in existing browser whitelist'],browserRun:false,externalRequests:'none: no browser/server/network started by this audit'};
await mkdir(new URL('./evidence/',import.meta.url),{recursive:true});
await writeFile(new URL('./evidence/baseline.json',import.meta.url),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({comparisons,checks,sourceFiles:Object.keys(hashes).length},null,2));
