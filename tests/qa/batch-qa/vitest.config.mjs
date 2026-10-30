import {defineConfig} from 'vitest/config';
import react from '@vitejs/plugin-react';
import {fileURLToPath} from 'node:url';
export default defineConfig({plugins:[react(),{name:'submit-isolation',enforce:'pre',resolveId(id,importer){
 if(importer?.includes('CompanySubmitDialog.tsx') && id==='../../infrastructure/backend')return fileURLToPath(new URL('./i2-stubs.tsx',import.meta.url));
 if(importer?.includes('components/PendingPage.tsx') && (id.startsWith('./')||id.startsWith('../')) && !id.endsWith('/pendingFilterState') && !id.endsWith('/useRecordSelection') && !id.endsWith('/companySubmit/CompanySubmitDialog'))return fileURLToPath(new URL('./i2-stubs.tsx',import.meta.url));
 if(id.endsWith('/notifications/notifications'))return fileURLToPath(new URL('./notifications-stub.ts',import.meta.url));if(/infrastructure|@tauri-apps|(?:^|\/)App\.|(?:^|\/)main\./.test(id))throw Error('Forbidden mock dependency: '+id);}}],test:{include:['src/features/changelists/components/SubmitDialog.test.tsx','tests/qa/batch-qa/*.test.tsx'],setupFiles:[],pool:'forks',maxWorkers:1,minWorkers:1}});
