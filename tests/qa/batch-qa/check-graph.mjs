import {build} from 'vite';
import {writeFile} from 'node:fs/promises';
import path from 'node:path';
const root=process.cwd();
const i2=process.argv.includes('--i2');
const result=await build({configFile:path.join(root,'tests/qa/preview-audit/vite.config.mjs'),build:{write:false,rollupOptions:{input:(i2?['tests/qa/batch-qa/i2-fixture.tsx']:['tests/qa/batch-qa/toolbar-fixture.tsx',...['fixture','branch-fixture','gate-fixture','pending-fixture','topbar-fixture','scroll-fixture'].map(n=>'tests/qa/preview-audit/'+n+'.tsx')]).map(p=>path.join(root,p))}},plugins:[{name:'qa-graph',generateBundle(){const modules=[...this.getModuleIds()].map(id=>({id,imports:this.getModuleInfo(id)?.importedIds}));const forbidden=modules.filter(x=>/\/src\/(?:infrastructure\/|app\/App\.|main\.)|@tauri-apps/.test(x.id.replaceAll('\\','/')));if(forbidden.length)throw Error('Forbidden runtime dependency');this.graph=modules;return writeFile(new URL(i2?'./evidence/graph-i2.json':'./evidence/graph.json',import.meta.url),JSON.stringify({modules,forbidden},null,2));}}]});
console.log('Synthetic graph validated; no files emitted by build.');
