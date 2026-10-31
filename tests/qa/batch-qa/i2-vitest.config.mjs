import {defineConfig} from 'vitest/config';
import react from '@vitejs/plugin-react';
export default defineConfig({plugins:[react(),{name:'qa-i2-no-host',enforce:'pre',resolveId(id){if(/infrastructure|@tauri-apps|(?:^|\/)App\.|(?:^|\/)main\./.test(id))throw Error('Forbidden QA-I2 dependency: '+id);}}],test:{include:['tests/qa/batch-qa/i2-integration.test.tsx','src/app/context-menu/model.test.ts'],setupFiles:[],pool:'forks',maxWorkers:1,minWorkers:1}});
