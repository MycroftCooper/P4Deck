import {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {ConnectionSetupGate} from '../../../src/features/settings/ConnectionSetupGate';
import type {useRuntime} from '../../../src/app/hooks/useRuntime';
import type {Preferences} from '../../../src/app/hooks/usePreferences';
import {audit,runtime,profiles} from './gate-stubs';
import '../../app/styles/tokens.css';
import '../../app/styles/dialogs.css';
import './fixture.css';
if('__TAURI_INTERNALS__' in window)throw new Error('Native bridge forbidden');
const mode=new URLSearchParams(location.search).get('mode');
audit.stored=profiles(mode==='offline');audit.fail=mode==='error';
Object.assign(window,{gateAudit:audit});
function Fixture(){
 const [value,setValue]=useState({...runtime(mode==='offline'),...(mode==='loading'?{p4Version:'loading'}:{})});
 return <ConnectionSetupGate state={{runtime:value,applyRuntime:setValue,applyConnection:()=>{}} as unknown as ReturnType<typeof useRuntime>} preferences={{zh:true,locale:'zh-CN'} as Preferences}><main data-testid="work">合成业务入口</main></ConnectionSetupGate>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
