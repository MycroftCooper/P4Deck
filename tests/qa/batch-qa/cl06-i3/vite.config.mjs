import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {commandStubs} from '../boundaries.mjs';
const root=fileURLToPath(new URL('.',import.meta.url)),repo=path.resolve(root,'../../../..');
const local=n=>path.join(root,n),prior=n=>path.resolve(root,'../../preview-audit',n);
const files=[
 'features/settings/ConnectionProfilesCard.tsx','features/settings/ConnectionDirectoryDialog.tsx','features/settings/connectionWizard.ts',
 'features/companySubmit/useCustomSubmit.ts','features/companySubmit/customSubmit.ts','features/companySubmit/CustomSubmitStatusDialog.tsx','app/dialogs/Dialog.tsx','features/files/address.ts','features/changelists/components/PendingPage.tsx','features/changelists/pendingFilterState.ts',
 'shared/lib/storage.ts','shared/i18n.ts','app/context-menu/useRecordSelection.ts','features/browsers/components/BranchMappingsPage.tsx','features/browsers/branchMappingModel.ts',
 ...['ResizeHeader','ResizableTable','ColumnResizer','useColumnWidths'].map(n=>'app/context-menu/'+n+'.tsx'),
 'app/context-menu/useColumnWidths.ts','app/shell/CommandBar.tsx','app/shell/commandPolicy.ts',
 ...['tokens','workbench','settings','dialogs','branch-mappings','commands'].map(n=>'app/styles/'+n+'.css'),
];
const exact=new Set(files.map(f=>path.normalize(path.join(repo,'src',f))));
const testFiles=[prior('pending-stubs.tsx'),prior('branch-stubs.tsx'),prior('stubs.tsx'),path.resolve(root,'../command-stubs.tsx')].map(path.normalize);testFiles.forEach(f=>exact.add(f));
export default defineConfig({root,plugins:[react(),{name:'t01-synthetic-only',enforce:'pre',resolveId(id,importer){
 const from=importer?.replaceAll('\\','/').split('?')[0];
 if(from?.endsWith('/ConnectionProfilesCard.tsx')&&['../../app/closeGuard','../../infrastructure/backend','../swarm/swarmLinks','./ConnectionSpecCreateDialog'].includes(id))return local('settings-stubs.tsx');
 if(from?.endsWith('/ConnectionDirectoryDialog.tsx')&&id==='../../infrastructure/backend')return local('settings-stubs.tsx');
 if(from?.endsWith('/components/PendingPage.tsx')&&(id.startsWith('./')||id.startsWith('../'))&&!id.endsWith('/pendingFilterState')&&!id.endsWith('/useRecordSelection'))return local('pending-stubs.tsx');
 if((from?.endsWith('/app/shell/CommandBar.tsx')&&commandStubs.includes(id))||(from?.endsWith('/app/shell/commandPolicy.ts')&&['../../features/files/selectionCommands','../../features/files/selection'].includes(id)))return local('command-stubs.tsx');
 if(from?.endsWith('/BranchMappingsPage.tsx')&&(id==='../../infrastructure/backend'||id.includes('/shared/cache/')||id.endsWith('/BranchMappingMutationDialog')))return prior('branch-stubs.tsx');
 if(from?.endsWith('/BranchMappingsPage.tsx')&&id.endsWith('/docking/chrome'))return prior('stubs.tsx');
 if(/infrastructure|@tauri-apps|(?:^|\/)App(?:\.|$)|(?:^|\/)main(?:\.|$)/.test(id))throw Error('Forbidden T01 dependency: '+id);
 },load(id){const p=path.normalize(id.split('?')[0]);if(path.isAbsolute(p)&&p.replaceAll('\\','/').includes('/src/')&&!exact.has(p)&&!p.startsWith(path.normalize(root))&&!p.startsWith(path.join(repo,'src/shared/i18n')+path.sep)&&!p.startsWith(path.join(repo,'node_modules')+path.sep))throw Error('Non-whitelisted T01 source: '+id);}}],optimizeDeps:{entries:['index.html']},server:{host:'127.0.0.1',port:1437,strictPort:true,open:false,fs:{strict:true,allow:[root,...exact,path.join(repo,'src/shared/i18n'),path.join(repo,'node_modules')]},headers:{'Content-Security-Policy':"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws://127.0.0.1:1437; img-src 'self' data:; object-src 'none'"}}});

