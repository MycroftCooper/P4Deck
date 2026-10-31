// @ts-nocheck
import {useEffect,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {PendingPage} from '../../../src/features/changelists/components/PendingPage';
import {messages} from '../../../src/shared/i18n';
import {CommandExecutionContext,i2Audit,exactSnapshot} from './i2-stubs';
import '../../app/styles/tokens.css';
import '../../app/styles/workbench.css';
import '../../app/styles/dialogs.css';
import '../preview-audit/fixture.css';
if('__TAURI_INTERNALS__' in window)throw Error('Native bridge forbidden');
Object.assign(window,{i2Audit,exactSnapshot});
function Fixture(){
 const [key,setKey]=useState(1),[menu,setMenu]=useState(null);
 useEffect(()=>{const fn=()=>setMenu({...i2Audit.menu});window.addEventListener('qa-menu',fn);window.qaSwitch=()=>setKey(v=>v+1);return()=>window.removeEventListener('qa-menu',fn);},[]);
 return <><p>Synthetic QA-I2 — no execution backend</p><CommandExecutionContext.Provider value={(...args)=>i2Audit.normal.push(args.slice(0,2))}><PendingPage t={messages['en-US']} clientName="synthetic" connectionKey={'i2-'+key} demo={false} ready/></CommandExecutionContext.Provider>{menu&&<aside aria-label="Synthetic context menu"><button disabled={!!menu.items['公司提交预览…']?.reason} title={menu.items['公司提交预览…']?.reason} onClick={()=>{menu.items['公司提交预览…'].run(menu.source);setMenu(null);}}>Company preview</button><span>{menu.scope}</span></aside>}</>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
